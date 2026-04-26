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
const BATCH_SIZE    = 9000; // Census hard limit is 10k — stay safely under
const CHUNK_WRITE   = 100;  // rows per UPDATE batch to avoid giant transactions
const NOMINATIM_DELAY_MS = 1100; // Nominatim ToS: max 1 req/sec

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

  // 2. Census batch pass — all records in one shot
  let totalMatched = 0;
  let totalWritten = 0;
  const unmatchedBizIds = new Set();

  // Track which business objects failed Census for fallback
  const bizById = Object.fromEntries(rows.map(r => [r.business_id, r]));

  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const chunk    = rows.slice(start, start + BATCH_SIZE);
    const csvRows  = chunk.map(toCsvRow);
    const chunkNum = Math.floor(start / BATCH_SIZE) + 1;
    const numChunks = Math.ceil(rows.length / BATCH_SIZE);

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
