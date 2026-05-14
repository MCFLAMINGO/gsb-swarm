'use strict';
// ── Standalone entry point (spawned by dashboard-server.js trigger) ───────────
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

/**
 * worldModelWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Computes derived sig_* signals for all TARGET_ZIPS.
 * Pure math — ZERO LLM calls. Reads zip_signals + businesses table.
 * Runs AFTER primary workers (ACS, FRED, QWI, QCEW, CES, LODES, BEA) have
 * written their data. Safe to re-run at any time (idempotent upserts).
 *
 * Writes to zip_signals:
 *   sig_growth_score        numeric  0–100
 *   sig_opportunity_score   numeric  0–100
 *   sig_risk_score          numeric  0–100
 *   sig_market_maturity     text     "Emerging" | "Growing" | "Established" | "Mature"
 *   sig_income_tier         text     "Moderate" | "Above Average" | "High" | "Affluent" | "Ultra-Affluent"
 *   sig_peer_cohort         text     e.g. "Coastal Affluent" | "Suburban Growth" | "Working Class Core"
 *   sig_biz_density_per_1k  numeric  businesses per 1,000 residents
 *   sig_job_capture_ratio   numeric  lodes_jobs_here / qcew_employment (how many jobs the ZIP captures)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const TARGET_ZIPS = ['32082', '32081', '32250', '32266', '32233', '32259', '32034'];

module.exports = async function worldModelWorker(db, logEvent) {
  const workerName = 'worldModelWorker';
  await logEvent(workerName, 'START', null, `Computing derived signals for ${TARGET_ZIPS.length} ZIPs`);

  // ── 1. Load all zip_signals rows for target ZIPs ──────────────────────────
  const rows = await db.query(
    `SELECT * FROM zip_signals WHERE zip = ANY($1)`,
    [TARGET_ZIPS]
  );
  if (!rows.length) {
    await logEvent(workerName, 'SKIP', null, 'No zip_signals rows found — run primary workers first');
    return { skipped: true, reason: 'no_rows' };
  }

  // ── 2. Load business counts per ZIP ──────────────────────────────────────
  const bizRows = await db.query(
    `SELECT zip, COUNT(*)::int AS biz_count FROM businesses WHERE zip = ANY($1) GROUP BY zip`,
    [TARGET_ZIPS]
  );
  const bizMap = {};
  for (const r of bizRows) bizMap[r.zip] = Number(r.biz_count || 0);

  // Index rows by ZIP
  const sigMap = {};
  for (const r of rows) sigMap[r.zip] = r;

  // ── 3. Helper: safe numeric parse ────────────────────────────────────────
  const n = (v) => (v != null && v !== '' ? Number(v) : null);
  const orZero = (v) => (n(v) ?? 0);

  // ── 4. Compute per-ZIP raw metrics ────────────────────────────────────────
  // We rank ZIPs against each other for growth + opportunity + risk.
  // Each metric contributes a sub-score; final scores are 0–100.

  const metrics = TARGET_ZIPS.map((zip) => {
    const s = sigMap[zip] || {};
    const bizCount = bizMap[zip] || 0;
    const pop = n(s.acs_population);

    // Biz density per 1k residents
    const biz_density_per_1k = pop && pop > 0 ? (bizCount / pop) * 1000 : null;

    // Job capture ratio: lodes_jobs_here / qcew_employment
    // >1 = ZIP is a job destination; <1 = bedroom community
    const lodes_jobs = n(s.lodes_jobs_here);
    const qcew_emp   = n(s.qcew_employment);
    const job_capture_ratio = lodes_jobs != null && qcew_emp != null && qcew_emp > 0
      ? lodes_jobs / qcew_emp : null;

    return {
      zip,
      // Growth inputs
      emp_yoy:           n(s.qcew_emp_yoy_pct),      // employment YoY %
      new_biz_12mo:      n(s.sunbiz_new_12mo),        // new entity formations
      units_permitted:   n(s.bps_total_units_annual), // residential permits
      // Opportunity inputs
      invest_score:      n(s.investment_opportunity_score), // CES composite
      net_flow:          n(s.lodes_net_flow),           // worker net flow
      biz_density_per_1k,
      // Risk inputs
      ai_risk:           n(s.ai_displacement_risk),
      unemployment_rate: n(s.fred_unemployment_rate),
      turnover_rate:     n(s.qwi_turnover_rate),
      // Income tier inputs
      per_capita_income: n(s.bea_per_capita_income),
      median_hhi:        n(s.acs_median_hhi),
      // Maturity inputs
      owner_occ_pct:     n(s.acs_owner_occ_pct),
      median_age:        n(s.acs_median_age),
      // Job capture
      job_capture_ratio,
    };
  });

  // ── 5. Rank-normalize helper ──────────────────────────────────────────────
  // For a given metric key, returns a map of zip → 0–100 score.
  // higher_is_better = true means highest value → 100.
  function rankScore(key, higherIsBetter = true) {
    const vals = metrics
      .map((m) => ({ zip: m.zip, v: m[key] }))
      .filter((x) => x.v != null);

    if (vals.length === 0) return {};

    const sorted = [...vals].sort((a, b) =>
      higherIsBetter ? b.v - a.v : a.v - b.v
    );
    const total = sorted.length;
    const out = {};
    sorted.forEach((x, i) => {
      // Rank 0 = best → score 100; rank (total-1) = worst → score 0
      out[x.zip] = total === 1 ? 100 : Math.round(((total - 1 - i) / (total - 1)) * 100);
    });
    return out;
  }

  // ── 6. Compute composite scores ──────────────────────────────────────────

  // GROWTH SCORE — weighted average of rank scores
  // emp_yoy (40%), new_biz_12mo (35%), units_permitted (25%)
  const rEmpYoy   = rankScore('emp_yoy', true);
  const rNewBiz   = rankScore('new_biz_12mo', true);
  const rPermits  = rankScore('units_permitted', true);

  // OPPORTUNITY SCORE
  // invest_score (40%), net_flow (35%), biz_density_per_1k (25%)
  const rInvest   = rankScore('invest_score', true);
  const rFlow     = rankScore('net_flow', true);
  const rDensity  = rankScore('biz_density_per_1k', true);

  // RISK SCORE — higher = riskier
  // ai_risk (40%), unemployment_rate (40%), turnover_rate (20%)
  const rAiRisk   = rankScore('ai_risk', true);        // higher ai_risk = higher risk score
  const rUnemp    = rankScore('unemployment_rate', true);
  const rTurnover = rankScore('turnover_rate', true);

  function weightedAvg(scores, weights) {
    // scores: array of { map: {zip: score}, weight }
    // Returns {zip: score}
    const out = {};
    let totalWeight = 0;
    for (const { map, weight } of scores) {
      totalWeight += weight;
      for (const zip of TARGET_ZIPS) {
        if (map[zip] != null) {
          out[zip] = (out[zip] || 0) + map[zip] * weight;
        }
      }
    }
    // Normalize by actual weight used per ZIP
    const usedWeight = {};
    for (const { map, weight } of scores) {
      for (const zip of TARGET_ZIPS) {
        if (map[zip] != null) usedWeight[zip] = (usedWeight[zip] || 0) + weight;
      }
    }
    for (const zip of TARGET_ZIPS) {
      if (usedWeight[zip]) out[zip] = Math.round(out[zip] / usedWeight[zip]);
    }
    return out;
  }

  const growthScores      = weightedAvg([{ map: rEmpYoy, weight: 40 }, { map: rNewBiz, weight: 35 }, { map: rPermits, weight: 25 }]);
  const opportunityScores = weightedAvg([{ map: rInvest, weight: 40 }, { map: rFlow,   weight: 35 }, { map: rDensity, weight: 25 }]);
  const riskScores        = weightedAvg([{ map: rAiRisk, weight: 40 }, { map: rUnemp,  weight: 40 }, { map: rTurnover, weight: 20 }]);

  // ── 7. Income tier (absolute thresholds, not relative) ───────────────────
  function incomeTier(pci, hhi) {
    // Use per_capita_income if available, fall back to median_hhi / 2.5 estimate
    const val = pci ?? (hhi != null ? hhi / 2.5 : null);
    if (val == null) return null;
    if (val >= 90000)  return 'Ultra-Affluent';
    if (val >= 65000)  return 'Affluent';
    if (val >= 45000)  return 'High';
    if (val >= 32000)  return 'Above Average';
    return 'Moderate';
  }

  // ── 8. Market maturity (owner-occ + median age thresholds) ───────────────
  function marketMaturity(ownerOcc, medAge, empYoy, newBiz12mo) {
    // Mature = high owner-occ + older median age + low/no new formations
    // Emerging = low owner-occ + younger + high new business activity
    const oo   = ownerOcc ?? 50;
    const age  = medAge   ?? 38;
    const yoy  = empYoy   ?? 0;
    const newB = newBiz12mo ?? 0;

    const maturityScore = (oo / 100) * 40 + (age / 60) * 30 + (1 - Math.min(yoy / 10, 1)) * 20 + (1 - Math.min(newB / 500, 1)) * 10;

    if (maturityScore >= 70) return 'Mature';
    if (maturityScore >= 50) return 'Established';
    if (maturityScore >= 30) return 'Growing';
    return 'Emerging';
  }

  // ── 9. Peer cohort — cluster label based on income + density + job capture ─
  function peerCohort(incomeTierVal, bizDensity, jobCapture, ownerOcc) {
    const oo  = ownerOcc ?? 50;
    const jc  = jobCapture ?? 0.5;
    const bd  = bizDensity ?? 5;

    if (incomeTierVal === 'Ultra-Affluent' || incomeTierVal === 'Affluent') {
      if (oo >= 75) return 'Coastal Affluent';
      return 'Urban Affluent';
    }
    if (incomeTierVal === 'High') {
      if (jc >= 0.8) return 'Job-Rich Suburb';
      return 'Suburban Growth';
    }
    if (jc < 0.4) return 'Bedroom Community';
    if (bd >= 15) return 'Dense Commercial Core';
    return 'Working Class Core';
  }

  // ── 10. Build signals per ZIP + upsert ───────────────────────────────────
  const { upsertZipSignals } = require('../lib/pgStore');
  const results = [];

  for (const m of metrics) {
    const { zip } = m;
    const tier     = incomeTier(m.per_capita_income, m.median_hhi);
    const maturity = marketMaturity(m.owner_occ_pct, m.median_age, m.emp_yoy, m.new_biz_12mo);
    const cohort   = peerCohort(tier, m.biz_density_per_1k, m.job_capture_ratio, m.owner_occ_pct);

    const signals = {
      sig_growth_score:        growthScores[zip]      ?? null,
      sig_opportunity_score:   opportunityScores[zip] ?? null,
      sig_risk_score:          riskScores[zip]        ?? null,
      sig_market_maturity:     maturity,
      sig_income_tier:         tier,
      sig_peer_cohort:         cohort,
      sig_biz_density_per_1k:  m.biz_density_per_1k != null ? Math.round(m.biz_density_per_1k * 10) / 10 : null,
      sig_job_capture_ratio:   m.job_capture_ratio   != null ? Math.round(m.job_capture_ratio * 1000) / 1000 : null,
    };

    await upsertZipSignals(zip, signals);
    results.push({ zip, ...signals });
    console.log(`[worldModelWorker] ${zip} → growth=${signals.sig_growth_score} opp=${signals.sig_opportunity_score} risk=${signals.sig_risk_score} tier=${tier} cohort=${cohort}`);
  }

  await logEvent(workerName, 'END', null,
    `World Model computed for ${results.length} ZIPs. Scores written to sig_* columns.`
  );

  return { computed: results.length, zips: results };
};
