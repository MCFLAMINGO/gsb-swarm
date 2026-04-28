'use strict';

/**
 * lib/stateConfig.js
 * Single source of truth for which states LocalIntel is active in.
 *
 * To expand to a new state:
 *   1. Add an entry to STATE_REGISTRY with its ZIP prefixes
 *   2. Add its abbreviation to ACTIVE_STATES
 *   3. That's it — workers, stats, coverage, and MCP all pick it up automatically
 *
 * ZIP prefix reference:
 *   FL  → 32, 33, 34
 *   TX  → 75, 76, 77, 78, 79
 *   GA  → 30, 31
 *   SC  → 29
 *   NC  → 27, 28
 *   TN  → 37, 38
 *   AL  → 35, 36
 *   MS  → 38, 39
 *   LA  → 70, 71
 *   OK  → 73, 74
 *   AR  → 71, 72
 */

const STATE_REGISTRY = {
  FL: { name: 'Florida',        prefixes: ['32', '33', '34'],               region: 'Southeast' },
  TX: { name: 'Texas',          prefixes: ['75', '76', '77', '78', '79'],   region: 'South Central' },
  GA: { name: 'Georgia',        prefixes: ['30', '31'],                      region: 'Southeast' },
  SC: { name: 'South Carolina', prefixes: ['29'],                            region: 'Southeast' },
  NC: { name: 'North Carolina', prefixes: ['27', '28'],                      region: 'Southeast' },
  TN: { name: 'Tennessee',      prefixes: ['37', '38'],                      region: 'Southeast' },
  AL: { name: 'Alabama',        prefixes: ['35', '36'],                      region: 'Southeast' },
  MS: { name: 'Mississippi',    prefixes: ['38', '39'],                      region: 'Southeast' },
  LA: { name: 'Louisiana',      prefixes: ['70', '71'],                      region: 'South Central' },
  OK: { name: 'Oklahoma',       prefixes: ['73', '74'],                      region: 'South Central' },
  AR: { name: 'Arkansas',       prefixes: ['71', '72'],                      region: 'South Central' },
};

/**
 * ACTIVE_STATES — the only states workers will process.
 * Override with ACTIVE_STATES env var: "FL,TX,GA"
 * Default: Florida only.
 */
const ACTIVE_STATES = process.env.ACTIVE_STATES
  ? process.env.ACTIVE_STATES.toUpperCase().split(',').map(s => s.trim()).filter(Boolean)
  : ['FL'];

// Derive active ZIP prefixes from active states
const ACTIVE_PREFIXES = ACTIVE_STATES
  .flatMap(abbr => (STATE_REGISTRY[abbr] || { prefixes: [] }).prefixes)
  .filter((v, i, a) => a.indexOf(v) === i); // dedupe

/**
 * isActiveZip(zip) — returns true if the ZIP is in an active state.
 * Use this everywhere instead of hardcoded startsWith checks.
 */
function isActiveZip(zip) {
  if (!zip) return false;
  return ACTIVE_PREFIXES.some(p => zip.startsWith(p));
}

/**
 * activeZipSqlFilter(alias) — returns a SQL WHERE fragment for filtering
 * businesses to active states. Pass a table alias if needed (e.g. 'b').
 *
 * Usage:
 *   WHERE ${activeZipSqlFilter()} AND other_conditions
 *   WHERE ${activeZipSqlFilter('b')} AND b.status = 'active'
 */
function activeZipSqlFilter(alias = '') {
  const col = alias ? `${alias}.zip` : 'zip';
  if (ACTIVE_PREFIXES.length === 0) return '1=1'; // safety: no filter if misconfigured
  return '(' + ACTIVE_PREFIXES.map(p => `${col} LIKE '${p}%'`).join(' OR ') + ')';
}

/**
 * Summary string for display / MCP manifests.
 */
function coverageSummary() {
  const stateNames = ACTIVE_STATES.map(a => STATE_REGISTRY[a]?.name || a);
  return stateNames.length === 1
    ? `${stateNames[0]} only`
    : stateNames.join(', ');
}

module.exports = {
  STATE_REGISTRY,
  ACTIVE_STATES,
  ACTIVE_PREFIXES,
  isActiveZip,
  activeZipSqlFilter,
  coverageSummary,
};
