'use strict';
/**
 * irsSoiWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * IRS Statistics of Income (SOI) 2022 — ZIP-level income enrichment for FL.
 *
 * Source: https://www.irs.gov/pub/irs-soi/22zpallagi.csv
 *   Key fields: STATEFIPS, zipcode, agi_stub (1-6 income bands), N1 (returns),
 *               A00100 (AGI $000s), A00200 (wages $000s), N00200 (wage returns)
 *
 * What it does:
 *  - Downloads the CSV once (cached to data/irs_soi_2022.csv)
 *  - Parses rows where STATEFIPS=12 (Florida)
 *  - For each ZIP: computes weighted-median AGI, total returns, wage share
 *  - Merges result into data/zips/{zip}.json  ← { irs_agi_median, irs_returns, irs_wage_share, irs_updated_at }
 *  - Also enriches data/spendingZones.json entries that match a FL ZIP
 *  - Runs once per day (24-h loop)
 *
 * agi_stub bands (IRS definition):
 *   1: <$25k  2: $25k-$50k  3: $50k-$75k  4: $75k-$100k  5: $100k-$200k  6: >$200k
 * Midpoints used for weighted median: 12.5k, 37.5k, 62.5k, 87.5k, 150k, 350k
 */

const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const https = require('https');

const db = require('../lib/db');
const { fetchZctaBoundary, computeCentroid } = require('../lib/fetchZctaBoundary');

// ── Config ────────────────────────────────────────────────────────────────────
// CSV is source data — temp file is fine. State/results live in Postgres.
const TMP_DIR           = os.tmpdir();
const CSV_CACHE_FP      = path.join(TMP_DIR, 'irs_soi_2022.csv');
const CSV_URL           = 'https://www.irs.gov/pub/irs-soi/22zpallagi.csv';
const FL_STATEFIPS      = '12';
const LOOP_SLEEP_H      = 24;         // 24h sleep — Node setTimeout overflows >24.8d
const FRESH_H           = 24 * 180;   // 180d freshness window — IRS SOI is annual data
const CSV_MAX_AGE_H     = 72;   // re-download every 3 days
const FULL_REFRESH      = process.env.FULL_REFRESH === 'true';

// agi_stub midpoints ($000s × 1000 = actual $)
const STUB_MIDPOINTS = { '1': 12500, '2': 37500, '3': 62500, '4': 87500, '5': 150000, '6': 350000 };

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function ensureSchema() {
  await db.query(`
    ALTER TABLE zip_intelligence
      ADD COLUMN IF NOT EXISTS irs_agi_median NUMERIC,
      ADD COLUMN IF NOT EXISTS irs_returns INTEGER,
      ADD COLUMN IF NOT EXISTS irs_wage_share NUMERIC,
      ADD COLUMN IF NOT EXISTS irs_updated_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS county_name TEXT,
      ADD COLUMN IF NOT EXISTS county_fips TEXT,
      ADD COLUMN IF NOT EXISTS city_name TEXT,
      ADD COLUMN IF NOT EXISTS lat NUMERIC,
      ADD COLUMN IF NOT EXISTS lon NUMERIC
  `);
  // Seed county + city + lat/lon from flZipSeed if not yet populated
  try {
    const unseeded = await db.query(`SELECT COUNT(*) AS cnt FROM zip_intelligence WHERE county_name IS NULL`);
    if (parseInt(unseeded[0].cnt) > 0) {
      const seed = require('./flZipSeed.json');
      let seeded = 0;
      for (const z of seed) {
        await db.query(
          `UPDATE zip_intelligence SET county_name=$1, county_fips=$2, city_name=$3, lat=$4, lon=$5
           WHERE zip=$6 AND county_name IS NULL`,
          [z.county, z.county_fips, z.city, z.lat, z.lon, z.zip]
        );
        seeded++;
      }
      console.log(`[irs-soi] seeded county/city/lat/lon for ${seeded} ZIPs`);
    }
  } catch (e) {
    console.warn('[irs-soi] county seed failed (non-fatal):', e.message);
  }
}

async function getEnrichedZipSet() {
  if (FULL_REFRESH) return new Set();
  try {
    const rows = await db.query(
      `SELECT zip FROM zip_intelligence WHERE irs_agi_median IS NOT NULL`
    );
    return new Set(rows.map(r => String(r.zip).padStart(5, '0')));
  } catch (e) {
    console.warn('[irs-soi] enriched-zip lookup failed:', e.message);
    return new Set();
  }
}

async function upsertIrsRow(zip, m) {
  await db.query(
    `INSERT INTO zip_intelligence (zip, irs_agi_median, irs_returns, irs_wage_share, irs_updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (zip) DO UPDATE SET
       irs_agi_median = EXCLUDED.irs_agi_median,
       irs_returns    = EXCLUDED.irs_returns,
       irs_wage_share = EXCLUDED.irs_wage_share,
       irs_updated_at = NOW()`,
    [zip, m.irs_agi_median, m.irs_returns, m.irs_wage_share_pct]
  );

  // World model — write irs_* signals into zip_signals
  const { upsertZipSignals } = require('../lib/pgStore');
  upsertZipSignals(zip, {
    irs_agi_median: m.irs_agi_median || null,
    irs_returns:    m.irs_returns    || null,
    irs_wage_share: m.irs_wage_share_pct || null,
    irs_updated_at: new Date(),
  }).catch(() => {});

  // Fetch ZCTA boundary for this ZIP if not yet stored — fire-and-forget
  db.query('SELECT boundary_geojson FROM zip_intelligence WHERE zip=$1', [zip])
    .then(async rows => {
      if (rows.length && rows[0].boundary_geojson) return;
      const geom = await fetchZctaBoundary(zip);
      if (!geom) return;
      const c = computeCentroid(geom);
      await db.query(
        `UPDATE zip_intelligence SET boundary_geojson=$1, lat=COALESCE(lat,$2), lon=COALESCE(lon,$3), updated_at=now() WHERE zip=$4`,
        [JSON.stringify(geom), c?.lat ?? null, c?.lon ?? null, zip]
      );
    })
    .catch(e => console.warn(`[irs-soi] boundary fetch skipped for ${zip}:`, e.message));
}

function csvFresh() {
  try {
    const st = fs.statSync(CSV_CACHE_FP);
    return (Date.now() - st.mtimeMs) < CSV_MAX_AGE_H * 60 * 60 * 1000;
  } catch { return false; }
}

// ── Download CSV ──────────────────────────────────────────────────────────────
function downloadCsv() {
  return new Promise((resolve, reject) => {
    console.log('[irs-soi] Downloading IRS SOI 2022 CSV...');
    const file = fs.createWriteStream(CSV_CACHE_FP);
    https.get(CSV_URL, { headers: { 'User-Agent': 'LocalIntel/1.0' } }, res => {
      if (res.statusCode !== 200) {
        return reject(new Error(`IRS CSV HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        const sz = fs.statSync(CSV_CACHE_FP).size;
        console.log(`[irs-soi] Downloaded ${(sz / 1024 / 1024).toFixed(1)} MB`);
        resolve();
      });
    }).on('error', err => { fs.unlink(CSV_CACHE_FP, () => {}); reject(err); });
  });
}

// ── Parse CSV → Map<zip, {stubs}> ─────────────────────────────────────────────
function parseFlorida() {
  const raw = fs.readFileSync(CSV_CACHE_FP, 'utf8');
  const lines = raw.split('\n');
  const header = lines[0].split(',').map(h => h.trim().toUpperCase());
  const idx = name => header.indexOf(name);

  const iSTATEFIPS = idx('STATEFIPS');
  const iZIP       = idx('ZIPCODE');
  const iSTUB      = idx('AGI_STUB');
  const iN1        = idx('N1');
  const iA00100    = idx('A00100');
  const iN00200    = idx('N00200');
  const iA00200    = idx('A00200');

  // Fallback: some files use different casing
  const safe = (line, i) => (i >= 0 ? (line[i] || '').trim() : '');

  const byZip = new Map(); // zip → { [stub]: { n1, agi_k, nWage, wageK } }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].split(',');
    if (safe(line, iSTATEFIPS) !== FL_STATEFIPS) continue;
    const zip  = safe(line, iZIP).padStart(5, '0');
    const stub = safe(line, iSTUB);
    if (!stub || stub === '0') continue; // stub=0 is aggregate, skip

    const n1    = parseFloat(safe(line, iN1))    || 0;
    const agiK  = parseFloat(safe(line, iA00100)) || 0; // $000s
    const nWage = parseFloat(safe(line, iN00200)) || 0;
    const wageK = parseFloat(safe(line, iA00200)) || 0;

    if (!byZip.has(zip)) byZip.set(zip, {});
    byZip.get(zip)[stub] = { n1, agiK, nWage, wageK };
  }

  console.log(`[irs-soi] Parsed ${byZip.size} FL ZIPs from CSV`);
  return byZip;
}

// ── Weighted median AGI ────────────────────────────────────────────────────────
function computeMetrics(stubs) {
  let totalReturns = 0;
  let totalAgiK    = 0;
  let totalNWage   = 0;
  let totalWageK   = 0;

  for (const [stub, d] of Object.entries(stubs)) {
    if (stub === '0') continue;
    totalReturns += d.n1;
    totalAgiK    += d.agiK;
    totalNWage   += d.nWage;
    totalWageK   += d.wageK;
  }

  // Weighted median: find stub where cumulative returns cross 50%
  const half = totalReturns / 2;
  let cum = 0;
  let medianAgi = 0;
  for (let s = 1; s <= 6; s++) {
    const d = stubs[String(s)];
    if (!d) continue;
    cum += d.n1;
    if (cum >= half) {
      medianAgi = STUB_MIDPOINTS[String(s)] || 0;
      break;
    }
  }

  const avgAgi      = totalReturns > 0 ? Math.round((totalAgiK * 1000) / totalReturns) : 0;
  const wageShare   = totalReturns > 0 ? Math.round((totalNWage / totalReturns) * 100) : 0;
  const avgWage     = totalNWage  > 0  ? Math.round((totalWageK * 1000) / totalNWage)  : 0;

  return {
    irs_agi_median    : medianAgi,
    irs_agi_avg       : avgAgi,
    irs_returns       : totalReturns,
    irs_wage_share_pct: wageShare,
    irs_avg_wage      : avgWage,
    irs_updated_at    : new Date().toISOString(),
  };
}

// ── Main enrichment pass ──────────────────────────────────────────────────────
async function runPass() {
  await ensureSchema();

  // Step 1 of the contract: ASK Postgres what's already done.
  const enrichedSet = await getEnrichedZipSet();

  // 1. Ensure CSV is available (source data — temp file is fine)
  if (!csvFresh()) {
    try { await downloadCsv(); }
    catch (err) {
      console.error('[irs-soi] CSV download failed:', err.message);
      return;
    }
  } else {
    console.log('[irs-soi] Using cached CSV');
  }

  // 2. Parse Florida rows
  let byZip;
  try { byZip = parseFlorida(); }
  catch (err) { console.error('[irs-soi] Parse failed:', err.message); return; }

  // 3. Upsert each ZIP into zip_intelligence (skipping already-enriched unless FULL_REFRESH)
  let enriched = 0, skipped = 0, errors = 0;
  for (const [zip, stubs] of byZip.entries()) {
    if (enrichedSet.has(zip)) { skipped++; continue; }
    try {
      const metrics = computeMetrics(stubs);
      await upsertIrsRow(zip, metrics);
      enriched++;
    } catch (e) {
      errors++;
      if (errors <= 3) console.warn(`[irs-soi] upsert ${zip} failed:`, e.message);
    }
  }
  console.log(`[irs-soi] Enriched ${enriched} ZIPs; skipped:${skipped} errors:${errors}`);
}

// ── Daemon loop ───────────────────────────────────────────────────────────────
(async function main() {
  const hb = require('../lib/workerHeartbeat');
  const FRESH_MS = FRESH_H * 60 * 60 * 1000;         // 180d freshness check
  const SLEEP_MS  = LOOP_SLEEP_H * 60 * 60 * 1000;   // 24h sleep (avoids overflow)
  console.log('[irs-soi] Worker started');
  while (true) {
    if (await hb.isFresh('irsSoiWorker', FRESH_MS)) {
      console.log('[irs-soi] Fresh — skipping pass');
    } else {
      try { await runPass(); await hb.ping('irsSoiWorker'); }
      catch (err) { console.error('[irs-soi] Pass crashed:', err.message); await hb.pingError('irsSoiWorker', err.message); }
    }
    console.log('[irs-soi] Sleeping 24h');
    await db.disconnect(); // release connection slot during sleep
    await sleep(SLEEP_MS);
    // pool reconnects lazily on next db.query()
  }
})();
