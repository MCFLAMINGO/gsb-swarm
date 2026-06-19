'use strict';

/**
 * lib/geoExpand.js — Cross-ZIP city/abbreviation expansion + nearby-ZIP lookup.
 *
 * Two jobs:
 *  1. expandZips(query, pinnedZip) — city name/abbreviation → ZIP set (unchanged).
 *  2. getNearbyZips(zip)           — returns [zip, ...neighbors within 15 miles]
 *     using a haversine neighbor map built from fl_zip_geo at startup.
 *     Falls back to STATIC_NEIGHBORS (SJC area) if DB hasn't loaded yet.
 */

const CITY_ZIP_MAP = {
  'st augustine':       ['32084','32095','32086','32092'],
  'saint augustine':    ['32084','32095','32086','32092'],
  'sta':                ['32084','32095'],
  'stj':                ['32084','32095'],
  'jacksonville':       ['32202','32207','32210','32216','32217','32224','32225','32256','32257','32258','32259'],
  'jax':                ['32202','32207','32210','32216','32217','32224','32225','32256','32257','32258','32259'],
  'nocatee':            ['32081'],
  'noc':                ['32081'],
  'ponte vedra':        ['32082','32081'],
  'ponte vedra beach':  ['32082'],
  'pvb':                ['32082'],
  'orange park':        ['32065','32073'],
  'opk':                ['32065','32073'],
  'fleming island':     ['32003'],
  'fi':                 ['32003'],
  'st johns':           ['32259','32092','32095'],
  'palm valley':        ['32082'],
  'neptune beach':      ['32266'],
  'atlantic beach':     ['32233'],
  'jacksonville beach': ['32250'],
  'jax beach':          ['32250'],
};

const DEFAULT_ZIPS = ['32082','32081','32250','32266','32233','32259','32034'];

// ── Nearby-ZIP neighbor map ────────────────────────────────────────────────────
// Built once at startup from fl_zip_geo via haversine.
// Map: zip → [neighbors within 15 miles, sorted nearest-first]
// Populated by loadNeighborMap() called from index.js after DB is ready.
let _neighborMap = null; // null = not loaded yet

// Static fallback for the SJC / PVB area while the async map loads.
const STATIC_NEIGHBORS = {
  '32082': ['32081','32004','32095'],
  '32081': ['32082','32095','32004','32259'],
  '32084': ['32095','32092','32086'],
  '32250': ['32266','32233','32224'],
  '32266': ['32250','32233'],
  '32233': ['32266','32250'],
  '32259': ['32081','32092','32095'],
  '32092': ['32084','32095','32259'],
};

/**
 * Load the full FL neighbor map from Postgres (haversine, 15-mile radius).
 * Call once after DB migrations have run. Safe to call multiple times — no-op if loaded.
 * @returns {Promise<void>}
 */
async function loadNeighborMap() {
  if (_neighborMap) return; // already loaded
  try {
    const db = require('./db');
    const rows = await db.query(`
      SELECT z1.zip, array_agg(z2.zip ORDER BY (
          3958.8 * acos(LEAST(1.0,
            cos(radians(z1.lat::float)) * cos(radians(z2.lat::float)) *
            cos(radians(z2.lon::float) - radians(z1.lon::float)) +
            sin(radians(z1.lat::float)) * sin(radians(z2.lat::float))
          ))
        )) AS neighbors
      FROM fl_zip_geo z1
      JOIN fl_zip_geo z2 ON z2.zip != z1.zip
        AND (3958.8 * acos(LEAST(1.0,
            cos(radians(z1.lat::float)) * cos(radians(z2.lat::float)) *
            cos(radians(z2.lon::float) - radians(z1.lon::float)) +
            sin(radians(z1.lat::float)) * sin(radians(z2.lat::float))
          ))) <= 15
      GROUP BY z1.zip
    `);
    const map = {};
    for (const row of rows) {
      map[row.zip] = row.neighbors || [];
    }
    _neighborMap = map;
    console.log(`[geoExpand] Neighbor map loaded — ${Object.keys(map).length} ZIPs with 15-mile coverage`);
  } catch (e) {
    console.warn('[geoExpand] Could not load neighbor map (using static fallback):', e.message);
  }
}

/**
 * Return [pinnedZip, ...neighbors within 15 miles], ordered nearest-first.
 * Falls back to STATIC_NEIGHBORS for SJC area, then [pinnedZip] alone.
 * Always includes pinnedZip as first element.
 *
 * @param {string} zip
 * @returns {string[]}
 */
function getNearbyZips(zip) {
  if (!zip) return DEFAULT_ZIPS.slice();
  const map = _neighborMap || STATIC_NEIGHBORS;
  const neighbors = map[zip] || [];
  return [zip, ...neighbors];
}

/**
 * Given a query string and an optional pinned ZIP, return the array of ZIPs to search.
 * Detects city names/abbreviations using word-boundary matches and expands accordingly.
 * Longer keys are matched first so "ponte vedra beach" wins over "ponte vedra".
 *
 * @param {string} query
 * @param {string|null} pinnedZip
 * @returns {string[]}
 */
function expandZips(query, pinnedZip) {
  const q = (query || '').toLowerCase();
  const base = pinnedZip ? [pinnedZip] : DEFAULT_ZIPS.slice();
  // Sort keys longest-first so multi-word cities beat shorter prefixes.
  const keys = Object.keys(CITY_ZIP_MAP).sort((a, b) => b.length - a.length);
  for (const cityKey of keys) {
    const re = new RegExp(`\\b${cityKey.replace(/\\s+/g, '\\s+')}\\b`, 'i');
    if (re.test(q)) {
      return [...new Set([...base, ...CITY_ZIP_MAP[cityKey]])];
    }
  }
  return base;
}

module.exports = { expandZips, getNearbyZips, loadNeighborMap, CITY_ZIP_MAP, DEFAULT_ZIPS };
