'use strict';
/**
 * fredWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches BLS Local Area Unemployment Statistics (LAUS) for all 67 FL counties
 * via the BLS Public Data API v2 (api.bls.gov).
 *
 * BLS supports batch requests: up to 50 series per POST.
 * 67 counties × 3 measures (rate, lf, employed) = 201 series → 5 batch calls.
 *
 * BLS LAUS series format:
 *   LAUCN + FIPS5(5) + 00000000(8) + MEASURE(2)
 *   Measure codes: 03=rate, 06=labor force, 04=unemployed persons
 *   Example: LAUCN120010000000003 = Alachua FL unemployment rate
 *
 * Worker contract:
 *   START → batch fetch BLS → map FIPS → ZIPs → upsert → END
 * ─────────────────────────────────────────────────────────────────────────────
 */

const https   = require('https');
const db      = require('../lib/db');
const pgStore = require('../lib/pgStore');
const { getZipsForCountyFips } = require('../lib/flZipCountyMap');

const BLS_BASE = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
const API_KEY  = process.env.BUREAU_OF_LABOR_STATISTICS_API;

// All 67 FL counties with 5-digit FIPS
const FL_COUNTIES = [
  { name: 'Alachua',       fips: '12001' },
  { name: 'Baker',         fips: '12003' },
  { name: 'Bay',           fips: '12005' },
  { name: 'Bradford',      fips: '12007' },
  { name: 'Brevard',       fips: '12009' },
  { name: 'Broward',       fips: '12011' },
  { name: 'Calhoun',       fips: '12013' },
  { name: 'Charlotte',     fips: '12015' },
  { name: 'Citrus',        fips: '12017' },
  { name: 'Clay',          fips: '12019' },
  { name: 'Collier',       fips: '12021' },
  { name: 'Columbia',      fips: '12023' },
  { name: 'DeSoto',        fips: '12027' },
  { name: 'Dixie',         fips: '12029' },
  { name: 'Duval',         fips: '12031' },
  { name: 'Escambia',      fips: '12033' },
  { name: 'Flagler',       fips: '12035' },
  { name: 'Franklin',      fips: '12037' },
  { name: 'Gadsden',       fips: '12039' },
  { name: 'Gilchrist',     fips: '12041' },
  { name: 'Glades',        fips: '12043' },
  { name: 'Gulf',          fips: '12045' },
  { name: 'Hamilton',      fips: '12047' },
  { name: 'Hardee',        fips: '12049' },
  { name: 'Hendry',        fips: '12051' },
  { name: 'Hernando',      fips: '12053' },
  { name: 'Highlands',     fips: '12055' },
  { name: 'Hillsborough',  fips: '12057' },
  { name: 'Holmes',        fips: '12059' },
  { name: 'Indian River',  fips: '12061' },
  { name: 'Jackson',       fips: '12063' },
  { name: 'Jefferson',     fips: '12065' },
  { name: 'Lafayette',     fips: '12067' },
  { name: 'Lake',          fips: '12069' },
  { name: 'Lee',           fips: '12071' },
  { name: 'Leon',          fips: '12073' },
  { name: 'Levy',          fips: '12075' },
  { name: 'Liberty',       fips: '12077' },
  { name: 'Madison',       fips: '12079' },
  { name: 'Manatee',       fips: '12081' },
  { name: 'Marion',        fips: '12083' },
  { name: 'Martin',        fips: '12085' },
  { name: 'Miami-Dade',    fips: '12086' },
  { name: 'Monroe',        fips: '12087' },
  { name: 'Nassau',        fips: '12089' },
  { name: 'Okaloosa',      fips: '12091' },
  { name: 'Okeechobee',    fips: '12093' },
  { name: 'Orange',        fips: '12095' },
  { name: 'Osceola',       fips: '12097' },
  { name: 'Palm Beach',    fips: '12099' },
  { name: 'Pasco',         fips: '12101' },
  { name: 'Pinellas',      fips: '12103' },
  { name: 'Polk',          fips: '12105' },
  { name: 'Putnam',        fips: '12107' },
  { name: 'St. Johns',     fips: '12109' },
  { name: 'St. Lucie',     fips: '12111' },
  { name: 'Santa Rosa',    fips: '12113' },
  { name: 'Sarasota',      fips: '12115' },
  { name: 'Seminole',      fips: '12117' },
  { name: 'Sumter',        fips: '12119' },
  { name: 'Suwannee',      fips: '12121' },
  { name: 'Taylor',        fips: '12123' },
  { name: 'Union',         fips: '12125' },
  { name: 'Volusia',       fips: '12127' },
  { name: 'Wakulla',       fips: '12129' },
  { name: 'Walton',        fips: '12131' },
  { name: 'Washington',    fips: '12133' },
];

// Build series IDs for a county
function seriesIds(fips) {
  return {
    rate:   `LAUCN${fips}0000000003`,
    lf:     `LAUCN${fips}0000000006`,
    unemp:  `LAUCN${fips}0000000004`,
  };
}

// POST batch request to BLS API v2
function blsBatch(seriesList) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      seriesid: seriesList,
      registrationkey: API_KEY,
      latest: true,   // only most recent observation
    });

    const options = {
      hostname: 'api.bls.gov',
      path: '/publicAPI/v2/timeseries/data/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'LocalIntel-DataWorker/1.0 (erik@mcflamingo.com)',
      },
    };

    const req = https.request(options, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j.status !== 'REQUEST_SUCCEEDED') {
            const msg = (j.message || []).join('; ');
            return reject(new Error(`BLS batch failed: ${j.status} — ${msg}`));
          }
          // Build map: seriesID → { value, year, period }
          const map = {};
          for (const s of (j.Results?.series || [])) {
            const obs = s.data?.[0]; // latest=true returns 1 observation
            if (obs && obs.value !== '-') {
              map[s.seriesID] = {
                value:  parseFloat(obs.value),
                year:   obs.year,
                period: obs.period, // M01-M12
              };
            }
          }
          resolve(map);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Chunk array into batches of n
function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function run() {
  if (!API_KEY) {
    console.error('[fred] ❌ BUREAU_OF_LABOR_STATISTICS_API env var not set — cannot run');
    process.exit(1);
  }

  console.log(`[fred] Starting FRED/BLS LAUS worker — ${FL_COUNTIES.length} FL counties via BLS API v2`);
  const start = Date.now();

  // Build all series IDs (67 counties × 3 = 201 series)
  const allSeries = [];
  for (const c of FL_COUNTIES) {
    const ids = seriesIds(c.fips);
    allSeries.push(ids.rate, ids.lf, ids.unemp);
  }

  // Batch into groups of 50 (BLS limit) → 5 batches
  const batches = chunks(allSeries, 50);
  console.log(`[fred] Fetching ${allSeries.length} series in ${batches.length} BLS batch calls`);

  const resultMap = {};
  for (let i = 0; i < batches.length; i++) {
    try {
      const batchResult = await blsBatch(batches[i]);
      Object.assign(resultMap, batchResult);
      console.log(`[fred] Batch ${i + 1}/${batches.length} — got ${Object.keys(batchResult).length} series`);
    } catch (e) {
      console.error(`[fred] Batch ${i + 1} failed:`, e.message);
    }
  }

  let countyDone = 0, zipsDone = 0, skipped = 0;

  for (const county of FL_COUNTIES) {
    const ids = seriesIds(county.fips);
    const rateObs  = resultMap[ids.rate];
    const lfObs    = resultMap[ids.lf];
    const unempObs = resultMap[ids.unemp];

    if (!rateObs) {
      console.warn(`[fred] ${county.name} (${county.fips}): no rate data — skipping`);
      skipped++;
      continue;
    }

    const rate    = rateObs.value;
    const lf      = lfObs   ? Math.round(lfObs.value)    : null;
    const unemp   = unempObs ? Math.round(unempObs.value) : null;
    const vintage = `${rateObs.year}-${rateObs.period.replace('M', '').padStart(2, '0')}`;

    console.log(`[fred] ${county.name}: rate=${rate}% lf=${lf} vintage=${vintage}`);

    const zips = getZipsForCountyFips(county.fips);
    if (zips.length === 0) {
      console.warn(`[fred] ${county.name} (${county.fips}): no ZIPs in registry`);
      skipped++;
      continue;
    }

    const signals = {
      fred_unemployment_rate: rate,
      fred_labor_force:       lf,
      fred_employed:          (lf != null && unemp != null) ? lf - unemp : null,
      fred_unemployment_yoy:  null,
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
