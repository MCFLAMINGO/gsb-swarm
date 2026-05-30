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
// Generate a sequence of candidate QWI quarters to try, newest-first.
// QWI typically lags 2-3 quarters, but can be longer. We try up to 8 back.
function qwiCandidates() {
  const now = new Date();
  let qtr = Math.floor(now.getMonth() / 3) + 1;
  let yr  = now.getFullYear();
  const candidates = [];
  // Start 2 quarters back (minimum lag) and walk back 8 total
  for (let i = 0; i < 8; i++) {
    qtr--;
    if (qtr < 1) { qtr = 4; yr--; }
    candidates.push({ year: yr, quarter: qtr });
  }
  return candidates;
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

  // Freshness check — skip if ran within 180 days (QWI vintage is annual) — QWI_FORCE=true bypasses
  const forceRun = process.env.QWI_FORCE === 'true';
  try {
    const hb = await db.query(`SELECT last_run FROM worker_heartbeat WHERE worker_name = 'qwiWorker'`);
    if (!forceRun && Array.isArray(hb) && hb[0]?.last_run) {
      const ageDays = (Date.now() - new Date(hb[0].last_run).getTime()) / 86400000;
      if (ageDays < 180) {  // QWI vintage is annual — re-run every 180 days
        console.log(`[qwi] Data fresh (${ageDays.toFixed(1)} days old, window 90d) — skipping. Use QWI_FORCE=true to override.`);
        process.exit(0);
      }
    }
  } catch (_) { /* no heartbeat yet — run */ }
  if (forceRun) console.log('[qwi] QWI_FORCE=true — bypassing 90-day heartbeat skip');

  console.log('[qwi] Starting QWI worker — FL county workforce indicators');
  const start = Date.now();

  const candidates = qwiCandidates();
  console.log(`[qwi] Will try up to ${candidates.length} quarters: ${candidates.map(c => `${c.year}-Q${c.quarter}`).join(', ')}`);

  let countyData = null;
  let usedVintage = null;
  for (const { year, quarter } of candidates) {
    try {
      console.log(`[qwi] Fetching ${year}-Q${quarter} data for all 67 FL counties...`);
      countyData = await fetchQwiFL(year, quarter);
      usedVintage = `${year}-Q${quarter}`;
      console.log(`[qwi] ✓ Got data for ${usedVintage}`);
      break;
    } catch (e) {
      console.warn(`[qwi] ${year}-Q${quarter} not available (${e.message.slice(0, 80)}), trying earlier...`);
    }
  }
  if (!countyData) {
    console.error('[qwi] ❌ Could not find any available QWI quarter after 8 attempts');
    process.exit(1);
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
