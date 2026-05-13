'use strict';
/**
 * lodesWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Downloads LEHD LODES8 FL bulk CSV files, aggregates census block → ZIP,
 * and upserts job counts per ZIP into zip_signals.
 *
 * Files used (all public, no auth):
 *   WAC: fl_wac_S000_JT00_{year}.csv.gz  — jobs WITH WORKPLACE in each block
 *   RAC: fl_rac_S000_JT00_{year}.csv.gz  — workers LIVING in each block
 *   XWALK: fl_xwalk.csv.gz               — block → ZCTA crosswalk
 *
 * WAC columns used:
 *   C000  = total jobs
 *   CNS07 = Retail Trade
 *   CNS12 = Accommodation & Food Services
 *   CNS18 = Health Care & Social Assistance
 *   CNS10 = Information (tech proxy)
 *   CE01  = earnings <$1250/mo (low)
 *   CE03  = earnings >$3333/mo (high)
 *
 * RAC columns used:
 *   C000  = total workers living here
 *   CNS07 = retail workers living here
 *   CNS12 = food/hospitality workers living here
 *   CNS18 = healthcare workers living here
 *
 * Worker contract:
 *   START → check heartbeat (skip if <24h) → download 3 files → aggregate → upsert → END
 *
 * Runtime: ~90-120s (download ~11MB compressed, process 390k blocks → 1013 ZIPs)
 * Memory: ~200MB peak (holds 3 files + block maps in memory) — acceptable on Railway
 * ─────────────────────────────────────────────────────────────────────────────
 */

const https   = require('https');
const http    = require('http');
const zlib    = require('zlib');
const db      = require('../lib/db');
const pgStore = require('../lib/pgStore');

const LODES_BASE = 'https://lehd.ces.census.gov/data/lodes/LODES8/fl';
const VINTAGE    = '2022';  // Latest stable LODES8 FL release

function downloadGz(url) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, { headers: { 'User-Agent': 'LocalIntel-DataWorker/1.0 (erik@mcflamingo.com)' } }, res => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const gunzip = zlib.createGunzip();
      res.pipe(gunzip);
      gunzip.on('data', c => chunks.push(c));
      gunzip.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      gunzip.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

function parseCsv(text) {
  const lines = text.split('\n');
  if (!lines.length) return { header: [], rows: [] };
  const header = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    rows.push(line.split(','));
  }
  return { header, rows };
}

function buildIndex(header) {
  const idx = {};
  header.forEach((h, i) => { idx[h.trim()] = i; });
  return idx;
}

async function run() {
  console.log('[lodes] Starting LODES worker — FL WAC + RAC block aggregation');
  const start = Date.now();

  // Skip if run recently (LODES is annual data)
  const hb = await db.query(
    `SELECT last_run FROM worker_heartbeat WHERE worker_name = 'lodesWorker'`
  ).catch(() => []);
  if (Array.isArray(hb) && hb.length) {
    const age = Date.now() - new Date(hb[0].last_run).getTime();
    const days = age / 86400000;
    if (days < 7) {
      console.log(`[lodes] Skipping — ran ${days.toFixed(1)} days ago (LODES is annual)`);
      process.exit(0);
    }
  }

  // ── 1. Download crosswalk ──────────────────────────────────────────────────
  console.log('[lodes] Downloading crosswalk...');
  const xwalkText = await downloadGz(`${LODES_BASE}/fl_xwalk.csv.gz`);
  const { header: xwalkH, rows: xwalkRows } = parseCsv(xwalkText);
  const xi = buildIndex(xwalkH);

  const blockToZip = new Map();
  for (const row of xwalkRows) {
    const blk  = row[xi['tabblk2020']];
    const zcta = row[xi['zcta']];
    if (blk && zcta && zcta !== '99999') blockToZip.set(blk, zcta);
  }
  console.log(`[lodes] Crosswalk: ${blockToZip.size} blocks → ZIPs`);

  // ── 2. Download + aggregate WAC (workplace) ────────────────────────────────
  console.log('[lodes] Downloading WAC...');
  const wacText = await downloadGz(`${LODES_BASE}/wac/fl_wac_S000_JT00_${VINTAGE}.csv.gz`);
  const { header: wacH, rows: wacRows } = parseCsv(wacText);
  const wi = buildIndex(wacH);

  const wacByZip = new Map();
  for (const row of wacRows) {
    const zcta = blockToZip.get(row[wi['w_geocode']]);
    if (!zcta) continue;

    if (!wacByZip.has(zcta)) wacByZip.set(zcta, { total:0, retail:0, food:0, health:0, tech:0, low:0, high:0 });
    const z = wacByZip.get(zcta);
    z.total  += parseInt(row[wi['C000']]  || 0, 10);
    z.retail += parseInt(row[wi['CNS07']] || 0, 10);
    z.food   += parseInt(row[wi['CNS12']] || 0, 10);
    z.health += parseInt(row[wi['CNS18']] || 0, 10);
    z.tech   += parseInt(row[wi['CNS10']] || 0, 10);
    z.low    += parseInt(row[wi['CE01']]  || 0, 10);
    z.high   += parseInt(row[wi['CE03']]  || 0, 10);
  }
  console.log(`[lodes] WAC: aggregated ${wacByZip.size} ZIPs`);

  // ── 3. Download + aggregate RAC (residence) ────────────────────────────────
  console.log('[lodes] Downloading RAC...');
  const racText = await downloadGz(`${LODES_BASE}/rac/fl_rac_S000_JT00_${VINTAGE}.csv.gz`);
  const { header: racH, rows: racRows } = parseCsv(racText);
  const ri = buildIndex(racH);

  const racByZip = new Map();
  for (const row of racRows) {
    const zcta = blockToZip.get(row[ri['h_geocode']]);
    if (!zcta) continue;

    if (!racByZip.has(zcta)) racByZip.set(zcta, { total:0, retail:0, food:0, health:0 });
    const z = racByZip.get(zcta);
    z.total  += parseInt(row[ri['C000']]  || 0, 10);
    z.retail += parseInt(row[ri['CNS07']] || 0, 10);
    z.food   += parseInt(row[ri['CNS12']] || 0, 10);
    z.health += parseInt(row[ri['CNS18']] || 0, 10);
  }
  console.log(`[lodes] RAC: aggregated ${racByZip.size} ZIPs`);

  // ── 4. Upsert to zip_signals ───────────────────────────────────────────────
  const allZips = new Set([...wacByZip.keys(), ...racByZip.keys()]);
  let done = 0;

  for (const zip of allZips) {
    const wac = wacByZip.get(zip) || { total:0, retail:0, food:0, health:0, tech:0, low:0, high:0 };
    const rac = racByZip.get(zip) || { total:0, retail:0, food:0, health:0 };

    const highPct = wac.total > 0 ? parseFloat((wac.high / wac.total * 100).toFixed(1)) : null;
    const lowPct  = wac.total > 0 ? parseFloat((wac.low  / wac.total * 100).toFixed(1)) : null;
    const netFlow = wac.total - rac.total;

    await pgStore.upsertZipSignals(zip, {
      lodes_jobs_here:         wac.total  || null,
      lodes_retail_jobs:       wac.retail || null,
      lodes_food_jobs:         wac.food   || null,
      lodes_healthcare_jobs:   wac.health || null,
      lodes_tech_jobs:         wac.tech   || null,
      lodes_high_earn_pct:     highPct,
      lodes_low_earn_pct:      lowPct,
      lodes_workers_live_here: rac.total  || null,
      lodes_live_retail:       rac.retail || null,
      lodes_live_food:         rac.food   || null,
      lodes_live_healthcare:   rac.health || null,
      lodes_net_flow:          netFlow,
      lodes_vintage:           VINTAGE,
      lodes_updated_at:        new Date(),
    });
    done++;

    if (done % 100 === 0) console.log(`[lodes] Upserted ${done}/${allZips.size} ZIPs`);
  }

  // Heartbeat
  await db.query(
    `INSERT INTO worker_heartbeat (worker_name, last_run) VALUES ('lodesWorker', NOW())
     ON CONFLICT (worker_name) DO UPDATE SET last_run = NOW()`
  ).catch(() => {});

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[lodes] ✅ Done — ${done} ZIP upserts — ${elapsed}s`);
  process.exit(0);
}

run().catch(e => { console.error('[lodes] fatal:', e.message); process.exit(1); });
