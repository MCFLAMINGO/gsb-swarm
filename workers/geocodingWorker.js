'use strict';
/**
 * geocodingWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Batch geocodes all businesses in Postgres where lat IS NULL and address
 * is meaningful. Uses the US Census Geocoder batch API — free, no key, no
 * rate limit, handles up to 10,000 records per request.
 *
 * Flow:
 *   1. Pull all businesses WHERE lat IS NULL AND address IS NOT NULL from Postgres
 *   2. Build CSV in Census batch format
 *   3. POST to Census API in chunks of 9,000 (their hard limit is 10k)
 *   4. Parse response, UPDATE businesses SET lat=, lon= WHERE business_id=
 *   5. Log match rates per ZIP
 *
 * Census Geocoder docs: https://geocoding.geo.census.gov/geocoder/
 *
 * Run:
 *   node workers/geocodingWorker.js              — geocodes all NULL-lat records
 *   node workers/geocodingWorker.js --zip 32082  — single ZIP only
 *   node workers/geocodingWorker.js --dry        — count only, no writes
 */

const path     = require('path');
const fs       = require('fs');
const FormData = require('form-data');
const fetch    = (...a) => import('node-fetch').then(m => m.default(...a));

const CENSUS_URL    = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const PHOTON_URL    = 'https://photon.komoot.io/api';
const OVERPASS_URL  = 'https://overpass-api.de/api/interpreter';
const BATCH_SIZE    = 9000; // Census hard limit is 10k — stay safely under
const CHUNK_WRITE   = 100;  // rows per UPDATE batch to avoid giant transactions
const NOMINATIM_DELAY_MS = 1100; // Nominatim ToS: max 1 req/sec

// Bounding boxes [south, west, north, east] for known NE Florida ZIPs
// For unknown ZIPs we derive a 0.15° buffer from the ZIP centroid
const ZIP_BBOX = {
  '32082': [30.10, -81.45, 30.27, -81.32], // Ponte Vedra Beach
  '32081': [30.06, -81.44, 30.18, -81.33], // Nocatee
  '32034': [30.55, -81.55, 30.72, -81.40], // Fernandina Beach
  '32250': [30.24, -81.44, 30.32, -81.36], // Jacksonville Beach
  '32256': [30.13, -81.52, 30.22, -81.44], // Jacksonville south
  '32259': [30.05, -81.59, 30.18, -81.48], // St Johns
  '32092': [29.97, -81.62, 30.10, -81.50], // St Augustine
};

/**
 * Pass 0 — Overpass bulk fetch for a ZIP
 * Downloads ALL named OSM nodes/ways within the ZIP bounding box in one call,
 * then does fuzzy name matching locally. Returns map of business_id → {lat,lon}.
 */
async function geocodeOverpass(bizList, zip) {
  // Get bounding box for this ZIP
  let bbox = ZIP_BBOX[zip];
  if (!bbox) {
    // Generic NE Florida fallback — better than nothing
    bbox = [29.80, -81.70, 30.80, -81.20];
    console.log(`[geocoder/overpass] No bbox for ZIP ${zip}, using NE Florida fallback`);
  }
  const [s, w, n, e] = bbox;

  // One bulk query — all named nodes + ways in bbox
  const query = `[out:json][timeout:30];
(
  node["name"](${s},${w},${n},${e});
  way["name"](${s},${w},${n},${e});
);
out center;`;

  console.log(`[geocoder/overpass] ZIP ${zip}: fetching all named OSM features in bbox...`);
  let osmFeatures = [];
  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      body: `data=${encodeURIComponent(query)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'LocalIntel-Geocoder/1.0' },
      timeout: 35000,
    });
    if (!res.ok) {
      console.warn(`[geocoder/overpass] HTTP ${res.status} — skipping Pass 0 for ${zip}`);
      return {};
    }
    const data = await res.json();
    osmFeatures = data.elements || [];
    console.log(`[geocoder/overpass] Got ${osmFeatures.length} OSM features for ZIP ${zip}`);
  } catch (e) {
    console.warn(`[geocoder/overpass] Fetch failed: ${e.message} — skipping Pass 0 for ${zip}`);
    return {};
  }

  // Build a lookup: normalised_name → {lat, lon}
  const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  const osmMap = {};
  for (const el of osmFeatures) {
    const name = el.tags?.name;
    if (!name) continue;
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!lat || !lon) continue;
    osmMap[normalize(name)] = { lat, lon };
  }

  // Match each business by normalised name
  const matched = {};
  for (const biz of bizList) {
    if (!biz.name) continue;
    const key = normalize(biz.name);
    // Exact match
    if (osmMap[key]) {
      matched[biz.business_id] = { ...osmMap[key], source: 'osm_overpass' };
      continue;
    }
    // Partial match — OSM name contains our name or vice versa
    for (const [osmName, coords] of Object.entries(osmMap)) {
      if (osmName.includes(key) || key.includes(osmName)) {
        if (key.length >= 5 && osmName.length >= 5) { // avoid short false matches
          matched[biz.business_id] = { ...coords, source: 'osm_overpass' };
          break;
        }
      }
    }
  }

  console.log(`[geocoder/overpass] Matched ${Object.keys(matched).length}/${bizList.length} businesses via OSM names`);
  return matched; // { business_id: { lat, lon, source } }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    zip:  args.includes('--zip') ? args[args.indexOf('--zip') + 1] : null,
    dry:  args.includes('--dry'),
  };
}

/** Build a Census batch CSV row from a business record */
function toCsvRow(biz) {
  // Census format: ID, Street, City, State, ZIP
  // Strip unit/suite noise that confuses the geocoder
  const street = (biz.address || '')
    .replace(/,\s*(ponte vedra beach|nocatee|jacksonville|fl|florida).*/i, '')
    .replace(/,\s*\d{5}.*/, '')
    .trim();

  const city  = biz.city  || 'Ponte Vedra Beach';
  const state = 'FL';
  const zip   = biz.zip   || '';

  // Escape commas inside fields
  const esc = s => `"${String(s).replace(/"/g, '""')}"`;
  return `${esc(biz.business_id)},${esc(street)},${esc(city)},${esc(state)},${esc(zip)}`;
}

/** POST one chunk to Census batch geocoder, return parsed results */
async function geocodeChunk(rows) {
  const csvHeader = 'Unique ID,Street address,City,State,ZIP';
  const csvBody   = [csvHeader, ...rows].join('\n');

  const form = new FormData();
  form.append('addressFile', Buffer.from(csvBody, 'utf8'), {
    filename:    'addresses.csv',
    contentType: 'text/csv',
  });
  form.append('benchmark', 'Public_AR_Current');
  form.append('vintage',   'Current_Current');

  const res = await fetch(CENSUS_URL, {
    method:  'POST',
    body:    form,
    headers: form.getHeaders(),
    timeout: 120000, // 2 min — Census can be slow on large batches
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Census geocoder HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const text = await res.text();
  // Census response format per line:
  // ID,input_addr,match_status,match_type,matched_addr,coords,tigerline_id,tigerline_side
  // coords = "lon,lat" (note: lon first)
  const results = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(',');
    const id     = parts[0]?.replace(/"/g, '').trim();
    const status = parts[2]?.replace(/"/g, '').trim(); // 'Match' or 'No_Match' or 'Tie'
    const coords = parts[5]?.replace(/"/g, '').trim(); // "lon,lat"

    if (!id) continue;

    if (status === 'Match' && coords) {
      const [lon, lat] = coords.split(',').map(Number);
      if (lon && lat && !isNaN(lon) && !isNaN(lat)) {
        results.push({ business_id: id, lat, lon, matched: true });
      }
    } else {
      results.push({ business_id: id, matched: false });
    }
  }
  return results;
}

/** sleep helper */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Nominatim fallback — 1 req/sec, tries name+address then address-only
 * Returns { business_id, lat, lon, matched } for each record
 */
async function geocodeNominatim(biz) {
  const queries = [
    // Try 1: name + street + city
    `${biz.name}, ${biz.address}, ${biz.city || 'Ponte Vedra Beach'}, FL`,
    // Try 2: street + city only (name can confuse it)
    `${biz.address}, ${biz.city || 'Ponte Vedra Beach'}, FL ${biz.zip}`,
  ];

  for (const q of queries) {
    try {
      const url = `${NOMINATIM_URL}?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=us`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'LocalIntel-Geocoder/1.0 (localintel@mcflamingo.com)' },
        timeout: 8000,
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data && data.length > 0) {
        const lat = parseFloat(data[0].lat);
        const lon = parseFloat(data[0].lon);
        if (!isNaN(lat) && !isNaN(lon)) {
          return { business_id: biz.business_id, lat, lon, matched: true, source: 'nominatim' };
        }
      }
    } catch (_) {}
    await sleep(NOMINATIM_DELAY_MS);
  }
  return { business_id: biz.business_id, matched: false };
}

/**
 * Photon (OSM-based) fallback — no rate limit, no key
 * Good at picking up businesses Nominatim misses
 */
async function geocodePhoton(biz) {
  const queries = [
    `${biz.address}, ${biz.city || 'Ponte Vedra Beach'}, FL ${biz.zip}`,
    `${biz.name}, ${biz.zip}`,
  ];

  for (const q of queries) {
    try {
      const url = `${PHOTON_URL}?q=${encodeURIComponent(q)}&limit=1&lang=en`;
      const res = await fetch(url, { timeout: 8000 });
      if (!res.ok) continue;
      const data = await res.json();
      const feat = data?.features?.[0];
      if (feat) {
        const [lon, lat] = feat.geometry.coordinates;
        if (!isNaN(lat) && !isNaN(lon)) {
          return { business_id: biz.business_id, lat, lon, matched: true, source: 'photon' };
        }
      }
    } catch (_) {}
  }
  return { business_id: biz.business_id, matched: false };
}

/**
 * Fallback geocoding pass — runs Nominatim then Photon on unmatched records
 * Returns array of { business_id, lat, lon, matched, source }
 */
async function geocodeFallback(unmatched) {
  console.log(`[geocoder] Fallback pass: ${unmatched.length} records → Nominatim then Photon`);
  const results = [];
  let nomMatched = 0, photonMatched = 0, stillMissed = 0;

  for (let i = 0; i < unmatched.length; i++) {
    const biz = unmatched[i];
    if (i % 50 === 0) process.stdout.write(`  [${i}/${unmatched.length}]\r`);

    // Try Nominatim first
    await sleep(NOMINATIM_DELAY_MS);
    const nomResult = await geocodeNominatim(biz);
    if (nomResult.matched) {
      results.push(nomResult);
      nomMatched++;
      continue;
    }

    // Photon fallback (no delay needed)
    const photonResult = await geocodePhoton(biz);
    if (photonResult.matched) {
      results.push(photonResult);
      photonMatched++;
      continue;
    }

    results.push({ business_id: biz.business_id, matched: false });
    stillMissed++;
  }

  console.log(`\n[geocoder] Fallback results: Nominatim=${nomMatched} Photon=${photonMatched} still_missing=${stillMissed}`);
  return results;
}

/** Write lat/lon back to Postgres in batches */
async function writeToDB(db, matched) {
  let written = 0;
  for (let i = 0; i < matched.length; i += CHUNK_WRITE) {
    const chunk = matched.slice(i, i + CHUNK_WRITE);
    // Build a VALUES list for a bulk UPDATE
    const values = chunk.map((r, idx) => `($${idx * 3 + 1}::uuid, $${idx * 3 + 2}::float8, $${idx * 3 + 3}::float8)`).join(',');
    const params = chunk.flatMap(r => [r.business_id, r.lat, r.lon]);
    await db.getPool().query(
      `UPDATE businesses AS b
       SET lat = v.lat, lon = v.lon, updated_at = NOW()
       FROM (VALUES ${values}) AS v(business_id, lat, lon)
       WHERE b.business_id = v.business_id`,
      params
    );
    written += chunk.length;
  }
  return written;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function run() {
  const { zip, dry } = parseArgs();

  if (!process.env.LOCAL_INTEL_DB_URL) {
    console.error('LOCAL_INTEL_DB_URL not set — run this on Railway or with the DB URL in env');
    process.exit(1);
  }

  const db = require('../lib/db');

  // 1. Pull all businesses missing lat/lon
  const whereZip = zip ? `AND zip = '${zip}'` : '';
  const rows = await db.query(
    `SELECT business_id, name, address, city, zip
     FROM businesses
     WHERE lat IS NULL
       AND address IS NOT NULL
       AND address != ''
       AND length(address) > 5
       ${whereZip}
     ORDER BY zip, name`,
    []
  );

  console.log(`\n[geocoder] Found ${rows.length} businesses missing lat/lon${zip ? ` in ${zip}` : ''}`);

  if (rows.length === 0) {
    console.log('[geocoder] Nothing to do.');
    process.exit(0);
  }

  if (dry) {
    console.log('[geocoder] --dry mode: no writes. Exiting.');
    // Show ZIP breakdown
    const byZip = {};
    for (const r of rows) byZip[r.zip] = (byZip[r.zip] || 0) + 1;
    for (const [z, c] of Object.entries(byZip).sort()) console.log(`  ${z}: ${c} records`);
    process.exit(0);
  }

  // Track all business objects by id for fallback passes
  const bizById = Object.fromEntries(rows.map(r => [r.business_id, r]));

  let totalMatched = 0;
  let totalWritten = 0;
  const unmatchedBizIds = new Set(rows.map(r => r.business_id));

  // ── Pass 0: Overpass OSM bulk fetch (one call per ZIP, exact OSM pin coords) ──
  const zipGroups = {};
  for (const biz of rows) zipGroups[biz.zip] = (zipGroups[biz.zip] || []).concat(biz);

  for (const [zipCode, bizList] of Object.entries(zipGroups)) {
    const overpassMatched = await geocodeOverpass(bizList, zipCode);
    const overpassResults = Object.entries(overpassMatched).map(([bid, coords]) => ({
      business_id: bid, lat: coords.lat, lon: coords.lon, matched: true,
    }));
    if (overpassResults.length > 0) {
      const written = await writeToDB(db, overpassResults);
      totalWritten += written;
      totalMatched += overpassResults.length;
      for (const r of overpassResults) unmatchedBizIds.delete(r.business_id);
      console.log(`[geocoder] Pass 0 (OSM): wrote ${written} records for ZIP ${zipCode}`);
    }
    await sleep(2000); // be polite to Overpass between ZIPs
  }

  // Rebuild rows to only include unmatched after Pass 0
  const remainingRows = [...unmatchedBizIds].map(id => bizById[id]).filter(Boolean);
  console.log(`[geocoder] After Pass 0: ${totalMatched} matched, ${remainingRows.length} remaining for Census/fallback`);

  // ── Pass 1: Census batch — all remaining records ──
  for (let start = 0; start < remainingRows.length; start += BATCH_SIZE) {
    const chunk    = remainingRows.slice(start, start + BATCH_SIZE);
    const csvRows  = chunk.map(toCsvRow);
    const chunkNum = Math.floor(start / BATCH_SIZE) + 1;
    const numChunks = Math.ceil(remainingRows.length / BATCH_SIZE);

    console.log(`[geocoder] Census chunk ${chunkNum}/${numChunks} — sending ${chunk.length} addresses...`);

    let results;
    try {
      results = await geocodeChunk(csvRows);
    } catch (e) {
      console.error(`[geocoder] Census chunk ${chunkNum} failed: ${e.message} — queuing for fallback`);
      chunk.forEach(r => unmatchedBizIds.add(r.business_id));
      continue;
    }

    const matched = results.filter(r => r.matched);
    const missed  = results.filter(r => !r.matched);
    totalMatched += matched.length;
    missed.forEach(r => unmatchedBizIds.add(r.business_id));

    console.log(`[geocoder] Census chunk ${chunkNum}: ${matched.length} matched, ${missed.length} no-match`);

    if (matched.length > 0) {
      const written = await writeToDB(db, matched);
      totalWritten += written;
      console.log(`[geocoder] Wrote ${written} records to Postgres`);
    }
  }

  // 3. Fallback pass — Nominatim then Photon on Census misses
  const unmatchedRows = [...unmatchedBizIds].map(id => bizById[id]).filter(Boolean);
  // (unmatchedBizIds was pruned by Pass 0 and updated by Census pass above)
  if (unmatchedRows.length > 0) {
    const fallbackResults = await geocodeFallback(unmatchedRows);
    const fallbackMatched = fallbackResults.filter(r => r.matched);
    if (fallbackMatched.length > 0) {
      const written = await writeToDB(db, fallbackMatched);
      totalWritten  += written;
      totalMatched  += fallbackMatched.length;
      console.log(`[geocoder] Fallback wrote ${written} records to Postgres`);
    }
  }

  // 4. Summary
  const totalMissed = rows.length - totalMatched;
  const matchRate   = rows.length > 0 ? Math.round((totalMatched / rows.length) * 100) : 0;
  console.log(`\n[geocoder] ✅ Done`);
  console.log(`  Total processed: ${rows.length}`);
  console.log(`  Matched:         ${totalMatched} (${matchRate}%)`);
  console.log(`  No match:        ${totalMissed}`);
  console.log(`  Written to DB:   ${totalWritten}`);

  // 5. Per-ZIP breakdown
  if (!zip) {
    const zipStats = await db.query(
      `SELECT zip,
              COUNT(*) AS total,
              COUNT(lat) AS with_lat
       FROM businesses
       WHERE zip IN (SELECT DISTINCT zip FROM businesses WHERE lat IS NOT NULL)
       GROUP BY zip
       ORDER BY zip`,
      []
    );
    console.log('\n  ZIP coverage after geocoding:');
    for (const r of zipStats) {
      const pct = Math.round((r.with_lat / r.total) * 100);
      console.log(`    ${r.zip}: ${r.with_lat}/${r.total} (${pct}%)`);
    }
  }

  await db.getPool().end();
}

run().catch(e => {
  console.error('[geocoder] Fatal:', e.message);
  process.exit(1);
});
