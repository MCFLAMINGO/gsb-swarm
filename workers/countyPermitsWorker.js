'use strict';
/**
 * countyPermitsWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * County-level construction + permits data, fanned out to ZIPs.
 *
 * Layer A — Census BPS (Building Permits Survey):
 *   permits_new_units — annual new residential units authorized (1-unit bldgs)
 *   Endpoint: timeseries/eits/bps, requires Census_Data_API key
 *
 * Layer B — Census CBP NAICS 236 (Construction of Buildings):
 *   construction_estab_count — establishments
 *   construction_emp         — employment
 *   Endpoint: 2022 cbp, no key required
 *
 * Worker contract:
 *   START → check heartbeat (skip if <30d) → per county fetch BPS + CBP →
 *           fan out to ZIPs via fl_zip_geo.county_fips → upsert → END
 * ─────────────────────────────────────────────────────────────────────────────
 */

const https   = require('https');
const db      = require('../lib/db');
const pgStore = require('../lib/pgStore');

const FRESH_MS = 30 * 24 * 60 * 60 * 1000;
const CENSUS_API_KEY = process.env.Census_Data_API || process.env.CENSUS_API_KEY || null;
const STATE_FIPS = '12'; // Florida

function fetchJson(url, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'LocalIntel-DataWorker/1.0 (erik@mcflamingo.com)' },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJson(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('JSON parse failed')); }
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

function toN(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

// Parse Census API response (header row + data rows) into objects keyed by header
function parseCensus(raw) {
  if (!Array.isArray(raw) || raw.length < 2) return [];
  const [headers, ...rows] = raw;
  return rows.map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

// Layer A — fetch building permits (new units authorized, 1-unit buildings)
// category_code=1 = 1-unit buildings; cell_value = units authorized
async function fetchBPS(countyFips3) {
  if (!CENSUS_API_KEY) return null;
  const url = `https://api.census.gov/data/timeseries/eits/bps?get=cell_value,time_slot_id,category_code&for=county:${countyFips3}&in=state:${STATE_FIPS}&YEAR=2023&MONTH=12&key=${CENSUS_API_KEY}`;
  try {
    const raw = await fetchJson(url);
    const rows = parseCensus(raw);
    // Sum cell_value across rows with category_code=1 (1-unit buildings)
    let total = 0;
    let matched = 0;
    for (const r of rows) {
      if (String(r.category_code) === '1') {
        total += toN(r.cell_value);
        matched++;
      }
    }
    if (matched === 0) return null;
    return total;
  } catch (e) {
    console.warn(`[countyPermits] BPS fetch failed for county ${countyFips3}: ${e.message}`);
    return null;
  }
}

// Layer B — fetch CBP NAICS 236 (Construction of Buildings)
async function fetchCBP236(countyFips3) {
  const url = `https://api.census.gov/data/2022/cbp?get=NAICS2017_LABEL,ESTAB,EMP,PAYANN&for=county:${countyFips3}&in=state:${STATE_FIPS}&NAICS2017=236`;
  try {
    const raw = await fetchJson(url);
    const rows = parseCensus(raw);
    const row = rows[0];
    if (!row) return null;
    return {
      construction_estab_count: toN(row.ESTAB) || null,
      construction_emp:         toN(row.EMP)   || null,
    };
  } catch (e) {
    console.warn(`[countyPermits] CBP fetch failed for county ${countyFips3}: ${e.message}`);
    return null;
  }
}

async function run() {
  console.log('[countyPermits] Starting countyPermitsWorker — Census BPS + CBP NAICS 236');
  const start = Date.now();

  // Freshness check
  try {
    const hb = await db.query(`SELECT last_run FROM worker_heartbeat WHERE worker_name = 'countyPermitsWorker'`);
    if (Array.isArray(hb) && hb[0]?.last_run) {
      const age = Date.now() - new Date(hb[0].last_run).getTime();
      const days = age / 86400000;
      if (age < FRESH_MS) {
        console.log(`[countyPermits] Data fresh (${days.toFixed(1)} days old, window 30d) — skipping run`);
        return;
      }
    }
  } catch (_) { /* run */ }

  if (!CENSUS_API_KEY) {
    console.log('[countyPermits] No Census_Data_API key — BPS layer will be skipped, CBP layer will still run');
  }

  // All distinct FL counties
  let counties;
  try {
    const rows = await db.query(
      `SELECT DISTINCT county_fips FROM fl_zip_geo WHERE county_fips IS NOT NULL AND county_fips <> ''`
    );
    counties = Array.isArray(rows) ? rows.map(r => String(r.county_fips)) : [];
  } catch (e) {
    console.error('[countyPermits] Failed to load counties from fl_zip_geo:', e.message);
    return;
  }
  if (counties.length === 0) {
    console.warn('[countyPermits] fl_zip_geo has no counties — aborting');
    return;
  }
  console.log(`[countyPermits] Processing ${counties.length} FL counties`);

  let countyDone = 0, zipsDone = 0;

  for (const fips5 of counties) {
    if (!fips5.startsWith(STATE_FIPS)) continue;
    const fips3 = fips5.slice(2); // strip "12" → 3-digit county FIPS

    // Get ZIPs for this county
    let zipsForCounty;
    try {
      const rows = await db.query(`SELECT zip FROM fl_zip_geo WHERE county_fips = $1`, [fips5]);
      zipsForCounty = Array.isArray(rows) ? rows.map(r => String(r.zip).trim()).filter(Boolean) : [];
    } catch (e) {
      console.warn(`[countyPermits] Failed to load ZIPs for ${fips5}: ${e.message}`);
      continue;
    }
    if (zipsForCounty.length === 0) continue;

    // Layer A: BPS
    const permits = await fetchBPS(fips3);

    // Layer B: CBP NAICS 236
    const cbp = await fetchCBP236(fips3);

    // Build signals object
    const signals = {};
    if (permits != null) signals.permits_new_units = permits;
    if (cbp?.construction_estab_count != null) signals.construction_estab_count = cbp.construction_estab_count;
    if (cbp?.construction_emp != null) signals.construction_emp = cbp.construction_emp;

    if (Object.keys(signals).length === 0) {
      console.log(`[countyPermits] county ${fips5} — no data, skipping`);
      continue;
    }

    console.log(`[countyPermits] county ${fips5}: permits=${permits ?? 'n/a'}, estab=${cbp?.construction_estab_count ?? 'n/a'}, emp=${cbp?.construction_emp ?? 'n/a'} → ${zipsForCounty.length} ZIPs`);

    for (const zip of zipsForCounty) {
      try {
        await pgStore.upsertZipSignals(zip, signals);
        zipsDone++;
      } catch (e) {
        console.error(`[countyPermits] upsert failed for ${zip}: ${e.message}`);
      }
    }
    countyDone++;
  }

  // Heartbeat
  await db.query(
    `INSERT INTO worker_heartbeat (worker_name, last_run) VALUES ('countyPermitsWorker', NOW())
     ON CONFLICT (worker_name) DO UPDATE SET last_run = NOW()`
  ).catch(() => {});

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[countyPermits] ✅ Done — ${countyDone} counties, ${zipsDone} ZIP upserts — ${elapsed}s`);
  return;
}

run().catch(e => { console.error('[countyPermits] fatal:', e.message); });
