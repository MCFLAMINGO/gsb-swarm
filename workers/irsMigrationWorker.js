'use strict';
/**
 * irsMigrationWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * IRS SOI County-to-County Migration Data (2021–2022).
 *
 * Sources:
 *   Inflow:  https://www.irs.gov/pub/irs-soi/countyinflow2122.csv
 *   Outflow: https://www.irs.gov/pub/irs-soi/countyoutflow2122.csv
 *
 * Inflow CSV columns:
 *   y2_statefips, y2_countyfips = destination (where they moved TO)
 *   y1_statefips, y1_countyfips = origin (where they moved FROM)
 *   n1 = returns (households), n2 = exemptions, agi = AGI ($000s)
 *
 * Outflow CSV columns (same but y1=source, y2=destination):
 *   y1_statefips, y1_countyfips = origin (where they moved FROM = FL county)
 *   y2_statefips, y2_countyfips = destination (where they moved TO)
 *
 * What we compute per FL county:
 *   irs_mig_in_returns    — total returns moving INTO county (y2=FL, y1_fips < 90)
 *   irs_mig_out_returns   — total returns moving OUT of county (y1=FL, y2_fips < 90)
 *   irs_mig_in_agi        — AGI ($000s) moving in
 *   irs_mig_out_agi       — AGI ($000s) moving out
 *   irs_mig_net_returns   — in - out
 *   irs_mig_net_agi       — in_agi - out_agi
 *   irs_mig_top_origin    — county sending the most returns INTO this county
 *   irs_mig_top_dest      — county receiving the most returns FROM this county
 *   irs_mig_vintage       — '2021-2022'
 *
 * County-level signals are then apportioned equally to all ZIPs in each county.
 * (ZIP-level migration data is not published by IRS — county is the finest grain.)
 *
 * Runs once per week. Skips ZIPs already fresh within 6 days.
 * Caches CSVs to /tmp for up to 72 hours.
 */

const fs    = require('fs');
const os    = require('os');
const https = require('https');
const path  = require('path');
const db    = require('../lib/db');
const { upsertZipSignals } = require('../lib/pgStore');

const INFLOW_URL  = 'https://www.irs.gov/pub/irs-soi/countyinflow2122.csv';
const OUTFLOW_URL = 'https://www.irs.gov/pub/irs-soi/countyoutflow2122.csv';
const INFLOW_PATH  = path.join(os.tmpdir(), 'irs_mig_inflow2122.csv');
const OUTFLOW_PATH = path.join(os.tmpdir(), 'irs_mig_outflow2122.csv');
const CSV_MAX_AGE_H = 72;
const CYCLE_H = 24;           // 24h sleep — Node setTimeout overflows >24.8d
const FRESH_H = 24 * 180;     // 180d freshness window — IRS migration is annual
const SKIP_FRESH_H = 6 * 24;  // per-ZIP skip window (6 days)
const FL_FIPS = '12';
const VINTAGE = '2021-2022';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function csvFresh(fp) {
  try {
    return (Date.now() - fs.statSync(fp).mtimeMs) < CSV_MAX_AGE_H * 3600000;
  } catch { return false; }
}

function downloadFile(url, fp) {
  return new Promise((resolve, reject) => {
    console.log(`[irsMig] Downloading ${path.basename(fp)}...`);
    const file = fs.createWriteStream(fp);
    https.get(url, { headers: { 'User-Agent': 'LocalIntel-IRS-Migration/1.0' } }, res => {
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        const sz = fs.statSync(fp).size;
        console.log(`[irsMig] Downloaded ${path.basename(fp)} — ${(sz/1024).toFixed(0)} KB`);
        resolve();
      });
    }).on('error', err => { fs.unlink(fp, () => {}); reject(err); });
  });
}

// Parse CSV into array of objects
function parseCsv(fp) {
  const raw = fs.readFileSync(fp, 'utf8');
  const lines = raw.split('\n');
  if (!lines.length) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(',');
    const obj = {};
    headers.forEach((h, j) => { obj[h] = (cols[j] || '').trim(); });
    rows.push(obj);
  }
  return rows;
}

// Build per-FL-county migration aggregates from inflow CSV
// Inflow: y2_statefips=12 (FL) is destination
function buildInflowByCounty(rows) {
  // county_fips (3-digit) → { returns, agi, topOrigin: {county, returns} }
  const byCounty = {};

  for (const r of rows) {
    if (r.y2_statefips !== FL_FIPS) continue; // only FL destinations
    const destFips = r.y2_countyfips.padStart(3, '0');
    if (!destFips || destFips === '000') continue;

    // Skip summary rows (y1_countyfips = 0 = total, 96/97/98 = special codes)
    const srcFips = parseInt(r.y1_countyfips || '0');
    if (srcFips <= 0 || srcFips >= 90) continue;

    // Skip non-migrants (same county)
    if (r.y1_statefips === FL_FIPS && r.y1_countyfips === r.y2_countyfips) continue;

    const n1  = parseInt(r.n1  || '0') || 0;
    const agi = parseInt(r.agi || '0') || 0;

    if (!byCounty[destFips]) {
      byCounty[destFips] = { returns: 0, agi: 0, origins: {} };
    }
    byCounty[destFips].returns += n1;
    byCounty[destFips].agi     += agi;

    // Track top origin
    const originKey = `${r.y1_statefips}-${r.y1_countyfips}-${r.y1_countyname || ''}`;
    byCounty[destFips].origins[originKey] = (byCounty[destFips].origins[originKey] || 0) + n1;
  }

  // Compute top origin per county
  for (const [fips, d] of Object.entries(byCounty)) {
    const sorted = Object.entries(d.origins).sort((a, b) => b[1] - a[1]);
    d.top_origin = sorted.length > 0 ? sorted[0][0].split('-').slice(2).join(' ').trim() || sorted[0][0] : null;
    delete d.origins;
  }

  return byCounty;
}

// Build per-FL-county migration aggregates from outflow CSV
// Outflow: y1_statefips=12 (FL) is origin
function buildOutflowByCounty(rows) {
  const byCounty = {};

  for (const r of rows) {
    if (r.y1_statefips !== FL_FIPS) continue; // only FL sources
    const srcFips = r.y1_countyfips.padStart(3, '0');
    if (!srcFips || srcFips === '000') continue;

    // Skip summary rows
    const destFips = parseInt(r.y2_countyfips || '0');
    if (destFips <= 0 || destFips >= 90) continue;

    // Skip non-migrants
    if (r.y2_statefips === FL_FIPS && r.y2_countyfips === r.y1_countyfips) continue;

    const n1  = parseInt(r.n1  || '0') || 0;
    const agi = parseInt(r.agi || '0') || 0;

    if (!byCounty[srcFips]) {
      byCounty[srcFips] = { returns: 0, agi: 0, dests: {} };
    }
    byCounty[srcFips].returns += n1;
    byCounty[srcFips].agi     += agi;

    const destKey = `${r.y2_statefips}-${r.y2_countyfips}-${r.y2_countyname || ''}`;
    byCounty[srcFips].dests[destKey] = (byCounty[srcFips].dests[destKey] || 0) + n1;
  }

  for (const [fips, d] of Object.entries(byCounty)) {
    const sorted = Object.entries(d.dests).sort((a, b) => b[1] - a[1]);
    d.top_dest = sorted.length > 0 ? sorted[0][0].split('-').slice(2).join(' ').trim() || sorted[0][0] : null;
    delete d.dests;
  }

  return byCounty;
}

// ── Main pass ─────────────────────────────────────────────────────────────────
async function runPass() {
  console.log('[irsMig] Starting IRS Migration SOI pass');

  // Check which ZIPs are already fresh
  let freshSet = new Set();
  try {
    const cutoff = new Date(Date.now() - SKIP_FRESH_H * 3600000).toISOString();
    const rows = await db.query(
      `SELECT zip FROM zip_signals WHERE irs_mig_updated_at > $1`,
      [cutoff]
    );
    freshSet = new Set(rows.map(r => r.zip));
    if (freshSet.size > 0)
      console.log(`[irsMig] Skipping ${freshSet.size} ZIPs with fresh migration data`);
  } catch (e) {
    // zip_signals table may not exist yet — proceed
    console.warn('[irsMig] Fresh-check failed (non-fatal):', e.message);
  }

  // Ensure CSVs are available
  if (!csvFresh(INFLOW_PATH)) {
    try { await downloadFile(INFLOW_URL, INFLOW_PATH); }
    catch (e) { console.error('[irsMig] Inflow download failed:', e.message); return; }
  } else {
    console.log('[irsMig] Using cached inflow CSV');
  }

  if (!csvFresh(OUTFLOW_PATH)) {
    try { await downloadFile(OUTFLOW_URL, OUTFLOW_PATH); }
    catch (e) { console.error('[irsMig] Outflow download failed:', e.message); return; }
  } else {
    console.log('[irsMig] Using cached outflow CSV');
  }

  // Parse CSVs
  let inflowRows, outflowRows;
  try {
    inflowRows  = parseCsv(INFLOW_PATH);
    outflowRows = parseCsv(OUTFLOW_PATH);
    console.log(`[irsMig] Parsed ${inflowRows.length} inflow rows, ${outflowRows.length} outflow rows`);
  } catch (e) {
    console.error('[irsMig] Parse failed:', e.message);
    return;
  }

  // Build county aggregates
  const inflowByCounty  = buildInflowByCounty(inflowRows);
  const outflowByCounty = buildOutflowByCounty(outflowRows);

  console.log(`[irsMig] FL inflow: ${Object.keys(inflowByCounty).length} counties | outflow: ${Object.keys(outflowByCounty).length} counties`);

  // Get ZIP → county_fips mapping
  let zipRows;
  try {
    zipRows = await db.query(
      `SELECT zip, county_fips FROM zip_intelligence WHERE county_fips IS NOT NULL`
    );
  } catch (e) {
    console.error('[irsMig] ZIP→county lookup failed:', e.message);
    return;
  }

  // Build county (3-digit) → zip[] map
  const countyToZips = {};
  for (const r of zipRows) {
    if (freshSet.has(r.zip)) continue;
    // Normalize to 3-digit
    const fips3 = r.county_fips.length === 5
      ? r.county_fips.slice(2)    // '12031' → '031'
      : r.county_fips.padStart(3, '0');
    if (!countyToZips[fips3]) countyToZips[fips3] = [];
    countyToZips[fips3].push(r.zip);
  }

  // Upsert irs_mig_* for each ZIP
  let updated = 0;
  const allFips = new Set([
    ...Object.keys(inflowByCounty),
    ...Object.keys(outflowByCounty),
  ]);

  for (const fips3 of allFips) {
    const zips = countyToZips[fips3] || [];
    if (!zips.length) continue;

    const inflow  = inflowByCounty[fips3]  || { returns: 0, agi: 0, top_origin: null };
    const outflow = outflowByCounty[fips3] || { returns: 0, agi: 0, top_dest:   null };

    const signals = {
      irs_mig_in_returns:   inflow.returns  || null,
      irs_mig_out_returns:  outflow.returns || null,
      irs_mig_in_agi:       inflow.agi      || null,
      irs_mig_out_agi:      outflow.agi     || null,
      irs_mig_net_returns:  (inflow.returns  - outflow.returns)  || null,
      irs_mig_net_agi:      (inflow.agi      - outflow.agi)      || null,
      irs_mig_top_origin:   inflow.top_origin  || null,
      irs_mig_top_dest:     outflow.top_dest   || null,
      irs_mig_vintage:      VINTAGE,
      irs_mig_updated_at:   new Date(),
    };

    for (const zip of zips) {
      await upsertZipSignals(zip, signals).catch(() => {});
      updated++;
    }
  }

  console.log(`[irsMig] Pass complete — irs_mig_* signals written for ${updated} ZIPs`);
}

// ── Daemon loop ───────────────────────────────────────────────────────────────
(async function main() {
  const hb = require('../lib/workerHeartbeat');
  const FRESH_MS = FRESH_H * 3600 * 1000;       // 180d freshness check
  const SLEEP_MS  = CYCLE_H * 3600 * 1000;       // 24h sleep (avoids overflow)
  await sleep(60 * 1000); // 60s startup stagger
  console.log('[irsMig] Worker started');
  while (true) {
    if (await hb.isFresh('irsMigrationWorker', FRESH_MS)) {
      console.log('[irsMig] Fresh — skipping pass');
    } else {
      try { await runPass(); await hb.ping('irsMigrationWorker'); }
      catch (e) { console.error('[irsMig] Pass crashed:', e.message); await hb.pingError('irsMigrationWorker', e.message); }
    }
    console.log('[irsMig] Sleeping 24h');
    await sleep(SLEEP_MS);
  }
})();

module.exports = { runPass };
