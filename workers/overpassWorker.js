'use strict';
/**
 * overpassWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Bulk OSM POI ingestion for all 983 FL ZIPs via Overpass API.
 *
 * Strategy:
 *  - Pulls amenity/shop/office/tourism/leisure nodes + ways per ZIP bounding box
 *  - Rate-limited: 1 req / 2 s (Overpass public policy)
 *  - Priority queue: high-population ZIPs first
 *  - Resume-safe: checks zip_enrichment Postgres freshness first
 *  - Writes POIs to zip_enrichment (raw cache) AND promotes to businesses table
 *  - Runs in a daemon loop: full pass → sleep 24 h → repeat
 *
 * Output per ZIP: zip_enrichment (Postgres cache) + businesses (promoted)
 */

const https = require('https');

const { getZipsByPriority, getZipBbox } = require('./flZipRegistry');
const db = require('../lib/db');

// category/group mapper (mirrors zipAgent)
const PG_GROUP_MAP = {
  restaurant:'food', fast_food:'food', cafe:'food', bar:'food', pub:'food',
  doctor:'health', dentist:'health', clinic:'health', hospital:'health', pharmacy:'health',
  leisure:'retail', gym:'retail', fitness:'retail',
  bank:'finance', insurance:'finance', financial:'finance',
  legal:'legal', attorney:'legal',
  retail:'retail', shop:'retail',
  school:'civic', church:'civic', government:'civic', library:'civic',
};
function pgGroup(cat) {
  if (!cat) return 'services';
  return PG_GROUP_MAP[cat.toLowerCase().replace(/[^a-z_]/g,'_')] || 'services';
}
function resolveCategory(poi) {
  const sub = poi.subtype || '';
  const cat = poi.category || 'other';
  if (cat === 'amenity' || cat === 'shop') return sub || cat;
  if (cat === 'healthcare') return 'clinic';
  if (cat === 'leisure') return sub === 'fitness_centre' ? 'gym' : (sub || 'leisure');
  if (cat === 'tourism') return (sub === 'hotel' || sub === 'motel') ? 'hotel' : (sub || 'tourism');
  return sub || cat;
}

// ── Config ────────────────────────────────────────────────────────────────────
const OVERPASS_URL  = 'https://overpass-api.de/api/interpreter';
const RATE_MS       = 2200;          // 1 req / 2.2 s — stay under public limit
const BBOX_DEG      = 0.07;          // ~7.7 km half-width; tighter = fewer noise POIs
const LOOP_SLEEP_H  = 24;
const MAX_POI_TAGS  = ['amenity', 'shop', 'office', 'tourism', 'leisure',
                        'healthcare', 'craft', 'club', 'sport'];

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Mirror raw OSM POIs to Postgres zip_enrichment (non-blocking)
function saveOsmEnrichment(zip, pois) {
  if (!process.env.LOCAL_INTEL_DB_URL || !Array.isArray(pois)) return;
  const { upsertOsmEnrichment } = require('../lib/pgStore');
  return upsertOsmEnrichment(zip, {
    osm_pois:       pois,
    osm_updated_at: new Date().toISOString(),
    poi_count:      pois.length,
  }).catch(e => console.warn('[overpass] Postgres zip_enrichment write failed:', e.message));
}

/**
 * promoteOsmToBusinesses — upserts all named POIs from a freshly-fetched set
 * into the businesses table. Called immediately after saveZipFile so every
 * Overpass run lands in Postgres without waiting for enrichmentAgent.
 */
async function promoteOsmToBusinesses(zip, pois) {
  if (!process.env.LOCAL_INTEL_DB_URL) return;
  const named = pois.filter(p => p.name);
  if (!named.length) return;
  let written = 0, failed = 0;
  for (const poi of named) {
    try {
      const category = resolveCategory(poi);
      const addr = poi.addr || {};
      const address = [addr.street, addr.city].filter(Boolean).join(', ') || null;
      await db.upsertBusiness({
        name:             poi.name,
        zip:              (addr.postcode || zip).toString().slice(0,5),
        address,
        city:             addr.city || null,
        phone:            poi.phone || null,
        website:          poi.website || null,
        hours:            poi.hours || null,
        category,
        category_group:   pgGroup(category),
        status:           'active',
        lat:              poi.lat || null,
        lon:              poi.lon || null,
        confidence_score: 0.70,
        tags:             [],
        description:      null,
        source_id:        'osm',
        source_weight:    0.3,
        source_raw:       null,
      });
      written++;
    } catch (e) {
      failed++;
      if (failed === 1) console.warn(`[overpass] promote error (${zip}):`, e.message);
    }
  }
  console.log(`[overpass] ${zip}: promoted ${written}/${named.length} POIs to businesses (${failed} failed)`);
}

// Check Postgres for freshness before re-fetching from Overpass.
// Returns the set of ZIPs already covered by recent overpass data so the
// hot loop can skip them up-front (the contract: ASK Postgres first).
async function getFreshZipSetFromBusinesses() {
  if (!process.env.LOCAL_INTEL_DB_URL) return new Set();
  try {
    // Any ZIP that already has an overpass-sourced active business is "covered".
    const rows = await db.query(
      `SELECT DISTINCT zip FROM businesses
        WHERE 'osm' = ANY(sources)
          AND status != 'inactive'
          AND zip IS NOT NULL`
    );
    return new Set(rows.map(r => r.zip));
  } catch (e) {
    console.warn('[overpass] fresh-zip lookup failed:', e.message);
    return new Set();
  }
}

async function alreadyFreshPg(zip) {
  if (!process.env.LOCAL_INTEL_DB_URL) return false;
  try {
    const { getZipEnrichment } = require('../lib/pgStore');
    const row = await getZipEnrichment(zip);
    if (!row?.osm_json?.osm_pois?.length) return false;
    const age = Date.now() - new Date(row.osm_updated_at || 0).getTime();
    return age < 20 * 60 * 60 * 1000;
  } catch { return false; }
}

// ── Overpass query builder ────────────────────────────────────────────────────
function buildQuery(bbox) {
  const { minLat, maxLat, minLon, maxLon } = bbox;
  const bb = `${minLat},${minLon},${maxLat},${maxLon}`;
  const tagUnion = MAX_POI_TAGS.map(t =>
    `node["${t}"](${bb});\nway["${t}"](${bb});`
  ).join('\n');
  return `[out:json][timeout:30];\n(\n${tagUnion}\n);\nout center 400;`;
}

// ── HTTP POST to Overpass ─────────────────────────────────────────────────────
function overpassPost(query) {
  return new Promise((resolve, reject) => {
    const body = `data=${encodeURIComponent(query)}`;
    const opts = {
      method : 'POST',
      headers: {
        'Content-Type'  : 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent'    : 'LocalIntel/1.0 (gsb-swarm; contact=erik@mcflamingo.com)',
      },
    };
    const req = https.request(OVERPASS_URL, opts, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Overpass HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`Overpass JSON parse fail: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(35000, () => { req.destroy(new Error('Overpass timeout')); });
    req.write(body);
    req.end();
  });
}

// ── POI normaliser ────────────────────────────────────────────────────────────
function normalisePois(elements) {
  return elements
    .filter(el => el.tags && Object.keys(el.tags).length > 0)
    .map(el => {
      const tags = el.tags;
      const lat  = el.lat  ?? el.center?.lat ?? null;
      const lon  = el.lon  ?? el.center?.lon ?? null;
      const cat  = MAX_POI_TAGS.find(t => tags[t]) || 'other';
      return {
        id      : el.id,
        type    : el.type,
        name    : tags.name || tags['name:en'] || null,
        category: cat,
        subtype : tags[cat] || null,
        lat, lon,
        addr    : {
          street : tags['addr:street']   || null,
          city   : tags['addr:city']     || null,
          postcode: tags['addr:postcode'] || null,
        },
        phone   : tags.phone || tags['contact:phone'] || null,
        website : tags.website || tags['contact:website'] || null,
        hours   : tags.opening_hours || null,
      };
    })
    .filter(p => p.name); // only named POIs
}

// ── Process one ZIP ───────────────────────────────────────────────────────────
const FULL_REFRESH = process.env.FULL_REFRESH === 'true';

async function processZip(zip, freshZipSet) {
  if (!FULL_REFRESH && (freshZipSet?.has(zip) || await alreadyFreshPg(zip))) {
    return { zip, skipped: true };
  }

  const bbox = await getZipBbox(zip, BBOX_DEG);
  if (!bbox) {
    console.warn(`[overpass] No bbox for ${zip} — skipping`);
    return { zip, skipped: true, reason: 'no_bbox' };
  }

  const query = buildQuery(bbox);
  let result;
  try {
    result = await overpassPost(query);
  } catch (err) {
    console.error(`[overpass] ${zip} fetch error: ${err.message}`);
    return { zip, error: err.message };
  }

  const pois = normalisePois(result.elements || []);

  // Cache raw POIs to Postgres zip_enrichment (replaces data/osm/{zip}.json).
  await saveOsmEnrichment(zip, pois);

  // Promote POIs to businesses table — this is the key Postgres-first change
  await promoteOsmToBusinesses(zip, pois);

  console.log(`[overpass] ${zip} → ${pois.length} named POIs`);
  return { zip, count: pois.length };
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function runPass() {
  const zips = getZipsByPriority();  // sorted by population desc
  // Step 1 of the contract: ASK Postgres what's already done before we start.
  const freshZipSet = FULL_REFRESH ? new Set() : await getFreshZipSetFromBusinesses();
  console.log(
    `[overpass] Starting pass — ${zips.length} FL ZIPs ` +
    `(skip set: ${freshZipSet.size}, FULL_REFRESH=${FULL_REFRESH})`
  );
  let done = 0, skipped = 0, errors = 0;

  for (const entry of zips) {
    const result = await processZip(entry.zip, freshZipSet);
    if (result.skipped) { skipped++; }
    else if (result.error) { errors++; }
    else { done++; }
    await sleep(RATE_MS);
  }

  console.log(`[overpass] Pass complete — pulled:${done} skipped:${skipped} errors:${errors}`);

  // Trigger deduplication merge after every ingestion pass
  try {
    const merge = require('./businessMergeWorker');
    await merge.triggerMerge();
  } catch (e) {
    console.error('[overpass] post-pass merge trigger failed:', e.message);
  }
}

(async function main() {
  console.log('[overpass] Worker started');
  while (true) {
    try { await runPass(); }
    catch (err) { console.error('[overpass] Pass crashed:', err.message); }
    console.log(`[overpass] Sleeping ${LOOP_SLEEP_H}h until next pass`);
    await sleep(LOOP_SLEEP_H * 60 * 60 * 1000);
  }
})();
