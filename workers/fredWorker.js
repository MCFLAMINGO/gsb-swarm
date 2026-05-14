'use strict';
/**
 * fredWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches BLS Local Area Unemployment Statistics (LAUS) for all FL counties
 * via the FRED GeoFRED Maps API (geofred/series/data).
 *
 * One call returns ALL counties at once — no per-series loops, no rate limits.
 * Response includes county FIPS code → mapped to ZIPs via flZipCountyMap.
 *
 * GeoFRED series used (FL county unemployment):
 *   FLALACHUA1URN  — unemployment rate, all FL counties returned in one call
 *
 * Worker contract:
 *   START → fetch GeoFRED (rate + labor force) → map FIPS → ZIPs → upsert → END
 * ─────────────────────────────────────────────────────────────────────────────
 */

const https   = require('https');
const db      = require('../lib/db');
const pgStore = require('../lib/pgStore');
const { getZipsForCountyFips } = require('../lib/flZipCountyMap');

const GEOFRED_BASE = 'https://api.stlouisfed.org/geofred/series/data';
const API_KEY      = process.env.FRED_API;

// GeoFRED series IDs for FL county LAUS data
// One call returns all counties — code field = 5-digit county FIPS
const SERIES_RATE = 'FLALACHUA1URN';   // unemployment rate % — all FL counties
const SERIES_LF   = 'FLALACHUA1LFN';   // labor force — all FL counties
const SERIES_UE   = 'FLALACHUA1URN';   // we derive unemployed from rate * lf

function fetchGeoFred(seriesId) {
  return new Promise((resolve, reject) => {
    const url = `${GEOFRED_BASE}?series_id=${seriesId}&api_key=${API_KEY}&file_type=json`;
    https.get(url, { headers: { 'User-Agent': 'LocalIntel-DataWorker/1.0 (erik@mcflamingo.com)' } }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j.error_code) return reject(new Error(`GeoFRED ${seriesId}: ${j.error_message}`));
          // Response: { meta: { date, ... }, data: [{ region, code, value, series_id }, ...] }
          const meta = j.meta || {};
          const data = meta.data || [];
          resolve({ date: meta.date, data });
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function run() {
  if (!API_KEY) {
    console.error('[fred] ❌ FRED_API env var not set — cannot run');
    process.exit(1);
  }

  console.log('[fred] Starting FRED LAUS worker via GeoFRED Maps API');
  const start = Date.now();

  // Fetch unemployment rate for all FL counties in one call
  let rateData, lfData;
  try {
    const rateResult = await fetchGeoFred(SERIES_RATE);
    rateData = rateResult.data;
    console.log(`[fred] ✓ Got unemployment rate data: ${rateData.length} counties, vintage ${rateResult.date}`);
  } catch (e) {
    console.error('[fred] ❌ Failed to fetch unemployment rate:', e.message);
    process.exit(1);
  }

  try {
    const lfResult = await fetchGeoFred(SERIES_LF);
    lfData = lfResult.data;
    console.log(`[fred] ✓ Got labor force data: ${lfData.length} counties`);
  } catch (e) {
    console.warn('[fred] ⚠ Failed to fetch labor force (continuing without lf):', e.message);
    lfData = [];
  }

  // Build FIPS → labor force map
  const lfByFips = {};
  for (const row of lfData) {
    if (row.code && row.value !== '.' && row.value !== null) {
      // code is 5-digit county FIPS e.g. "12001"
      lfByFips[row.code] = parseFloat(row.value);
    }
  }

  let countyDone = 0, zipsDone = 0, skipped = 0;
  let vintage = null;

  // Filter to FL counties only (FIPS starting with 12)
  const flRates = rateData.filter(r => r.code && String(r.code).startsWith('12'));
  console.log(`[fred] Processing ${flRates.length} FL counties`);

  for (const row of flRates) {
    const fips5 = String(row.code).padStart(5, '0'); // ensure 5 digits
    const rate  = (row.value !== '.' && row.value != null) ? parseFloat(row.value) : null;

    if (rate == null) {
      console.warn(`[fred] ${row.region} (${fips5}): no rate data — skipping`);
      skipped++;
      continue;
    }

    if (!vintage && row.date) vintage = row.date ? row.date.substring(0, 7) : null;

    const lf    = lfByFips[fips5] ? Math.round(lfByFips[fips5]) : null;
    const unemp = (lf != null) ? Math.round(lf * rate / 100) : null;

    console.log(`[fred] ${row.region}: rate=${rate}% lf=${lf} vintage=${vintage}`);

    const zips = getZipsForCountyFips(fips5);
    if (zips.length === 0) {
      console.warn(`[fred] ${row.region} (${fips5}): no ZIPs in registry — skipping`);
      skipped++;
      continue;
    }

    const signals = {
      fred_unemployment_rate: rate,
      fred_labor_force:       lf,
      fred_employed:          (lf != null && unemp != null) ? lf - unemp : null,
      fred_unemployment_yoy:  null, // GeoFRED single-date snapshot, no YoY in one call
      fred_vintage:           vintage,
      fred_updated_at:        new Date(),
    };

    for (const zip of zips) {
      await pgStore.upsertZipSignals(zip, signals);
      zipsDone++;
    }
    countyDone++;
  }

  // Heartbeat
  await db.query(
    `INSERT INTO worker_heartbeat (worker_name, last_run) VALUES ('fredWorker', NOW())
     ON CONFLICT (worker_name) DO UPDATE SET last_run = NOW()`
  ).catch(() => {});

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[fred] ✅ Done — ${countyDone} counties, ${zipsDone} ZIP upserts, ${skipped} skipped — ${elapsed}s`);
  process.exit(0);
}

run().catch(e => { console.error('[fred] fatal:', e.message); process.exit(1); });
