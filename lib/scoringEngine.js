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
    default:             return sigRow[key] != null ? Number(sigRow[key]) : null;
  }
}

function boundsFor(key, bounds) {
  // Bounds keyed by factor name; fall back to a sensible per-key default.
  if (bounds && bounds[key]) return bounds[key];
  switch (key) {
    case 'owner_occ':  return { min: 0,   max: 100 };
    case 'age_index':  return { min: 25,  max: 65 };
    case 'population': return bounds?.population || { min: 0, max: 100000 };
    default:           return { min: 0, max: 100 };
  }
}

function normalize(key, val, normFn, normParams, bounds) {
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
    return { total_score: 0, factor_breakdown: [], hard_floor_triggered: false, hard_floor_reason: null };
  }

  const floor = evalHardFloors(conceptProfile, sigRow);
  if (floor.triggered) {
    return {
      total_score: 0,
      factor_breakdown: [],
      hard_floor_triggered: true,
      hard_floor_reason: floor.reason,
    };
  }

  const breakdown = [];
  let total = 0;
  for (const f of conceptProfile.factors) {
    const raw = pickValue(f.key, sigRow);
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

  return {
    total_score: Math.round(Math.max(0, Math.min(100, total))),
    factor_breakdown: breakdown,
    hard_floor_triggered: false,
    hard_floor_reason: null,
  };
}

module.exports = {
  scoreZipForConcept,
  minMax,
  gaussian,
  sigmoid,
};
