'use strict';
/**
 * searchRank.js — B70
 * Unified concept-profile-weighted ORDER BY generator for business search.
 *
 * buildConceptOrderBy(concept, alias='zs', bizAlias='b') returns a SQL
 * fragment that ranks businesses by:
 *   1. zip-level signals from zip_signals (weighted per concept profile)
 *   2. business-level signals (wallet, claimed_at, confidence_score)
 *
 * The zip-signal portion accounts for ~60% of weight; the business-level
 * portion ~40%. All zip_signals fields are COALESCE'd to 0 so businesses
 * without a matching zip_signals row still sort cleanly (rather than
 * NULL-poisoning the order).
 *
 * Pure string composition — no values are interpolated from user input,
 * concept is validated against the known profile set.
 */

const { CONCEPT_PROFILES } = require('./conceptProfiles');

// Map profile factor keys → underlying zip_signals column expression.
// Mirrors lib/scoringEngine.js pickValue() — these are the canonical
// signal columns each factor reads from.
const FACTOR_SQL = {
  aadt:             'zs.fdot_max_aadt',
  hhi:              'zs.acs_median_hhi',
  daytime_pop:      '(COALESCE(zs.lodes_jobs_here,0) + COALESCE(zs.acs_population,0))',
  food_gap:         '(100 - COALESCE(zs.biz_density_per_1k, 50))',
  growth:           'zs.sig_growth_score',
  opportunity:      'zs.sig_opportunity_score',
  owner_occ:        'zs.acs_owner_occ_pct',
  age_index:        'zs.acs_median_age',
  population:       'zs.acs_population',
  psycho_index:     'zs.psycho_index',
  sig_wallet_rate:  'zs.sig_wallet_rate',
  sig_task_density: 'zs.sig_task_density',
  // Fallback: assume the key is itself a column on zip_signals.
};

function factorExpr(key, alias) {
  const expr = FACTOR_SQL[key] || `${alias}.${key}`;
  // Swap the default 'zs' alias when a custom alias is requested.
  return alias === 'zs' ? expr : expr.replace(/\bzs\./g, `${alias}.`);
}

/**
 * buildConceptOrderBy(concept, alias='zs', bizAlias='b')
 * Returns a SQL fragment WITHOUT the leading "ORDER BY" keyword:
 *   (weighted zip score + weighted biz signals) DESC
 *
 * Designed to be appended as `ORDER BY ${buildConceptOrderBy(...)}`.
 */
function buildConceptOrderBy(concept, alias = 'zs', bizAlias = 'b') {
  const profile = CONCEPT_PROFILES[concept] || CONCEPT_PROFILES.GENERAL;
  const factors = Array.isArray(profile.factors) ? profile.factors : [];

  // Zip-level weighted sum — each factor contributes (raw / 100) * weight.
  // We divide by 100 because most signals are 0–100 scale; we want a 0–1
  // contribution before multiplying by the profile weight.
  const zipTerms = factors.length
    ? factors.map(f =>
        `COALESCE(${factorExpr(f.key, alias)}, 0) * ${Number(f.weight) || 0}`
      ).join(' +\n      ')
    : '0';

  // Business-level signals — wallet attached, claimed, and confidence score
  // are universal "this business is real and ready" boosters. Constants
  // here are deliberately chosen so business signals dominate when zip
  // signals are missing (the common case today).
  const bizTerms = [
    `(CASE WHEN ${bizAlias}.wallet IS NOT NULL THEN 15 ELSE 0 END)`,
    `(CASE WHEN ${bizAlias}.claimed_at IS NOT NULL THEN 10 ELSE 0 END)`,
    `(COALESCE(${bizAlias}.confidence_score, 0) * 40)`,
  ].join(' +\n      ');

  return `(\n      ${zipTerms} +\n      ${bizTerms}\n    ) DESC, ${bizAlias}.name ASC`;
}

module.exports = { buildConceptOrderBy };
