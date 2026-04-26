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
const path  = require('path');
const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────────
const DATA_DIR          = path.join(__dirname, '..', 'data');
const ZIPS_DIR          = path.join(DATA_DIR, 'osm');
const SPENDING_ZONES_FP = path.join(DATA_DIR, 'spendingZones.json');
const CSV_CACHE_FP      = path.join(DATA_DIR, 'irs_soi_2022.csv');
const CSV_URL           = 'https://www.irs.gov/pub/irs-soi/22zpallagi.csv';
const FL_STATEFIPS      = '12';
const LOOP_SLEEP_H      = 24;
const CSV_MAX_AGE_H     = 72;   // re-download every 3 days

// agi_stub midpoints ($000s × 1000 = actual $)
const STUB_MIDPOINTS = { '1': 12500, '2': 37500, '3': 62500, '4': 87500, '5': 150000, '6': 350000 };

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
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

// ── Load / save helpers ───────────────────────────────────────────────────────
function loadZipFile(zip) {
  const fp = path.join(ZIPS_DIR, `${zip}.json`);
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return {}; }
}

function saveZipFile(zip, data) {
  ensureDir(ZIPS_DIR);
  fs.writeFileSync(path.join(ZIPS_DIR, `${zip}.json`), JSON.stringify(data));
  // Mirror IRS enrichment fields to Postgres (non-blocking)
  if (process.env.LOCAL_INTEL_DB_URL && data.irs_agi_median !== undefined) {
    const { upsertIrsEnrichment } = require('../lib/pgStore');
    upsertIrsEnrichment(zip, {
      irs_agi_median:  data.irs_agi_median,
      irs_returns:     data.irs_returns,
      irs_wage_share:  data.irs_wage_share,
      irs_updated_at:  data.irs_updated_at,
    }).catch(e => console.warn('[irsSoi] Postgres write failed:', e.message));
  }
}

function loadSpendingZones() {
  try { return JSON.parse(fs.readFileSync(SPENDING_ZONES_FP, 'utf8')); }
  catch { return []; }
}

function saveSpendingZones(zones) {
  fs.writeFileSync(SPENDING_ZONES_FP, JSON.stringify(zones, null, 2));
}

// ── Main enrichment pass ──────────────────────────────────────────────────────
async function runPass() {
  // 1. Ensure CSV is available
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

  // 3. Enrich data/zips/{zip}.json for every FL ZIP we have data for
  let enriched = 0;
  for (const [zip, stubs] of byZip.entries()) {
    const metrics  = computeMetrics(stubs);
    const existing = loadZipFile(zip);
    saveZipFile(zip, { ...existing, zip, ...metrics });
    enriched++;
  }
  console.log(`[irs-soi] Enriched ${enriched} ZIP files`);

  // 4. Also patch spendingZones.json entries that have matching ZIPs
  const zones   = loadSpendingZones();
  let   patched = 0;
  for (const zone of zones) {
    const zip = zone.zip || zone.zipCode;
    if (!zip) continue;
    const stubs = byZip.get(String(zip).padStart(5, '0'));
    if (!stubs) continue;
    const metrics = computeMetrics(stubs);
    Object.assign(zone, metrics);
    patched++;
  }
  if (patched > 0) {
    saveSpendingZones(zones);
    console.log(`[irs-soi] Patched ${patched} spendingZones entries`);
  }
}

// ── Daemon loop ───────────────────────────────────────────────────────────────
(async function main() {
  console.log('[irs-soi] Worker started');
  while (true) {
    try { await runPass(); }
    catch (err) { console.error('[irs-soi] Pass crashed:', err.message); }
    console.log(`[irs-soi] Sleeping ${LOOP_SLEEP_H}h`);
    await sleep(LOOP_SLEEP_H * 60 * 60 * 1000);
  }
})();
