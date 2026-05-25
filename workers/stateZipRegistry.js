'use strict';
/**
 * stateZipRegistry.js — Multi-state ZIP registry gateway
 *
 * Today: FL only (delegates to flZipRegistry).
 * Future: add GA, TX, NC, etc. by adding entries to STATE_REGISTRIES.
 *
 * Usage:
 *   const { getZipsByState, getAllZips } = require('./stateZipRegistry');
 *   const zips = getZipsByState(process.env.TARGET_STATE || 'FL');
 */

const FL_REGISTRY = require('./flZipRegistry');

const STATE_REGISTRIES = {
  FL: FL_REGISTRY,
  // GA: require('./gaZipRegistry'),  // add when expanding
  // TX: require('./txZipRegistry'),  // add when expanding
};

function getZipsByState(state = 'FL') {
  const reg = STATE_REGISTRIES[state.toUpperCase()];
  if (!reg) throw new Error(`[stateZipRegistry] No registry for state: ${state}. Add it to STATE_REGISTRIES.`);
  const fn = reg.getZipsByPriority || reg.getAllZips || reg.default;
  if (typeof fn !== 'function') throw new Error(`[stateZipRegistry] Registry for ${state} has no getZipsByPriority() function`);
  return fn().map(z => String(z.zip || z));
}

function getAllZips() {
  return Object.keys(STATE_REGISTRIES).flatMap(s => getZipsByState(s));
}

module.exports = { getZipsByState, getAllZips };
