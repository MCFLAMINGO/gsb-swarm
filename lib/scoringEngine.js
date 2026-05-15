'use strict';
/**
 * scoringEngine.js — B62
 * Unified MCDA/WLC site intelligence scoring. Given a zip_signals row, a
 * concept profile (lib/conceptProfiles.js), and statewide bounds, computes a
 * 0–100 total_score with a transparent per-factor breakdown.
 *
 * Pure math + table-driven normalization. Zero LLM calls.
 */

function minMax(val, min, max) {
  if (val == null || isNaN(val)) return 0;
  if (max === min) return 0.5;
  return Math.max(0, Math.min(1, (val - min) / (max - min)));
}

// Gaussian bell curve — used for "sweet spot" factors (e.g. QSR HHI at ~$65k).
function gaussian(val, peak, sigma) {
  if (val == null || isNaN(val) || !sigma) return 0;
  return Math.exp(-0.5 * Math.pow((val - peak) / sigma, 2));
}

// Logistic curve — captures diminishing returns above a midpoint (e.g. AADT > 40k).
function sigmoid(val, midpoint, steepness) {
  if (val == null || isNaN(val)) return 0;
  return 1 / (1 + Math.exp(-steepness * (val - midpoint)));
}

function pickValue(key, sigRow) {
  switch (key) {
    case 'aadt':         return sigRow.fdot_max_aadt != null ? Number(sigRow.fdot_max_aadt) : null;
    case 'hhi':          return sigRow.acs_median_hhi != null ? Number(sigRow.acs_median_hhi) : null;
    case 'daytime_pop':  return (Number(sigRow.lodes_jobs_here || 0) + Number(sigRow.acs_population || 0)) || null;
    case 'food_gap':     return sigRow.biz_density_per_1k != null
                            ? Math.max(0, 100 - Number(sigRow.biz_density_per_1k))
                            : 50;
    case 'growth':       return sigRow.sig_growth_score != null ? Number(sigRow.sig_growth_score) : null;
    case 'opportunity':  return sigRow.sig_opportunity_score != null ? Number(sigRow.sig_opportunity_score) : null;
    case 'owner_occ':    return sigRow.acs_owner_occ_pct != null ? Number(sigRow.acs_owner_occ_pct) : null;
    case 'age_index':    return sigRow.acs_median_age != null ? Number(sigRow.acs_median_age) : null;
    case 'population':   return sigRow.acs_population != null ? Number(sigRow.acs_population) : null;
    case 'psycho_index': return sigRow.psycho_index != null ? Number(sigRow.psycho_index) : null;
    // B65 — business-layer signals (written by businessSignalWorker)
    case 'sig_wallet_rate':  return sigRow.sig_wallet_rate  != null ? Number(sigRow.sig_wallet_rate)  : null;
    case 'sig_task_density': return sigRow.sig_task_density != null ? Number(sigRow.sig_task_density) : null;
    default:             return sigRow[key] != null ? Number(sigRow[key]) : null;
  }
}

function boundsFor(key, bounds) {
  // Bounds keyed by factor name; fall back to a sensible per-key default.
  if (bounds && bounds[key]) return bounds[key];
  switch (key) {
    case 'owner_occ':        return { min: 0,   max: 100 };
    case 'age_index':        return { min: 25,  max: 65 };
    case 'population':       return bounds?.population || { min: 0, max: 100000 };
    case 'sig_wallet_rate':  return { min: 0, max: 100 };
    case 'sig_task_density': return { min: 0, max: 100 };
    default:                 return { min: 0, max: 100 };
  }
}

function normalize(key, val, normFn, normParams, bounds) {
  if (normFn === 'precomputed') {
    // Value is already 0–100 (e.g. psycho_index); scale to 0–1.
    if (val == null || isNaN(val)) return 0;
    return Math.max(0, Math.min(1, Number(val) / 100));
  }
  if (val == null || isNaN(val)) return 0;
  if (normFn === 'gaussian') {
    return gaussian(val, normParams.peak, normParams.sigma);
  }
  if (normFn === 'sigmoid') {
    return sigmoid(val, normParams.midpoint, normParams.steepness);
  }
  const b = boundsFor(key, bounds);
  return minMax(val, b.min, b.max);
}

// B63 — composite psychographic index from OSM POI density + ACS lifestyle vars.
// Returns 0–100. Bounds optional (sensible defaults for FL ZIPs).
function computePsychoIndex(sigRow, bounds) {
  if (!sigRow) return 0;
  const b = bounds || {};
  const golfNorm    = minMax(Number(sigRow.osm_golf_count)    || 0, 0, b.golf_max    || 10);
  const artsNorm    = minMax(Number(sigRow.osm_arts_count)    || 0, 0, b.arts_max    || 20);
  const worshipNorm = minMax(Number(sigRow.osm_worship_count) || 0, 0, b.worship_max || 50);
  const fitnessNorm = minMax(Number(sigRow.osm_fitness_count) || 0, 0, b.fitness_max || 30);
  const eduNorm     = minMax(Number(sigRow.acs_pct_bachelors_plus)   || 0, 0, 60);
  const stemNorm    = minMax(Number(sigRow.acs_pct_stem_occupations) || 0, 0, 30);
  const ageNorm     = gaussian(Number(sigRow.acs_median_age) || 38, 42, 12);

  const psycho = (
    artsNorm    * 0.30 +
    golfNorm    * 0.25 +
    eduNorm     * 0.20 +
    stemNorm    * 0.10 +
    worshipNorm * 0.08 +
    fitnessNorm * 0.05 +
    ageNorm     * 0.02
  ) * 100;

  return Math.round(Math.min(100, Math.max(0, psycho)));
}

function evalHardFloors(profile, sigRow) {
  const floors = profile.hardFloors || [];
  for (const f of floors) {
    if (f === 'min_aadt_5000') {
      const aadt = Number(sigRow.fdot_max_aadt || 0);
      if (aadt < 5000) {
        return { triggered: true, reason: `AADT ${aadt} below 5,000 drive-by threshold` };
      }
    }
    if (f === 'no_residential') {
      if (sigRow.osm_road_class === 'residential') {
        return { triggered: true, reason: 'Dominant road class is residential — no commercial traffic' };
      }
    }
  }
  return { triggered: false, reason: null };
}

function scoreZipForConcept(sigRow, conceptProfile, statewideBounds) {
  if (!sigRow || !conceptProfile) {
    return { total_score: 0, factor_breakdown: [], psycho_index: 0, hard_floor_triggered: false, hard_floor_reason: null };
  }

  // Always compute psycho_index — surfaced on every result even when the
  // profile doesn't weight it (callers may still want to display it).
  const psycho_index = sigRow.psycho_index != null && !isNaN(Number(sigRow.psycho_index))
    ? Number(sigRow.psycho_index)
    : computePsychoIndex(sigRow, statewideBounds);
  // Inject into sigRow so factors with normFn='precomputed' pick it up.
  const scoringRow = { ...sigRow, psycho_index };

  const floor = evalHardFloors(conceptProfile, scoringRow);
  if (floor.triggered) {
    return {
      total_score: 0,
      factor_breakdown: [],
      psycho_index,
      hard_floor_triggered: true,
      hard_floor_reason: floor.reason,
    };
  }

  const breakdown = [];
  let total = 0;
  for (const f of conceptProfile.factors) {
    const raw = pickValue(f.key, scoringRow);
    const normalized = normalize(f.key, raw, f.normFn, f.normParams || {}, statewideBounds);
    const points = normalized * f.weight * 100;
    total += points;
    breakdown.push({
      factor: f.key,
      label: f.label,
      raw_value: raw,
      normalized: Math.round(normalized * 1000) / 1000,
      weight: f.weight,
      points: Math.round(points * 10) / 10,
      source: f.source,
    });
  }

  // B65 — food-concept closure penalty: high food-business closure rate signals
  // a struggling market. Applied as a multiplier AFTER weighted sum so it acts
  // as risk damping rather than a weighted factor. A 50% closure rate caps the
  // penalty at 7.5% of total_score. Only fires on food-oriented profiles.
  const isFoodConcept = /QSR|Drive-By|Dining/i.test(conceptProfile.name || '');
  let closure_penalty_applied = null;
  if (isFoodConcept && scoringRow.sig_closure_rate_food != null) {
    const closureRate = Number(scoringRow.sig_closure_rate_food) || 0;
    const penaltyFrac = Math.max(0, Math.min(1, closureRate / 100)) * 0.15;
    const before = total;
    total = total * (1 - penaltyFrac);
    closure_penalty_applied = {
      sig_closure_rate_food: closureRate,
      penalty_fraction: Math.round(penaltyFrac * 1000) / 1000,
      score_before: Math.round(before * 10) / 10,
      score_after:  Math.round(total * 10) / 10,
    };
  }

  return {
    total_score: Math.round(Math.max(0, Math.min(100, total))),
    factor_breakdown: breakdown,
    psycho_index,
    hard_floor_triggered: false,
    hard_floor_reason: null,
    closure_penalty_applied,
  };
}

module.exports = {
  scoreZipForConcept,
  computePsychoIndex,
  minMax,
  gaussian,
  sigmoid,
};
