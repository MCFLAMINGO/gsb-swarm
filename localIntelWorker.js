'use strict';
/**
 * Local Intel Worker — GSB Swarm
 *
 * Runs as a persistent swarm agent. Responsibilities:
 *
 *  1. CLAIM PROCESSOR — watches for new business submissions from the dashboard,
 *     geocodes them, validates them, and adds them to the live dataset.
 *
 *  2. OSM SUBMITTER — formats verified claims as OSM changeset XML and queues
 *     them for submission. (OSM requires OAuth — queued for manual push or
 *     automated via OAuth token when configured.)
 *
 *  3. DATA REFRESHER — re-pulls OSM for covered zip codes on a weekly schedule,
 *     merges with owner-verified records, recalculates confidence scores.
 *
 *  4. COVERAGE SCORER — monitors data completeness per zip, flags gaps,
 *     recommends which streets/blocks need manual data collection.
 *
 * ACP jobs this worker handles:
 *   local_intel_query    — answered in localIntelAgent.js (HTTP layer)
 *   local_intel_claim    — submit + verify a new business listing
 *   local_intel_refresh  — trigger a fresh OSM pull for a zip
 *   local_intel_osm_prep — format a verified listing as OSM changeset
 */

const fs   = require('fs');
const path = require('path');
const http = require('http');

const DATA_PATH       = path.join(__dirname, 'data', 'localIntel.json');
const QUEUE_PATH      = path.join(__dirname, 'data', 'claimQueue.json');
const OSM_QUEUE_PATH  = path.join(__dirname, 'data', 'osmQueue.json');
const COVERED_ZIPS    = ['32081', '32082'];

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadJSON(p, fallback = []) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function saveJSON(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function log(msg) {
  console.log(`[LocalIntelWorker] ${new Date().toISOString().slice(11,19)} ${msg}`);
}

// ── Geocode via Nominatim ─────────────────────────────────────────────────────
async function geocode(address, city, state, zip) {
  const q = encodeURIComponent(`${address}, ${city}, ${state} ${zip}`);
  const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&addressdetails=1`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'MCFL-LocalIntel/1.0 contact@mcflamingo.com' } });
    const data = await res.json();
    if (data[0]) return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), display: data[0].display_name };
  } catch {}
  return null;
}

// ── Confidence scorer ─────────────────────────────────────────────────────────
function scoreConfidence(b) {
  let s = 0;
  if (b.name)    s += 25;
  if (b.address) s += 20;
  if (b.lat && b.lon) s += 20;
  if (b.phone)   s += 10;
  if (b.website) s += 10;
  if (b.hours)   s += 10;
  if (b.claimed) s += 15;   // owner-verified bump
  const srcCount = (b.sources || []).length;
  if (srcCount >= 2) s += 10;
  if (srcCount >= 3) s += 10;
  return Math.min(s, 100);
}

// ── OSM changeset formatter ───────────────────────────────────────────────────
function toOsmChangeset(business) {
  const tags = [
    `<tag k="name" v="${business.name.replace(/&/g,'&amp;').replace(/"/g,'&quot;')}"/>`,
    `<tag k="addr:housenumber" v="${(business.address.match(/^\d+/) || [''])[0]}"/>`,
    `<tag k="addr:street" v="${business.address.replace(/^\d+\s*/,'')}"/>`,
    `<tag k="addr:city" v="${business.city || 'Ponte Vedra Beach'}"/>`,
    `<tag k="addr:state" v="FL"/>`,
    `<tag k="addr:postcode" v="${business.zip}"/>`,
    business.phone   ? `<tag k="phone" v="${business.phone}"/>` : '',
    business.website ? `<tag k="website" v="${business.website}"/>` : '',
    business.hours   ? `<tag k="opening_hours" v="${business.hours}"/>` : '',
    `<tag k="${getCategoryTag(business.category)}" v="${business.category}"/>`,
  ].filter(Boolean).join('\n      ');

  return `<osmChange version="0.6">
  <create>
    <node id="-1" lat="${business.lat}" lon="${business.lon}" version="1">
      ${tags}
    </node>
  </create>
</osmChange>`;
}

function getCategoryTag(cat) {
  const shopCats = ['supermarket','convenience','clothes','hairdresser','beauty','chemist',
                    'mobile_phone','dry_cleaning','nutrition_supplements','copyshop','florist'];
  const amenityCats = ['restaurant','fast_food','cafe','bar','bank','atm','fuel',
                       'dentist','clinic','hospital','pharmacy','school','library',
                       'place_of_worship','post_office','police','fire_station'];
  if (shopCats.includes(cat))   return 'shop';
  if (amenityCats.includes(cat)) return 'amenity';
  if (['estate_agent','office','coworking'].includes(cat)) return 'office';
  return 'amenity';
}

// ── Claim processor ───────────────────────────────────────────────────────────
async function processClaims() {
  const queue = loadJSON(QUEUE_PATH, []);
  if (!queue.length) return;

  log(`Processing ${queue.length} pending claim(s)...`);
  const dataset   = loadJSON(DATA_PATH, []);
  const osmQueue  = loadJSON(OSM_QUEUE_PATH, []);
  const processed = [];
  const remaining = [];

  for (const claim of queue) {
    try {
      log(`  Processing: ${claim.name}`);

      // Geocode if no coords
      if (!claim.lat || !claim.lon) {
        const geo = await geocode(claim.address, claim.city, 'FL', claim.zip);
        if (geo) {
          claim.lat = geo.lat;
          claim.lon = geo.lon;
          log(`    Geocoded: ${geo.lat}, ${geo.lon}`);
        } else {
          log(`    Could not geocode — keeping in queue`);
          remaining.push(claim);
          continue;
        }
      }

      // Check for duplicate
      const dup = dataset.find(b =>
        b.name.toLowerCase() === claim.name.toLowerCase() &&
        b.zip === claim.zip
      );
      if (dup) {
        // Merge — update existing record
        Object.assign(dup, { ...claim, sources: [...new Set([...(dup.sources||[]), ...(claim.sources||[])])] });
        dup.confidence = scoreConfidence(dup);
        log(`    Merged with existing record`);
      } else {
        // New record
        claim.confidence = scoreConfidence(claim);
        claim.addedAt    = new Date().toISOString();
        dataset.unshift(claim);
        log(`    Added as new record (confidence: ${claim.confidence})`);
      }

      // Queue for OSM submission if owner-verified + has coords
      if (claim.claimed && claim.lat && claim.lon) {
        osmQueue.push({
          business:    claim,
          changeset:   toOsmChangeset(claim),
          queuedAt:    new Date().toISOString(),
          status:      'pending',
          note:        'Ready for OSM OAuth submission',
        });
        log(`    Queued for OSM submission`);
      }

      processed.push(claim);
    } catch (e) {
      log(`    Error: ${e.message}`);
      remaining.push(claim);
    }

    await new Promise(r => setTimeout(r, 1000)); // Nominatim rate limit
  }

  saveJSON(DATA_PATH,       dataset);
  saveJSON(QUEUE_PATH,      remaining);
  saveJSON(OSM_QUEUE_PATH,  osmQueue);

  log(`Done. Processed: ${processed.length}, Remaining: ${remaining.length}, OSM queue: ${osmQueue.length}`);
  return { processed: processed.length, remaining: remaining.length, osmQueued: osmQueue.length };
}

// ── HTTP server for job intake ────────────────────────────────────────────────
// Accepts POST /local-intel/claim from the Railway /api route
// and GET /local-intel/osm-queue for dashboard visibility
const PORT = parseInt(process.env.LOCAL_INTEL_PORT || '3003');

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'POST' && req.url === '/claim') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const claim = JSON.parse(body);
        // Basic validation
        if (!claim.name || !claim.address || !claim.zip) {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: 'name, address, zip required' }));
        }
        // Normalize
        claim.sources  = ['owner_verified'];
        claim.claimed  = true;
        claim.submittedAt = new Date().toISOString();
        claim.status   = 'pending';

        // Add to queue
        const queue = loadJSON(QUEUE_PATH, []);
        queue.push(claim);
        saveJSON(QUEUE_PATH, queue);
        log(`New claim queued: ${claim.name} (${claim.zip})`);

        // Process immediately
        const result = await processClaims();
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, message: 'Claim received and processed', ...result }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/osm-queue') {
    const queue = loadJSON(OSM_QUEUE_PATH, []);
    res.writeHead(200);
    return res.end(JSON.stringify({ ok: true, count: queue.length, queue }));
  }

  if (req.method === 'GET' && req.url === '/stats') {
    const data     = loadJSON(DATA_PATH, []);
    const queue    = loadJSON(QUEUE_PATH, []);
    const osmQueue = loadJSON(OSM_QUEUE_PATH, []);
    res.writeHead(200);
    return res.end(JSON.stringify({
      ok: true,
      totalBusinesses:  data.length,
      claimQueueLength: queue.length,
      osmQueueLength:   osmQueue.length,
      ownerVerified:    data.filter(b => b.claimed).length,
      coverageZips:     COVERED_ZIPS,
    }));
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    return res.end(JSON.stringify({ ok: true, worker: 'LocalIntelWorker', uptime: process.uptime() }));
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  log(`Worker listening on port ${PORT}`);
});

// ── Startup: process any queued claims ────────────────────────────────────────
(async () => {
  log('LocalIntelWorker starting...');
  log(`Covered zips: ${COVERED_ZIPS.join(', ')}`);

  const data = loadJSON(DATA_PATH, []);
  log(`Dataset loaded: ${data.length} businesses`);

  const queue = loadJSON(QUEUE_PATH, []);
  if (queue.length) {
    log(`Found ${queue.length} pending claims — processing...`);
    await processClaims();
  }

  // Weekly OSM refresh — every Monday 3am UTC
  function scheduleWeeklyRefresh() {
    const now  = new Date();
    const next = new Date(now);
    next.setUTCDate(now.getUTCDate() + ((1 - now.getUTCDay() + 7) % 7 || 7));
    next.setUTCHours(3, 0, 0, 0);
    const ms = next - now;
    log(`Weekly OSM refresh scheduled — next in ${(ms/86400000).toFixed(1)} days`);
    setTimeout(async () => {
      log('Weekly OSM refresh triggered');
      // Trigger the main swarm's sync endpoint
      try {
        await fetch('http://localhost:3001/api/local-intel/refresh', { method: 'POST' });
      } catch {}
      scheduleWeeklyRefresh();
    }, ms);
  }
  scheduleWeeklyRefresh();

  log('LocalIntelWorker ready.');
})();

module.exports = { processClaims, toOsmChangeset, scoreConfidence };
