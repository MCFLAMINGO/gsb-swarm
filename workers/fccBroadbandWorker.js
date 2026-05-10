'use strict';
/**
 * fccBroadbandWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * FCC Form 477 (June 2021) broadband availability at county level → apportioned
 * to ZIP via zip_intelligence.county_fips.
 *
 * Source: https://opendata.fcc.gov/resource/xvwq-qtaj.json (FCC F477 Area Table)
 *   type='county', id=FIPS, tech='acfosw' (all consumer fixed technologies),
 *   speed=25 → 25/3 Mbps benchmark
 *   speed=100 → 100/20 Mbps benchmark
 *   speed=1000 → gigabit
 *
 * Fields populated in zip_signals:
 *   fcc_has_25_3       — true if any coverage at 25/3 Mbps in county
 *   fcc_has_100_20     — true if any coverage at 100/20 Mbps in county
 *   fcc_has_gigabit    — true if any coverage at 1 Gbps in county
 *   fcc_providers_cnt  — max providers at 25 Mbps in county (has_3more > 0 → 3+)
 *   fcc_max_down_mbps  — highest speed tier with has_3more > 0
 *   fcc_fiber_available — techcode includes 'f' (fiber) in county
 *   fcc_updated_at
 *
 * Runs once per week (data updates annually — weekly check catches the update).
 * Skips ZIPs already fresh (fcc_updated_at within 6 days).
 *
 * NOTE: This is county-level data apportioned to ZIPs — all ZIPs in a county
 * get the same fcc_* values. ZIP-level FCC data requires the block-level dataset
 * plus a census block→ZIP crosswalk, which is future work.
 */

const db = require('../lib/db');
const { upsertZipSignals } = require('../lib/pgStore');

const SOCRATA_BASE = 'https://opendata.fcc.gov/resource/xvwq-qtaj.json';
const FL_FIPS_PREFIX = '12';
const CYCLE_H = 24 * 7; // weekly
const SKIP_FRESH_H = 6 * 24; // skip if updated within 6 days

// Speed benchmarks to query
const SPEED_TIERS = [
  { speed: '25',   field: 'fcc_has_25_3'   },
  { speed: '100',  field: 'fcc_has_100_20' },
  { speed: '1000', field: 'fcc_has_gigabit' },
];

// techcode containing 'f' means fiber is in the mix
// tech string is a sorted set of codes: a=ADSL, c=Cable, f=Fiber, o=Other, s=Satellite, w=Wireless

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchJson(url) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'LocalIntel-FCC/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      if (res.statusCode !== 200)
        return reject(new Error(`HTTP ${res.statusCode}`));
      let b = '';
      res.setEncoding('utf8');
      res.on('data', c => { b += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(b)); }
        catch (e) { reject(new Error('JSON parse failed')); }
      });
      res.on('error', reject);
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

// Fetch F477 area table for FL counties at a given speed tier
async function fetchCountyCoverage(speed) {
  // Fetch all FL county rows at this speed (all tech combined = 'acfosw')
  // has_0 = locations with 0 providers, has_1 = 1 provider, has_2 = 2, has_3more = 3+
  const url = encodeURI(
    `${SOCRATA_BASE}?type=county&speed=${speed}&$where=id LIKE '${FL_FIPS_PREFIX}%'&$limit=500`
  );
  try {
    const rows = await fetchJson(url);
    // Group by county FIPS (id) — sum across urban/rural/tribal
    const byCounty = {};
    for (const r of rows) {
      const fips = r.id;
      if (!byCounty[fips]) byCounty[fips] = {
        has_any: false,
        total_locations: 0,
        covered_1plus: 0,
        covered_3plus: 0,
        tech: r.tech || '',
      };
      const has_1     = parseInt(r.has_1     || 0);
      const has_2     = parseInt(r.has_2     || 0);
      const has_3more = parseInt(r.has_3more || 0);
      const has_0     = parseInt(r.has_0     || 0);
      const total = has_0 + has_1 + has_2 + has_3more;
      byCounty[fips].total_locations += total;
      byCounty[fips].covered_1plus   += has_1 + has_2 + has_3more;
      byCounty[fips].covered_3plus   += has_3more;
      byCounty[fips].has_any          = byCounty[fips].covered_1plus > 0;
      // Merge tech string (take the one with most tech types)
      if ((r.tech || '').length > byCounty[fips].tech.length) {
        byCounty[fips].tech = r.tech || '';
      }
    }
    return byCounty;
  } catch (e) {
    console.warn(`[fccBroadband] fetchCountyCoverage speed=${speed} failed:`, e.message);
    return {};
  }
}

// ── Main pass ─────────────────────────────────────────────────────────────────
async function runPass() {
  console.log('[fccBroadband] Starting FCC broadband coverage pass');

  // Check which ZIPs are already fresh
  let freshSet = new Set();
  try {
    const cutoff = new Date(Date.now() - SKIP_FRESH_H * 3600 * 1000).toISOString();
    const rows = await db.query(
      `SELECT zip FROM zip_signals WHERE fcc_updated_at > $1`,
      [cutoff]
    );
    freshSet = new Set(rows.map(r => r.zip));
    if (freshSet.size > 0)
      console.log(`[fccBroadband] Skipping ${freshSet.size} ZIPs with fresh FCC data`);
  } catch (e) {
    // zip_signals may not exist yet — proceed anyway
    console.warn('[fccBroadband] Fresh-check failed (non-fatal):', e.message);
  }

  // Fetch ZIP → county_fips mapping from zip_intelligence
  let zipRows;
  try {
    zipRows = await db.query(
      `SELECT zip, county_fips FROM zip_intelligence WHERE county_fips IS NOT NULL`
    );
  } catch (e) {
    console.error('[fccBroadband] ZIP→county lookup failed:', e.message);
    return;
  }
  if (!zipRows.length) {
    console.warn('[fccBroadband] No ZIPs with county_fips — run irsSoiWorker first to seed');
    return;
  }

  // Build county_fips → zip[] map (use short FIPS = last 3 digits, FCC uses full 5-digit FIPS)
  const countyToZips = {};
  for (const r of zipRows) {
    if (freshSet.has(r.zip)) continue;
    // county_fips may be '001' (3-digit) or '12001' (5-digit)
    const fips5 = r.county_fips.length === 3
      ? FL_FIPS_PREFIX + r.county_fips
      : r.county_fips;
    if (!countyToZips[fips5]) countyToZips[fips5] = [];
    countyToZips[fips5].push(r.zip);
  }

  // Fetch coverage data for each speed tier
  console.log('[fccBroadband] Fetching coverage tiers from FCC F477...');
  const coverage25  = await fetchCountyCoverage('25');   await sleep(1000);
  const coverage100 = await fetchCountyCoverage('100');  await sleep(1000);
  const coverage1k  = await fetchCountyCoverage('1000'); await sleep(1000);

  console.log(`[fccBroadband] Got county coverage: ${Object.keys(coverage25).length} counties at 25Mbps`);

  // For each county, compute fcc_* signals and upsert to all ZIPs in that county
  let updated = 0;
  for (const [fips5, zips] of Object.entries(countyToZips)) {
    const c25   = coverage25[fips5]  || {};
    const c100  = coverage100[fips5] || {};
    const c1k   = coverage1k[fips5]  || {};

    // Determine provider count tier from 25Mbps data
    // has_3more > 0 → 3+ providers; else has_2 > 0 → 2; else has_1 > 0 → 1; else 0
    let providers = 0;
    if (c25.covered_3plus > 0) providers = 3;
    else if (c25.covered_1plus > c25.covered_3plus) providers = 2;
    else if (c25.covered_1plus > 0) providers = 1;

    // Max speed tier available (has any coverage)
    let maxDown = 0;
    if (c1k.has_any)  maxDown = 1000;
    else if (c100.has_any) maxDown = 100;
    else if (c25.has_any)  maxDown = 25;

    // Fiber available = tech string contains 'f'
    const techStr = c25.tech || c100.tech || '';
    const fiberAvailable = techStr.includes('f');

    const signals = {
      fcc_has_25_3:      c25.has_any  || false,
      fcc_has_100_20:    c100.has_any || false,
      fcc_has_gigabit:   c1k.has_any  || false,
      fcc_providers_cnt: providers || null,
      fcc_max_down_mbps: maxDown || null,
      fcc_fiber_available: fiberAvailable,
      fcc_updated_at:    new Date(),
    };

    for (const zip of zips) {
      await upsertZipSignals(zip, signals).catch(() => {});
      updated++;
    }
  }

  console.log(`[fccBroadband] Pass complete — fcc_* signals written for ${updated} ZIPs`);
}

// ── Daemon loop ───────────────────────────────────────────────────────────────
(async function main() {
  // Stagger startup to avoid hammering APIs on deploy
  await sleep(30 * 1000);
  console.log('[fccBroadband] Worker started');
  while (true) {
    try { await runPass(); }
    catch (e) { console.error('[fccBroadband] Pass crashed:', e.message); }
    console.log(`[fccBroadband] Sleeping ${CYCLE_H}h`);
    await sleep(CYCLE_H * 3600 * 1000);
  }
})();

module.exports = { runPass };
