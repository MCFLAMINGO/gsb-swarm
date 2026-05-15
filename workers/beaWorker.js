'use strict';
/**
 * beaWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches per capita personal income for all 67 FL counties from the
 * Bureau of Economic Analysis (BEA) Regional Economic Accounts API.
 *
 * Table: CAINC1 — Per Capita Personal Income and Population
 * Line: 3 = Per Capita Personal Income
 *
 * Single batch call returns all 67 FL counties at once (GeoFips=12000 wildcard).
 * Fetches 3 years to compute YoY growth and 5yr CAGR.
 *
 * Worker contract:
 *   START → fetch BEA (2 API calls: current + 5yr ago) → compute growth → upsert → END
 *
 * Rate limit: BEA allows 1000 req/day per key. We use 2 calls total.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const https   = require('https');
const db      = require('../lib/db');
const pgStore = require('../lib/pgStore');
const { getZipsForCountyFips } = require('../lib/flZipCountyMap');

const BEA_BASE = 'https://apps.bea.gov/api/data/';
const API_KEY  = process.env.BEA_API;

function fetchBea(params) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({
      UserID:      API_KEY,
      method:      'GetData',
      datasetname: 'Regional',
      ResultFormat: 'JSON',
      ...params,
    }).toString();
    const url = `${BEA_BASE}?${qs}`;
    https.get(url, { headers: { 'User-Agent': 'LocalIntel-DataWorker/1.0 (erik@mcflamingo.com)' } }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          const results = j?.BEAAPI?.Results;
          if (!results) return reject(new Error('BEA: no Results in response'));
          if (results.Error) return reject(new Error(`BEA API error: ${JSON.stringify(results.Error)}`));
          resolve(results.Data || []);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// CAINC1, Line 3 = Per Capita Personal Income
// GeoFips "STATE:12" returns all FL counties (12000 is just the state total)
async function fetchAllFLCounties(year) {
  const data = await fetchBea({
    TableName: 'CAINC1',
    LineCode:  '3',
    GeoFips:   'STATE:12',   // all counties in Florida
    Year:      String(year),
  });
  // Build map: fips5 → value
  const map = {};
  for (const row of data) {
    if (!row.GeoFips || !row.DataValue) continue;
    const fips = row.GeoFips.replace(/\D/g,'').padStart(5,'0');
    // DataValue may have commas or (NA)
    if (row.DataValue === '(NA)' || row.DataValue === '') continue;
    const val = parseInt(row.DataValue.replace(/,/g,''), 10);
    if (!isNaN(val) && val > 0) map[fips] = val;
  }
  return map;
}

function getZipsForCounty(fips) {
  return getZipsForCountyFips(fips);
}

async function run() {
  if (!API_KEY) {
    console.error('[bea] ❌ BEA_API env var not set — cannot run');
    process.exit(1);
  }

  // Freshness check — skip if ran within 30 days (BEA releases annual data with ~2yr lag)
  try {
    const hb = await db.query(`SELECT last_run FROM worker_heartbeat WHERE worker_name = 'beaWorker'`);
    if (Array.isArray(hb) && hb[0]?.last_run) {
      const ageDays = (Date.now() - new Date(hb[0].last_run).getTime()) / 86400000;
      if (ageDays < 365) {  // BEA is annual data with 2yr lag — no need to re-fetch within a year
        console.log(`[bea] Data fresh (${ageDays.toFixed(1)} days old, window 365d) — skipping run`);
        process.exit(0);
      }
    }
  } catch (_) { /* no heartbeat yet — run */ }

  console.log('[bea] Starting BEA CAINC1 worker — fetching FL county per capita income');
  const start = Date.now();

  // Determine latest available BEA year (typically 2 years lag — if 2026, use 2024 or 2023)
  const currentYear = new Date().getFullYear();
  const latestYear  = currentYear - 2;  // BEA is ~18mo lag
  const priorYear1  = latestYear - 1;
  const priorYear5  = latestYear - 5;

  let currentData, prior1Data, prior5Data, flStateAvg;

  try {
    console.log(`[bea] Fetching ${latestYear} data...`);
    currentData = await fetchAllFLCounties(latestYear);
    console.log(`[bea] Got ${Object.keys(currentData).length} counties for ${latestYear}`);
  } catch (e) {
    // Try one year earlier if latest isn't available yet
    console.warn(`[bea] ${latestYear} failed (${e.message}), trying ${latestYear - 1}`);
    try {
      currentData = await fetchAllFLCounties(latestYear - 1);
    } catch (e2) {
      console.error('[bea] ❌ Could not fetch current year data:', e2.message);
      process.exit(1);
    }
  }

  try {
    prior1Data = await fetchAllFLCounties(priorYear1);
  } catch (e) {
    console.warn(`[bea] Prior 1yr (${priorYear1}) failed:`, e.message);
    prior1Data = {};
  }

  try {
    prior5Data = await fetchAllFLCounties(priorYear5);
  } catch (e) {
    console.warn(`[bea] Prior 5yr (${priorYear5}) failed:`, e.message);
    prior5Data = {};
  }

  // FL state average per capita income (GeoFips 12000 = state-level row has fips "12000")
  flStateAvg = currentData['12000'] || null;
  console.log(`[bea] FL state avg per capita income: $${flStateAvg?.toLocaleString() || 'N/A'}`);

  // Build county results
  let countyDone = 0, zipsDone = 0;

  for (const [fips, income] of Object.entries(currentData)) {
    if (fips === '12000') continue; // skip state-level row
    if (!fips.startsWith('12')) continue; // FL counties only

    const prior1 = prior1Data[fips];
    const prior5 = prior5Data[fips];

    const yoy = prior1 ? parseFloat(((income - prior1) / prior1 * 100).toFixed(2)) : null;
    // 5yr CAGR: (current/prior5)^(1/5) - 1
    const cagr5 = prior5 ? parseFloat(((Math.pow(income / prior5, 1/5) - 1) * 100).toFixed(2)) : null;
    const vsFlAvg = flStateAvg ? parseFloat((income / flStateAvg).toFixed(3)) : null;

    const vintage = String(latestYear);
    const countyName = fips; // will be logged with fips

    console.log(`[bea] FIPS ${fips}: $${income.toLocaleString()} (yoy=${yoy}%, 5yr_cagr=${cagr5}%, vs_fl=${vsFlAvg})`);

    const signals = {
      bea_per_capita_income:  income,
      bea_income_growth_1yr:  yoy,
      bea_income_growth_5yr:  cagr5,
      bea_income_vs_fl_avg:   vsFlAvg,
      bea_vintage:            vintage,
      bea_updated_at:         new Date(),
    };

    // Get ZIPs for this county from static registry
    const zips = getZipsForCounty(fips);
    if (zips.length === 0) continue;

    for (const zip of zips) {
      await pgStore.upsertZipSignals(zip, signals);
      zipsDone++;
    }
    countyDone++;
  }

  // Heartbeat
  await db.query(
    `INSERT INTO worker_heartbeat (worker_name, last_run) VALUES ('beaWorker', NOW())
     ON CONFLICT (worker_name) DO UPDATE SET last_run = NOW()`
  ).catch(() => {});

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[bea] ✅ Done — ${countyDone} counties, ${zipsDone} ZIP upserts — ${elapsed}s`);
  process.exit(0);
}

run().catch(e => { console.error('[bea] fatal:', e.message); process.exit(1); });
