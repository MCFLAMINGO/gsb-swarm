'use strict';
/**
 * qwiWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches Quarterly Workforce Indicators (QWI) for all 67 FL counties via
 * the Census QWI API, then denormalizes to ZIPs via flZipCountyMap.
 *
 * Indicators fetched (single batch call for all FL counties):
 *   Emp     = beginning-of-quarter employment
 *   EmpEnd  = end-of-quarter employment
 *   EarnBeg = average monthly earnings at beginning of quarter ($)
 *   HirA    = all hires in quarter
 *   Sep     = all separations in quarter
 *
 * One call → all 67 FL counties → ~instant. Denormalize to ZIPs using
 * the flZipCountyMap static registry.
 *
 * Worker contract:
 *   START → fetch latest QWI quarter → compute turnover → upsert → END
 *
 * API: https://api.census.gov/data/timeseries/qwi/sa
 * Key env var: Census_Data_API
 * ─────────────────────────────────────────────────────────────────────────────
 */

const https  = require('https');
const db     = require('../lib/db');
const pgStore = require('../lib/pgStore');
const { getZipsForCountyFips } = require('../lib/flZipCountyMap');

const QWI_BASE   = 'https://api.census.gov/data/timeseries/qwi/sa';
const CENSUS_KEY = process.env.Census_Data_API;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'LocalIntel-DataWorker/1.0 (erik@mcflamingo.com)' } }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse failed: ${e.message} — body: ${body.substring(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

// Find the most recent available QWI quarter (typically 3 quarters behind current)
function getLatestQwiQuarter() {
  const now = new Date();
  const qtr = Math.floor((now.getMonth()) / 3) + 1;
  const yr  = now.getFullYear();
  // QWI is typically 3 quarters behind
  let tgt_qtr = qtr - 3;
  let tgt_yr  = yr;
  if (tgt_qtr < 1) { tgt_qtr += 4; tgt_yr -= 1; }
  return { year: tgt_yr, quarter: tgt_qtr };
}

async function fetchQwiFL(year, quarter) {
  const url = `${QWI_BASE}?get=Emp,EmpEnd,EarnBeg,HirA,Sep&for=county:*&in=state:12&year=${year}&quarter=${quarter}&key=${CENSUS_KEY}`;
  const data = await fetchJson(url);

  if (!Array.isArray(data) || data.length < 2) {
    throw new Error(`QWI returned no data for ${year}-Q${quarter}`);
  }

  const header = data[0]; // ['Emp','EmpEnd','EarnBeg','HirA','Sep','year','quarter','state','county']
  const hi = {};
  header.forEach((h, i) => { hi[h] = i; });

  const results = {};
  for (let i = 1; i < data.length; i++) {
    const row    = data[i];
    const county = row[hi['county']];
    const fips5  = '12' + county.padStart(3, '0');

    const emp    = parseInt(row[hi['Emp']]    || 0, 10);
    const empEnd = parseInt(row[hi['EmpEnd']] || 0, 10);
    const earn   = parseInt(row[hi['EarnBeg']]|| 0, 10);
    const hires  = parseInt(row[hi['HirA']]  || 0, 10);
    const seps   = parseInt(row[hi['Sep']]   || 0, 10);

    // Turnover rate: (hires + seps) / (2 * avg_emp) — quarterly, so annualize ×4
    const avgEmp  = (emp + empEnd) / 2;
    const turnover = avgEmp > 0
      ? parseFloat(((hires + seps) / (2 * avgEmp) * 4 * 100).toFixed(1))
      : null;

    results[fips5] = {
      qwi_employment:       emp     || null,
      qwi_avg_monthly_earn: earn    || null,
      qwi_hires_qtr:        hires   || null,
      qwi_seps_qtr:         seps    || null,
      qwi_turnover_rate:    turnover,
      qwi_vintage:          `${year}-Q${quarter}`,
      qwi_updated_at:       new Date(),
    };
  }
  return results;
}

async function run() {
  if (!CENSUS_KEY) {
    console.error('[qwi] ❌ Census_Data_API env var not set — cannot run');
    process.exit(1);
  }

  console.log('[qwi] Starting QWI worker — FL county workforce indicators');
  const start = Date.now();

  const { year, quarter } = getLatestQwiQuarter();
  console.log(`[qwi] Fetching ${year}-Q${quarter} data for all 67 FL counties...`);

  let countyData;
  try {
    countyData = await fetchQwiFL(year, quarter);
  } catch (e) {
    // Try one quarter earlier if latest not yet available
    console.warn(`[qwi] ${year}-Q${quarter} failed (${e.message}), trying one quarter earlier`);
    let prevQ = quarter - 1, prevY = year;
    if (prevQ < 1) { prevQ = 4; prevY -= 1; }
    countyData = await fetchQwiFL(prevY, prevQ);
  }

  console.log(`[qwi] Got ${Object.keys(countyData).length} counties`);

  // Sample: St. Johns County
  const sjc = countyData['12109'];
  if (sjc) {
    console.log(`[qwi] St. Johns: emp=${sjc.qwi_employment?.toLocaleString()} earn=$${sjc.qwi_avg_monthly_earn} turnover=${sjc.qwi_turnover_rate}%/yr`);
  }

  let countyDone = 0, zipsDone = 0;

  for (const [fips5, signals] of Object.entries(countyData)) {
    const zips = getZipsForCountyFips(fips5);
    if (zips.length === 0) continue;

    for (const zip of zips) {
      await pgStore.upsertZipSignals(zip, signals);
      zipsDone++;
    }
    countyDone++;
  }

  // Heartbeat
  await db.query(
    `INSERT INTO worker_heartbeat (worker_name, last_run) VALUES ('qwiWorker', NOW())
     ON CONFLICT (worker_name) DO UPDATE SET last_run = NOW()`
  ).catch(() => {});

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[qwi] ✅ Done — ${countyDone} counties, ${zipsDone} ZIP upserts — ${elapsed}s`);
  process.exit(0);
}

run().catch(e => { console.error('[qwi] fatal:', e.message); process.exit(1); });
