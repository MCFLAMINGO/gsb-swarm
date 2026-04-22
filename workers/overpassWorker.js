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
 *  - Resume-safe: skips ZIPs whose data/zips/{zip}.json already has osm_pois[]
 *  - Merges POIs into existing zip JSON; does NOT overwrite other fields
 *  - Runs in a daemon loop: full pass → sleep 24 h → repeat
 *
 * Output per ZIP:  data/zips/{zip}.json  ← { ...existing, osm_pois: [...], osm_updated_at }
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const { getZipsByPriority, getZipBbox } = require('./flZipRegistry');

// ── Config ────────────────────────────────────────────────────────────────────
const DATA_DIR      = path.join(__dirname, '..', 'data', 'osm');
const OVERPASS_URL  = 'https://overpass-api.de/api/interpreter';
const RATE_MS       = 2200;          // 1 req / 2.2 s — stay under public limit
const BBOX_DEG      = 0.07;          // ~7.7 km half-width; tighter = fewer noise POIs
const LOOP_SLEEP_H  = 24;
const MAX_POI_TAGS  = ['amenity', 'shop', 'office', 'tourism', 'leisure',
                        'healthcare', 'craft', 'club', 'sport'];

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function loadZipFile(zip) {
  const fp = path.join(DATA_DIR, `${zip}.json`);
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return {}; }
}

function saveZipFile(zip, data) {
  ensureDir(DATA_DIR);
  fs.writeFileSync(path.join(DATA_DIR, `${zip}.json`), JSON.stringify(data));
}

function alreadyFresh(zip) {
  const d = loadZipFile(zip);
  if (!Array.isArray(d.osm_pois) || d.osm_pois.length === 0) return false;
  const age = Date.now() - new Date(d.osm_updated_at || 0).getTime();
  return age < 20 * 60 * 60 * 1000; // re-pull if > 20 h old
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
async function processZip(zip) {
  if (alreadyFresh(zip)) {
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
  const existing = loadZipFile(zip);
  saveZipFile(zip, {
    ...existing,
    zip,
    osm_pois      : pois,
    osm_poi_count : pois.length,
    osm_updated_at: new Date().toISOString(),
  });

  console.log(`[overpass] ${zip} → ${pois.length} named POIs`);
  return { zip, count: pois.length };
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function runPass() {
  const zips = getZipsByPriority();  // sorted by population desc
  console.log(`[overpass] Starting pass — ${zips.length} FL ZIPs`);
  let done = 0, skipped = 0, errors = 0;

  for (const entry of zips) {
    const result = await processZip(entry.zip);
    if (result.skipped) { skipped++; }
    else if (result.error) { errors++; }
    else { done++; }
    await sleep(RATE_MS);
  }

  console.log(`[overpass] Pass complete — pulled:${done} skipped:${skipped} errors:${errors}`);
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
