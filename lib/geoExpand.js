'use strict';

/**
 * lib/geoExpand.js — Cross-ZIP city/abbreviation expansion helper.
 *
 * Given a query string and an optional pinned ZIP, returns the ZIPs to search.
 * When a recognized city name or local abbreviation appears in the query, its
 * ZIPs are unioned onto the base set so e.g. "reservation at st augustine fish
 * camp" expands to include St. Augustine ZIPs rather than only the default PVB
 * area. Used by reservation, RFQ, and the main search path.
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
    const re = new RegExp(`\\b${cityKey.replace(/\s+/g, '\\s+')}\\b`, 'i');
    if (re.test(q)) {
      return [...new Set([...base, ...CITY_ZIP_MAP[cityKey]])];
    }
  }
  return base;
}

module.exports = { expandZips, CITY_ZIP_MAP, DEFAULT_ZIPS };
