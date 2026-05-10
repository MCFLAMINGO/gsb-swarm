'use strict';
/**
 * flZipMsaMap.js
 * ─────────────────────────────────────────────────────────────────────────────
 * ZIP → MSA (Metropolitan Statistical Area) lookup for Florida.
 *
 * Chain: ZIP → county FIPS (via flZipCountyMap) → MSA FIPS (static table)
 *
 * MSA codes are the OMB CBSA codes used by BLS for SM/CES series.
 * Source: OMB CBSA delineation 2023.
 *
 * FL MSAs included (22 metro areas):
 *   15980 Cape Coral-Fort Myers
 *   18880 Crestview-Fort Walton Beach-Destin
 *   19660 Deltona-Daytona Beach-Ormond Beach
 *   23540 Gainesville
 *   26140 Homosassa Springs
 *   27260 Jacksonville
 *   29460 Lakeland-Winter Haven
 *   33100 Miami-Fort Lauderdale-West Palm Beach
 *   34940 Naples-Marco Island
 *   35840 North Port-Bradenton-Sarasota
 *   36100 Ocala
 *   36740 Orlando-Kissimmee-Sanford
 *   37460 Panama City
 *   37860 Pensacola-Ferry Pass-Brent
 *   38940 Port St. Lucie
 *   39460 Punta Gorda
 *   42680 Sebastian-Vero Beach
 *   42700 Sebring
 *   45220 Tallahassee
 *   45300 Tampa-St. Petersburg-Clearwater
 *   48424 West Palm Beach-Boca Raton (Metro Div — part of Miami CBSA)
 *
 * Counties NOT in any MSA are labeled as micropolitan or rural.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { getZipsForCountyFips } = require('./flZipCountyMap');

// County FIPS5 → MSA code (OMB CBSA 2023 delineation)
// Source: OMB Bulletin 23-01, Appendix: Core Based Statistical Areas
const COUNTY_TO_MSA = {
  // Cape Coral-Fort Myers MSA (15980)
  '12071': '15980',  // Lee

  // Crestview-Fort Walton Beach-Destin MSA (18880)
  '12091': '18880',  // Okaloosa

  // Deltona-Daytona Beach-Ormond Beach MSA (19660)
  '12127': '19660',  // Volusia
  '12035': '19660',  // Flagler

  // Gainesville MSA (23540)
  '12001': '23540',  // Alachua
  '12041': '23540',  // Gilchrist

  // Homosassa Springs MSA (26140) — micropolitan
  '12017': '26140',  // Citrus

  // Jacksonville MSA (27260)
  '12031': '27260',  // Duval
  '12019': '27260',  // Clay
  '12089': '27260',  // Nassau
  '12109': '27260',  // St. Johns
  '12003': '27260',  // Baker

  // Lakeland-Winter Haven MSA (29460)
  '12105': '29460',  // Polk

  // Miami-Fort Lauderdale-West Palm Beach MSA (33100)
  '12086': '33100',  // Miami-Dade
  '12011': '33100',  // Broward
  '12099': '33100',  // Palm Beach

  // Naples-Marco Island MSA (34940)
  '12021': '34940',  // Collier

  // North Port-Bradenton-Sarasota MSA (35840)
  '12115': '35840',  // Sarasota
  '12081': '35840',  // Manatee

  // Ocala MSA (36100)
  '12083': '36100',  // Marion

  // Orlando-Kissimmee-Sanford MSA (36740)
  '12095': '36740',  // Orange
  '12097': '36740',  // Osceola
  '12117': '36740',  // Seminole
  '12069': '36740',  // Lake

  // Panama City MSA (37460)
  '12005': '37460',  // Bay

  // Pensacola-Ferry Pass-Brent MSA (37860)
  '12033': '37860',  // Escambia
  '12113': '37860',  // Santa Rosa

  // Port St. Lucie MSA (38940)
  '12111': '38940',  // St. Lucie
  '12085': '38940',  // Martin

  // Punta Gorda MSA (39460)
  '12015': '39460',  // Charlotte

  // Sebastian-Vero Beach MSA (42680)
  '12061': '42680',  // Indian River

  // Sebring MSA (42700) — micropolitan
  '12055': '42700',  // Highlands

  // Tallahassee MSA (45220)
  '12073': '45220',  // Leon
  '12039': '45220',  // Gadsden
  '12065': '45220',  // Jefferson
  '12129': '45220',  // Wakulla

  // Tampa-St. Petersburg-Clearwater MSA (45300)
  '12057': '45300',  // Hillsborough
  '12103': '45300',  // Pinellas
  '12101': '45300',  // Pasco
  '12053': '45300',  // Hernando

  // Palm Bay-Melbourne-Titusville MSA (37340)
  '12009': '37340',  // Brevard
};

// MSA code → human-readable name
const MSA_NAMES = {
  '15980': 'Cape Coral-Fort Myers',
  '18880': 'Crestview-Fort Walton Beach-Destin',
  '19660': 'Deltona-Daytona Beach-Ormond Beach',
  '23540': 'Gainesville',
  '26140': 'Homosassa Springs',
  '27260': 'Jacksonville',
  '29460': 'Lakeland-Winter Haven',
  '33100': 'Miami-Fort Lauderdale-West Palm Beach',
  '34940': 'Naples-Marco Island',
  '35840': 'North Port-Bradenton-Sarasota',
  '36100': 'Ocala',
  '36740': 'Orlando-Kissimmee-Sanford',
  '37340': 'Palm Bay-Melbourne-Titusville',
  '37460': 'Panama City',
  '37860': 'Pensacola-Ferry Pass-Brent',
  '38940': 'Port St. Lucie',
  '39460': 'Punta Gorda',
  '42680': 'Sebastian-Vero Beach',
  '42700': 'Sebring',
  '45220': 'Tallahassee',
  '45300': 'Tampa-St. Petersburg-Clearwater',
};

// All FL MSA codes with verified BLS SM series coverage
const FL_MSAS = Object.keys(MSA_NAMES);

/**
 * Get MSA code for a county FIPS5 (e.g. "12109" → "27260")
 * Returns null if county is rural/not in a metro area.
 */
function getMsaForCountyFips(fips5) {
  return COUNTY_TO_MSA[fips5] || null;
}

/**
 * Get MSA name for an MSA code.
 */
function getMsaName(msaCode) {
  return MSA_NAMES[msaCode] || `MSA ${msaCode}`;
}

/**
 * Get all ZIP codes for a given MSA code.
 * Chains through county→ZIP lookup from flZipCountyMap.
 */
function getZipsForMsa(msaCode) {
  const zips = new Set();
  for (const [fips5, msa] of Object.entries(COUNTY_TO_MSA)) {
    if (msa === msaCode) {
      for (const zip of getZipsForCountyFips(fips5)) {
        zips.add(zip);
      }
    }
  }
  return [...zips];
}

/**
 * Get MSA code for a ZIP code.
 * Returns null if ZIP is not in a mapped MSA.
 */
function getMsaForZip(zip) {
  // We need to find which county the ZIP is in, then look up MSA
  // This is an O(n) scan but only called occasionally; for workers use getZipsForMsa instead
  for (const [fips5, msaCode] of Object.entries(COUNTY_TO_MSA)) {
    const zips = getZipsForCountyFips(fips5);
    if (zips.includes(zip)) return msaCode;
  }
  return null;
}

module.exports = {
  FL_MSAS,
  MSA_NAMES,
  COUNTY_TO_MSA,
  getMsaForCountyFips,
  getMsaForZip,
  getMsaName,
  getZipsForMsa,
};
