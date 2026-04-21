/**
 * chamberDirectory.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Maps ZIP codes to their local Chamber of Commerce directory URLs.
 * As LocalIntel expands to new ZIPs, add the chamber here.
 *
 * Each entry has:
 *   - url:      the member directory page
 *   - name:     human-readable chamber name
 *   - parser:   'generic' (default GrowthZone/ChamberMaster) or custom key
 *   - zips:     ZIP codes this chamber covers
 *
 * Most chambers run GrowthZone or ChamberMaster SaaS — same HTML structure,
 * same parser works across all of them.
 */

'use strict';

const CHAMBER_DIRECTORY = [

  // ── St. Johns County, FL ─────────────────────────────────────────────────
  {
    name:   'St. Johns County Chamber of Commerce',
    url:    'https://business.sjcchamber.com/member-directory/FindStartsWith?term=%23%21',
    parser: 'growthzone',
    zips:   ['32004', '32081', '32082', '32084', '32086', '32092', '32095', '32259'],
    state:  'FL',
    county: 'St. Johns',
  },

  // ── Duval County / Jacksonville, FL ──────────────────────────────────────
  {
    name:   'Jacksonville Chamber of Commerce (JAX Chamber)',
    url:    'https://members.myjaxchamber.com/member-directory/FindStartsWith?term=%23%21',
    parser: 'growthzone',
    zips:   ['32099', '32202', '32204', '32205', '32206', '32207', '32208', '32209',
             '32210', '32211', '32212', '32216', '32217', '32218', '32219', '32220',
             '32221', '32222', '32223', '32224', '32225', '32226', '32227', '32228',
             '32244', '32246', '32250', '32254', '32256', '32257', '32258'],
    state:  'FL',
    county: 'Duval',
  },

  // ── Clay County, FL ───────────────────────────────────────────────────────
  {
    name:   'Clay County Chamber of Commerce',
    url:    'https://business.claychamber.com/member-directory/FindStartsWith?term=%23%21',
    parser: 'growthzone',
    zips:   ['32003', '32043', '32065', '32068', '32073', '32656'],
    state:  'FL',
    county: 'Clay',
  },

  // ── Flagler County, FL ────────────────────────────────────────────────────
  {
    name:   'Flagler County Chamber of Commerce',
    url:    'https://www.flaglerchamber.org/member-directory/',
    parser: 'growthzone',
    zips:   ['32110', '32136', '32137', '32164'],
    state:  'FL',
    county: 'Flagler',
  },

  // ── Volusia County / Daytona, FL ─────────────────────────────────────────
  {
    name:   'Daytona Regional Chamber of Commerce',
    url:    'https://members.daytonachamber.com/member-directory/FindStartsWith?term=%23%21',
    parser: 'growthzone',
    zips:   ['32114', '32117', '32118', '32119', '32124', '32127', '32128', '32129', '32130'],
    state:  'FL',
    county: 'Volusia',
  },

  // ── Template for new chambers ─────────────────────────────────────────────
  // {
  //   name:   'XYZ Chamber of Commerce',
  //   url:    'https://business.xyzchamber.com/member-directory/FindStartsWith?term=%23%21',
  //   parser: 'growthzone',   // or 'chambermaster' or 'custom'
  //   zips:   ['XXXXX'],
  //   state:  'FL',
  //   county: 'XYZ',
  // },
];

/**
 * Get the chamber(s) that cover a given ZIP code.
 * Returns array (a ZIP may overlap multiple chambers).
 */
function getChambersForZip(zip) {
  return CHAMBER_DIRECTORY.filter(c => c.zips.includes(zip));
}

/**
 * Get all unique chamber URLs we should scrape for a given state.
 */
function getChambersForState(state) {
  return CHAMBER_DIRECTORY.filter(c => c.state === state);
}

/**
 * Auto-discover chamber URL for a ZIP we haven't mapped yet.
 * Searches common patterns: county name + "chamber" + "member-directory"
 * Returns null if not found — manual addition required.
 */
async function discoverChamber(zip, countyName, stateName) {
  const candidates = [
    `https://business.${countyName.toLowerCase().replace(/\s+/g,'')}chamber.com/member-directory/FindStartsWith?term=%23%21`,
    `https://members.${countyName.toLowerCase().replace(/\s+/g,'')}chamber.com/member-directory/FindStartsWith?term=%23%21`,
    `https://www.${countyName.toLowerCase().replace(/\s+/g,'')}chamber.org/member-directory/`,
    `https://www.${countyName.toLowerCase().replace(/\s+/g,'')}chamber.com/business-directory/`,
  ];

  const http  = require('http');
  const https = require('https');

  for (const url of candidates) {
    try {
      const found = await new Promise((resolve) => {
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(url, { timeout: 8000 }, (res) => {
          resolve(res.statusCode === 200 ? url : null);
          res.resume();
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
      });
      if (found) return { url: found, parser: 'growthzone' };
    } catch (_) {}
  }
  return null;
}

module.exports = { CHAMBER_DIRECTORY, getChambersForZip, getChambersForState, discoverChamber };
