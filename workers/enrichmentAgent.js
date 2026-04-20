/**
 * enrichmentAgent.js
 * 
 * Autonomous enrichment agent. Runs continuously, cycling through all
 * per-zip JSON files, finding businesses with confidence < 80, and
 * enriching them with:
 *   - Yelp review velocity (reviews/30 days → foot traffic proxy)
 *   - Hours (Yelp public API)
 *   - Phone (Yelp public API)
 *   - Website (Yelp public API)
 * 
 * Upgrades confidence scores after enrichment. No human loop.
 * 
 * Port: 3007
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');

const PORT = 3007;
const DATA_DIR = path.join(__dirname, '../data');
const ZIPS_DIR = path.join(DATA_DIR, 'zips');
const ENRICH_LOG = path.join(DATA_DIR, 'enrichmentLog.json');

// ── HTTP helper ───────────────────────────────────────────────────────────────

function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LocalIntel-Enrichment/1.0)',
        'Accept': 'application/json, text/html',
        ...opts.headers,
      },
      ...opts,
    };
    const req = https.get(url, options, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJson(res.headers.location, opts).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Yelp Fusion (public endpoint, no auth needed for basic search) ─────────────
// Yelp Business Search — uses the public Yelp Fusion API
// We use the business search endpoint to match by name+location, then
// pull the business detail for hours, phone, website, and review count.
// Rate: ~1 req/sec to be safe.

const YELP_API_KEY = process.env.YELP_API_KEY || null;

async function yelpSearch(name, lat, lon) {
  if (!YELP_API_KEY) return null;

  const params = new URLSearchParams({
    term: name,
    latitude: lat,
    longitude: lon,
    limit: 1,
    radius: 200, // 200m — tight match
  });

  try {
    const result = await fetchJson(
      `https://api.yelp.com/v3/businesses/search?${params}`,
      { headers: { Authorization: `Bearer ${YELP_API_KEY}` } }
    );
    if (result.status === 200 && result.body.businesses && result.body.businesses.length > 0) {
      return result.body.businesses[0];
    }
  } catch (err) {
    // Non-fatal
  }
  return null;
}

async function yelpBusinessDetail(yelpId) {
  if (!YELP_API_KEY || !yelpId) return null;
  try {
    const result = await fetchJson(
      `https://api.yelp.com/v3/businesses/${yelpId}`,
      { headers: { Authorization: `Bearer ${YELP_API_KEY}` } }
    );
    if (result.status === 200) return result.body;
  } catch (err) {}
  return null;
}

// ── OSM Nominatim phone/website fallback ──────────────────────────────────────

async function osmPhoneLookup(name, lat, lon) {
  try {
    await sleep(1100);
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name)}&lat=${lat}&lon=${lon}&format=json&addressdetails=1&extratags=1&limit=1`;
    const result = await fetchJson(url, {
      headers: { 'User-Agent': 'LocalIntel-Enrichment/1.0' }
    });
    if (result.body && result.body.length > 0) {
      const extra = result.body[0].extratags || {};
      return {
        phone: extra.phone || extra['contact:phone'] || null,
        website: extra.website || extra['contact:website'] || null,
        hours: extra.opening_hours || null,
      };
    }
  } catch (err) {}
  return null;
}

// ── Compute review velocity (foot traffic proxy) ───────────────────────────────

function computeReviewVelocity(yelpBiz) {
  if (!yelpBiz) return null;
  // Yelp doesn't give per-30-day counts in API, but review_count + rating
  // is our signal. Businesses with high review counts are high traffic.
  // We approximate velocity tier:
  const count = yelpBiz.review_count || 0;
  if (count > 500) return 'very_high';
  if (count > 200) return 'high';
  if (count > 75) return 'medium';
  if (count > 20) return 'low';
  return 'very_low';
}

// ── Enrich one business ────────────────────────────────────────────────────────

async function enrichBusiness(biz) {
  let changed = false;
  let yelpData = null;

  // Try Yelp first (if key available)
  if (YELP_API_KEY) {
    const match = await yelpSearch(biz.name, biz.lat, biz.lon);
    await sleep(1000);
    if (match) {
      const detail = await yelpBusinessDetail(match.id);
      await sleep(1000);
      yelpData = detail || match;

      if (yelpData.phone && !biz.phone) { biz.phone = yelpData.phone; changed = true; }
      if (yelpData.url && !biz.website) { biz.website = yelpData.url; changed = true; }

      // Hours from Yelp detail
      if (yelpData.hours && yelpData.hours.length > 0 && !biz.hours) {
        const open = yelpData.hours[0].open;
        if (open) {
          biz.hours = formatYelpHours(open);
          changed = true;
        }
      }

      // Rating
      if (yelpData.rating && !biz.rating) { biz.rating = yelpData.rating; changed = true; }
      if (yelpData.review_count) { biz.review_count = yelpData.review_count; changed = true; }

      // Foot traffic proxy
      const velocity = computeReviewVelocity(yelpData);
      if (velocity) { biz.foot_traffic_proxy = velocity; changed = true; }

      // Yelp ID for future reference
      if (!biz.yelp_id) { biz.yelp_id = match.id; changed = true; }

      // Confidence bump: Yelp confirmed = +10
      if (changed) biz.confidence = Math.min(95, (biz.confidence || 50) + 10);
    }
  }

  // OSM Nominatim fallback for phone/website
  if (!biz.phone || !biz.website) {
    const osmExtra = await osmPhoneLookup(biz.name, biz.lat, biz.lon);
    if (osmExtra) {
      if (!biz.phone && osmExtra.phone) { biz.phone = osmExtra.phone; changed = true; }
      if (!biz.website && osmExtra.website) { biz.website = osmExtra.website; changed = true; }
      if (!biz.hours && osmExtra.hours) { biz.hours = osmExtra.hours; changed = true; }
      if (changed) biz.confidence = Math.min(85, (biz.confidence || 50) + 5);
    }
  }

  if (changed) {
    biz.enriched_at = new Date().toISOString();
    biz.enrichment_source = YELP_API_KEY ? 'yelp+osm' : 'osm';
  }

  return { biz, changed };
}

function formatYelpHours(openArray) {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const byDay = {};
  openArray.forEach(slot => {
    const day = days[slot.day] || slot.day;
    const start = slot.start.replace(/(\d{2})(\d{2})/, '$1:$2');
    const end = slot.end.replace(/(\d{2})(\d{2})/, '$1:$2');
    byDay[day] = `${start}-${end}`;
  });
  return JSON.stringify(byDay);
}

// ── Main enrichment loop ──────────────────────────────────────────────────────

let enrichStats = { total: 0, enriched: 0, lastRun: null, running: false };
let enrichLog = [];

function loadLog() {
  if (fs.existsSync(ENRICH_LOG)) {
    try { return JSON.parse(fs.readFileSync(ENRICH_LOG)); }
    catch (e) { return []; }
  }
  return [];
}

function saveLog(log) {
  fs.writeFileSync(ENRICH_LOG, JSON.stringify(log.slice(-1000), null, 2)); // Keep last 1000 entries
}

async function enrichmentCycle() {
  if (enrichStats.running) return;
  enrichStats.running = true;
  enrichStats.lastRun = new Date().toISOString();

  if (!fs.existsSync(ZIPS_DIR)) {
    console.log('[EnrichmentAgent] No zips dir yet — waiting for ZipAgent to populate');
    enrichStats.running = false;
    return;
  }

  const zipFiles = fs.readdirSync(ZIPS_DIR).filter(f => f.endsWith('.json'));
  console.log(`[EnrichmentAgent] Scanning ${zipFiles.length} zip files`);

  let totalEnriched = 0;
  enrichLog = loadLog();

  for (const file of zipFiles) {
    const zipFile = path.join(ZIPS_DIR, file);
    let businesses;
    try {
      businesses = JSON.parse(fs.readFileSync(zipFile));
    } catch (e) {
      continue;
    }

    // Only enrich businesses below confidence 85 that haven't been enriched recently
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const candidates = businesses.filter(b => {
      if (b.confidence >= 85) return false;
      if (b.enriched_at && new Date(b.enriched_at).getTime() > oneDayAgo) return false;
      return true;
    });

    if (candidates.length === 0) continue;

    console.log(`[EnrichmentAgent] ${file}: ${candidates.length} candidates`);

    let fileChanged = false;
    for (const biz of candidates) {
      try {
        const { biz: enriched, changed } = await enrichBusiness(biz);
        if (changed) {
          // Update in-place (businesses array has reference)
          Object.assign(biz, enriched);
          totalEnriched++;
          fileChanged = true;
          enrichLog.push({
            zip: biz.zip,
            name: biz.name,
            enrichedAt: new Date().toISOString(),
            confidence: biz.confidence,
            source: biz.enrichment_source,
          });
        }
      } catch (err) {
        console.error(`[EnrichmentAgent] Error enriching ${biz.name}:`, err.message);
      }
      await sleep(500); // Gentle rate limiting
    }

    if (fileChanged) {
      fs.writeFileSync(zipFile, JSON.stringify(businesses, null, 2));
      console.log(`[EnrichmentAgent] Updated ${file}`);
    }
  }

  enrichStats.total += zipFiles.length;
  enrichStats.enriched += totalEnriched;
  enrichStats.running = false;
  console.log(`[EnrichmentAgent] Cycle done. Enriched ${totalEnriched} businesses.`);
  saveLog(enrichLog);
}

// ── Express API ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    worker: 'enrichmentAgent',
    port: PORT,
    status: enrichStats.running ? 'enriching' : 'idle',
    yelpConnected: !!YELP_API_KEY,
    stats: enrichStats,
  });
});

app.post('/run', async (req, res) => {
  res.json({ status: 'dispatched', message: 'Enrichment cycle triggered' });
  enrichmentCycle().catch(err => console.error('[EnrichmentAgent] Cycle error:', err));
});

app.get('/log', (req, res) => {
  res.json(loadLog().slice(-100));
});

// ── Auto-start ────────────────────────────────────────────────────────────────

const ENRICH_INTERVAL_MS = 30 * 60 * 1000; // Every 30 minutes

app.listen(PORT, () => {
  console.log(`[EnrichmentAgent] Running on port ${PORT}`);
  if (!YELP_API_KEY) {
    console.log('[EnrichmentAgent] No YELP_API_KEY — using OSM Nominatim only (add key to Railway env for full enrichment)');
  }
  enrichmentCycle().catch(err => console.error('[EnrichmentAgent] Init error:', err));
  setInterval(() => {
    enrichmentCycle().catch(err => console.error('[EnrichmentAgent] Interval error:', err));
  }, ENRICH_INTERVAL_MS);
});
