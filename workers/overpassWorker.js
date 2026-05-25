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

// ── worker_events logger ──────────────────────────────────────────────────────
async function logWorkerEvent({ eventType, recordsIn, recordsOut, durationMs, error }) {
  if (!process.env.LOCAL_INTEL_DB_URL) return;
  try {
    await db.query(
      `INSERT INTO worker_events (worker_name, event_type, records_in, records_out, duration_ms, error_message, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      ['osm_overpass', eventType, recordsIn || 0, recordsOut || 0, durationMs || 0, error || null]
    );
  } catch (e) { console.warn('[overpass] worker_events log failed:', e.message); }
}

// Mirror raw OSM POIs to Postgres zip_enrichment
async function saveOsmEnrichment(zip, pois) {
  if (!process.env.LOCAL_INTEL_DB_URL || !Array.isArray(pois)) return;
  const { upsertOsmEnrichment, upsertZipSignals } = require('../lib/pgStore');
  await upsertOsmEnrichment(zip, {
    osm_pois:       pois,
    osm_updated_at: new Date().toISOString(),
    poi_count:      pois.length,
  });

  // World model — aggregate OSM signals into zip_signals
  const total      = pois.length || 0;
  const withPhone  = pois.filter(p => p.phone).length;
  const withWeb    = pois.filter(p => p.website).length;
  const withHours  = pois.filter(p => p.hours).length;
  const food       = pois.filter(p => ['amenity','cuisine'].includes(p.category) ||
    ['restaurant','cafe','fast_food','bar','pub','food_court'].includes(p.subtype)).length;
  const retail     = pois.filter(p => p.category === 'shop').length;
  const worship    = pois.filter(p => p.subtype === 'place_of_worship' ||
    p.category === 'place_of_worship').length;
  const education  = pois.filter(p => ['school','college','university','kindergarten'].includes(p.subtype)).length;
  const healthcare = pois.filter(p => ['hospital','clinic','dentist','pharmacy','doctors'].includes(p.subtype)).length;
  await upsertZipSignals(zip, {
    osm_biz_count:        total || null,
    osm_with_phone_pct:   total > 0 ? Math.round((withPhone / total) * 1000) / 10 : null,
    osm_with_website_pct: total > 0 ? Math.round((withWeb   / total) * 1000) / 10 : null,
    osm_with_hours_pct:   total > 0 ? Math.round((withHours / total) * 1000) / 10 : null,
    osm_food_count:       food     || null,
    osm_retail_count:     retail   || null,
    osm_worship_count:    worship  || null,
    osm_education_count:  education  || null,
    osm_healthcare_count: healthcare || null,
    osm_updated_at:       new Date(),
  });
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
        tags:             poi.tags || [],
        cuisine:          poi.cuisine || null,
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
const OSM_FRESH_DAYS = 90; // re-fetch OSM POIs every 90 days
async function getFreshZipSetFromBusinesses() {
  if (!process.env.LOCAL_INTEL_DB_URL) return new Set();
  try {
    // Fresh = osm_updated_at exists and is < 90 days old
    const rows = await db.query(
      `SELECT zip FROM zip_signals
        WHERE osm_updated_at IS NOT NULL
          AND osm_updated_at > NOW() - INTERVAL '${OSM_FRESH_DAYS} days'
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

// B62: count amenity=fast_food nodes for QSR competitor density signal.
function buildFastFoodQuery(bbox) {
  const { minLat, maxLat, minLon, maxLon } = bbox;
  const bb = `${minLat},${minLon},${maxLat},${maxLon}`;
  return `[out:json][timeout:25];\nnode["amenity"="fast_food"](${bb});\nout count;`;
}

// B62: pull dominant highway tag in ZIP bbox for site accessibility scoring.
function buildRoadClassQuery(bbox) {
  const { minLat, maxLat, minLon, maxLon } = bbox;
  const bb = `${minLat},${minLon},${maxLat},${maxLon}`;
  return `[out:json][timeout:25];\nway["highway"~"^(trunk|primary|secondary|tertiary|residential)$"](${bb});\nout tags;`;
}

// B63 psychographic queries — each returns `out count;` so we read elements[0].tags.total
function buildGolfQuery(bbox) {
  const { minLat, maxLat, minLon, maxLon } = bbox;
  const bb = `${minLat},${minLon},${maxLat},${maxLon}`;
  return `[out:json][timeout:25];\n(\n  node["leisure"="golf_course"](${bb});\n  way["leisure"="golf_course"](${bb});\n  relation["leisure"="golf_course"](${bb});\n);\nout count;`;
}

function buildArtsQuery(bbox) {
  const { minLat, maxLat, minLon, maxLon } = bbox;
  const bb = `${minLat},${minLon},${maxLat},${maxLon}`;
  return `[out:json][timeout:25];\n(\n  node["amenity"~"^(theatre|cinema|arts_centre)$"](${bb});\n  way["amenity"~"^(theatre|cinema|arts_centre)$"](${bb});\n  node["tourism"~"^(museum|gallery|artwork)$"](${bb});\n  way["tourism"~"^(museum|gallery|artwork)$"](${bb});\n);\nout count;`;
}

function buildWorshipQuery(bbox) {
  const { minLat, maxLat, minLon, maxLon } = bbox;
  const bb = `${minLat},${minLon},${maxLat},${maxLon}`;
  return `[out:json][timeout:25];\n(\n  node["amenity"="place_of_worship"](${bb});\n  way["amenity"="place_of_worship"](${bb});\n);\nout count;`;
}

function buildFitnessQuery(bbox) {
  const { minLat, maxLat, minLon, maxLon } = bbox;
  const bb = `${minLat},${minLon},${maxLat},${maxLon}`;
  return `[out:json][timeout:25];\n(\n  node["leisure"~"^(fitness_centre|sports_centre|swimming_pool)$"](${bb});\n  way["leisure"~"^(fitness_centre|sports_centre|swimming_pool)$"](${bb});\n  node["sport"~"^(yoga|tennis|fitness)$"](${bb});\n);\nout count;`;
}

function extractCount(res) {
  const el = Array.isArray(res?.elements) && res.elements[0];
  if (!el) return 0;
  const c = Number(el.tags?.total ?? el.count ?? 0);
  return isNaN(c) ? 0 : c;
}

const ROAD_CLASS_TIER = { trunk: 5, primary: 4, secondary: 3, tertiary: 2, residential: 1 };
const ROAD_CLASS_BASE = { trunk: 95, primary: 80, secondary: 60, tertiary: 40, residential: 20 };

function deriveRoadClassMetrics(elements) {
  const ways = (elements || []).filter(el => el.tags && el.tags.highway);
  if (!ways.length) return { road_class: null, access_score: 10 };

  const counts = {};
  let onewayHit = false;
  let multiLaneHit = false;
  for (const w of ways) {
    const cls = w.tags.highway;
    if (ROAD_CLASS_TIER[cls]) counts[cls] = (counts[cls] || 0) + 1;
    if (w.tags.oneway === 'yes') onewayHit = true;
    const lanes = parseInt(w.tags.lanes, 10);
    if (!isNaN(lanes) && lanes >= 4) multiLaneHit = true;
  }
  const present = Object.keys(counts);
  if (!present.length) return { road_class: null, access_score: 10 };

  // Pick highest tier present (not just most common)
  const dominant = present.sort((a, b) => ROAD_CLASS_TIER[b] - ROAD_CLASS_TIER[a])[0];
  let score = ROAD_CLASS_BASE[dominant] || 10;
  if (onewayHit) score -= 10;
  if (multiLaneHit) score += 10;
  score = Math.max(0, Math.min(100, score));
  return { road_class: dominant, access_score: score };
}

async function fetchSiteAccessSignals(zip, bbox) {
  let osm_fast_food_count = null;
  let osm_road_class = null;
  let osm_access_score = null;
  let osm_golf_count = null;
  let osm_arts_count = null;
  let osm_worship_count = null;
  let osm_fitness_count = null;
  try {
    const ffRes = await overpassPost(buildFastFoodQuery(bbox));
    osm_fast_food_count = extractCount(ffRes);
  } catch (e) {
    console.warn(`[overpass] ${zip} fast_food count failed: ${e.message}`);
  }
  // Stay inside Overpass rate budget — small delay between sub-queries.
  await sleep(RATE_MS);
  try {
    const rcRes = await overpassPost(buildRoadClassQuery(bbox));
    const m = deriveRoadClassMetrics(rcRes.elements);
    osm_road_class = m.road_class;
    osm_access_score = m.access_score;
  } catch (e) {
    console.warn(`[overpass] ${zip} road_class fetch failed: ${e.message}`);
  }
  await sleep(RATE_MS);
  try {
    osm_golf_count = extractCount(await overpassPost(buildGolfQuery(bbox)));
  } catch (e) {
    console.warn(`[overpass] ${zip} golf count failed: ${e.message}`);
  }
  await sleep(RATE_MS);
  try {
    osm_arts_count = extractCount(await overpassPost(buildArtsQuery(bbox)));
  } catch (e) {
    console.warn(`[overpass] ${zip} arts count failed: ${e.message}`);
  }
  await sleep(RATE_MS);
  try {
    osm_worship_count = extractCount(await overpassPost(buildWorshipQuery(bbox)));
  } catch (e) {
    console.warn(`[overpass] ${zip} worship count failed: ${e.message}`);
  }
  await sleep(RATE_MS);
  try {
    osm_fitness_count = extractCount(await overpassPost(buildFitnessQuery(bbox)));
  } catch (e) {
    console.warn(`[overpass] ${zip} fitness count failed: ${e.message}`);
  }
  return {
    osm_fast_food_count, osm_road_class, osm_access_score,
    osm_golf_count, osm_arts_count, osm_worship_count, osm_fitness_count,
  };
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
      const t = el.tags;
      const lat  = el.lat  ?? el.center?.lat ?? null;
      const lon  = el.lon  ?? el.center?.lon ?? null;
      const cat  = MAX_POI_TAGS.find(k => t[k]) || 'other';

      // Extract cuisine
      const cuisine = t.cuisine || null;

      // Extract dietary/service tags into array
      const tags = [];
      if (t.cuisine) tags.push(...t.cuisine.split(';').map(c => c.trim().toLowerCase()).filter(Boolean));
      if (t['diet:vegan'] === 'yes' || t['diet:vegan'] === 'only') tags.push('vegan');
      if (t['diet:vegetarian'] === 'yes' || t['diet:vegetarian'] === 'only') tags.push('vegetarian');
      if (t['diet:gluten_free'] === 'yes' || t['diet:gluten_free'] === 'only') tags.push('gluten_free');
      if (t['diet:halal'] === 'yes') tags.push('halal');
      if (t['diet:kosher'] === 'yes') tags.push('kosher');
      if (t['diet:organic'] === 'yes') tags.push('organic');
      if (t.organic === 'yes') tags.push('organic');
      if (t.takeaway === 'yes' || t.takeaway === 'only') tags.push('takeout');
      if (t.delivery === 'yes') tags.push('delivery');
      if (t.outdoor_seating === 'yes') tags.push('outdoor_seating');
      if (t.wheelchair === 'yes') tags.push('wheelchair_accessible');
      if (t.stars) tags.push(`stars_${t.stars}`);

      return {
        id      : el.id,
        type    : el.type,
        name    : t.name || t['name:en'] || null,
        category: cat,
        subtype : t[cat] || null,
        lat, lon,
        addr    : {
          street : t['addr:street']   || null,
          city   : t['addr:city']     || null,
          postcode: t['addr:postcode'] || null,
        },
        phone   : t.phone || t['contact:phone'] || null,
        website : t.website || t['contact:website'] || null,
        hours   : t.opening_hours || null,
        cuisine,
        tags,
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

  // B62: fetch fast_food competitor count + dominant road class for site scoring.
  // Sequential after main fetch so we respect Overpass rate budget.
  await sleep(RATE_MS);
  const siteSig = await fetchSiteAccessSignals(zip, bbox);
  if (process.env.LOCAL_INTEL_DB_URL) {
    const { upsertZipSignals } = require('../lib/pgStore');
    await upsertZipSignals(zip, {
      osm_fast_food_count: siteSig.osm_fast_food_count,
      osm_road_class:      siteSig.osm_road_class,
      osm_access_score:    siteSig.osm_access_score,
      osm_golf_count:      siteSig.osm_golf_count,
      osm_arts_count:      siteSig.osm_arts_count,
      osm_worship_count:   siteSig.osm_worship_count,
      osm_fitness_count:   siteSig.osm_fitness_count,
      osm_updated_at:      new Date(),
    });
  }

  console.log(`[overpass] ${zip} → ${pois.length} named POIs, fast_food=${siteSig.osm_fast_food_count}, road=${siteSig.osm_road_class}, access=${siteSig.osm_access_score}, golf=${siteSig.osm_golf_count}, arts=${siteSig.osm_arts_count}, worship=${siteSig.osm_worship_count}, fitness=${siteSig.osm_fitness_count}`);
  return { zip, count: pois.length };
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function runPass() {
  const t0 = Date.now();
  const zips = getZipsByPriority();  // sorted by population desc
  // Step 1 of the contract: ASK Postgres what's already done before we start.
  const freshZipSet = FULL_REFRESH ? new Set() : await getFreshZipSetFromBusinesses();
  console.log(
    `[overpass] Starting pass — ${zips.length} FL ZIPs ` +
    `(skip set: ${freshZipSet.size}, FULL_REFRESH=${FULL_REFRESH})`
  );
  let done = 0, skipped = 0, errors = 0;

  await logWorkerEvent({ eventType: 'start', recordsIn: zips.length });

  for (const entry of zips) {
    const result = await processZip(entry.zip, freshZipSet);
    if (result.skipped) { skipped++; }
    else if (result.error) { errors++; }
    else { done++; }
    await sleep(RATE_MS);
  }

  const durationMs = Date.now() - t0;
  console.log(`[overpass] Pass complete — pulled:${done} skipped:${skipped} errors:${errors}`);
  await logWorkerEvent({ eventType: 'complete', recordsIn: zips.length, recordsOut: done, durationMs });

  // Trigger deduplication after every ingestion pass
  try {
    const merge = require('./businessMergeWorker');
    await merge.triggerMerge();
  } catch (e) {
    console.warn('[overpass] businessMergeWorker trigger failed:', e.message);
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
