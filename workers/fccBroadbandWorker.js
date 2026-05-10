'use strict';
/**
 * fccBroadbandWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * TIER 1 — Weekly BDC county summary pulse
 * ─────────────────────────────────────────────────────────────────────────────
 * Uses the authenticated FCC BDC public map API to fetch county-level broadband
 * availability summaries for all 67 FL counties. Results are apportioned to ZIP
 * codes via zip_intelligence.county_fips.
 *
 * Auth: requires Railway env vars:
 *   FCC_BDC_USERNAME  — your FCC BDC account email (erik@mcflamingo.com)
 *   FCC_BDC_API_KEY   — API key from noreply@api.data.gov
 *
 * Fields populated in zip_signals:
 *   fcc_vintage_date        — BDC as-of date used (e.g. "2024-12-31")
 *   fcc_has_25_3            — true if any coverage at 25/3 Mbps
 *   fcc_has_100_20          — true if any coverage at 100/20 Mbps
 *   fcc_has_gigabit         — true if any gigabit coverage
 *   fcc_pct_25_3            — % locations covered at 25/3 Mbps (0-100)
 *   fcc_pct_100_20          — % locations covered at 100/20 Mbps
 *   fcc_pct_gigabit         — % locations covered at gigabit
 *   fcc_provider_count      — distinct fixed providers in county
 *   fcc_fiber_pct           — % locations with fiber available
 *   fcc_fixed_wireless_pct  — % locations with fixed wireless available
 *   fcc_bead_unserved_pct   — % locations unserved (<25/3) — BEAD eligible
 *   fcc_bead_underserved_pct— % locations underserved (25/3–100/20)
 *   fcc_updated_at
 *
 * TIER 2 (stub): location-level deep dive is available as an on-demand tool
 * in the dashboard for paid consultation customers. See POST /api/local-intel/admin/fcc-deep-dive
 * Data vintage is updated semiannually by FCC (June + December). Runs weekly
 * so we catch new vintages within days of release.
 *
 * Behavior on failure:
 *   - Logs clearly, does NOT wipe existing fcc_* data
 *   - Falls back to skip if API is unavailable rather than reverting to Socrata
 *
 * Rate limit: 10 calls/minute. 67 counties = ~7 minutes at max rate, we pace
 * at 8s/call (7.5 calls/min) to stay safe.
 */

const db = require('../lib/db');
const { upsertZipSignals } = require('../lib/pgStore');
const https = require('https');

const BDC_BASE     = 'https://broadbandmap.fcc.gov/api/public/map';
const FL_STATE_FIPS = '12';
const CYCLE_H      = 24 * 7;       // weekly
const SKIP_FRESH_H = 6 * 24;       // skip ZIPs updated within 6 days
const CALL_PACE_MS = 8000;          // 8s between county calls → ~7.5/min (under 10/min limit)

// All 67 FL county FIPS codes (12001–12133)
const FL_COUNTY_FIPS = [
  '12001','12003','12005','12007','12009','12011','12013','12015','12017','12019',
  '12021','12023','12025','12027','12029','12031','12033','12035','12037','12039',
  '12041','12043','12045','12047','12049','12051','12053','12055','12057','12059',
  '12061','12063','12065','12067','12069','12071','12073','12075','12077','12079',
  '12081','12083','12085','12086','12087','12089','12091','12093','12095','12097',
  '12099','12101','12103','12105','12107','12109','12111','12113','12115','12117',
  '12119','12121','12123','12125','12127','12129','12131','12133',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getAuthHeaders() {
  const username  = process.env.FCC_BDC_USERNAME;
  const hash_value = process.env.FCC_BDC_API_KEY;
  if (!username || !hash_value) return null;
  return { username, hash_value, 'Accept': 'application/json', 'User-Agent': 'LocalIntel-BDC/2.0' };
}

function fetchJson(url, headers) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: headers || { 'Accept': 'application/json', 'User-Agent': 'LocalIntel-BDC/2.0' },
    };
    const req = https.get(url, opts, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJson(res.headers.location, headers).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse failed: ${e.message}`)); }
      });
      res.on('error', reject);
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

// ── Fetch the latest BDC as-of date ──────────────────────────────────────────
async function fetchLatestAsOfDate(headers) {
  try {
    const url  = `${BDC_BASE}/listAsOfDates`;
    const data = await fetchJson(url, headers);
    // Response: { data: [ { as_of_date: "2024-12-31" }, ... ] } sorted desc
    const dates = (data.data || data || []).map(d => d.as_of_date || d).filter(Boolean).sort().reverse();
    if (!dates.length) throw new Error('No as-of dates returned');
    console.log(`[fccBroadband] Latest BDC vintage: ${dates[0]} (${dates.length} available)`);
    return dates[0];
  } catch (e) {
    console.error('[fccBroadband] fetchLatestAsOfDate failed:', e.message);
    return null;
  }
}

// ── Fetch county-level availability summary from BDC ─────────────────────────
// Endpoint: GET /api/public/map/availability/summary/county/{fips}?as_of_date={date}
// Returns aggregated coverage pct, provider counts, BEAD metrics
async function fetchCountySummary(countyFips, asOfDate, headers) {
  const url = `${BDC_BASE}/availability/summary/county/${countyFips}?as_of_date=${asOfDate}&category=R`; // R = residential
  try {
    const data = await fetchJson(url, headers);
    // Normalize — FCC returns nested object, key fields may vary slightly across vintages
    const d = data.data || data;
    return {
      fips:              countyFips,
      pct_25_3:          parseFloat(d.pct_bb_25_3  || d.pct_25_3  || d.pct_served   || 0),
      pct_100_20:        parseFloat(d.pct_bb_100_20 || d.pct_100_20 || 0),
      pct_gigabit:       parseFloat(d.pct_bb_1000   || d.pct_gigabit || d.pct_1000_100 || 0),
      provider_count:    parseInt(d.provider_count  || d.providers  || 0),
      pct_fiber:         parseFloat(d.pct_fiber     || d.fiber_pct  || 0),
      pct_fixed_wireless:parseFloat(d.pct_fixed_wireless || d.fixed_wireless_pct || 0),
      pct_unserved:      parseFloat(d.pct_unserved  || d.bead_unserved_pct   || 0),
      pct_underserved:   parseFloat(d.pct_underserved || d.bead_underserved_pct || 0),
      ok: true,
    };
  } catch (e) {
    // Log per-county failure but don't crash — might be one bad FIPS
    if (e.message.includes('404') || e.message.includes('400')) {
      // County not in BDC (some unincorporated territories) — skip quietly
      return { fips: countyFips, ok: false, skip: true };
    }
    console.warn(`[fccBroadband] County ${countyFips} summary failed: ${e.message}`);
    return { fips: countyFips, ok: false };
  }
}

// ── Main pass ─────────────────────────────────────────────────────────────────
async function runPass() {
  console.log('[fccBroadband] ── Starting FCC BDC Tier-1 county pulse ──────────────');

  // Auth check
  const headers = getAuthHeaders();
  if (!headers) {
    console.error('[fccBroadband] MISSING CREDENTIALS — set FCC_BDC_USERNAME and FCC_BDC_API_KEY in Railway env vars. Skipping pass.');
    return;
  }

  // Get latest vintage date
  const asOfDate = await fetchLatestAsOfDate(headers);
  if (!asOfDate) {
    console.error('[fccBroadband] Could not determine BDC vintage date — skipping pass. Existing fcc_* data preserved.');
    return;
  }

  // Check which ZIPs already have fresh data for this vintage
  let freshSet = new Set();
  try {
    const rows = await db.query(
      `SELECT zip FROM zip_signals WHERE fcc_vintage_date = $1 AND fcc_updated_at IS NOT NULL`,
      [asOfDate]
    );
    freshSet = new Set(rows.map(r => r.zip));
    if (freshSet.size > 0)
      console.log(`[fccBroadband] ${freshSet.size} ZIPs already have ${asOfDate} vintage — skipping those`);
  } catch (e) {
    console.warn('[fccBroadband] Fresh-check failed (non-fatal):', e.message);
  }

  // Get ZIP → county_fips mapping
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
    console.warn('[fccBroadband] No ZIPs with county_fips found — ensure zip_intelligence is populated');
    return;
  }

  // Build county_fips → zip[] map, normalizing to 5-digit FIPS
  const countyToZips = {};
  for (const r of zipRows) {
    if (freshSet.has(r.zip)) continue;
    const fips5 = r.county_fips.length === 3 ? FL_STATE_FIPS + r.county_fips : r.county_fips;
    if (!FL_COUNTY_FIPS.includes(fips5)) continue; // only FL counties
    if (!countyToZips[fips5]) countyToZips[fips5] = [];
    countyToZips[fips5].push(r.zip);
  }

  const uniqueCounties = Object.keys(countyToZips);
  if (!uniqueCounties.length) {
    console.log('[fccBroadband] All ZIPs already fresh for this vintage — nothing to do');
    return;
  }
  console.log(`[fccBroadband] Fetching BDC summaries for ${uniqueCounties.length} counties (vintage ${asOfDate})...`);
  console.log(`[fccBroadband] Estimated time: ~${Math.ceil(uniqueCounties.length * CALL_PACE_MS / 60000)} minutes`);

  // Fetch each county at paced rate
  let updatedZips = 0;
  let countyOk    = 0;
  let countyFail  = 0;

  for (const fips5 of uniqueCounties) {
    const summary = await fetchCountySummary(fips5, asOfDate, headers);
    await sleep(CALL_PACE_MS);

    if (!summary.ok) {
      if (!summary.skip) countyFail++;
      continue;
    }
    countyOk++;

    const signals = {
      fcc_vintage_date:         asOfDate,
      fcc_has_25_3:             summary.pct_25_3   > 0,
      fcc_has_100_20:           summary.pct_100_20 > 0,
      fcc_has_gigabit:          summary.pct_gigabit > 0,
      fcc_pct_25_3:             summary.pct_25_3        || null,
      fcc_pct_100_20:           summary.pct_100_20      || null,
      fcc_pct_gigabit:          summary.pct_gigabit     || null,
      fcc_provider_count:       summary.provider_count  || null,
      fcc_fiber_pct:            summary.pct_fiber        || null,
      fcc_fixed_wireless_pct:   summary.pct_fixed_wireless || null,
      fcc_bead_unserved_pct:    summary.pct_unserved    || null,
      fcc_bead_underserved_pct: summary.pct_underserved || null,
      fcc_updated_at:           new Date(),
    };

    for (const zip of countyToZips[fips5]) {
      await upsertZipSignals(zip, signals).catch(e => {
        console.warn(`[fccBroadband] upsert failed for ${zip}:`, e.message);
      });
      updatedZips++;
    }
  }

  console.log(`[fccBroadband] ── Pass complete ──────────────────────────────────────`);
  console.log(`[fccBroadband]   Vintage: ${asOfDate}`);
  console.log(`[fccBroadband]   Counties: ${countyOk} ok, ${countyFail} failed`);
  console.log(`[fccBroadband]   ZIPs updated: ${updatedZips}`);
  if (countyFail > 0) {
    console.warn(`[fccBroadband] ⚠ ${countyFail} counties failed — check BDC API status. Existing data NOT cleared.`);
  }
}

// ── Daemon loop ───────────────────────────────────────────────────────────────
(async function main() {
  // Stagger startup — let other signal workers populate zip_signals first
  await sleep(45 * 1000);
  console.log('[fccBroadband] Worker started (BDC Tier-1 county pulse, weekly)');

  while (true) {
    try { await runPass(); }
    catch (e) { console.error('[fccBroadband] Pass crashed:', e.message, e.stack); }
    console.log(`[fccBroadband] Sleeping ${CYCLE_H}h until next pass`);
    await sleep(CYCLE_H * 3600 * 1000);
  }
})();

module.exports = { runPass };
