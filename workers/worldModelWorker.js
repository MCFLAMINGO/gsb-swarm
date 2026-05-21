'use strict';
/**
 * worldModelWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Computes derived sig_* signals for ALL FL ZIPs from fl_zip_geo.
 * Pure math — ZERO LLM calls. Reads zip_signals + businesses table.
 * Runs AFTER primary workers (ACS, FRED, QWI, QCEW, CES, LODES, BEA) have
 * written their data. Safe to re-run at any time (idempotent upserts).
 *
 * ZIP source: fl_zip_geo (1,473 FL ZIPs) — POSTGRES IS KING.
 * No hardcoded ZIP lists. Picks up every ZIP that has at least one signal row.
 *
 * Writes to zip_signals:
 *   sig_growth_score        numeric  0–100  (rank among FL ZIPs with data)
 *   sig_opportunity_score   numeric  0–100  (rank among FL ZIPs with data)
 *   sig_risk_score          numeric  0–100  (rank among FL ZIPs with data)
 *   sig_market_maturity     text     "Emerging" | "Growing" | "Established" | "Mature"
 *   sig_income_tier         text     "Moderate" | "Above Average" | "High" | "Affluent" | "Ultra-Affluent"
 *   sig_peer_cohort         text     e.g. "Coastal Affluent" | "Suburban Growth" | "Working Class Core"
 *   sig_biz_density_per_1k  numeric  businesses per 1,000 residents
 *   sig_job_capture_ratio   numeric  lodes_jobs_here / qcew_employment
 *
 * Scores are relative ranks within Florida — a score of 90 means this ZIP is
 * in the top 10% of FL ZIPs for that composite among ZIPs that have data.
 * Absolute signals (HHI, AADT, permits) are written directly by their workers
 * and not re-computed here.
 * ─────────────────────────────────────────────────────────────────────────────
 */

module.exports = async function worldModelWorker(db, logEvent) {
  const workerName = 'worldModelWorker';

  // ── 1. Load all FL ZIPs from fl_zip_geo (POSTGRES IS KING) ───────────────
  let allFLZips;
  try {
    const geoRows = await db.query(
      `SELECT zip FROM fl_zip_geo WHERE state = 'FL' ORDER BY zip`
    );
    allFLZips = Array.isArray(geoRows) ? geoRows.map(r => r.zip) : [];
  } catch (e) {
    await logEvent(workerName, 'ERROR', null, `Failed to load ZIPs from fl_zip_geo: ${e.message}`);
    return { skipped: true, reason: 'fl_zip_geo_unavailable' };
  }

  if (allFLZips.length === 0) {
    await logEvent(workerName, 'SKIP', null, 'fl_zip_geo returned 0 rows — run migration 029 first');
    return { skipped: true, reason: 'no_zips' };
  }

  await logEvent(workerName, 'START', null,
    `Computing derived signals for up to ${allFLZips.length} FL ZIPs from fl_zip_geo`
  );

  // ── 2. Load zip_signals rows for all FL ZIPs ──────────────────────────────
  // Only process ZIPs that have at least one signal row written by a worker.
  // ZIPs with no data at all would produce meaningless null scores.
  let rows;
  try {
    rows = await db.query(
      `SELECT * FROM zip_signals WHERE zip = ANY($1)`,
      [allFLZips]
    );
  } catch (e) {
    await logEvent(workerName, 'ERROR', null, `zip_signals query failed: ${e.message}`);
    return { skipped: true, reason: 'query_failed' };
  }

  if (!rows || rows.length === 0) {
    await logEvent(workerName, 'SKIP', null, 'No zip_signals rows found — run primary workers first');
    return { skipped: true, reason: 'no_rows' };
  }

  // Work only with ZIPs that have signal rows
  const activeZips = rows.map(r => r.zip);
  console.log(`[worldModelWorker] ${allFLZips.length} FL ZIPs in geo | ${activeZips.length} have zip_signals rows`);

  // ── 3. Load business counts for active ZIPs ───────────────────────────────
  const bizRows = await db.query(
    `SELECT zip, COUNT(*)::int AS biz_count FROM businesses WHERE zip = ANY($1) GROUP BY zip`,
    [activeZips]
  ).catch(() => []);
  const bizMap = {};
  for (const r of bizRows) bizMap[r.zip] = Number(r.biz_count || 0);

  // Index signal rows by ZIP
  const sigMap = {};
  for (const r of rows) sigMap[r.zip] = r;

  // ── 4. Helper: safe numeric parse ─────────────────────────────────────────
  const n = (v) => (v != null && v !== '' ? Number(v) : null);

  // ── 5. Build per-ZIP metrics from what Postgres has ───────────────────────
  // Each field reads directly from zip_signals — written by its own worker.
  // If a worker hasn't run yet for a ZIP, the field is null and that ZIP
  // simply won't contribute to that metric's ranking.
  const metrics = activeZips.map((zip) => {
    const s = sigMap[zip] || {};
    const bizCount = bizMap[zip] || 0;
    const pop = n(s.acs_population);

    // Biz density per 1k residents (from businesses table count + ACS population)
    const biz_density_per_1k = pop && pop > 0 ? (bizCount / pop) * 1000 : null;

    // Job capture ratio: lodes_jobs_here / qcew_employment
    // >1 = ZIP attracts workers from outside; <1 = bedroom community
    const lodes_jobs = n(s.lodes_jobs_here);
    const qcew_emp   = n(s.qcew_employment);
    const job_capture_ratio = lodes_jobs != null && qcew_emp != null && qcew_emp > 0
      ? lodes_jobs / qcew_emp : null;

    return {
      zip,
      // ── Growth inputs (written by: qcewWorker, sunbizWorker, permitWorker)
      emp_yoy:         n(s.qcew_emp_yoy_pct),       // QCEW: employment YoY %
      new_biz_12mo:    n(s.sunbiz_new_12mo),         // SunBiz: new entity formations
      units_permitted: n(s.bps_total_units_annual),  // Census BPS: residential permits
      // ── Opportunity inputs (written by: cesWorker, lodesWorker)
      invest_score:    n(s.investment_opportunity_score), // CES composite
      net_flow:        n(s.lodes_net_flow),               // LODES: worker net flow
      biz_density_per_1k,                                 // derived above
      // ── Construction density (written by: countyPermitsWorker)
      cbp_total_construction: (
        (n(s.cbp_bldg_estab) ?? 0) +
        (n(s.cbp_civil_estab) ?? 0) +
        (n(s.cbp_trade_estab) ?? 0)
      ) || null,
      // ── Risk inputs (written by: cesWorker, fredWorker, qwiWorker)
      ai_risk:         n(s.ai_displacement_risk),    // CES: AI displacement risk
      unemp_rate:      n(s.fred_unemployment_rate),  // FRED: unemployment %
      turnover_rate:   n(s.qwi_turnover_rate),       // QWI: job turnover rate
      // ── Income tier inputs (written by: beaWorker, acsWorker)
      per_capita_income: n(s.bea_per_capita_income), // BEA: per capita personal income
      median_hhi:        n(s.acs_median_hhi),         // ACS B19013: median HHI
      // ── Maturity inputs (written by: acsWorker, qcewWorker, sunbizWorker)
      owner_occ_pct:   n(s.acs_owner_occ_pct),       // ACS: owner-occupancy %
      median_age:      n(s.acs_median_age),            // ACS: median age
      // ── Derived
      job_capture_ratio,
    };
  });

  // ── 6. Rank-normalize helper ──────────────────────────────────────────────
  // Returns zip → 0–100 score based on rank among ZIPs that have this field.
  // Only ZIPs with non-null values participate in the ranking.
  // A ZIP with null for a metric is excluded from that metric's ranking and
  // that metric does not contribute to its composite score.
  function rankScore(key, higherIsBetter = true) {
    const vals = metrics
      .map(m => ({ zip: m.zip, v: m[key] }))
      .filter(x => x.v != null && !isNaN(x.v));

    if (vals.length === 0) return {};

    const sorted = [...vals].sort((a, b) =>
      higherIsBetter ? b.v - a.v : a.v - b.v
    );
    const total = sorted.length;
    const out = {};
    sorted.forEach((x, i) => {
      out[x.zip] = total === 1 ? 100 : Math.round(((total - 1 - i) / (total - 1)) * 100);
    });
    return out;
  }

  // ── 7. Compute rank scores for each input field ───────────────────────────
  const rEmpYoy   = rankScore('emp_yoy',         true);   // higher YoY % = better growth
  const rNewBiz   = rankScore('new_biz_12mo',    true);   // more formations = better growth
  const rPermits  = rankScore('units_permitted', true);   // more permits = better growth

  const rInvest   = rankScore('invest_score',       true);  // CES opportunity composite
  const rFlow     = rankScore('net_flow',            true);  // positive net worker flow = opportunity
  const rDensity  = rankScore('biz_density_per_1k', true);  // denser = more commercial activity
  const rConstruction = rankScore('cbp_total_construction', true); // more construction firms = higher opportunity

  const rAiRisk   = rankScore('ai_risk',       true);  // higher AI risk = higher risk score
  const rUnemp    = rankScore('unemp_rate',    true);  // higher unemployment = higher risk
  const rTurnover = rankScore('turnover_rate', true);  // higher turnover = higher risk

  // ── 8. Weighted composite score ───────────────────────────────────────────
  // Weights express relative importance of each input within its composite.
  // Only inputs with actual data contribute — weight is re-normalized per ZIP
  // so a ZIP missing one input still gets a valid composite from the others.
  function weightedAvg(inputs, zips) {
    const out = {};
    for (const zip of zips) {
      let total = 0;
      let usedW = 0;
      for (const { map, weight } of inputs) {
        if (map[zip] != null) {
          total += map[zip] * weight;
          usedW += weight;
        }
      }
      out[zip] = usedW > 0 ? Math.round(total / usedW) : null;
    }
    return out;
  }

  const growthScores = weightedAvg([
    { map: rEmpYoy,  weight: 40 },  // Employment YoY % — most current growth signal
    { map: rNewBiz,  weight: 35 },  // New business formations — forward-looking
    { map: rPermits, weight: 25 },  // Residential permits — population growth proxy
  ], activeZips);

  const opportunityScores = weightedAvg([
    { map: rInvest,       weight: 35 },  // CES investment composite
    { map: rFlow,         weight: 30 },  // LODES net worker flow
    { map: rDensity,      weight: 20 },  // Business density
    { map: rConstruction, weight: 15 },  // CBP construction firm density
  ], activeZips);

  const riskScores = weightedAvg([
    { map: rAiRisk,   weight: 40 },  // AI displacement risk — structural employment threat
    { map: rUnemp,    weight: 40 },  // Unemployment rate — current labor health
    { map: rTurnover, weight: 20 },  // Job turnover — labor market stability
  ], activeZips);

  // ── 9. Income tier (absolute thresholds — not relative) ──────────────────
  // Based on BEA per capita income. Falls back to ACS median HHI / 2.5 estimate.
  // Thresholds sourced from BEA regional income quintiles for Florida.
  function incomeTier(pci, hhi) {
    const val = pci ?? (hhi != null ? hhi / 2.5 : null);
    if (val == null) return null;
    if (val >= 90000) return 'Ultra-Affluent';
    if (val >= 65000) return 'Affluent';
    if (val >= 45000) return 'High';
    if (val >= 32000) return 'Above Average';
    return 'Moderate';
  }

  // ── 10. Market maturity (deterministic thresholds) ───────────────────────
  // Mature = high owner-occ + older age + low new business activity
  // Emerging = low owner-occ + younger + high new business activity
  function marketMaturity(ownerOcc, medAge, empYoy, newBiz12mo) {
    const oo   = ownerOcc   ?? 50;
    const age  = medAge     ?? 38;
    const yoy  = empYoy     ?? 0;
    const newB = newBiz12mo ?? 0;
    const score =
      (oo / 100)                        * 40 +
      (Math.min(age, 60) / 60)          * 30 +
      (1 - Math.min(yoy  / 10,  1))     * 20 +
      (1 - Math.min(newB / 500, 1))     * 10;
    if (score >= 70) return 'Mature';
    if (score >= 50) return 'Established';
    if (score >= 30) return 'Growing';
    return 'Emerging';
  }

  // ── 11. Peer cohort label ─────────────────────────────────────────────────
  function peerCohort(tier, bizDensity, jobCapture, ownerOcc) {
    const oo = ownerOcc   ?? 50;
    const jc = jobCapture ?? 0.5;
    const bd = bizDensity ?? 5;
    if (tier === 'Ultra-Affluent' || tier === 'Affluent') {
      return oo >= 75 ? 'Coastal Affluent' : 'Urban Affluent';
    }
    if (tier === 'High') {
      return jc >= 0.8 ? 'Job-Rich Suburb' : 'Suburban Growth';
    }
    if (jc < 0.4)  return 'Bedroom Community';
    if (bd >= 15)  return 'Dense Commercial Core';
    return 'Working Class Core';
  }

  // ── 12. Upsert all ZIPs ───────────────────────────────────────────────────
  const { upsertZipSignals } = require('../lib/pgStore');
  const results = [];
  let written = 0;

  for (const m of metrics) {
    const { zip } = m;
    const tier     = incomeTier(m.per_capita_income, m.median_hhi);
    const maturity = marketMaturity(m.owner_occ_pct, m.median_age, m.emp_yoy, m.new_biz_12mo);
    const cohort   = peerCohort(tier, m.biz_density_per_1k, m.job_capture_ratio, m.owner_occ_pct);

    const signals = {
      sig_growth_score:       growthScores[zip]      ?? null,
      sig_opportunity_score:  opportunityScores[zip] ?? null,
      sig_risk_score:         riskScores[zip]        ?? null,
      sig_market_maturity:    maturity,
      sig_income_tier:        tier,
      sig_peer_cohort:        cohort,
      sig_biz_density_per_1k: m.biz_density_per_1k != null
        ? Math.min(999999, Math.round(m.biz_density_per_1k * 10) / 10) : null,
      sig_job_capture_ratio:  m.job_capture_ratio != null
        ? Math.min(999999, Math.round(m.job_capture_ratio * 1000) / 1000) : null,
    };

    try {
      await upsertZipSignals(zip, signals);
      written++;
    } catch (e) {
      console.warn(`[worldModelWorker] upsert failed for ${zip}:`, e.message);
    }

    results.push({ zip, ...signals });

    if (written % 100 === 0) {
      console.log(`[worldModelWorker] progress: ${written}/${activeZips.length} ZIPs written`);
    }
  }

  await logEvent(workerName, 'END', null,
    `World Model complete — ${written}/${activeZips.length} ZIPs written. ` +
    `${allFLZips.length - activeZips.length} ZIPs skipped (no signal data yet).`
  );

  return { computed: written, total_geo: allFLZips.length, active: activeZips.length };
};

// ── Standalone entry point ────────────────────────────────────────────────────
if (require.main === module) {
  const db = require('../lib/db');
  async function logEvent(worker, type, zip, msg) {
    try {
      await db.query(
        `INSERT INTO worker_events (worker_name, event_type, error_message, meta, created_at)
         VALUES ($1, $2, NULL, $3, NOW())`,
        [worker, type, JSON.stringify({ message: msg, zip: zip || null })]
      );
    } catch (_) {}
    console.log(`[${worker}] ${type}${zip ? ' ' + zip : ''}: ${msg}`);
  }
  module.exports(db, logEvent)
    .then(r => { console.log('[worldModelWorker] done:', JSON.stringify(r)); process.exit(0); })
    .catch(e => { console.error('[worldModelWorker] fatal:', e.message); process.exit(1); });
}
