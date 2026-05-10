'use strict';
/**
 * worldModelWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * LocalIntel World Model v1 — deterministic, no LLM, no external API calls.
 *
 * Algorithm:
 *   1. Read ALL rows from zip_signals (the materialized signal store)
 *   2. Cluster ZIPs into peer cohorts by structural similarity (population +
 *      income + business density + housing type)
 *   3. For each ZIP: compute z-scores vs its cohort for every signal
 *   4. Score growth trajectory (0-100) and opportunity (0-100)
 *   5. Write zip_forecast (12/24/36 month projections)
 *   6. Detect anomalies (signals > 2σ from cohort) → write zip_anomalies
 *   7. Snapshot current state to zip_signals_history (append-only, daily)
 *
 * Runs daily. Designed to be re-run safely (all writes are upserts by date).
 *
 * Model version: 'v1-cohort-2026'
 * Self-improvement mechanism: anomalies table is the feedback loop.
 *   - Anomalies that remain unexplained for 30+ days → flagged for review
 *   - When a causal_event is linked, anomaly gets explained automatically
 *   - Forecast accuracy is tracked via zip_signals_history vs zip_forecast
 *
 * PHILOSOPHY: "we need to figure out a way to ask ourselves questions we
 * don't know to ask" — the anomaly detector IS that mechanism.
 */

const db = require('../lib/db');

const MODEL_VERSION = 'v1-cohort-2026';
const CYCLE_H = 24;
const ANOMALY_THRESHOLD_NOTABLE    = 2.0;  // 2σ
const ANOMALY_THRESHOLD_SIGNIFICANT = 3.0; // 3σ
const ANOMALY_THRESHOLD_EXTREME    = 4.0;  // 4σ

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Statistics helpers ────────────────────────────────────────────────────────
function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}
function stddev(arr, mu) {
  if (arr.length < 2) return 0;
  const m = mu !== undefined ? mu : mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + Math.pow(v - m, 2), 0) / arr.length);
}
function zScore(value, mu, sd) {
  if (sd === 0) return 0;
  return (value - mu) / sd;
}
function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)];
}

// ── Cohort assignment ─────────────────────────────────────────────────────────
// ZIPs are grouped into cohorts by:
//   - population tier (S/M/L/XL)
//   - income tier (low/mid/high/ultra)
//   - housing character (renter/mixed/owner)
// This ensures we compare ZIPs to their structural peers, not apples to oranges.

function assignCohort(row) {
  const pop  = row.acs_population || row.acs_households * 2.5 || 0;
  const agi  = row.irs_agi_median || 0;
  const occ  = row.acs_owner_occ_pct || 50;

  // Population tier
  let popTier;
  if (pop < 5000)       popTier = 'micro';
  else if (pop < 20000) popTier = 'small';
  else if (pop < 60000) popTier = 'medium';
  else if (pop < 150000) popTier = 'large';
  else                  popTier = 'metro';

  // Income tier (by median AGI)
  let incTier;
  if (agi < 35000)      incTier = 'low';
  else if (agi < 65000) incTier = 'mid';
  else if (agi < 120000) incTier = 'high';
  else                  incTier = 'ultra';

  // Housing character
  let housingTier;
  if (occ > 70)       housingTier = 'owner';
  else if (occ > 45)  housingTier = 'mixed';
  else                housingTier = 'renter';

  return `${popTier}-${incTier}-${housingTier}`;
}

// ── Growth scoring (0-100) ────────────────────────────────────────────────────
// Combines permit activity, migration inflow, business formation, OSM density.
// All scored relative to cohort peers (z-scores → normalized to 0-100).

function scoreGrowth(row, cohortStats) {
  const signals = [
    // Permit activity — strongest leading indicator for residential growth
    { name: 'bps_res_1unit_annual',   weight: 2.5, higherIsBetter: true  },
    { name: 'bps_res_multifam_annual', weight: 2.0, higherIsBetter: true  },
    { name: 'bps_total_units_mo',     weight: 1.5, higherIsBetter: true  },
    // Migration — net inbound AGI = wealth import = growth signal
    { name: 'irs_mig_net_returns',    weight: 2.0, higherIsBetter: true  },
    { name: 'irs_mig_net_agi',        weight: 1.5, higherIsBetter: true  },
    // Business formation — Sunbiz net new entities
    { name: 'sunbiz_net_12mo',        weight: 2.0, higherIsBetter: true  },
    // OSM completeness — proxy for market maturity and discoverability
    { name: 'osm_biz_count',          weight: 1.0, higherIsBetter: true  },
    // IRS income trajectory — higher AGI = spending power
    { name: 'irs_agi_median',         weight: 1.0, higherIsBetter: true  },
    // Vacancy — high vacancy is a drag on growth
    { name: 'acs_vacancy_pct',        weight: 1.2, higherIsBetter: false },
  ];

  let totalWeight = 0;
  let weightedScore = 0;

  for (const sig of signals) {
    const val = row[sig.name];
    if (val === null || val === undefined) continue;
    const stats = cohortStats[sig.name];
    if (!stats || stats.sd === 0) continue;

    let z = zScore(parseFloat(val), stats.mean, stats.sd);
    if (!sig.higherIsBetter) z = -z;

    // Clamp z-score to [-3, 3] and normalize to [0, 100]
    const clamped  = Math.max(-3, Math.min(3, z));
    const norm     = ((clamped + 3) / 6) * 100;

    weightedScore += norm * sig.weight;
    totalWeight   += sig.weight;
  }

  if (totalWeight === 0) return 50; // no data → neutral
  return Math.round(weightedScore / totalWeight);
}

// ── Opportunity scoring (0-100) ───────────────────────────────────────────────
// High opportunity = high population / spending power + low business density
// (underserved market) or specific sector gaps.

function scoreOpportunity(row, cohortStats) {
  const signals = [
    // High income relative to peers = strong spending power
    { name: 'irs_agi_median',              weight: 2.0, higherIsBetter: true },
    { name: 'acs_owner_occ_pct',           weight: 1.0, higherIsBetter: true },
    // Low business density = opportunity gap (fewer competitors per resident)
    { name: 'cbp_total_establishments',    weight: 1.5, higherIsBetter: false },
    { name: 'osm_biz_count',              weight: 1.5, higherIsBetter: false },
    // Population growth proxy (permits = incoming residents)
    { name: 'bps_res_1unit_annual',        weight: 2.0, higherIsBetter: true },
    // Low OSM completeness = SEO/discoverability opportunity
    { name: 'osm_with_website_pct',        weight: 1.5, higherIsBetter: false },
    // Broadband = infrastructure for knowledge businesses
    { name: 'fcc_has_gigabit',             weight: 0.5, higherIsBetter: true },
  ];

  let totalWeight = 0;
  let weightedScore = 0;

  for (const sig of signals) {
    const val = row[sig.name];
    if (val === null || val === undefined || val === false) continue;
    if (typeof val === 'boolean') {
      // Boolean signals: just add full weight if true (gigabit, etc.)
      if (val && sig.higherIsBetter) { weightedScore += 80 * sig.weight; totalWeight += sig.weight; }
      continue;
    }
    const stats = cohortStats[sig.name];
    if (!stats || stats.sd === 0) continue;

    let z = zScore(parseFloat(val), stats.mean, stats.sd);
    if (!sig.higherIsBetter) z = -z;

    const clamped  = Math.max(-3, Math.min(3, z));
    const norm     = ((clamped + 3) / 6) * 100;

    weightedScore += norm * sig.weight;
    totalWeight   += sig.weight;
  }

  if (totalWeight === 0) return 50;
  return Math.round(weightedScore / totalWeight);
}

// ── Market maturity classifier ─────────────────────────────────────────────────
// Based on business density + growth signals + income
function classifyMaturity(row, growthScore) {
  const estabs  = row.cbp_total_establishments || row.zbp_total_establishments || 0;
  const pop     = row.acs_population || 0;
  const density = pop > 0 ? (estabs / pop) * 1000 : 0; // estabs per 1000 residents

  if (density > 80 && growthScore < 45)  return 'saturated';
  if (density > 50 && growthScore < 55)  return 'mature';
  if (density > 20 && growthScore >= 55) return 'growing';
  if (density > 20 && growthScore < 55)  return 'stable';
  if (density < 20 && growthScore >= 55) return 'emerging';
  return 'nascent';
}

// ── Biz delta projection ───────────────────────────────────────────────────────
// Rough % change in business count based on current trajectory.
// Uses permit rate + sunbiz formation rate as proxies.
function projectBizDelta(row, growthScore, horizonMonths) {
  const permitAnnual   = row.bps_total_units_annual || 0;
  const sunbizNet12    = row.sunbiz_net_12mo || 0;
  const totalBiz       = row.cbp_total_establishments || row.zbp_total_establishments || 100;

  // Annual biz change rate from sunbiz (if available)
  const bizGrowthRate = totalBiz > 0 ? sunbizNet12 / totalBiz : 0;

  // If no sunbiz data, use permit activity as proxy (more permits → more population → more demand)
  const permitProxy = totalBiz > 0 ? (permitAnnual / 1000) * 0.05 : 0; // rough: 1000 permits → 5% biz growth

  // Blend: weighted average of data sources
  const baseRate = sunbizNet12 !== 0
    ? bizGrowthRate * 0.7 + permitProxy * 0.3
    : permitProxy;

  // Growth score amplifier: above 50 = positive momentum, below = drag
  const momentumFactor = (growthScore - 50) / 100; // -0.5 to +0.5

  const annualRate = baseRate + (momentumFactor * 0.03); // momentum adds ±3%
  const years = horizonMonths / 12;

  return Math.round(annualRate * years * 100 * 10) / 10; // %
}

// ── Anomaly detection ─────────────────────────────────────────────────────────
const ANOMALY_SIGNALS = [
  { name: 'bps_res_multifam_annual',  label: 'multifamily building permits' },
  { name: 'bps_res_1unit_annual',     label: 'single-family building permits' },
  { name: 'irs_mig_net_returns',      label: 'net migration (households)' },
  { name: 'irs_mig_net_agi',          label: 'net AGI migration ($000s)' },
  { name: 'sunbiz_net_12mo',          label: 'net business formations' },
  { name: 'sunbiz_dissolved_12mo',    label: 'business dissolutions' },
  { name: 'osm_biz_count',           label: 'OSM-indexed businesses' },
  { name: 'irs_agi_median',           label: 'median AGI ($)' },
  { name: 'cbp_total_establishments', label: 'total business establishments' },
  { name: 'acs_vacancy_pct',          label: 'housing vacancy rate (%)' },
  { name: 'fcc_providers_cnt',        label: 'broadband provider count' },
];

function generateAnomalyQuestion(zip, signalName, signalLabel, actual, expected, direction, zSc) {
  const pct = expected > 0 ? Math.abs(Math.round((actual - expected) / expected * 100)) : null;
  const pctStr = pct !== null ? ` (${pct}% ${direction === 'above' ? 'above' : 'below'} cohort median)` : '';
  const zStr = `${Math.abs(zSc).toFixed(1)}σ`;
  return `Why does ZIP ${zip} have ${direction}-median ${signalLabel}${pctStr}? ` +
    `[${zStr} from peer cohort — ${zSc > 0 ? 'unusually high' : 'unusually low'}]`;
}

function generateCandidateCauses(signalName, direction) {
  const causes = {
    'bps_res_multifam_annual': {
      above: [
        { cause: 'Large approved development project under construction', plausibility: 'high', data_needed_to_confirm: 'Check zip_causal_events for rezoning or development approvals' },
        { cause: 'Investor-driven rental housing surge (REIT activity)', plausibility: 'medium', data_needed_to_confirm: 'Cross-reference corporate entity filings in sunbiz_entities' },
        { cause: 'Workforce housing shortage driving government-sponsored development', plausibility: 'medium', data_needed_to_confirm: 'Check county housing authority records and HUD grants' },
      ],
      below: [
        { cause: 'Zoning restrictions limiting multifamily development', plausibility: 'high', data_needed_to_confirm: 'Review county comprehensive plan and zoning maps' },
        { cause: 'Low demand signal — population decline or stagnation', plausibility: 'medium', data_needed_to_confirm: 'Check irs_mig_net_returns trend and acs_population' },
        { cause: 'Infrastructure limitations (sewer capacity, roads)', plausibility: 'medium', data_needed_to_confirm: 'Check FDOT and county utility master plans' },
      ],
    },
    'irs_mig_net_returns': {
      above: [
        { cause: 'Retirement or lifestyle migration from high-cost states', plausibility: 'high', data_needed_to_confirm: 'Check irs_mig_top_origin — if NY/CA/IL, strong signal' },
        { cause: 'Remote work enabled population growth', plausibility: 'high', data_needed_to_confirm: 'Cross-reference acs_wfh if available, broadband coverage' },
        { cause: 'New employer or industry anchor attracting workers', plausibility: 'medium', data_needed_to_confirm: 'Check zip_causal_events for major employer announcements' },
      ],
      below: [
        { cause: 'Aging population exodus (seniors to higher-care facilities)', plausibility: 'medium', data_needed_to_confirm: 'Cross with acs_retiree_index and irs_mig_top_dest' },
        { cause: 'Housing affordability driving out-migration to cheaper ZIPs', plausibility: 'high', data_needed_to_confirm: 'Compare irs_agi_median to median_home_value ratio' },
        { cause: 'Natural disaster or hurricane displacement (temporary)', plausibility: 'medium', data_needed_to_confirm: 'Check zip_causal_events for disaster declarations' },
      ],
    },
    'sunbiz_net_12mo': {
      above: [
        { cause: 'New commercial development attracting entrepreneurs', plausibility: 'high', data_needed_to_confirm: 'Cross with bps_commercial_mo and county permit records' },
        { cause: 'Gig economy LLC formation wave (not necessarily real businesses)', plausibility: 'medium', data_needed_to_confirm: 'Review sunbiz entity types — solo LLCs with no employees' },
      ],
      below: [
        { cause: 'Post-pandemic closure wave still working through', plausibility: 'medium', data_needed_to_confirm: 'Compare sunbiz_dissolved_12mo to baseline years' },
        { cause: 'Market saturation — no room for new entrants', plausibility: 'medium', data_needed_to_confirm: 'Check cbp_total_establishments vs population density' },
      ],
    },
  };

  const defaults = {
    above: [
      { cause: 'Structural growth driver not yet captured in current data sources', plausibility: 'medium', data_needed_to_confirm: 'Add to zip_causal_events and monitor for 90 days' },
    ],
    below: [
      { cause: 'Structural constraint or demand suppression not yet captured', plausibility: 'medium', data_needed_to_confirm: 'Add to zip_causal_events and monitor for 90 days' },
    ],
  };

  return (causes[signalName] || defaults)[direction] || defaults[direction];
}

// ── Cohort statistics ──────────────────────────────────────────────────────────
function computeCohortStats(cohortRows) {
  const stats = {};
  const signalNames = ANOMALY_SIGNALS.map(s => s.name);

  for (const sigName of signalNames) {
    const vals = cohortRows
      .map(r => r[sigName])
      .filter(v => v !== null && v !== undefined && !isNaN(parseFloat(v)))
      .map(v => parseFloat(v));

    if (vals.length < 2) {
      stats[sigName] = { mean: 0, sd: 0, median: 0, n: vals.length };
    } else {
      const mu = mean(vals);
      const sd = stddev(vals, mu);
      stats[sigName] = { mean: mu, sd, median: percentile(vals, 50), n: vals.length };
    }
  }

  return stats;
}

// ── Snapshot to zip_signals_history ──────────────────────────────────────────
async function snapshotHistory(row) {
  try {
    await db.query(
      `INSERT INTO zip_signals_history
         (zip, snapshot_date,
          acs_population, acs_households, acs_median_hhi,
          irs_agi_median, irs_returns, irs_mig_net_returns, irs_mig_net_agi,
          cbp_total_establishments, zbp_total_establishments,
          bps_res_1unit_annual, bps_total_units_annual, bps_total_value_annual,
          osm_biz_count, sunbiz_active_entities, sunbiz_net_12mo,
          fcc_has_25_3, fcc_has_gigabit,
          sig_growth_score, sig_opportunity_score, sig_market_maturity,
          sig_peer_cohort, sig_data_completeness)
       VALUES ($1, CURRENT_DATE, $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       ON CONFLICT (zip, snapshot_date) DO UPDATE SET
         acs_population           = EXCLUDED.acs_population,
         irs_agi_median           = EXCLUDED.irs_agi_median,
         bps_total_units_annual   = EXCLUDED.bps_total_units_annual,
         sig_growth_score         = EXCLUDED.sig_growth_score,
         sig_opportunity_score    = EXCLUDED.sig_opportunity_score,
         sig_market_maturity      = EXCLUDED.sig_market_maturity,
         sig_data_completeness    = EXCLUDED.sig_data_completeness`,
      [
        row.zip,
        row.acs_population          || null,
        row.acs_households          || null,
        row.acs_median_hhi          || null,
        row.irs_agi_median          || null,
        row.irs_returns             || null,
        row.irs_mig_net_returns     || null,
        row.irs_mig_net_agi         || null,
        row.cbp_total_establishments || null,
        row.zbp_total_establishments || null,
        row.bps_res_1unit_annual    || null,
        row.bps_total_units_annual  || null,
        row.bps_total_value_annual  || null,
        row.osm_biz_count           || null,
        row.sunbiz_active_entities  || null,
        row.sunbiz_net_12mo         || null,
        row.fcc_has_25_3            || null,
        row.fcc_has_gigabit         || null,
        row.sig_growth_score        || null,
        row.sig_opportunity_score   || null,
        row.sig_market_maturity     || null,
        row.sig_peer_cohort         || null,
        row.sig_data_completeness   || null,
      ]
    );
  } catch (e) {
    if (!e.message.includes('zip_signals_history')) {
      console.warn(`[worldModel] History snapshot failed for ${row.zip}:`, e.message);
    }
  }
}

// ── Main pass ─────────────────────────────────────────────────────────────────
async function runPass() {
  const t0 = Date.now();
  console.log('[worldModel] Starting world model pass...');

  // Read all zip_signals rows
  let allRows;
  try {
    allRows = await db.query(`SELECT * FROM zip_signals ORDER BY zip`);
  } catch (e) {
    console.error('[worldModel] Cannot read zip_signals:', e.message);
    return;
  }
  if (!allRows.length) {
    console.warn('[worldModel] zip_signals is empty — workers must run first');
    return;
  }
  console.log(`[worldModel] Read ${allRows.length} ZIPs from zip_signals`);

  // Assign cohorts
  for (const row of allRows) {
    row._cohort = assignCohort(row);
  }

  // Group by cohort
  const cohorts = {};
  for (const row of allRows) {
    if (!cohorts[row._cohort]) cohorts[row._cohort] = [];
    cohorts[row._cohort].push(row);
  }
  console.log(`[worldModel] ${Object.keys(cohorts).length} peer cohorts identified`);

  // Compute stats per cohort
  const cohortStats = {};
  for (const [cohortKey, rows] of Object.entries(cohorts)) {
    cohortStats[cohortKey] = computeCohortStats(rows);
  }

  // Process each ZIP
  let forecasts = 0, anomalies = 0, snapshots = 0, errors = 0;

  for (const row of allRows) {
    try {
      const cohortKey   = row._cohort;
      const cohortRows  = cohorts[cohortKey];
      const stats       = cohortStats[cohortKey];

      // ── Compute scores ──────────────────────────────────────────────────
      const growthScore  = scoreGrowth(row, stats);
      const oppScore     = scoreOpportunity(row, stats);
      const maturity12   = classifyMaturity(row, growthScore);

      // Project maturity forward — simple state machine
      const MATURITY_PROGRESSION = {
        nascent: 'emerging', emerging: 'growing', growing: 'stable',
        stable: 'mature', mature: 'saturated', saturated: 'saturated',
      };
      const maturity24 = growthScore > 55
        ? (MATURITY_PROGRESSION[maturity12] || maturity12)
        : maturity12;
      const maturity36 = growthScore > 60
        ? (MATURITY_PROGRESSION[maturity24] || maturity24)
        : maturity24;

      // Business delta projections
      const bizDelta12 = projectBizDelta(row, growthScore, 12);
      const bizDelta24 = projectBizDelta(row, growthScore, 24);
      const bizDelta36 = projectBizDelta(row, growthScore, 36);

      // Data completeness score (how many key signals are non-null)
      const KEY_SIGNALS = [
        'acs_population','irs_agi_median','cbp_total_establishments',
        'bps_total_units_annual','osm_biz_count','sunbiz_active_entities',
        'irs_mig_net_returns','fcc_has_25_3',
      ];
      const present = KEY_SIGNALS.filter(k => row[k] !== null && row[k] !== undefined).length;
      const completeness = Math.round((present / KEY_SIGNALS.length) * 100);

      // Model confidence — lower when few cohort peers or low completeness
      const peerCount    = cohortRows.length;
      const peerConf     = Math.min(1, peerCount / 10);    // 10+ peers = full confidence
      const dataConf     = completeness / 100;
      const confidence   = Math.round((peerConf * 0.4 + dataConf * 0.6) * 100) / 100;

      // ── Driver signals (top 3 positive, top 2 negative) ─────────────────
      const drivers = [];
      for (const sig of ANOMALY_SIGNALS) {
        const val = row[sig.name];
        if (val === null || val === undefined) continue;
        const st = stats[sig.name];
        if (!st || st.sd === 0) continue;
        const z = zScore(parseFloat(val), st.mean, st.sd);
        drivers.push({ signal: sig.name, label: sig.label, value: parseFloat(val), z, weight: Math.abs(z) });
      }
      drivers.sort((a, b) => b.weight - a.weight);
      const topDrivers = drivers.slice(0, 5).map(d => ({
        signal: d.signal,
        value:  d.value,
        z_score: Math.round(d.z * 100) / 100,
        direction: d.z > 0 ? 'above_cohort' : 'below_cohort',
      }));

      // ── Opportunity gaps (sector underrepresentation) ───────────────────
      const opportunityGaps = [];
      if (row.cbp_total_establishments && row.acs_population) {
        const bizPer1k = (row.cbp_total_establishments / row.acs_population) * 1000;
        const cohortBizPer1k = cohortRows
          .map(r => r.cbp_total_establishments && r.acs_population
            ? (r.cbp_total_establishments / r.acs_population) * 1000 : null)
          .filter(v => v !== null);
        const med = percentile(cohortBizPer1k, 50);
        if (bizPer1k < med * 0.7) {
          opportunityGaps.push({
            sector: 'general_business',
            gap_score: Math.round((1 - bizPer1k / med) * 100),
            rationale: `ZIP has ${bizPer1k.toFixed(1)} businesses per 1000 residents vs cohort median of ${med.toFixed(1)}`,
          });
        }
      }
      if (row.osm_with_website_pct !== null && row.osm_with_website_pct < 30) {
        opportunityGaps.push({
          sector: 'digital_presence',
          gap_score: Math.round((30 - row.osm_with_website_pct) / 30 * 100),
          rationale: `Only ${row.osm_with_website_pct}% of businesses have a website — SEO and discoverability gap`,
        });
      }

      // ── Summaries (plain English, no LLM) ──────────────────────────────
      const growthWord = growthScore > 70 ? 'strong' : growthScore > 55 ? 'moderate' : growthScore < 35 ? 'declining' : 'flat';
      const summary12 = `ZIP ${row.zip} shows ${growthWord} growth momentum (score ${growthScore}/100). ` +
        `Market is currently ${maturity12}. Projected to remain ${maturity24} by 12 months. ` +
        (bizDelta12 > 0 ? `Business count expected to grow ~${bizDelta12}%.` : `Business count may contract ~${Math.abs(bizDelta12)}%.`) +
        ` Opportunity score: ${oppScore}/100. Data completeness: ${completeness}%.`;
      const summary36 = `36-month outlook: Market transitions to ${maturity36}. ` +
        `Cumulative business delta ~${bizDelta36}%. ` +
        (row.irs_mig_net_returns > 0 ? `Net in-migration indicates sustained demand. ` : '') +
        (opportunityGaps.length > 0 ? `Key opportunities: ${opportunityGaps.map(g => g.sector).join(', ')}.` : 'Market approaching equilibrium.');

      // ── Write zip_forecast ──────────────────────────────────────────────
      await db.query(
        `INSERT INTO zip_forecast
           (zip, model_version, generated_at,
            peer_cohort, peer_zip_count,
            proj_12mo_growth_score, proj_12mo_opportunity, proj_12mo_biz_delta_pct, proj_12mo_maturity, proj_12mo_confidence,
            proj_24mo_growth_score, proj_24mo_opportunity, proj_24mo_biz_delta_pct, proj_24mo_maturity, proj_24mo_confidence,
            proj_36mo_growth_score, proj_36mo_opportunity, proj_36mo_biz_delta_pct, proj_36mo_maturity, proj_36mo_confidence,
            driver_signals, risk_factors, opportunity_gaps, summary_12mo, summary_36mo)
         VALUES ($1,$2,NOW(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
         ON CONFLICT (zip, model_version, generated_at::DATE) DO UPDATE SET
           peer_cohort                = EXCLUDED.peer_cohort,
           peer_zip_count             = EXCLUDED.peer_zip_count,
           proj_12mo_growth_score     = EXCLUDED.proj_12mo_growth_score,
           proj_12mo_opportunity      = EXCLUDED.proj_12mo_opportunity,
           proj_12mo_biz_delta_pct    = EXCLUDED.proj_12mo_biz_delta_pct,
           proj_12mo_maturity         = EXCLUDED.proj_12mo_maturity,
           proj_12mo_confidence       = EXCLUDED.proj_12mo_confidence,
           proj_24mo_growth_score     = EXCLUDED.proj_24mo_growth_score,
           proj_24mo_opportunity      = EXCLUDED.proj_24mo_opportunity,
           proj_36mo_growth_score     = EXCLUDED.proj_36mo_growth_score,
           proj_36mo_opportunity      = EXCLUDED.proj_36mo_opportunity,
           proj_36mo_biz_delta_pct    = EXCLUDED.proj_36mo_biz_delta_pct,
           proj_36mo_maturity         = EXCLUDED.proj_36mo_maturity,
           driver_signals             = EXCLUDED.driver_signals,
           opportunity_gaps           = EXCLUDED.opportunity_gaps,
           summary_12mo               = EXCLUDED.summary_12mo,
           summary_36mo               = EXCLUDED.summary_36mo`,
        [
          row.zip, MODEL_VERSION,
          cohortKey, peerCount,
          growthScore,   oppScore,   bizDelta12, maturity12, confidence,
          growthScore,   oppScore,   bizDelta24, maturity24, Math.max(0.1, confidence - 0.1),
          Math.round(growthScore * 0.9), Math.round(oppScore * 0.9), bizDelta36, maturity36, Math.max(0.1, confidence - 0.2),
          JSON.stringify(topDrivers),
          JSON.stringify([]),  // risk_factors — populated by anomaly detector
          JSON.stringify(opportunityGaps),
          summary12,
          summary36,
        ]
      );
      forecasts++;

      // ── Update zip_signals with computed scores ─────────────────────────
      await db.query(
        `UPDATE zip_signals SET
           sig_growth_score      = $2,
           sig_opportunity_score = $3,
           sig_market_maturity   = $4,
           sig_peer_cohort       = $5,
           sig_data_completeness = $6,
           sig_computed_at       = NOW()
         WHERE zip = $1`,
        [row.zip, growthScore, oppScore, maturity12, cohortKey, completeness]
      );

      // ── Anomaly detection ───────────────────────────────────────────────
      for (const sig of ANOMALY_SIGNALS) {
        const val = row[sig.name];
        if (val === null || val === undefined) continue;
        const st = stats[sig.name];
        if (!st || st.n < 3 || st.sd === 0) continue;

        const z   = Math.abs(zScore(parseFloat(val), st.mean, st.sd));
        if (z < ANOMALY_THRESHOLD_NOTABLE) continue;

        const direction = parseFloat(val) > st.mean ? 'above' : 'below';
        const severity  = z >= ANOMALY_THRESHOLD_EXTREME    ? 'extreme'
                        : z >= ANOMALY_THRESHOLD_SIGNIFICANT ? 'significant'
                        : 'notable';
        const question  = generateAnomalyQuestion(row.zip, sig.name, sig.label, parseFloat(val), st.mean, direction, zScore(parseFloat(val), st.mean, st.sd));
        const causes    = generateCandidateCauses(sig.name, direction);

        try {
          await db.query(
            `INSERT INTO zip_anomalies
               (zip, signal_name, actual_value, expected_value, z_score, direction, severity, question, candidate_causes, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open')
             ON CONFLICT (zip, signal_name, (detected_at::DATE)) DO UPDATE SET
               actual_value    = EXCLUDED.actual_value,
               expected_value  = EXCLUDED.expected_value,
               z_score         = EXCLUDED.z_score,
               severity        = EXCLUDED.severity,
               question        = EXCLUDED.question,
               candidate_causes = EXCLUDED.candidate_causes`,
            [row.zip, sig.name, parseFloat(val), st.mean, zScore(parseFloat(val), st.mean, st.sd), direction, severity, question, JSON.stringify(causes)]
          );
          anomalies++;
        } catch (ae) {
          if (!ae.message.includes('zip_anomalies')) {
            console.warn(`[worldModel] Anomaly upsert failed (${row.zip}/${sig.name}):`, ae.message);
          }
        }
      }

      // ── Daily history snapshot ──────────────────────────────────────────
      // Augment row with computed scores before snapshotting
      const augmented = {
        ...row,
        sig_growth_score:      growthScore,
        sig_opportunity_score: oppScore,
        sig_market_maturity:   maturity12,
        sig_peer_cohort:       cohortKey,
        sig_data_completeness: completeness,
      };
      await snapshotHistory(augmented);
      snapshots++;

    } catch (e) {
      errors++;
      if (errors <= 3) console.error(`[worldModel] Error processing ${row.zip}:`, e.message);
    }
  }

  const dur = Math.round((Date.now() - t0) / 1000);
  console.log(`[worldModel] Pass complete in ${dur}s:`);
  console.log(`  Forecasts: ${forecasts} | Anomalies: ${anomalies} | Snapshots: ${snapshots} | Errors: ${errors}`);
  console.log(`  Cohorts: ${Object.keys(cohorts).length} | ZIPs: ${allRows.length}`);

  // Self-check: log anomaly count for visibility
  try {
    const anomalyStats = await db.query(
      `SELECT severity, COUNT(*) as cnt FROM zip_anomalies WHERE status='open' GROUP BY severity ORDER BY severity`
    );
    if (anomalyStats.length) {
      console.log('[worldModel] Open anomalies by severity:', anomalyStats.map(r => `${r.severity}:${r.cnt}`).join(' | '));
    }
  } catch (_) {}
}

// ── Daemon loop ───────────────────────────────────────────────────────────────
(async function main() {
  // Wait for signal workers to populate zip_signals before first run
  await sleep(90 * 1000); // 90s startup delay
  console.log('[worldModel] Worker started');
  while (true) {
    try { await runPass(); }
    catch (e) { console.error('[worldModel] Pass crashed:', e.message); }
    console.log(`[worldModel] Sleeping ${CYCLE_H}h`);
    await sleep(CYCLE_H * 3600 * 1000);
  }
})();

module.exports = { runPass };
