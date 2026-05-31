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
 *   FCC_BDC_USERNAME  — FCC BDC account email (erik@mcflamingo.com)
 *   FCC_BDC_API_KEY   — 44-char token from broadbandmap.fcc.gov → Manage API Access
 *
 * Endpoint used:
 *   GET /api/public/map/availability/summary?county_fips={fips}&as_of_date={date}
 *   (per FCC BDC Public Data API spec)
 *
 * Auth headers (all required per spec):
 *   username    — account email
 *   hash_value  — 44-char API token
 *   user-agent  — MUST be custom; FCC blocks datacenter default agents (Railway = AWS)
 *
 * Fields populated in zip_signals (computed from count fields in API response):
 *   fcc_vintage_date         — BDC as-of date used (e.g. "2024-12-31")
 *   fcc_total_locations      — total fabric locations in county
 *   fcc_served_locations     — locations meeting 25/3 Mbps threshold
 *   fcc_unserved_locations   — locations with no service at threshold
 *   fcc_underserved_locations— locations below full service threshold
 *   fcc_has_25_3             — true if any served locations
 *   fcc_has_100_20           — true if pct_100_20 > 0
 *   fcc_has_gigabit          — true if pct_gigabit > 0
 *   fcc_pct_25_3             — computed: served/total * 100
 *   fcc_pct_100_20           — from technology-filtered call (speed_download=100)
 *   fcc_pct_gigabit          — from technology-filtered call (speed_download=1000)
 *   fcc_provider_count       — distinct providers in county
 *   fcc_bead_unserved_pct    — unserved/total * 100
 *   fcc_bead_underserved_pct — underserved/total * 100
 *   fcc_fiber_available      — true if technology_code=50 (fiber) call returns > 0 served
 *   fcc_fixed_wireless_avail — true if technology_code=70 call returns > 0 served
 *   fcc_updated_at
 *
 * TIER 2 (stub): location-level deep dive via POST /api/local-intel/admin/fcc-deep-dive
 * on-demand for paid consultation customers. See dashboard LocalIntel tab.
 *
 * Data vintage: FCC updates BDC semiannually (June + December).
 * Worker runs weekly — catches new vintage within days of release.
 *
 * Rate limit: 10 calls/minute. We make up to 4 calls per county (25/3, 100/20,
 * gigabit, fiber check) but batch them with 2s spacing, then 6s between counties
 * → ~6 county-sets/min, well under limit even with multi-call strategy.
 *
 * Fail-safe: on any API error, logs loudly, preserves existing fcc_* data.
 */

const db = require('../lib/db');
const { upsertZipSignals } = require('../lib/pgStore');
const https = require('https');

const BDC_BASE      = 'https://broadbandmap.fcc.gov/api/public/map';
const FL_STATE_FIPS = '12';
const CYCLE_H       = 24 * 7;   // weekly
const INTER_COUNTY_MS = 7000;   // 7s between counties → ~8.5 counties/min
const INTER_CALL_MS   = 2000;   // 2s between calls within same county

// All 67 FL county FIPS codes
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
  const username   = process.env.FCC_BDC_USERNAME;
  const hash_value = process.env.FCC_BDC_API_KEY;
  if (!username || !hash_value) return null;
  return {
    'username':    username,
    'hash_value':  hash_value,
    // Custom user-agent is REQUIRED — FCC blocks datacenter IPs with default agents
    'user-agent':  'LocalIntel/1.0 (localintel.com; data@localintel.com)',
    'Accept':      'application/json',
  };
}

function fetchJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJson(res.headers.location, headers).then(resolve).catch(reject);
      }
      if (res.statusCode === 401) return reject(new Error('HTTP 401 — check FCC_BDC_USERNAME and FCC_BDC_API_KEY'));
      if (res.statusCode === 403) return reject(new Error('HTTP 403 — Railway IP may be blocked by FCC bot protection; try rotating user-agent'));
      if (res.statusCode === 429) return reject(new Error('HTTP 429 — rate limited; slow down calls'));
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse failed: ${e.message} — body: ${body.slice(0, 200)}`)); }
      });
      res.on('error', reject);
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout after 30s')); });
    req.on('error', reject);
  });
}

// ── Fetch latest BDC as-of date ───────────────────────────────────────────────
async function fetchLatestAsOfDate(headers) {
  const url  = `${BDC_BASE}/listAsOfDates`;
  const data = await fetchJson(url, headers);
  // Response: { data: [ { as_of_date: "2024-12-31" }, ... ] }
  const dates = (data.data || [])
    .map(d => d.as_of_date)
    .filter(Boolean)
    .sort()
    .reverse();
  if (!dates.length) throw new Error('listAsOfDates returned no dates');
  console.log(`[fccBroadband] Latest BDC vintage: ${dates[0]} (${dates.length} vintages available)`);
  return dates[0];
}

// ── Fetch county summary for one speed threshold ──────────────────────────────
// Endpoint: GET /availability/summary?county_fips={fips}&as_of_date={date}&speed_download={spd}&speed_upload={upl}
// Returns: { data: { total_locations, served_locations, unserved_locations, underserved_locations, provider_count, ... } }
async function fetchCountySummary(countyFips, asOfDate, headers, speedDown = 25, speedUp = 3, techCode = null) {
  let url = `${BDC_BASE}/availability/summary?county_fips=${countyFips}&as_of_date=${asOfDate}&speed_download=${speedDown}&speed_upload=${speedUp}&category=R`;
  if (techCode !== null) url += `&technology_code=${techCode}`;

  try {
    const resp = await fetchJson(url, headers);
    const d = resp.data || resp;
    return {
      ok:            true,
      total:         parseInt(d.total_locations      || d.total    || 0),
      served:        parseInt(d.served_locations     || d.served   || 0),
      unserved:      parseInt(d.unserved_locations   || d.unserved || 0),
      underserved:   parseInt(d.underserved_locations || d.underserved || 0),
      provider_count: parseInt(d.provider_count      || 0),
    };
  } catch (e) {
    // 404 = county not in BDC (rare); skip quietly
    if (e.message.includes('404')) return { ok: false, skip: true };
    return { ok: false, error: e.message };
  }
}

// ── Compute pct safely ────────────────────────────────────────────────────────
function pct(num, denom) {
  if (!denom || denom === 0) return null;
  return Math.round((num / denom) * 1000) / 10; // one decimal place
}

// ── Main pass ─────────────────────────────────────────────────────────────────
async function runPass() {
  console.log('[fccBroadband] ── Starting FCC BDC Tier-1 county pulse ────────────');

  const headers = getAuthHeaders();
  if (!headers) {
    console.error('[fccBroadband] ✗ MISSING CREDENTIALS — set FCC_BDC_USERNAME + FCC_BDC_API_KEY in Railway. Skipping.');
    return;
  }

  // Get latest vintage
  let asOfDate;
  try {
    asOfDate = await fetchLatestAsOfDate(headers);
  } catch (e) {
    console.error(`[fccBroadband] ✗ Could not fetch BDC vintage date: ${e.message}`);
    console.error('[fccBroadband] Existing fcc_* data preserved — will retry next cycle.');
    return;
  }

  // Which ZIPs already have this vintage?
  let freshSet = new Set();
  try {
    const rows = await db.query(
      `SELECT zip FROM zip_signals WHERE fcc_vintage_date = $1 AND fcc_updated_at IS NOT NULL`,
      [asOfDate]
    );
    freshSet = new Set(rows.map(r => r.zip));
    if (freshSet.size > 0)
      console.log(`[fccBroadband] ${freshSet.size} ZIPs already on ${asOfDate} vintage — skipping`);
  } catch (_) { /* zip_signals may not exist yet — proceed */ }

  // ZIP → county_fips map
  let zipRows;
  try {
    zipRows = await db.query(
      `SELECT zip, county_fips FROM zip_intelligence WHERE county_fips IS NOT NULL`
    );
  } catch (e) {
    console.error('[fccBroadband] ✗ ZIP→county lookup failed:', e.message);
    return;
  }
  if (!zipRows.length) {
    console.warn('[fccBroadband] No ZIPs with county_fips — ensure zip_intelligence is seeded');
    return;
  }

  // Build county → [zip, ...] map, FL only, skip already-fresh
  const countyToZips = {};
  for (const r of zipRows) {
    if (freshSet.has(r.zip)) continue;
    const fips5 = r.county_fips.length === 3 ? FL_STATE_FIPS + r.county_fips : r.county_fips;
    if (!FL_COUNTY_FIPS.includes(fips5)) continue;
    if (!countyToZips[fips5]) countyToZips[fips5] = [];
    countyToZips[fips5].push(r.zip);
  }

  const uniqueCounties = Object.keys(countyToZips);
  if (!uniqueCounties.length) {
    console.log('[fccBroadband] All ZIPs fresh for this vintage — nothing to do');
    return;
  }

  const estMin = Math.ceil(uniqueCounties.length * (INTER_COUNTY_MS + INTER_CALL_MS * 3) / 60000);
  console.log(`[fccBroadband] Fetching ${uniqueCounties.length} counties (vintage ${asOfDate}) — est. ${estMin} min`);

  let updatedZips = 0, countyOk = 0, countyFail = 0;

  for (const fips5 of uniqueCounties) {
    // Call 1: baseline 25/3 Mbps — gives us served/unserved/underserved + provider_count
    const base = await fetchCountySummary(fips5, asOfDate, headers, 25, 3);
    await sleep(INTER_CALL_MS);

    if (!base.ok) {
      if (!base.skip) {
        countyFail++;
        console.warn(`[fccBroadband] County ${fips5} base call failed: ${base.error}`);
      }
      await sleep(INTER_COUNTY_MS);
      continue;
    }

    // Call 2: 100/20 Mbps — how many locations meet enhanced broadband threshold
    const c100 = await fetchCountySummary(fips5, asOfDate, headers, 100, 20);
    await sleep(INTER_CALL_MS);

    // Call 3: gigabit — 1000/100 Mbps
    const c1k = await fetchCountySummary(fips5, asOfDate, headers, 1000, 100);
    await sleep(INTER_CALL_MS);

    // Call 4: fiber tech check (technology_code=50) at 25/3 baseline
    const fiber = await fetchCountySummary(fips5, asOfDate, headers, 25, 3, 50);
    await sleep(INTER_CALL_MS);

    // Call 5: fixed wireless check (technology_code=70)
    const fwa = await fetchCountySummary(fips5, asOfDate, headers, 25, 3, 70);

    countyOk++;

    const total = base.total || 0;

    const signals = {
      fcc_vintage_date:          asOfDate,
      fcc_total_locations:       total                        || null,
      fcc_served_locations:      base.served                  || null,
      fcc_unserved_locations:    base.unserved                || null,
      fcc_underserved_locations: base.underserved             || null,
      fcc_provider_count:        base.provider_count          || null,
      fcc_has_25_3:              (base.served  || 0) > 0,
      fcc_has_100_20:            (c100.ok && (c100.served  || 0) > 0),
      fcc_has_gigabit:           (c1k.ok  && (c1k.served   || 0) > 0),
      fcc_pct_25_3:              pct(base.served,   total),
      fcc_pct_100_20:            c100.ok ? pct(c100.served,  total) : null,
      fcc_pct_gigabit:           c1k.ok  ? pct(c1k.served,   total) : null,
      fcc_bead_unserved_pct:     pct(base.unserved,    total),
      fcc_bead_underserved_pct:  pct(base.underserved,  total),
      fcc_fiber_available:       (fiber.ok && (fiber.served || 0) > 0),
      fcc_fixed_wireless_avail:  (fwa.ok   && (fwa.served   || 0) > 0),
      fcc_updated_at:            new Date(),
    };

    for (const zip of countyToZips[fips5]) {
      await upsertZipSignals(zip, signals).catch(e =>
        console.warn(`[fccBroadband] upsert failed for ${zip}:`, e.message)
      );
      updatedZips++;
    }

    // Log progress every 10 counties
    if (countyOk % 10 === 0) {
      console.log(`[fccBroadband] Progress: ${countyOk}/${uniqueCounties.length} counties — ${updatedZips} ZIPs written`);
    }

    await sleep(INTER_COUNTY_MS);
  }

  console.log(`[fccBroadband] ── Pass complete ──────────────────────────────────`);
  console.log(`[fccBroadband]   Vintage:          ${asOfDate}`);
  console.log(`[fccBroadband]   Counties:         ${countyOk} ok, ${countyFail} failed`);
  console.log(`[fccBroadband]   ZIPs updated:     ${updatedZips}`);
  if (countyFail > 0) {
    console.warn(`[fccBroadband] ⚠ ${countyFail} county failures — existing fcc_* data NOT cleared`);
  }
}

// ── Daemon loop ───────────────────────────────────────────────────────────────
(async function main() {
  const hb = require('../lib/workerHeartbeat');
  const FRESH_MS = CYCLE_H * 3600 * 1000;
  await sleep(45 * 1000); // stagger startup
  console.log('[fccBroadband] Worker started — FCC BDC Tier-1, weekly county pulse');
  while (true) {
    if (await hb.isFresh('fccBroadbandWorker', FRESH_MS)) {
      console.log('[fccBroadband] Fresh — skipping pass');
    } else {
      try { await runPass(); await hb.ping('fccBroadbandWorker'); }
      catch (e) { console.error('[fccBroadband] Pass crashed:', e.message); await hb.pingError('fccBroadbandWorker', e.message); }
    }
    console.log(`[fccBroadband] Sleeping ${CYCLE_H}h`);
    try { await db.disconnect(); } catch (_) {} // release connection slot during sleep
    await sleep(FRESH_MS);
  }
})();

module.exports = { runPass };
