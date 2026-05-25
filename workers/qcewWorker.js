'use strict';
/**
 * qcewWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches BLS Quarterly Census of Employment and Wages (QCEW) for all 67 FL
 * counties via the BLS Public Data API v2, then denormalizes to ZIPs.
 *
 * Series fetched per county (3 series × 67 counties = 201 series total):
 *   ENU{FIPS5}10010  = all-industry private employment (count)
 *   ENU{FIPS5}10410  = all-industry private establishments (count)
 *   ENU{FIPS5}10540  = all-industry average weekly wages ($)
 *
 * BLS batch limit: 50 series per POST call.
 * 201 series / 50 = 5 calls (last call has 1 series).
 * With 1 call per 1.5s pacing → ~8 seconds total.
 *
 * YoY calculation: BLS returns annual data per year. We pull 2 years and
 * compute (current - prior) / prior * 100 in-worker — no LLM, pure math.
 *
 * Worker contract:
 *   START → read Postgres (skip if fresh < 30 days) → batch BLS calls
 *         → compute YoY → upsert all ZIPs → heartbeat → END
 *
 * API env var: BUREAU_OF_LABOR_STATISTICS_API (Railway)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const https  = require('https');
const db     = require('../lib/db');
const pgStore = require('../lib/pgStore');
const { getZipsForCountyFips } = require('../lib/flZipCountyMap');

const BLS_API_URL = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
const API_KEY     = process.env.BUREAU_OF_LABOR_STATISTICS_API;
const BATCH_SIZE  = 50;   // BLS hard limit per call
const PACE_MS     = 1500; // 1.5s between batch calls — BLS rate limit is lenient with key

// All 67 FL counties with 5-digit FIPS — same list as fredWorker
const FL_COUNTIES = [
  { name: 'Alachua',       fips: '12001' }, { name: 'Baker',         fips: '12003' },
  { name: 'Bay',           fips: '12005' }, { name: 'Bradford',      fips: '12007' },
  { name: 'Brevard',       fips: '12009' }, { name: 'Broward',       fips: '12011' },
  { name: 'Calhoun',       fips: '12013' }, { name: 'Charlotte',     fips: '12015' },
  { name: 'Citrus',        fips: '12017' }, { name: 'Clay',          fips: '12019' },
  { name: 'Collier',       fips: '12021' }, { name: 'Columbia',      fips: '12023' },
  { name: 'DeSoto',        fips: '12027' }, { name: 'Dixie',         fips: '12029' },
  { name: 'Duval',         fips: '12031' }, { name: 'Escambia',      fips: '12033' },
  { name: 'Flagler',       fips: '12035' }, { name: 'Franklin',      fips: '12037' },
  { name: 'Gadsden',       fips: '12039' }, { name: 'Gilchrist',     fips: '12041' },
  { name: 'Glades',        fips: '12043' }, { name: 'Gulf',          fips: '12045' },
  { name: 'Hamilton',      fips: '12047' }, { name: 'Hardee',        fips: '12049' },
  { name: 'Hendry',        fips: '12051' }, { name: 'Hernando',      fips: '12053' },
  { name: 'Highlands',     fips: '12055' }, { name: 'Hillsborough',  fips: '12057' },
  { name: 'Holmes',        fips: '12059' }, { name: 'Indian River',  fips: '12061' },
  { name: 'Jackson',       fips: '12063' }, { name: 'Jefferson',     fips: '12065' },
  { name: 'Lafayette',     fips: '12067' }, { name: 'Lake',          fips: '12069' },
  { name: 'Lee',           fips: '12071' }, { name: 'Leon',          fips: '12073' },
  { name: 'Levy',          fips: '12075' }, { name: 'Liberty',       fips: '12077' },
  { name: 'Madison',       fips: '12079' }, { name: 'Manatee',       fips: '12081' },
  { name: 'Marion',        fips: '12083' }, { name: 'Martin',        fips: '12085' },
  { name: 'Miami-Dade',    fips: '12086' }, { name: 'Monroe',        fips: '12087' },
  { name: 'Nassau',        fips: '12089' }, { name: 'Okaloosa',      fips: '12091' },
  { name: 'Okeechobee',    fips: '12093' }, { name: 'Orange',        fips: '12095' },
  { name: 'Osceola',       fips: '12097' }, { name: 'Palm Beach',    fips: '12099' },
  { name: 'Pasco',         fips: '12101' }, { name: 'Pinellas',      fips: '12103' },
  { name: 'Polk',          fips: '12105' }, { name: 'Putnam',        fips: '12107' },
  { name: 'St. Johns',     fips: '12109' }, { name: 'St. Lucie',     fips: '12111' },
  { name: 'Santa Rosa',    fips: '12113' }, { name: 'Sarasota',      fips: '12115' },
  { name: 'Seminole',      fips: '12117' }, { name: 'Sumter',        fips: '12119' },
  { name: 'Suwannee',      fips: '12121' }, { name: 'Taylor',        fips: '12123' },
  { name: 'Union',         fips: '12125' }, { name: 'Volusia',       fips: '12127' },
  { name: 'Wakulla',       fips: '12129' }, { name: 'Walton',        fips: '12131' },
  { name: 'Washington',    fips: '12133' },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Build series ID array for a batch of counties.
 * Each county produces 3 series: 10010 (emp), 10410 (estab), 10540 (wages)
 */
function buildSeriesIds(counties) {
  const ids = [];
  for (const c of counties) {
    ids.push(`ENU${c.fips}10010`);  // employment
    ids.push(`ENU${c.fips}10410`);  // establishments
    ids.push(`ENU${c.fips}10540`);  // avg weekly wages
  }
  return ids;
}

/**
 * POST to BLS batch API with up to 50 series IDs.
 * Requests last 2 annual periods so we can compute YoY.
 */
function blsBatchPost(seriesIds) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      seriesid: seriesIds,
      registrationkey: API_KEY,
      annualaverage: false,
      calculations: false,
      // No startyear/endyear — BLS returns most recent by default when omitted
      // but we need at least 2 years for YoY, so request last 3 years to be safe
      startyear: String(new Date().getFullYear() - 2),
      endyear:   String(new Date().getFullYear()),
    });
    const opts = {
      method: 'POST',
      hostname: 'api.bls.gov',
      path: '/publicAPI/v2/timeseries/data/',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     'LocalIntel-DataWorker/1.0 (erik@mcflamingo.com)',
      },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.status === 'REQUEST_NOT_PROCESSED') {
            return reject(new Error('BLS API: REQUEST_NOT_PROCESSED — ' + (j.message?.join(', ') || 'unknown')));
          }
          resolve(j);
        } catch (e) {
          reject(new Error(`BLS JSON parse error: ${e.message} — body: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Parse BLS series response into a map: fips5 → { emp, estab, wages, empYoy, wageYoy, vintage }
 */
function parseBLSResponse(blsJson) {
  const results = {};  // fips5 → signals

  if (!blsJson?.Results?.series) {
    console.warn('[qcew] BLS response had no Results.series');
    return results;
  }

  for (const series of blsJson.Results.series) {
    const sid = series.seriesID;           // e.g. "ENU1210910010"
    if (!sid || sid.length < 14) continue;

    // Series format: ENU + FIPS5(5) + seasonadj(1) + datatype(4) + ownership(2)
    // Actually: ENU + fips5 + "10010" (6 chars)
    // sid = "ENU" + "12109" + "10010" → length 13
    const fips5   = sid.substring(3, 8);   // chars 3–7 = 5-digit FIPS
    const metric  = sid.substring(8);      // "10010", "10410", "10540"

    if (!results[fips5]) results[fips5] = {};

    // Get most recent 2 annual values (data sorted desc by year)
    // QCEW ENU series returns monthly data (Jan–Dec), no 'Annual' period.
    // Use December (M12) as the year-end proxy for each year.
    const validData = (series.data || [])
      .filter(d => d.value !== '-' && d.value !== '0' && d.period === 'M12')
      .sort((a, b) => parseInt(b.year) - parseInt(a.year));

    if (!validData.length) continue;

    const current = parseInt(validData[0].value.replace(/,/g, ''), 10);
    const prior   = validData.length > 1
      ? parseInt(validData[1].value.replace(/,/g, ''), 10)
      : null;
    const yoyPct  = (prior && prior > 0)
      ? parseFloat(((current - prior) / prior * 100).toFixed(1))
      : null;
    const vintage = validData[0].year;  // "2024" or "2025"

    if (metric === '10010') {
      results[fips5].employment = current || null;
      results[fips5].emp_yoy_pct = yoyPct;
      results[fips5].vintage = vintage;
    } else if (metric === '10410') {
      results[fips5].establishments = current || null;
    } else if (metric === '10540') {
      results[fips5].avg_weekly_wages = current || null;
      results[fips5].wage_yoy_pct = yoyPct;
    }
  }

  return results;
}

/**
 * Check freshness — skip if all counties already loaded within 30 days.
 */
async function isFresh() {
  try {
    const row = await db.queryOne(
      `SELECT last_run FROM worker_heartbeat WHERE worker_name = 'qcewWorker'`
    );
    if (!row) return false;
    const ageMs = Date.now() - new Date(row.last_run).getTime();
    return ageMs < 90 * 24 * 60 * 60 * 1000;  // 90 days — QCEW is quarterly data, benchmarked annually
  } catch {
    return false;
  }
}

async function run() {
  if (!API_KEY) {
    console.error('[qcew] ❌ BUREAU_OF_LABOR_STATISTICS_API env var not set — cannot run');
    process.exit(1);
  }

  const forceRun = process.env.QCEW_FORCE === 'true';
  const fresh = await isFresh();
  if (!forceRun && fresh) {
    console.log('[qcew] ⏭ Data is fresh (< 90 days old) — skipping. Use QCEW_FORCE=true to override.');
    process.exit(0);
  }
  if (forceRun) console.log('[qcew] QCEW_FORCE=true — bypassing 90-day heartbeat skip');

  console.log(`[qcew] Starting QCEW worker — ${FL_COUNTIES.length} FL counties, 3 series each`);
  const start = Date.now();

  // Build all 201 series IDs, then chunk into batches of 50
  const allSeriesIds = buildSeriesIds(FL_COUNTIES);
  const batches = [];
  for (let i = 0; i < allSeriesIds.length; i += BATCH_SIZE) {
    batches.push(allSeriesIds.slice(i, i + BATCH_SIZE));
  }
  console.log(`[qcew] ${allSeriesIds.length} series → ${batches.length} batch calls`);

  // Fetch all batches
  const merged = {};   // fips5 → parsed signals
  for (let i = 0; i < batches.length; i++) {
    try {
      console.log(`[qcew] Batch ${i + 1}/${batches.length} — ${batches[i].length} series`);
      const blsJson = await blsBatchPost(batches[i]);
      const parsed  = parseBLSResponse(blsJson);
      Object.assign(merged, parsed);

      if (i < batches.length - 1) await sleep(PACE_MS);
    } catch (e) {
      console.error(`[qcew] Batch ${i + 1} failed:`, e.message);
      // Continue — partial data better than no data
    }
  }

  const countiesGot = Object.keys(merged).length;
  console.log(`[qcew] Parsed ${countiesGot} counties from BLS response`);

  // Sample: St. Johns County validation
  const sjc = merged['12109'];
  if (sjc) {
    console.log(`[qcew] St. Johns (12109): emp=${sjc.employment?.toLocaleString()} estab=${sjc.establishments?.toLocaleString()} wages=$${sjc.avg_weekly_wages}/wk empYoY=${sjc.emp_yoy_pct}% wageYoY=${sjc.wage_yoy_pct}% vintage=${sjc.vintage}`);
  } else {
    console.warn('[qcew] ⚠ St. Johns (12109) not found in response — check series IDs');
  }

  // Upsert to zip_signals via county→ZIP fan-out
  let countyDone = 0, zipsDone = 0, skipped = 0;

  for (const [fips5, signals] of Object.entries(merged)) {
    if (!signals.employment && !signals.establishments && !signals.avg_weekly_wages) {
      skipped++;
      continue;
    }

    const zips = getZipsForCountyFips(fips5);
    if (zips.length === 0) { skipped++; continue; }

    const payload = {
      qcew_establishments:   signals.establishments   || null,
      qcew_employment:       signals.employment       || null,
      qcew_avg_weekly_wages: signals.avg_weekly_wages || null,
      qcew_emp_yoy_pct:      signals.emp_yoy_pct      != null ? signals.emp_yoy_pct   : null,
      qcew_wage_yoy_pct:     signals.wage_yoy_pct     != null ? signals.wage_yoy_pct  : null,
      qcew_vintage:          signals.vintage          || null,
      qcew_updated_at:       new Date(),
    };

    for (const zip of zips) {
      await pgStore.upsertZipSignals(zip, payload);
      zipsDone++;
    }
    countyDone++;
  }

  // Heartbeat
  await db.query(
    `INSERT INTO worker_heartbeat (worker_name, last_run) VALUES ('qcewWorker', NOW())
     ON CONFLICT (worker_name) DO UPDATE SET last_run = NOW()`
  ).catch(() => {});

  const elapsed = ((Date.now() - start) / 1000).toFixed(1)  ;
  console.log(`[qcew] ✅ Done — ${countyDone} counties, ${zipsDone} ZIP upserts, ${skipped} skipped — ${elapsed}s`);
  process.exit(0);
}

run().catch(e => { console.error('[qcew] fatal:', e.message); process.exit(1); });
