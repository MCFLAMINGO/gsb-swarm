'use strict';
/**
 * countyPermitsWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * County-level construction establishment data (CBP NAICS 236),
 * fanned out to ZIPs.
 *
 * Census CBP NAICS 236 (Construction of Buildings):
 *   cbp_total_establishments  — establishments
 *   cbp_total_employees       — employment
 *   cbp_total_payroll_k       — annual payroll ($000s)
 *   cbp_updated_at            — fetch timestamp
 *   Endpoint: 2023 cbp, requires Census API key.
 *
 * Worker contract:
 *   START → check heartbeat (skip if <30d) → per county fetch CBP →
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

// Fetch CBP NAICS 236 (Construction of Buildings) for a county
async function fetchCBP236(countyFips3) {
  const url = `https://api.census.gov/data/2023/cbp?get=ESTAB,EMP,PAYANN,NAICS2017&for=county:${countyFips3}&in=state:${STATE_FIPS}&NAICS2017=236&key=${CENSUS_API_KEY}`;
  try {
    const raw = await fetchJson(url);
    const rows = parseCensus(raw);
    const row = rows[0];
    if (!row) return null;
    return {
      cbp_total_establishments: toN(row.ESTAB)  || null,
      cbp_total_employees:      toN(row.EMP)    || null,
      cbp_total_payroll_k:      toN(row.PAYANN) || null,
    };
  } catch (e) {
    console.warn(`[countyPermits] CBP fetch failed for county ${countyFips3}: ${e.message}`);
    return null;
  }
}

async function run() {
  console.log('[countyPermits] Starting countyPermitsWorker — Census CBP NAICS 236');
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
    console.warn('[countyPermits] No Census_Data_API / CENSUS_API_KEY env var — cannot fetch CBP, aborting');
    return;
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

    // CBP NAICS 236
    const cbp = await fetchCBP236(fips3);

    // Build signals object
    const signals = {};
    if (cbp?.cbp_total_establishments != null) signals.cbp_total_establishments = cbp.cbp_total_establishments;
    if (cbp?.cbp_total_employees      != null) signals.cbp_total_employees      = cbp.cbp_total_employees;
    if (cbp?.cbp_total_payroll_k      != null) signals.cbp_total_payroll_k      = cbp.cbp_total_payroll_k;
    if (Object.keys(signals).length > 0) signals.cbp_updated_at = new Date().toISOString();

    if (Object.keys(signals).length === 0) {
      console.log(`[countyPermits] county ${fips5} — no data, skipping`);
      continue;
    }

    console.log(`[countyPermits] county ${fips5}: estab=${cbp?.cbp_total_establishments ?? 'n/a'}, emp=${cbp?.cbp_total_employees ?? 'n/a'}, payroll=${cbp?.cbp_total_payroll_k ?? 'n/a'} → ${zipsForCounty.length} ZIPs`);

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
