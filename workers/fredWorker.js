'use strict';
/**
 * fredWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches BLS Local Area Unemployment Statistics (LAUS) for all 67 FL counties
 * via the FRED API (series LAUCN{FIPS5}0000000003 = unemployment rate).
 *
 * Each county's rate is denormalized to all ZIPs in that county in zip_signals.
 *
 * Worker contract:
 *   START → read Postgres for what's done (skip if fresh) → fetch FRED → upsert → END
 *
 * FRED series used:
 *   LAUCN{FIPS5}0000000003  = unemployment rate (%)
 *   LAUCN{FIPS5}0000000006  = civilian labor force (count)
 *   LAUCN{FIPS5}0000000004  = unemployed persons (count)
 *
 * Rate limit: FRED allows ~120 requests/minute with key. We pace at 500ms/series.
 * Total calls: 67 counties × 3 series = 201 calls ≈ ~2 min with pacing.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const https = require('https');
const db    = require('../lib/db');
const pgStore = require('../lib/pgStore');
const { getZipsForCountyFips } = require('../lib/flZipCountyMap');

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const API_KEY   = process.env.FRED_API;
const SLEEP_MS  = 500;  // 500ms between calls → ~2 req/s, well under 120/min limit

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchFred(seriesId) {
  return new Promise((resolve, reject) => {
    // Get last 14 observations so we can compute YoY (12 months back)
    const url = `${FRED_BASE}?series_id=${seriesId}&api_key=${API_KEY}&file_type=json&sort_order=desc&limit=14`;
    https.get(url, { headers: { 'User-Agent': 'LocalIntel-DataWorker/1.0 (erik@mcflamingo.com)' } }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j.error_code) return reject(new Error(`FRED ${seriesId}: ${j.error_message}`));
          resolve(j.observations || []);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function parseLatestAndYoY(obs) {
  // obs sorted desc (newest first), filter out '.' (missing) values
  const valid = obs.filter(o => o.value !== '.');
  if (!valid.length) return { latest: null, vintage: null, yoy: null };
  const latest = parseFloat(valid[0].value);
  const vintage = valid[0].date.substring(0, 7); // "YYYY-MM"
  // YoY: find observation ~12 entries back
  const prior = valid.length >= 13 ? parseFloat(valid[12].value) : null;
  const yoy = prior != null ? parseFloat((latest - prior).toFixed(2)) : null;
  return { latest, vintage, yoy };
}

async function fetchCounty(county) {
  const { fips } = county;
  // LAUCN series: LAUCN + FIPS5 + 10-char suffix
  const rateId   = `LAUCN${fips}0000000003`;  // unemployment rate %
  const lfId     = `LAUCN${fips}0000000006`;  // labor force
  const unempId  = `LAUCN${fips}0000000004`;  // unemployed persons

  const [rateObs, lfObs, unempObs] = await Promise.all([
    fetchFred(rateId).catch(e => { console.warn(`[fred] ${county.name} rate error: ${e.message}`); return []; }),
    sleep(200).then(() => fetchFred(lfId).catch(e => { console.warn(`[fred] ${county.name} lf error: ${e.message}`); return []; })),
    sleep(400).then(() => fetchFred(unempId).catch(e => { console.warn(`[fred] ${county.name} unemp error: ${e.message}`); return []; })),
  ]);

  const { latest: rate, vintage, yoy } = parseLatestAndYoY(rateObs);
  const { latest: lf }   = parseLatestAndYoY(lfObs);
  const { latest: unemp } = parseLatestAndYoY(unempObs);

  if (rate == null) {
    console.warn(`[fred] ${county.name} (${fips}): no valid rate data — skipping`);
    return null;
  }

  console.log(`[fred] ${county.name}: rate=${rate}% lf=${lf} vintage=${vintage}`);
  return {
    fips,
    fred_unemployment_rate: rate,
    fred_labor_force:       lf   ? Math.round(lf)   : null,
    fred_employed:          (lf != null && unemp != null) ? Math.round(lf - unemp) : null,
    fred_unemployment_yoy:  yoy,
    fred_vintage:           vintage,
    fred_updated_at:        new Date(),
  };
}

function getZipsForCounty(fips) {
  // Use pre-built ZIP→county FIPS lookup from censusLayerWorker ZIP registry
  return getZipsForCountyFips(fips);
}

async function run() {
  if (!API_KEY) {
    console.error('[fred] ❌ FRED_API env var not set — cannot run');
    process.exit(1);
  }

  console.log(`[fred] Starting FRED LAUS worker — ${FL_COUNTIES.length} FL counties`);
  const start = Date.now();
  let countyDone = 0, zipsDone = 0, skipped = 0;

  for (const county of FL_COUNTIES) {
    try {
      const data = await fetchCounty(county);
      await sleep(SLEEP_MS); // pace after 3 FRED calls

      if (!data) { skipped++; continue; }

      // Find ZIPs in this county via static ZIP registry
      const zips = getZipsForCounty(data.fips);

      if (zips.length === 0) {
        console.warn(`[fred] ${county.name} (${data.fips}): no ZIPs in registry — skipping`);
        skipped++;
        continue;
      }

      // Upsert each ZIP with county-level signals
      const { fips, ...signals } = data;
      for (const zip of zips) {
        await pgStore.upsertZipSignals(zip, signals);
        zipsDone++;
      }
      countyDone++;
    } catch (e) {
      console.error(`[fred] ${county.name} failed:`, e.message);
    }
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
