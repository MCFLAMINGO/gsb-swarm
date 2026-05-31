'use strict';
/**
 * censusMacroWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Macro-level Census economic intelligence — three datasets, three schedules.
 * All data lands in Postgres. No flat files. No /tmp state.
 *
 * WHY THIS WORKER EXISTS:
 *   censusLayerWorker handles ZIP-level structural data (ZBP/CBP/PDB).
 *   This worker handles macro + nonemployer data that censusLayerWorker
 *   does not touch — the full picture of economic activity including solo
 *   operators, revenue, and new business formation velocity.
 *
 * ── DATASETS ─────────────────────────────────────────────────────────────────
 *
 * LAYER A: BDS — Business Dynamics Statistics (annual, county-level)
 *   Source:  api.census.gov/data/timeseries/bds
 *   Vintage: 2019–2023 (annual, ~12 month lag)
 *   Geo:     County FIPS (all 67 FL counties)
 *   Writes:  macro_indicators (source='bds') + zip_signals.macro_bfs_apps_latest
 *   Why:     County-level establishment entry/exit, firm counts, employment.
 *            ESTABS_ENTRY = new establishments entering market — proxy for
 *            business formation velocity. Oracle uses this to score ZIP momentum.
 *            NOTE: Original BFS endpoint (timeseries/bfs, BA_BA variables) does
 *            not exist as a county-level Census API — only national via eits/bfs.
 *            BDS is the correct county-level replacement.
 *   Schedule: Annual (180d TTL — BDS data updated once per year)
 *
 * LAYER B: NES — Nonemployer Statistics (annual, ZIP-level)
 *   Source:  api.census.gov/data/{year}/nonemp (ZCTA level)
 *   Vintage: 2021 (most recent available at ZIP level)
 *   Geo:     ZCTA (ZIP code tabulation area) — all FL ZIPs
 *   Writes:  zip_macro_signals (nes_* columns)
 *            zip_signals.macro_nes_total_firms (summary col)
 *   Why:     CBP only counts employer businesses (W-2 payroll).
 *            NES counts solo operators and gig workers — often 3-5x the
 *            employer count. True economic density is CBP + NES combined.
 *            JEPA uses this to detect underserved solo-operator clusters.
 *   Schedule: Annual (runs once, skips if nes_updated_at < 300 days ago)
 *
 * LAYER C: Economic Census 2022 (annual, ZIP-level)
 *   Source:  api.census.gov/data/2022/ecnbasic
 *   Vintage: 2022 (5-year Economic Census — most granular ever)
 *   Geo:     ZIP code (ZIPCODE variable)
 *   Writes:  zip_macro_signals (ecn_* columns)
 *            zip_signals.macro_ecn_total_sales_k (summary col)
 *   Why:     ZBP counts establishments. Economic Census has REVENUE.
 *            Revenue + payroll by ZIP+NAICS sector is the most complete
 *            picture of what money is actually flowing through a market.
 *            Oracle uses ecn_sales_per_employee as productivity proxy.
 *   Schedule: One-time pull (5-year vintage, never changes)
 *
 * ── WORLD MODEL / JEPA / ORACLE ACCESS ───────────────────────────────────────
 *   Oracle:  reads zip_macro_signals by ZIP JOIN on zip_signals
 *   JEPA:    uses bfs_county_apps_highprop trend from macro_indicators
 *            to predict ZIP-level business formation probability
 *   MCP:     local_intel_signal tool reads macro_nes_total_firms +
 *            macro_ecn_total_sales_k from zip_signals (no JOIN needed)
 *
 * ── WORKER CONTRACT ───────────────────────────────────────────────────────────
 *   START → read Postgres for what's done (skip) → WORK only new → END
 *   → upsert to Postgres → REDEPLOY SAFE (idempotent)
 *   No flat files. No /tmp writes for state. Heartbeat via worker_heartbeat.
 */

const https  = require('https');
const db     = require('../lib/db');
const { ping: updateHeartbeat, isFresh } = require('../lib/workerHeartbeat');

// Census API key — required as of May 2026. Set in Railway as Census_Data_API.
const CENSUS_KEY = process.env.Census_Data_API || '';
if (!CENSUS_KEY) console.warn('[censusMacro] WARNING: Census_Data_API not set — all Census API calls will fail');

// ── Config ────────────────────────────────────────────────────────────────────
const WORKER_NAME     = 'censusMacroWorker';
const FL_STATE_FIPS   = '12';
const LOOP_SLEEP_H    = 24;          // check daily, each layer gates itself
const BFS_TTL_DAYS    = 180;         // re-fetch BDS annually (BDS updated once/year)
const NES_TTL_DAYS    = 300;         // re-fetch NES annually
const ECN_TTL_DAYS    = 999;         // Economic Census 2022 — one-time pull

// All 67 FL counties: { name, fips (2-digit county code within FL) }
const FL_COUNTIES = [
  { name: 'Alachua',       fips: '001' }, { name: 'Baker',         fips: '003' },
  { name: 'Bay',           fips: '005' }, { name: 'Bradford',      fips: '007' },
  { name: 'Brevard',       fips: '009' }, { name: 'Broward',       fips: '011' },
  { name: 'Calhoun',       fips: '013' }, { name: 'Charlotte',     fips: '015' },
  { name: 'Citrus',        fips: '017' }, { name: 'Clay',          fips: '019' },
  { name: 'Collier',       fips: '021' }, { name: 'Columbia',      fips: '023' },
  { name: 'DeSoto',        fips: '027' }, { name: 'Dixie',         fips: '029' },
  { name: 'Duval',         fips: '031' }, { name: 'Escambia',      fips: '033' },
  { name: 'Flagler',       fips: '035' }, { name: 'Franklin',      fips: '037' },
  { name: 'Gadsden',       fips: '039' }, { name: 'Gilchrist',     fips: '041' },
  { name: 'Glades',        fips: '043' }, { name: 'Gulf',          fips: '045' },
  { name: 'Hamilton',      fips: '047' }, { name: 'Hardee',        fips: '049' },
  { name: 'Hendry',        fips: '051' }, { name: 'Hernando',      fips: '053' },
  { name: 'Highlands',     fips: '055' }, { name: 'Hillsborough',  fips: '057' },
  { name: 'Holmes',        fips: '059' }, { name: 'Indian River',  fips: '061' },
  { name: 'Jackson',       fips: '063' }, { name: 'Jefferson',     fips: '065' },
  { name: 'Lafayette',     fips: '067' }, { name: 'Lake',          fips: '069' },
  { name: 'Lee',           fips: '071' }, { name: 'Leon',          fips: '073' },
  { name: 'Levy',          fips: '075' }, { name: 'Liberty',       fips: '077' },
  { name: 'Madison',       fips: '079' }, { name: 'Manatee',       fips: '081' },
  { name: 'Marion',        fips: '083' }, { name: 'Martin',        fips: '085' },
  { name: 'Miami-Dade',    fips: '086' }, { name: 'Monroe',        fips: '087' },
  { name: 'Nassau',        fips: '089' }, { name: 'Okaloosa',      fips: '091' },
  { name: 'Okeechobee',    fips: '093' }, { name: 'Orange',        fips: '095' },
  { name: 'Osceola',       fips: '097' }, { name: 'Palm Beach',    fips: '099' },
  { name: 'Pasco',         fips: '101' }, { name: 'Pinellas',      fips: '103' },
  { name: 'Polk',          fips: '105' }, { name: 'Putnam',        fips: '107' },
  { name: 'St. Johns',     fips: '109' }, { name: 'St. Lucie',     fips: '111' },
  { name: 'Santa Rosa',    fips: '113' }, { name: 'Sarasota',      fips: '115' },
  { name: 'Seminole',      fips: '117' }, { name: 'Sumter',        fips: '119' },
  { name: 'Suwannee',      fips: '121' }, { name: 'Taylor',        fips: '123' },
  { name: 'Union',         fips: '125' }, { name: 'Volusia',       fips: '127' },
  { name: 'Wakulla',       fips: '129' }, { name: 'Walton',        fips: '131' },
  { name: 'Washington',    fips: '133' },
];

// NES NAICS sectors we care about (maps to zip_macro_signals columns)
const NES_SECTORS = {
  '23':    'construction_firms',
  '44':    'retail_firms',      // 44-45 combined — use 44 as proxy
  '54':    'prof_firms',
  '62':    'health_firms',
  '72':    'food_firms',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'LocalIntel/1.0 (localintel@mcflamingo.com)' } }, res => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`JSON parse failed for ${url}: ${e.message}`)); }
      });
    }).on('error', reject).setTimeout(30000, function () { this.destroy(new Error(`Timeout: ${url}`)); });
  });
}

function toN(v) { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; }

// Get the most recent period for a source/geo from macro_indicators
async function getLatestPeriod(source, geoId) {
  const rows = await db.query(
    `SELECT period FROM macro_indicators WHERE source=$1 AND geo_id=$2 ORDER BY period DESC LIMIT 1`,
    [source, geoId]
  );
  return rows.length ? rows[0].period : null;
}

// Check NES freshness per ZIP from zip_macro_signals
async function getNesStaleZips(allZips) {
  const cutoff = new Date(Date.now() - NES_TTL_DAYS * 86400 * 1000);
  const fresh = await db.query(
    `SELECT zip FROM zip_macro_signals WHERE nes_updated_at > $1`,
    [cutoff]
  );
  const freshSet = new Set(fresh.map(r => r.zip));
  return allZips.filter(z => !freshSet.has(z));
}

// Check ECN freshness per ZIP
async function getEcnStaleZips(allZips) {
  const rows = await db.query(
    `SELECT zip FROM zip_macro_signals WHERE ecn_updated_at IS NOT NULL`
  );
  const doneSet = new Set(rows.map(r => r.zip));
  return allZips.filter(z => !doneSet.has(z));
}

// ── LAYER A: BDS — Business Dynamics Statistics (replaces defunct BFS county API) ──
// timeseries/bfs with BA_BA county variables does not exist — 404 with valid key.
// BDS (timeseries/bds) is the correct county-level source: ESTABS_ENTRY = new
// establishments entering market, annual, 2019-2023, all 67 FL counties.
async function ingestBFS() {
  console.log('[censusMacro] BDS: fetching Business Dynamics Statistics (county establishment entry/exit)...');
  let ingested = 0;
  let skipped  = 0;

  // BDS is annual — fetch all years from 2019 to latest (2023)
  // One request per county gets all years in one shot
  for (const { name, fips } of FL_COUNTIES) {
    const geoId = `${FL_STATE_FIPS}${fips}`;
    const latest = await getLatestPeriod('bds', geoId);

    // BDS latest vintage is 2023 — skip if we already have it
    if (latest && latest >= '2023') {
      skipped++;
      continue;
    }

    try {
      // BDS API: establishment entry/exit, firm count, employment — annual, county-level
      // NAICS=00 = all sectors combined
      const url = `https://api.census.gov/data/timeseries/bds?get=ESTABS_ENTRY,ESTABS_EXIT,ESTABS_ENTRY_RATE,FIRM,EMP,YEAR&for=county:${fips}&in=state:${FL_STATE_FIPS}&NAICS=00&time=from+2019&key=${CENSUS_KEY}`;
      const raw = await fetchJson(url);

      if (!Array.isArray(raw) || raw.length < 2) {
        console.warn(`[censusMacro] BDS: bad response for ${name}:`, raw?.error || raw?.message || JSON.stringify(raw)?.slice(0,80));
        continue;
      }

      const headers    = raw[0];
      const idxEntry   = headers.indexOf('ESTABS_ENTRY');
      const idxExit    = headers.indexOf('ESTABS_EXIT');
      const idxRate    = headers.indexOf('ESTABS_ENTRY_RATE');
      const idxFirm    = headers.indexOf('FIRM');
      const idxEmp     = headers.indexOf('EMP');
      const idxYear    = headers.indexOf('YEAR');

      // Upsert each year row into macro_indicators
      for (let i = 1; i < raw.length; i++) {
        const row    = raw[i];
        const period = String(row[idxYear]); // '2023' etc
        const metrics = {
          estabs_entry:      toN(row[idxEntry]),
          estabs_exit:       toN(row[idxExit]),
          estabs_entry_rate: parseFloat(row[idxRate]) || 0,
          firms:             toN(row[idxFirm]),
          emp:               toN(row[idxEmp]),
        };

        await db.query(
          `INSERT INTO macro_indicators (source, geo_type, geo_id, geo_name, period, metrics, vintage, fetched_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
           ON CONFLICT (source, geo_id, period) DO UPDATE SET
             metrics    = EXCLUDED.metrics,
             fetched_at = NOW()`,
          ['bds', 'county', geoId, `${name} County, FL`, period, JSON.stringify(metrics), '2019-2023']
        );
      }

      // Stamp latest year values onto every ZIP in this county
      const latestRow     = raw[raw.length - 1];
      const latestPeriod  = String(latestRow[idxYear]);
      const latestEntry   = toN(latestRow[idxEntry]);
      const latestExit    = toN(latestRow[idxExit]);
      const latestFirms   = toN(latestRow[idxFirm]);

      // Get ZIPs in this county via fl_zip_geo FIPS join
      const countyFips = `12${fips}`;
      const countyZips = await db.query(
        `SELECT DISTINCT z.zip FROM zip_signals z
         JOIN fl_zip_geo g ON g.zip = z.zip
         WHERE g.county_fips = $1`,
        [countyFips]
      );
      // Fallback: county name match
      const resolvedZips = countyZips.length > 0
        ? countyZips
        : await db.query(`SELECT zip FROM zip_signals WHERE county ILIKE $1`, [name]);

      if (resolvedZips.length === 0) {
        console.warn(`[censusMacro] BDS: no ZIPs found for ${name} (fips=${countyFips}) — skipping stamp`);
      }

      for (const { zip } of resolvedZips) {
        // zip_macro_signals: reuse bfs_county_* columns (same schema, BDS values)
        await db.query(
          `INSERT INTO zip_macro_signals (zip, bfs_county_apps_total, bfs_county_apps_highprop, bfs_county_wba, bfs_county_period, bfs_updated_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
           ON CONFLICT (zip) DO UPDATE SET
             bfs_county_apps_total    = EXCLUDED.bfs_county_apps_total,
             bfs_county_apps_highprop = EXCLUDED.bfs_county_apps_highprop,
             bfs_county_wba           = EXCLUDED.bfs_county_wba,
             bfs_county_period        = EXCLUDED.bfs_county_period,
             bfs_updated_at           = NOW(),
             updated_at               = NOW()`,
          // ESTABS_ENTRY → apps_total, ESTABS_EXIT → apps_highprop repurposed, firms → wba
          [zip, latestEntry, latestExit, latestFirms, latestPeriod]
        );
        // Summary col in zip_signals — ESTABS_ENTRY is the formation velocity signal
        await db.query(
          `INSERT INTO zip_signals (zip, macro_bfs_apps_latest, macro_updated_at, last_updated_at)
           VALUES ($1,$2,NOW(),NOW())
           ON CONFLICT (zip) DO UPDATE SET
             macro_bfs_apps_latest = EXCLUDED.macro_bfs_apps_latest,
             macro_updated_at      = NOW(),
             last_updated_at       = NOW()`,
          [zip, latestEntry]
        );
      }

      ingested++;
      await sleep(200); // BDS is less rate-limited than BFS was
    } catch (err) {
      console.error(`[censusMacro] BDS failed for ${name}:`, err.message);
    }
  }

  console.log(`[censusMacro] BDS: ${ingested} counties ingested, ${skipped} skipped (fresh)`);
}

// ── LAYER B: NES — Nonemployer Statistics ────────────────────────────────────
async function ingestNES(targetZips) {
  const stale = await getNesStaleZips(targetZips);
  if (stale.length === 0) {
    console.log('[censusMacro] NES: all ZIPs fresh — skipping');
    return;
  }
  console.log(`[censusMacro] NES: fetching nonemployer stats for ${stale.length} ZIPs...`);

  // NES is available at ZCTA level via the nonemp API
  // Fetch FL statewide (state:12) — all ZCTAs in one call, filter to our ZIPs
  try {
    const url = `https://api.census.gov/data/2021/nonemp?get=NESTALL,RCPTALL,NAICS2017&for=zip+code+tabulation+area:*&in=state:${FL_STATE_FIPS}&key=${CENSUS_KEY}`;
    const raw = await fetchJson(url);

    if (!Array.isArray(raw) || raw.length < 2) {
      console.warn('[censusMacro] NES: bad response:', raw?.error || raw?.message || JSON.stringify(raw)?.slice(0,80));
      return;
    }

    const headers  = raw[0];
    const idxFirms = headers.indexOf('NESTALL');
    const idxRcpt  = headers.indexOf('RCPTALL');
    const idxNaics = headers.indexOf('NAICS2017');
    const idxZcta  = headers.indexOf('zip code tabulation area');

    // Aggregate by ZCTA
    const byZip = {};
    for (let i = 1; i < raw.length; i++) {
      const row  = raw[i];
      const zip  = row[idxZcta];
      const naics = (row[idxNaics] || '').slice(0, 2);
      if (!byZip[zip]) {
        byZip[zip] = {
          total_firms: 0, total_receipts_k: 0,
          food_firms: 0, retail_firms: 0, health_firms: 0,
          prof_firms: 0, construction_firms: 0,
        };
      }
      const firms = toN(row[idxFirms]);
      const rcpt  = Math.round(toN(row[idxRcpt]) / 1000); // $000s

      if (naics === '00') {
        // Total row
        byZip[zip].total_firms       += firms;
        byZip[zip].total_receipts_k  += rcpt;
      } else {
        // Sector row
        const col = NES_SECTORS[naics];
        if (col) byZip[zip][col] += firms;
      }
    }

    let done = 0;
    for (const zip of stale) {
      const d = byZip[zip];
      if (!d) continue;

      const receiptsPerFirm = d.total_firms > 0
        ? Math.round((d.total_receipts_k * 1000) / d.total_firms)
        : null;

      await db.query(
        `INSERT INTO zip_macro_signals (
           zip, nes_total_firms, nes_total_receipts_k, nes_receipts_per_firm,
           nes_food_firms, nes_retail_firms, nes_health_firms, nes_prof_firms,
           nes_construction_firms, nes_vintage, nes_updated_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
         ON CONFLICT (zip) DO UPDATE SET
           nes_total_firms          = EXCLUDED.nes_total_firms,
           nes_total_receipts_k     = EXCLUDED.nes_total_receipts_k,
           nes_receipts_per_firm    = EXCLUDED.nes_receipts_per_firm,
           nes_food_firms           = EXCLUDED.nes_food_firms,
           nes_retail_firms         = EXCLUDED.nes_retail_firms,
           nes_health_firms         = EXCLUDED.nes_health_firms,
           nes_prof_firms           = EXCLUDED.nes_prof_firms,
           nes_construction_firms   = EXCLUDED.nes_construction_firms,
           nes_vintage              = EXCLUDED.nes_vintage,
           nes_updated_at           = NOW(),
           updated_at               = NOW()`,
        [zip, d.total_firms, d.total_receipts_k, receiptsPerFirm,
         d.food_firms, d.retail_firms, d.health_firms, d.prof_firms,
         d.construction_firms, '2021']
      );

      // Summary col in zip_signals
      await db.query(
        `INSERT INTO zip_signals (zip, macro_nes_total_firms, macro_updated_at, last_updated_at)
         VALUES ($1,$2,NOW(),NOW())
         ON CONFLICT (zip) DO UPDATE SET
           macro_nes_total_firms = EXCLUDED.macro_nes_total_firms,
           macro_updated_at      = NOW(),
           last_updated_at       = NOW()`,
        [zip, d.total_firms]
      );
      done++;
    }
    console.log(`[censusMacro] NES: ${done} ZIPs ingested`);
  } catch (err) {
    console.error('[censusMacro] NES failed:', err.message);
  }
}

// ── LAYER C: Economic Census 2022 ─────────────────────────────────────────────
async function ingestEcn(targetZips) {
  const stale = await getEcnStaleZips(targetZips);
  if (stale.length === 0) {
    console.log('[censusMacro] ECN: all ZIPs done — skipping (5-year vintage)');
    return;
  }
  console.log(`[censusMacro] ECN: fetching Economic Census 2022 for ${stale.length} ZIPs...`);

  // Economic Census basic stats: ESTAB, PAYANN, EMP, RCPTOT by NAICS sector
  // Available at ZIP level via ZIPCODE variable
  // Fetch FL all ZIPs in one call (state:12), all sectors (NAICS2017=00 for totals)
  try {
    const url = `https://api.census.gov/data/2022/ecnbasic?get=ESTAB,PAYANN,EMP,RCPTOT,NAICS2017&for=zipcode:*&in=state:${FL_STATE_FIPS}&key=${CENSUS_KEY}`;
    const raw = await fetchJson(url);

    if (!Array.isArray(raw) || raw.length < 2) {
      console.warn('[censusMacro] ECN: bad response:', raw?.error || raw?.message || JSON.stringify(raw)?.slice(0,80));
      return;
    }

    const headers   = raw[0];
    const idxEstab  = headers.indexOf('ESTAB');
    const idxPay    = headers.indexOf('PAYANN');
    const idxEmp    = headers.indexOf('EMP');
    const idxRcpt   = headers.indexOf('RCPTOT');
    const idxNaics  = headers.indexOf('NAICS2017');
    const idxZip    = headers.indexOf('zipcode');

    const byZip = {};
    for (let i = 1; i < raw.length; i++) {
      const row   = raw[i];
      const zip   = row[idxZip];
      const naics = (row[idxNaics] || '').slice(0, 2);
      if (!byZip[zip]) byZip[zip] = { total: null, sectors: {} };

      const estab   = toN(row[idxEstab]);
      const payK    = Math.round(toN(row[idxPay]) / 1000);
      const emp     = toN(row[idxEmp]);
      const salesK  = Math.round(toN(row[idxRcpt]) / 1000);

      if (naics === '00') {
        byZip[zip].total = { estab, payK, emp, salesK };
      } else if (naics.length === 2) {
        byZip[zip].sectors[naics] = { estab, payK, emp, salesK };
      }
    }

    let done = 0;
    for (const zip of stale) {
      const d = byZip[zip];
      if (!d || !d.total) continue;

      const t = d.total;
      const salesPerEmp = t.emp > 0 ? Math.round((t.salesK * 1000) / t.emp) : null;
      const avgEmpPerFirm = t.estab > 0
        ? Math.round((t.emp / t.estab) * 10) / 10
        : null;

      await db.query(
        `INSERT INTO zip_macro_signals (
           zip, ecn_total_estab, ecn_total_sales_k, ecn_total_payroll_k,
           ecn_total_employees, ecn_avg_employees_per_firm, ecn_sales_per_employee,
           ecn_sector_json, ecn_vintage, ecn_updated_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
         ON CONFLICT (zip) DO UPDATE SET
           ecn_total_estab             = EXCLUDED.ecn_total_estab,
           ecn_total_sales_k           = EXCLUDED.ecn_total_sales_k,
           ecn_total_payroll_k         = EXCLUDED.ecn_total_payroll_k,
           ecn_total_employees         = EXCLUDED.ecn_total_employees,
           ecn_avg_employees_per_firm  = EXCLUDED.ecn_avg_employees_per_firm,
           ecn_sales_per_employee      = EXCLUDED.ecn_sales_per_employee,
           ecn_sector_json             = EXCLUDED.ecn_sector_json,
           ecn_vintage                 = EXCLUDED.ecn_vintage,
           ecn_updated_at              = NOW(),
           updated_at                  = NOW()`,
        [zip, t.estab, t.salesK, t.payK, t.emp,
         avgEmpPerFirm, salesPerEmp,
         JSON.stringify(d.sectors), '2022']
      );

      // Summary col in zip_signals
      await db.query(
        `INSERT INTO zip_signals (zip, macro_ecn_total_sales_k, macro_updated_at, last_updated_at)
         VALUES ($1,$2,NOW(),NOW())
         ON CONFLICT (zip) DO UPDATE SET
           macro_ecn_total_sales_k = EXCLUDED.macro_ecn_total_sales_k,
           macro_updated_at        = NOW(),
           last_updated_at         = NOW()`,
        [zip, t.salesK]
      );
      done++;
    }
    console.log(`[censusMacro] ECN: ${done} ZIPs ingested`);
  } catch (err) {
    console.error('[censusMacro] ECN failed:', err.message);
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('[censusMacro] worker starting...');

  // Wait for DB to be ready
  let dbReady = false;
  for (let i = 0; i < 10; i++) {
    try {
      await db.query('SELECT 1');
      dbReady = true;
      break;
    } catch (e) {
      console.warn(`[censusMacro] DB not ready (attempt ${i+1}/10) — retrying in 5s`);
      await sleep(5000);
    }
  }
  if (!dbReady) {
    console.error('[censusMacro] DB never ready — exiting');
    process.exit(1);
  }

  while (true) {
    try {
      // Heartbeat gate — 28 days TTL (BFS monthly, others annual/one-time gate themselves)
      // Override: if macro_bfs_apps_latest is null/0 statewide, data was never written — force run
      const [bfsCheck] = await db.query(
        `SELECT COUNT(*) AS n FROM zip_signals WHERE macro_bfs_apps_latest IS NOT NULL AND macro_bfs_apps_latest > 0 AND state = 'FL'`
      );
      const bfsPopulated = parseInt(bfsCheck?.n || 0) > 0;
      if (bfsPopulated && await isFresh(WORKER_NAME, BFS_TTL_DAYS * 24 * 3600 * 1000)) {
        console.log(`[censusMacro] heartbeat fresh + BFS data present (${bfsCheck.n} ZIPs) — sleeping ${LOOP_SLEEP_H}h`);
        await sleep(LOOP_SLEEP_H * 3600 * 1000);
        continue;
      }
      if (!bfsPopulated) {
        console.log(`[censusMacro] macro_bfs_apps_latest is empty statewide — forcing BFS ingest despite heartbeat`);
      }

      // Get all FL ZIPs from zip_signals
      const zipRows = await db.query(`SELECT zip FROM zip_signals WHERE state = 'FL' ORDER BY zip`);
      const allZips = zipRows.map(r => r.zip);
      console.log(`[censusMacro] processing ${allZips.length} FL ZIPs`);

      await ingestBFS();
      await sleep(2000);
      await ingestNES(allZips);
      await sleep(2000);
      await ingestEcn(allZips);

      // Count rows written as signal of real work done
      const [countRow] = await db.query(`SELECT COUNT(*) AS n FROM macro_indicators`);
      await updateHeartbeat(WORKER_NAME, parseInt(countRow?.n || 0));
      console.log(`[censusMacro] cycle complete — sleeping ${LOOP_SLEEP_H}h`);
    } catch (err) {
      console.error('[censusMacro] cycle error:', err.message);
      const { pingError } = require('../lib/workerHeartbeat');
      await pingError(WORKER_NAME, err.message).catch(() => {});
    }

    await sleep(LOOP_SLEEP_H * 3600 * 1000);
  }
}

main();
