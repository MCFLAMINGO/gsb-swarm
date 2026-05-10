'use strict';
/**
 * flZipCountyMap.js
 * Pre-built ZIP → 5-digit county FIPS lookup for all FL ZIPs.
 * Extracted from censusLayerWorker.js ZIP registry.
 * Returns empty array if ZIP not found (not a FL ZIP).
 */

// Built from censusLayerWorker FL_ZIPS array (1,474 entries)
let _map = null;

function getMap() {
  if (_map) return _map;
  // Lazy-load from censusLayerWorker to avoid circular deps
  try {
    const src = require('../workers/censusLayerWorker.js');
    // censusLayerWorker exports nothing — parse the ZIP list from its source
    // Instead: inline build from the source file
    _map = buildFromSource();
    return _map;
  } catch {
    _map = buildFromSource();
    return _map;
  }
}

function buildFromSource() {
  const fs   = require('fs');
  const path = require('path');
  const src  = fs.readFileSync(path.join(__dirname, '../workers/censusLayerWorker.js'), 'utf8');

  // Extract { zip: 'XXXXX', ... countyFips: 'YYY' } entries
  const map = {}; // fips5 → [zip, ...]
  const zipRe = /\{\s*zip:\s*'(\d{5})'[^}]+?countyFips:\s*'(\d{3})'/g;
  let m;
  while ((m = zipRe.exec(src)) !== null) {
    const zip   = m[1];
    const fips5 = '12' + m[2];  // state 12 = FL
    if (!map[fips5]) map[fips5] = [];
    map[fips5].push(zip);
  }
  console.log(`[flZipCountyMap] Built: ${Object.keys(map).length} counties, ${Object.values(map).flat().length} ZIPs`);
  return map;
}

/**
 * Get all ZIP codes for a given 5-digit county FIPS (e.g. "12109")
 */
function getZipsForCountyFips(fips5) {
  const m = getMap();
  return m[fips5] || [];
}

module.exports = { getZipsForCountyFips };
