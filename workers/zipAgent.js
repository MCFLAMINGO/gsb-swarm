/**
 * zipAgent.js
 *
 * Stateless, single-ZIP discovery agent.
 * Spawned by ZipCoordinatorWorker with CLI args.
 *
 * NON-BLOCKING RULE: If any data source is unavailable, log the reason
 * + a retry_after timestamp, and continue. Never stall the coordinator.
 *
 * Data sources attempted (in order, all optional):
 *   1. OSM Overpass — business discovery
 *   2. SJC ArcGIS Hub — permit/BTR data (if zip is in SJC)
 *   3. FL Sunbiz — registered businesses (public records, best-effort)
 *   4. Nominatim reverse geocode — address enrichment
 *
 * Writes: data/zips/{zip}.json
 * Logs:   data/sourceLog.json  (per-zip availability log)
 * Exit 0 = success, Exit 1 = fatal error
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

// ── Args ──────────────────────────────────────────────────────────────────────

const args = {};
process.argv.slice(2).forEach((v, i, arr) => {
  if (v.startsWith('--')) args[v.slice(2)] = arr[i + 1];
});

const ZIP    = args.zip;
const LAT    = parseFloat(args.lat);
const LON    = parseFloat(args.lon);
const REGION = args.region || 'FL';
const NAME   = args.name   || ZIP;

if (!ZIP || isNaN(LAT) || isNaN(LON)) {
  console.error('[ZipAgent] Missing required args: --zip --lat --lon');
  process.exit(1);
}

const DATA_DIR   = path.join(__dirname, '../data');
const ZIPS_DIR   = path.join(DATA_DIR, 'zips');
const ZIP_FILE   = path.join(ZIPS_DIR, `${ZIP}.json`);
const SOURCE_LOG = path.join(DATA_DIR, 'sourceLog.json');

// SJC zip codes — only these get ArcGIS Hub queries
const SJC_ZIPS = new Set(['32004','32033','32068','32080','32081','32082','32084','32086','32092','32095','32259']);

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[ZipAgent ${ZIP}] ${msg}`);
}

function loadSourceLog() {
  if (fs.existsSync(SOURCE_LOG)) {
    try { return JSON.parse(fs.readFileSync(SOURCE_LOG)); }
    catch (e) { return {}; }
  }
  return {};
}

function saveSourceLog(slog) {
  fs.writeFileSync(SOURCE_LOG, JSON.stringify(slog, null, 2));
}

/**
 * Record a source availability result for this zip.
 * status: 'ok' | 'unavailable' | 'error' | 'pending'
 */
function logSource(source, status, detail, retryAfterHours = null) {
  const slog = loadSourceLog();
  if (!slog[ZIP]) slog[ZIP] = {};
  slog[ZIP][source] = {
    status,
    detail,
    checked_at: new Date().toISOString(),
    retry_after: retryAfterHours
      ? new Date(Date.now() + retryAfterHours * 3600 * 1000).toISOString()
      : null,
  };
  saveSourceLog(slog);
  const emoji = status === 'ok' ? '✓' : status === 'unavailable' ? '⏭' : '⚠';
  log(`${emoji} [${source}] ${status}${detail ? ': ' + detail : ''}`);
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function fetchJson(url, opts = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'LocalIntel-ZipAgent/1.0 (localintel.ai)',
        'Accept': 'application/json',
        ...opts.headers,
      },
    };
    const req = lib.get(url, options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Source 1: OSM Overpass ────────────────────────────────────────────────────

const OSM_CATEGORY_MAP = {
  'amenity=restaurant': 'restaurant',   'amenity=cafe': 'cafe',
  'amenity=bar': 'bar',                 'amenity=fast_food': 'fast_food',
  'amenity=pharmacy': 'pharmacy',       'amenity=bank': 'bank',
  'amenity=fuel': 'gas_station',        'amenity=clinic': 'healthcare',
  'amenity=dentist': 'healthcare',      'amenity=doctors': 'healthcare',
  'amenity=veterinary': 'veterinary',   'shop=supermarket': 'grocery',
  'shop=convenience': 'convenience',    'shop=hardware': 'hardware',
  'shop=beauty': 'beauty',             'shop=hairdresser': 'beauty',
  'shop=clothes': 'retail',            'shop=florist': 'retail',
  'shop=bakery': 'food',               'shop=butcher': 'food',
  'shop=electronics': 'retail',        'shop=furniture': 'retail',
  'shop=sports': 'retail',             'office=estate_agent': 'real_estate',
  'office=insurance': 'insurance',     'office=financial': 'financial',
  'office=lawyer': 'legal',            'leisure=fitness_centre': 'fitness',
  'leisure=spa': 'wellness',           'tourism=hotel': 'hotel',
  'tourism=motel': 'hotel',
};

async function fetchOSM() {
  const RADIUS = 5000;
  const unions = Object.keys(OSM_CATEGORY_MAP).map(cat => {
    const [k, v] = cat.split('=');
    return `node["${k}"="${v}"](around:${RADIUS},${LAT},${LON});\nway["${k}"="${v}"](around:${RADIUS},${LAT},${LON});`;
  }).join('\n');

  const query = `[out:json][timeout:60];\n(\n${unions}\n);\nout center tags;`;
  const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { status, body } = await fetchJson(url, {}, 60000);
      if (status === 429) {
        logSource('osm_overpass', 'unavailable', 'Rate limited — retry in 1h', 1);
        return [];
      }
      if (status !== 200 || !body.elements) {
        logSource('osm_overpass', 'error', `HTTP ${status}`);
        return [];
      }
      const results = body.elements
        .filter(el => el.tags && el.tags.name)
        .map(el => {
          const lat = el.lat || (el.center && el.center.lat) || LAT;
          const lon = el.lon || (el.center && el.center.lon) || LON;
          const tags = el.tags;
          let category = 'other';
          for (const [cat, mapped] of Object.entries(OSM_CATEGORY_MAP)) {
            const [k, v] = cat.split('=');
            if (tags[k] === v) { category = mapped; break; }
          }
          return {
            name: tags.name, category, zip: ZIP, lat, lon,
            address: [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ') || null,
            city: tags['addr:city'] || NAME, state: 'FL',
            phone: tags.phone || tags['contact:phone'] || null,
            website: tags.website || tags['contact:website'] || null,
            hours: tags.opening_hours || null,
            osm_id: `${el.type}/${el.id}`,
            source: 'osm', confidence: 70,
            last_updated: new Date().toISOString(), region: REGION,
          };
        });
      logSource('osm_overpass', 'ok', `${results.length} businesses found`);
      return results;
    } catch (err) {
      if (attempt < 3) { await sleep(5000 * attempt); continue; }
      logSource('osm_overpass', 'error', err.message, 2);
      return [];
    }
  }
  return [];
}

// ── Source 2: SJC ArcGIS Hub ─────────────────────────────────────────────────
// Checks the SJC open data hub for permit or BTR datasets.
// If the dataset isn't published yet, logs it and moves on.

async function fetchSJCArcGIS() {
  if (!SJC_ZIPS.has(ZIP)) return []; // Only relevant for SJC

  // ArcGIS Hub dataset search for SJC
  const searchUrl = `https://data-sjcfl.hub.arcgis.com/api/search/v1/collections/all/items?q=business+license+permit&bbox=-81.9,29.6,-81.0,30.3&f=json&num=5`;

  try {
    const { status, body } = await fetchJson(searchUrl, {}, 15000);
    if (status !== 200) {
      logSource('sjc_arcgis', 'unavailable',
        `Hub returned HTTP ${status} — BTR dataset not yet published. Public records request pending.`,
        24
      );
      return [];
    }

    const items = body.results || body.items || [];
    const bizItems = items.filter(i =>
      (i.title || '').toLowerCase().includes('business') ||
      (i.title || '').toLowerCase().includes('license') ||
      (i.title || '').toLowerCase().includes('permit') ||
      (i.title || '').toLowerCase().includes('btr')
    );

    if (bizItems.length === 0) {
      logSource('sjc_arcgis', 'unavailable',
        'No BTR/permit datasets found on ArcGIS Hub — awaiting public records response from publicrecords@sjctax.us',
        48
      );
      return [];
    }

    logSource('sjc_arcgis', 'ok', `Found dataset: ${bizItems[0].title}`);
    // TODO: pull actual features when dataset goes live
    return [];
  } catch (err) {
    logSource('sjc_arcgis', 'error', `${err.message} — skipping, moving to next source`, 4);
    return [];
  }
}

// ── Source 3: FL Sunbiz (best-effort walk) ────────────────────────────────────
// Sunbiz doesn't have a bulk API — we do a zip-level search.
// If it times out or blocks, log and skip.

async function fetchSunbiz() {
  const searchUrl = `https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResults?inquiryType=EntityName&inquiryDirectionType=ForwardList&searchNameOrder=&aggregateId=&searchTerm=${encodeURIComponent(NAME)}&listNameOrder=`;

  try {
    const { status, body } = await fetchJson(searchUrl, {
      headers: { 'Accept': 'text/html,application/json' }
    }, 15000);

    if (status === 403 || status === 429) {
      logSource('fl_sunbiz', 'unavailable',
        `Blocked (HTTP ${status}) — public records CSV request pending with DOS_Sunbiz@dos.myflorida.com`,
        24
      );
      return [];
    }
    if (status !== 200) {
      logSource('fl_sunbiz', 'unavailable', `HTTP ${status} — skipping zip`, 6);
      return [];
    }

    // Sunbiz returns HTML — extract business names (basic parse)
    const html = typeof body === 'string' ? body : '';
    const nameMatches = html.match(/href="\/Inquiry\/CorporationSearch\/SearchResultDetail[^"]*">([^<]+)</g) || [];
    const names = nameMatches.map(m => m.replace(/.*>/, '').trim()).filter(Boolean);

    if (names.length > 0) {
      logSource('fl_sunbiz', 'ok', `${names.length} entities found (name-only, no coords yet)`);
    } else {
      logSource('fl_sunbiz', 'unavailable', 'No results or parse failed — skipping', 12);
    }
    // Names only — not enough for map placement without address. Return empty for now.
    // These will be matched when bulk CSV arrives from public records request.
    return [];
  } catch (err) {
    logSource('fl_sunbiz', 'error', `${err.message} — skipping`, 4);
    return [];
  }
}

// ── Source 4: Nominatim address enrichment ────────────────────────────────────

async function enrichAddresses(businesses) {
  const needsAddr = businesses.filter(b => !b.address).slice(0, 15); // max 15/run
  for (const b of needsAddr) {
    try {
      await sleep(1100); // Nominatim 1 req/sec hard limit
      const url = `https://nominatim.openstreetmap.org/reverse?lat=${b.lat}&lon=${b.lon}&format=json`;
      const { status, body } = await fetchJson(url, {
        headers: { 'User-Agent': 'LocalIntel-ZipAgent/1.0' }
      }, 10000);
      if (status === 200 && body && body.address) {
        const a = body.address;
        b.address = [a.house_number, a.road].filter(Boolean).join(' ') || null;
        b.city = a.city || a.town || a.village || NAME;
      }
    } catch (err) {
      // Non-fatal — address stays null
    }
  }
  if (needsAddr.length > 0) logSource('nominatim', 'ok', `Enriched addresses for ${needsAddr.length} records`);
  return businesses;
}

// ── Dedup + merge ─────────────────────────────────────────────────────────────

function normalize(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function mergeBusinesses(existing, incoming) {
  const idx = {};
  existing.forEach(b => { idx[normalize(b.name)] = b; });
  let added = 0, upgraded = 0;
  incoming.forEach(b => {
    const key = normalize(b.name);
    if (idx[key]) {
      const ex = idx[key];
      ['phone','website','hours','address','osm_id'].forEach(f => {
        if (!ex[f] && b[f]) { ex[f] = b[f]; upgraded++; }
      });
      if (b.source === 'osm' && ex.confidence < 80) { ex.confidence = Math.max(ex.confidence, 75); upgraded++; }
      ex.last_updated = new Date().toISOString();
    } else {
      idx[key] = b;
      added++;
    }
  });
  log(`Merge: +${added} new, ${upgraded} fields upgraded`);
  return Object.values(idx);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  log(`Starting — ${NAME} (${LAT}, ${LON}) region=${REGION}`);
  if (!fs.existsSync(ZIPS_DIR)) fs.mkdirSync(ZIPS_DIR, { recursive: true });

  let existing = [];
  if (fs.existsSync(ZIP_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(ZIP_FILE)); }
    catch (e) { existing = []; }
  }
  log(`Existing: ${existing.length} businesses`);

  // Run all sources — each is non-blocking, logs and continues on failure
  const [osmResults] = await Promise.all([fetchOSM()]);

  // SJC and Sunbiz run sequentially to avoid hammering
  await fetchSJCArcGIS();
  await sleep(500);
  await fetchSunbiz();

  // Address enrichment
  const enriched = await enrichAddresses(osmResults);

  // Merge and write
  const final = mergeBusinesses(existing, enriched);
  log(`Final: ${final.length} businesses`);
  fs.writeFileSync(ZIP_FILE, JSON.stringify(final, null, 2));
  log(`Written → data/zips/${ZIP}.json`);

  // Update coverage
  const covFile = path.join(DATA_DIR, 'zipCoverage.json');
  let cov = {};
  if (fs.existsSync(covFile)) { try { cov = JSON.parse(fs.readFileSync(covFile)); } catch(e) {} }
  if (!cov.completed) cov.completed = {};
  cov.completed[ZIP] = { name: NAME, region: REGION, businesses: final.length, completedAt: new Date().toISOString() };
  fs.writeFileSync(covFile, JSON.stringify(cov, null, 2));

  process.exit(0);
}

run().catch(err => {
  console.error(`[ZipAgent ${ZIP}] Fatal:`, err.message);
  logSource('agent', 'error', err.message);
  process.exit(1);
});
