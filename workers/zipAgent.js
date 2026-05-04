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
 *   5. YellowPages — bulk business discovery by ZIP city (phone, website, address)
 *   6. SJC Chamber of Commerce — member directory bulk import (verified businesses)
 *   7. BBB — accredited business discovery (phone, address, category)
 *
 * Writes: businesses (Postgres) — direct per-source upserts
 * Logs:   data/sourceLog.json  (per-zip availability log, kept for diagnostics)
 * Exit 0 = success, Exit 1 = fatal error
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

// ── Bulk source imports (non-fatal if unavailable) ────────────────────────────
let bulkScrapeYellowPages, bulkImportChamber, bulkScrapeZipBBB, discoverAndImportChamber;
try { ({ bulkScrapeYellowPages } = require('./yellowPagesScraper')); } catch(e) { console.warn('[ZipAgent] YP scraper unavailable:', e.message); }
try { ({ bulkImport: bulkImportChamber } = require('./chamberScraper'));  } catch(e) { console.warn('[ZipAgent] Chamber scraper unavailable:', e.message); }
try { ({ bulkScrapeZip: bulkScrapeZipBBB } = require('./bbbScraper'));    } catch(e) { console.warn('[ZipAgent] BBB scraper unavailable:', e.message); }
try { ({ discoverAndImport: discoverAndImportChamber } = require('./chamberDiscovery')); } catch(e) { console.warn('[ZipAgent] Chamber discovery unavailable:', e.message); }

// ── Postgres dual-write (optional — non-fatal if DB unavailable) ──────────────
let _db = null;
function getDb() {
  if (!_db && process.env.LOCAL_INTEL_DB_URL) {
    try { _db = require('../lib/db'); } catch (_) {}
  }
  return _db;
}

// Category → group mapping (mirrors MCP layer)
const PG_GROUP_MAP = {
  restaurant:'food', fast_food:'food', cafe:'food', bar:'food', pub:'food',
  doctor:'health', dentist:'health', clinic:'health', hospital:'health', pharmacy:'health',
  chiropractor:'health', physical_therapy:'health', optometrist:'health',
  bank:'finance', insurance:'finance', finance:'finance', accounting:'finance', mortgage:'finance',
  legal:'legal', attorney:'legal',
  retail:'retail', boutique:'retail', salon:'retail', spa:'retail', gym:'retail', fitness:'retail',
  school:'civic', church:'civic', government:'civic', library:'civic',
};
function pgGroup(cat) {
  if (!cat) return 'services';
  return PG_GROUP_MAP[cat.toLowerCase().replace(/[^a-z_]/g,'_')] || 'services';
}

async function dualWritePostgres(businesses, zip, state) {
  const db = getDb();
  if (!db || !businesses || !businesses.length) return;
  let written = 0, failed = 0;
  for (const b of businesses) {
    try {
      await db.upsertBusiness({
        name:             b.name,
        zip:              b.zip || zip,
        address:          b.address   || null,
        city:             b.city      || null,
        phone:            b.phone     || null,
        website:          b.website   || null,
        hours:            b.hours     || null,
        category:         b.category  || null,
        category_group:   b.group     || pgGroup(b.category),
        status:           b.status    || 'active',
        lat:              b.lat       || null,
        lon:              b.lon       || null,
        confidence_score: (b.confidence || 50) / 100,
        tags:             b.tags      || [],
        description:      b.description || null,
        source_id:        b.source    || b.primary_source || 'zipagent',
        source_weight:    0.2,
        source_raw:       null,
      });
      written++;
    } catch (e) {
      failed++;
      if (failed === 1) console.warn(`[ZipAgent PG] first upsert error (${zip}):`, e.message);
    }
  }
  console.log(`[ZipAgent PG] ${zip}: wrote ${written} / ${businesses.length} to Postgres (${failed} failed)`);
}

// ZIP → YP city slug (for passing a focused city to YP bulk scrape)
const ZIP_TO_YP_CITY = {
  // SJC
  '32081': 'nocatee-fl',
  '32082': 'ponte-vedra-beach-fl',
  '32092': 'saint-augustine-fl',
  '32095': 'saint-augustine-fl',
  '32084': 'saint-augustine-fl',
  '32086': 'saint-augustine-fl',
  '32065': 'orange-park-fl',
  '32073': 'orange-park-fl',
  '32003': 'fleming-island-fl',
  '32068': 'middleburg-fl',
  '32259': 'fruit-cove-fl',
  '32080': 'saint-augustine-beach-fl',
  '32033': 'elkton-fl',
  '32004': 'saint-augustine-fl',
  // Jacksonville metro
  '32207': 'jacksonville-fl',
  '32205': 'jacksonville-fl',
  '32246': 'jacksonville-fl',
  '32223': 'jacksonville-fl',
  '32244': 'jacksonville-fl',
  '32210': 'jacksonville-fl',
  '32218': 'jacksonville-fl',
  '32256': 'jacksonville-fl',
  '32257': 'jacksonville-fl',
  '32258': 'jacksonville-fl',
  '32225': 'jacksonville-fl',
  // Tampa metro
  '33629': 'tampa-fl',
  '33618': 'tampa-fl',
  '33647': 'tampa-fl',
  '33626': 'tampa-fl',
  '34202': 'bradenton-fl',
  // Orlando metro
  '32828': 'orlando-fl',
  '32836': 'orlando-fl',
  '34786': 'windermere-fl',
  '32771': 'sanford-fl',
  '34711': 'clermont-fl',
  // South Florida
  '33458': 'jupiter-fl',
  '33496': 'boca-raton-fl',
  '33433': 'boca-raton-fl',
  '33076': 'parkland-fl',
  '33326': 'weston-fl',
  // Alabama Gulf Coast
  '36695': 'mobile-al',
  '36608': 'mobile-al',
  '36609': 'mobile-al',
  '36526': 'daphne-al',
  '36532': 'fairhope-al',
  '36542': 'gulf-shores-al',
  '36561': 'orange-beach-al',
  // Georgia — Savannah metro
  '31405': 'savannah-ga',
  '31406': 'savannah-ga',
  '31419': 'savannah-ga',
  '31407': 'port-wentworth-ga',
  '31322': 'pooler-ga',
  '31326': 'rincon-ga',
  // Georgia — Atlanta suburbs
  '30097': 'johns-creek-ga',
  '30022': 'alpharetta-ga',
  '30005': 'alpharetta-ga',
  '30024': 'suwanee-ga',
  '30068': 'marietta-ga',
  '30062': 'marietta-ga',
  '30009': 'alpharetta-ga',
  // Texas Gulf Coast — Houston metro
  '77494': 'katy-tx',
  '77479': 'sugar-land-tx',
  '77459': 'missouri-city-tx',
  '77584': 'pearland-tx',
  '77450': 'katy-tx',
  '77382': 'the-woodlands-tx',
  '77380': 'spring-tx',
  '77573': 'league-city-tx',
  // Texas Gulf Coast — Corpus Christi
  '78412': 'corpus-christi-tx',
  '78413': 'corpus-christi-tx',
  '78418': 'corpus-christi-tx',
};

// ZIP → city name (for chamber discovery)
const ZIP_TO_CITY = {
  '32081': 'Nocatee', '32082': 'Ponte Vedra Beach', '32084': 'Saint Augustine',
  '32086': 'Saint Augustine', '32092': 'Saint Augustine', '32095': 'Saint Johns',
  '32080': 'Saint Augustine Beach', '32033': 'Elkton', '32068': 'Middleburg',
  '32259': 'Fruit Cove', '32207': 'Jacksonville', '32205': 'Jacksonville',
  '32246': 'Jacksonville', '32223': 'Jacksonville', '32244': 'Jacksonville',
  '32210': 'Jacksonville', '32218': 'Jacksonville', '32256': 'Jacksonville',
  '32258': 'Jacksonville', '32225': 'Jacksonville',
  '33629': 'Tampa', '33618': 'Tampa', '33647': 'Tampa', '33626': 'Tampa',
  '34202': 'Bradenton',
  '32828': 'Orlando', '32836': 'Orlando', '34786': 'Windermere',
  '32771': 'Sanford', '34711': 'Clermont',
  '33458': 'Jupiter', '33496': 'Boca Raton', '33433': 'Boca Raton',
  '33076': 'Parkland', '33326': 'Weston',
  // Alabama Gulf Coast
  '36695': 'Mobile', '36608': 'Mobile', '36609': 'Mobile',
  '36526': 'Daphne', '36532': 'Fairhope',
  '36542': 'Gulf Shores', '36561': 'Orange Beach',
  // Georgia — Savannah
  '31405': 'Savannah', '31406': 'Savannah', '31419': 'Savannah',
  '31407': 'Port Wentworth', '31322': 'Pooler', '31326': 'Rincon',
  // Georgia — Atlanta suburbs
  '30097': 'Johns Creek', '30022': 'Alpharetta', '30005': 'Alpharetta',
  '30024': 'Suwanee', '30068': 'Marietta', '30062': 'Marietta', '30009': 'Alpharetta',
  // Texas Gulf Coast — Houston
  '77494': 'Katy', '77479': 'Sugar Land', '77459': 'Missouri City',
  '77584': 'Pearland', '77450': 'Katy', '77382': 'The Woodlands',
  '77380': 'Spring', '77573': 'League City',
  // Texas Gulf Coast — Corpus Christi
  '78412': 'Corpus Christi', '78413': 'Corpus Christi', '78418': 'Corpus Christi',
};

// ── Args ──────────────────────────────────────────────────────────────────────

const args = {};
process.argv.slice(2).forEach((v, i, arr) => {
  if (v.startsWith('--')) args[v.slice(2)] = arr[i + 1];
});

const ZIP    = args.zip;
const LAT    = parseFloat(args.lat);
const LON    = parseFloat(args.lon);
const REGION = args.region || 'FL';
const STATE  = args.state  || (REGION === 'FL' || REGION === 'SJC' || REGION === 'JAX' || REGION === 'TPA' || REGION === 'ORL' || REGION === 'SFL' ? 'FL' : (args.state || 'FL'));
const NAME   = args.name   || ZIP;

if (!ZIP || isNaN(LAT) || isNaN(LON)) {
  console.error('[ZipAgent] Missing required args: --zip --lat --lon');
  process.exit(1);
}

const DATA_DIR   = path.join(__dirname, '../data');
const pgStoreLib = require('../lib/pgStore');

// SJC zip codes — only these get ArcGIS Hub queries
const SJC_ZIPS = new Set(['32004','32033','32068','32080','32081','32082','32084','32086','32092','32095','32259']);

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[ZipAgent ${ZIP}] ${msg}`);
}

/**
 * Record a source availability result for this zip into Postgres source_log.
 * status: 'ok' | 'unavailable' | 'error' | 'pending'
 */
function logSource(source, status, detail, retryAfterHours = null) {
  const retryAfter = retryAfterHours
    ? new Date(Date.now() + retryAfterHours * 3600 * 1000).toISOString()
    : null;
  pgStoreLib.appendSourceLog({
    zip: ZIP,
    source_name: source,
    status,
    fetched_at: new Date().toISOString(),
    detail: { detail, retry_after: retryAfter },
  }).catch(() => {});
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
  // Alcohol & nightlife
  'shop=alcohol':      'liquor_store',
  'shop=wine':         'liquor_store',
  'shop=beer':         'liquor_store',
  'amenity=pub':       'bar',
  'amenity=nightclub': 'bar',
  'amenity=brewery':   'bar',
  // Food & drink additions
  'shop=bakery':       'bakery',
  'shop=deli':         'deli',
  'shop=coffee':       'cafe',
  'amenity=ice_cream': 'cafe',
  'amenity=food_court':'fast_food',
  // Grocery & convenience
  'shop=grocery':      'grocery',
  'shop=supermarket':  'grocery',
  'shop=convenience':  'convenience',
  'shop=kiosk':        'convenience',
  // Health & pharmacy
  'amenity=pharmacy':  'pharmacy',
  'healthcare=pharmacy':'pharmacy',
  'shop=chemist':      'pharmacy',
  'amenity=hospital':  'healthcare',
  'amenity=urgent_care':'healthcare',
  // Auto
  'shop=car_repair':   'car_repair',
  'amenity=car_wash':  'car_wash',
  'amenity=car_rental':'automotive',
  'shop=tyres':        'automotive',
  'shop=auto_parts':   'automotive',
  // Pet
  'shop=pet':          'pet',
  'shop=pet_food':     'pet',
  'amenity=animal_shelter':'pet',
  // Hardware & home
  'shop=doityourself': 'hardware',
  'shop=hardware':     'hardware',
  'shop=building_materials':'hardware',
  'shop=lumber':       'hardware',
  'shop=paint':        'hardware',
  // Beauty & wellness
  'shop=hairdresser':  'hairdresser',
  'shop=cosmetics':    'beauty',
  'shop=beauty':       'beauty',
  'shop=massage':      'wellness',
  'leisure=spa':       'wellness',
  // Laundry
  'shop=laundry':      'laundry',
  'amenity=laundry':   'laundry',
  'shop=dry_cleaning': 'laundry',
  // Florist
  'shop=florist':      'florist',
  // Finance
  'amenity=atm':       'bank',
  'amenity=bank':      'bank',
  'office=financial':  'financial',
  // Fitness
  'leisure=fitness_centre':'fitness',
  'leisure=sports_centre': 'fitness',
  'leisure=gym':       'fitness',
  // Childcare & education
  'amenity=childcare': 'childcare',
  'amenity=school':    'education',
  'amenity=college':   'education',
  // Lodging
  'tourism=hotel':     'hotel',
  'tourism=motel':     'hotel',
  'tourism=hostel':    'hotel',
  // Services
  'shop=locksmith':    'locksmith',
  'craft=electrician': 'electrician',
  'craft=plumber':     'plumber',
  'craft=hvac':        'hvac',
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
            city: tags['addr:city'] || NAME, state: STATE,
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

  // Run all sources — each is non-blocking, logs and continues on failure
  const [osmResults] = await Promise.all([fetchOSM()]);

  // SJC and Sunbiz run sequentially to avoid hammering
  await fetchSJCArcGIS();
  await sleep(500);
  await fetchSunbiz();

  // Address enrichment (in-memory only)
  const enriched = await enrichAddresses(osmResults);

  // Write OSM results directly to Postgres
  log(`OSM pass: ${enriched.length} businesses — writing to Postgres`);
  await dualWritePostgres(enriched, ZIP, STATE || 'FL');

  // ── Source 5: YellowPages bulk ────────────────────────────────────────
  // Runs per-city-slug so it only pulls businesses relevant to this ZIP
  if (bulkScrapeYellowPages) {
    const ypCity = ZIP_TO_YP_CITY[ZIP];
    if (ypCity) {
      log(`Source 5: YellowPages bulk — city: ${ypCity}`);
      try {
        const ypStats = await bulkScrapeYellowPages({ cities: [ypCity] });
        log(`Source 5 done — YP added:${ypStats.added} enriched:${ypStats.enriched}`);
        logSource('yellowpages', 'ok', `added:${ypStats.added} enriched:${ypStats.enriched}`);
      } catch(e) {
        log(`Source 5 failed (YP): ${e.message}`);
        logSource('yellowpages', 'error', e.message);
      }
    } else {
      log(`Source 5: YP — no city slug for ${ZIP}, skipping`);
    }
  }

  await sleep(1000);

  // ── Source 6: SJC Chamber of Commerce bulk ────────────────────────────
  // Only relevant for SJC ZIPs — chamber covers 841 verified member businesses
  if (bulkImportChamber && SJC_ZIPS.has(ZIP)) {
    log(`Source 6: SJC Chamber bulk import`);
    try {
      const chamberStats = await bulkImportChamber();
      log(`Source 6 done — Chamber added:${chamberStats?.added || 0} enriched:${chamberStats?.enriched || 0}`);
      logSource('sjc_chamber', 'ok', `added:${chamberStats?.added || 0}`);
    } catch(e) {
      log(`Source 6 failed (Chamber): ${e.message}`);
      logSource('sjc_chamber', 'error', e.message);
    }
  }

  await sleep(1000);

  // ── Source 8: Chamber Discovery (non-SJC ZIPs) ───────────────────────
  // Auto-discovers the local chamber of commerce URL for any city and
  // pulls members — GrowthZone/Chambermaster/generic HTML all supported.
  if (discoverAndImportChamber && !SJC_ZIPS.has(ZIP)) {
    const city = ZIP_TO_CITY[ZIP] || NAME;
    log(`Source 8: Chamber Discovery — ${city}`);
    try {
      const cdStats = await discoverAndImportChamber({ zip: ZIP, city, state: STATE, lat: LAT, lon: LON });
      log(`Source 8 done — added:${cdStats.added} enriched:${cdStats.enriched} (${cdStats.chamber || cdStats.reason || 'n/a'})`);
      logSource('chamber_discovery', cdStats.added + cdStats.enriched > 0 ? 'ok' : 'unavailable',
        cdStats.chamber ? `added:${cdStats.added} enriched:${cdStats.enriched} via ${cdStats.chamber}` : cdStats.reason || 'no data');
    } catch(e) {
      log(`Source 8 failed (ChamberDiscovery): ${e.message}`);
      logSource('chamber_discovery', 'error', e.message);
    }
  }

  await sleep(1000);

  // ── Source 7: BBB accredited business discovery ──────────────────────────
  // Pulls accredited businesses per ZIP — verified phone, address, category
  if (bulkScrapeZipBBB) {
    log(`Source 7: BBB bulk scrape — ${ZIP}`);
    try {
      const bbbStats = await bulkScrapeZipBBB(ZIP);
      log(`Source 7 done — BBB added:${bbbStats.added} enriched:${bbbStats.enriched}`);
      logSource('bbb', 'ok', `added:${bbbStats.added} enriched:${bbbStats.enriched}`);
    } catch(e) {
      log(`Source 7 failed (BBB): ${e.message}`);
      logSource('bbb', 'error', e.message);
    }
  }

  // Update zip_coverage in Postgres (replaces flat zipCoverage.json)
  try {
    const { markZipProcessed } = require('../lib/pgStore');
    await markZipProcessed(ZIP, 'zipagent', enriched.length);
  } catch (e) {
    log(`Warning: could not update zip_coverage: ${e.message}`);
  }

  log(`Done — Postgres updated for ${ZIP}`);
  process.exit(0);
}

run().catch(err => {
  console.error(`[ZipAgent ${ZIP}] Fatal:`, err.message);
  logSource('agent', 'error', err.message);
  process.exit(1);
});
