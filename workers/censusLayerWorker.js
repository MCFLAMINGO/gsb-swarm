'use strict';
/**
 * censusLayerWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages all Census API economic + confidence layers. Three datasets, three
 * refresh schedules — each runs independently on its own timer.
 *
 * LAYERS:
 *
 *   data/census_layer/{zip}.json          — per-ZIP economic fingerprint
 *     • ZBP 2018: establishment count + employment by NAICS sector (ZIP-level)
 *     • CBP 2023: county-level sector health (allocated to ZIP by density)
 *     • Derived: sector_gaps[], dominant_sector, employment_density
 *
 *   data/census_layer/_confidence.json    — per-ZIP data confidence scores
 *     • PDB 2024: low_response_score (Census hard-to-reach proxy)
 *     • Our own coverage: business_index_coverage, has_demo_data, oracle_cycles
 *     • Combined: data_confidence_score 0-100 + tier (VERIFIED/ESTIMATED/PROXY/SPARSE)
 *
 *   data/census_layer/_county_sectors.json — county NAICS fingerprint (shared)
 *     • CBP 2023: all counties we cover, full NAICS breakdown
 *
 * REFRESH SCHEDULES:
 *   ZBP  — once on startup only (2018 vintage, never changes)
 *   CBP  — monthly (updated annually, but we check monthly)
 *   PDB  — quarterly (updated annually)
 *
 * NO API KEY REQUIRED — all endpoints are public.
 *
 * Oracle reads from data/census_layer/{zip}.json to get:
 *   - employment_density (employees per 1000 residents)
 *   - sector_gaps (NAICS sectors present at county but absent at ZIP)
 *   - data_confidence_score (how much to trust oracle signals)
 */

const https   = require('https');
const pgStore = require('../lib/pgStore');
const db      = require('../lib/db');

// ── County FIPS map ────────────────────────────────────────────────────────────
// ── County FIPS map — all 67 Florida counties ─────────────────────────────────
const COUNTY_CONFIG = [
  { name: "Alachua",              state: '12', county: '001', fips: '12001' },
  { name: "Baker",                state: '12', county: '003', fips: '12003' },
  { name: "Bay",                  state: '12', county: '005', fips: '12005' },
  { name: "Bradford",             state: '12', county: '007', fips: '12007' },
  { name: "Brevard",              state: '12', county: '009', fips: '12009' },
  { name: "Broward",              state: '12', county: '011', fips: '12011' },
  { name: "Calhoun",              state: '12', county: '013', fips: '12013' },
  { name: "Charlotte",            state: '12', county: '015', fips: '12015' },
  { name: "Citrus",               state: '12', county: '017', fips: '12017' },
  { name: "Clay",                 state: '12', county: '019', fips: '12019' },
  { name: "Collier",              state: '12', county: '021', fips: '12021' },
  { name: "Columbia",             state: '12', county: '023', fips: '12023' },
  { name: "DeSoto",               state: '12', county: '027', fips: '12027' },
  { name: "Dixie",                state: '12', county: '029', fips: '12029' },
  { name: "Duval",                state: '12', county: '031', fips: '12031' },
  { name: "Escambia",             state: '12', county: '033', fips: '12033' },
  { name: "Flagler",              state: '12', county: '035', fips: '12035' },
  { name: "Franklin",             state: '12', county: '037', fips: '12037' },
  { name: "Gadsden",              state: '12', county: '039', fips: '12039' },
  { name: "Gilchrist",            state: '12', county: '041', fips: '12041' },
  { name: "Glades",               state: '12', county: '043', fips: '12043' },
  { name: "Gulf",                 state: '12', county: '045', fips: '12045' },
  { name: "Hamilton",             state: '12', county: '047', fips: '12047' },
  { name: "Hardee",               state: '12', county: '049', fips: '12049' },
  { name: "Hendry",               state: '12', county: '051', fips: '12051' },
  { name: "Hernando",             state: '12', county: '053', fips: '12053' },
  { name: "Highlands",            state: '12', county: '055', fips: '12055' },
  { name: "Hillsborough",         state: '12', county: '057', fips: '12057' },
  { name: "Holmes",               state: '12', county: '059', fips: '12059' },
  { name: "Indian River",         state: '12', county: '061', fips: '12061' },
  { name: "Jackson",              state: '12', county: '063', fips: '12063' },
  { name: "Jefferson",            state: '12', county: '065', fips: '12065' },
  { name: "Lafayette",            state: '12', county: '067', fips: '12067' },
  { name: "Lake",                 state: '12', county: '069', fips: '12069' },
  { name: "Lee",                  state: '12', county: '071', fips: '12071' },
  { name: "Leon",                 state: '12', county: '073', fips: '12073' },
  { name: "Levy",                 state: '12', county: '075', fips: '12075' },
  { name: "Liberty",              state: '12', county: '077', fips: '12077' },
  { name: "Madison",              state: '12', county: '079', fips: '12079' },
  { name: "Manatee",              state: '12', county: '081', fips: '12081' },
  { name: "Marion",               state: '12', county: '083', fips: '12083' },
  { name: "Martin",               state: '12', county: '085', fips: '12085' },
  { name: "Miami-Dade",           state: '12', county: '086', fips: '12086' },
  { name: "Monroe",               state: '12', county: '087', fips: '12087' },
  { name: "Nassau",               state: '12', county: '089', fips: '12089' },
  { name: "Okaloosa",             state: '12', county: '091', fips: '12091' },
  { name: "Okeechobee",           state: '12', county: '093', fips: '12093' },
  { name: "Orange",               state: '12', county: '095', fips: '12095' },
  { name: "Osceola",              state: '12', county: '097', fips: '12097' },
  { name: "Palm Beach",           state: '12', county: '099', fips: '12099' },
  { name: "Pasco",                state: '12', county: '101', fips: '12101' },
  { name: "Pinellas",             state: '12', county: '103', fips: '12103' },
  { name: "Polk",                 state: '12', county: '105', fips: '12105' },
  { name: "Putnam",               state: '12', county: '107', fips: '12107' },
  { name: "Santa Rosa",           state: '12', county: '113', fips: '12113' },
  { name: "Sarasota",             state: '12', county: '115', fips: '12115' },
  { name: "Seminole",             state: '12', county: '117', fips: '12117' },
  { name: "St. Johns",            state: '12', county: '109', fips: '12109' },
  { name: "St. Lucie",            state: '12', county: '111', fips: '12111' },
  { name: "Sumter",               state: '12', county: '119', fips: '12119' },
  { name: "Suwannee",             state: '12', county: '121', fips: '12121' },
  { name: "Taylor",               state: '12', county: '123', fips: '12123' },
  { name: "Union",                state: '12', county: '125', fips: '12125' },
  { name: "Volusia",              state: '12', county: '127', fips: '12127' },
  { name: "Wakulla",              state: '12', county: '129', fips: '12129' },
  { name: "Walton",               state: '12', county: '131', fips: '12131' },
  { name: "Washington",           state: '12', county: '133', fips: '12133' },
];

// ── FL ZIP seed — 1,473 Florida ZIPs ─────────────────────────────────────────
// Used as fallback by getTargetZips() if zip_intelligence has no county data.
// Source: Census ZCTA→county 2020 crosswalk + GeoNames 2023. Do not edit manually.
// To add ZIPs: add businesses to Postgres — getTargetZips() discovers them automatically.
const FL_ZIP_SEED = [
  { zip: '32601', name: "Gainesville",                county: "Alachua",            state: '12', countyFips: '001', lat: 29.6489, lon: -82.325 },
  { zip: '32602', name: "Gainesville",                county: "Alachua",            state: '12', countyFips: '001', lat: 29.6299, lon: -82.3966 },
  { zip: '32603', name: "Gainesville",                county: "Alachua",            state: '12', countyFips: '001', lat: 29.6515, lon: -82.3493 },
  { zip: '32604', name: "Gainesville",                county: "Alachua",            state: '12', countyFips: '001', lat: 29.5733, lon: -82.3979 },
  { zip: '32605', name: "Gainesville",                county: "Alachua",            state: '12', countyFips: '001', lat: 29.6785, lon: -82.3679 },
  { zip: '32606', name: "Gainesville",                county: "Alachua",            state: '12', countyFips: '001', lat: 29.6954, lon: -82.4023 },
  { zip: '32607', name: "Gainesville",                county: "Alachua",            state: '12', countyFips: '001', lat: 29.6456, lon: -82.4033 },
  { zip: '32608', name: "Gainesville",                county: "Alachua",            state: '12', countyFips: '001', lat: 29.6132, lon: -82.3873 },
  { zip: '32609', name: "Gainesville",                county: "Alachua",            state: '12', countyFips: '001', lat: 29.7005, lon: -82.308 },
  { zip: '32610', name: "Gainesville",                county: "Alachua",            state: '12', countyFips: '001', lat: 29.6813, lon: -82.3539 },
  { zip: '32611', name: "Gainesville",                county: "Alachua",            state: '12', countyFips: '001', lat: 29.6813, lon: -82.3539 },
  { zip: '32612', name: "Gainesville",                county: "Alachua",            state: '12', countyFips: '001', lat: 29.6813, lon: -82.3539 },
  { zip: '32614', name: "Gainesville",                county: "Alachua",            state: '12', countyFips: '001', lat: 29.6813, lon: -82.3539 },
  { zip: '32615', name: "Alachua",                    county: "Alachua",            state: '12', countyFips: '001', lat: 29.8135, lon: -82.472 },
  { zip: '32616', name: "Alachua",                    county: "Alachua",            state: '12', countyFips: '001', lat: 29.792, lon: -82.496 },
  { zip: '32618', name: "Archer",                     county: "Alachua",            state: '12', countyFips: '001', lat: 29.5597, lon: -82.5108 },
  { zip: '32627', name: "Gainesville",                county: "Alachua",            state: '12', countyFips: '001', lat: 29.6516, lon: -82.3248 },
  { zip: '32631', name: "Earleton",                   county: "Alachua",            state: '12', countyFips: '001', lat: 29.7439, lon: -82.1034 },
  { zip: '32633', name: "Evinston",                   county: "Alachua",            state: '12', countyFips: '001', lat: 29.4869, lon: -82.2312 },
  { zip: '32635', name: "Gainesville",                county: "Alachua",            state: '12', countyFips: '001', lat: 29.6813, lon: -82.3539 },
  { zip: '32640', name: "Hawthorne",                  county: "Alachua",            state: '12', countyFips: '001', lat: 29.574, lon: -82.1056 },
  { zip: '32641', name: "Gainesville",                county: "Alachua",            state: '12', countyFips: '001', lat: 29.6824, lon: -82.2014 },
  { zip: '32643', name: "High Springs",               county: "Alachua",            state: '12', countyFips: '001', lat: 29.841, lon: -82.6156 },
  { zip: '32653', name: "Gainesville",                county: "Alachua",            state: '12', countyFips: '001', lat: 29.7728, lon: -82.3782 },
  { zip: '32654', name: "Island Grove",               county: "Alachua",            state: '12', countyFips: '001', lat: 29.4536, lon: -82.1065 },
  { zip: '32655', name: "High Springs",               county: "Alachua",            state: '12', countyFips: '001', lat: 29.8175, lon: -82.6006 },
  { zip: '32658', name: "La Crosse",                  county: "Alachua",            state: '12', countyFips: '001', lat: 29.8433, lon: -82.4048 },
  { zip: '32662', name: "Lochloosa",                  county: "Alachua",            state: '12', countyFips: '001', lat: 29.5116, lon: -82.1004 },
  { zip: '32667', name: "Micanopy",                   county: "Alachua",            state: '12', countyFips: '001', lat: 29.5122, lon: -82.3053 },
  { zip: '32669', name: "Newberry",                   county: "Alachua",            state: '12', countyFips: '001', lat: 29.6609, lon: -82.5852 },
  { zip: '32694', name: "Waldo",                      county: "Alachua",            state: '12', countyFips: '001', lat: 29.7871, lon: -82.1608 },
  { zip: '32040', name: "Glen Saint Mary",            county: "Baker",              state: '12', countyFips: '003', lat: 30.2861, lon: -82.2041 },
  { zip: '32063', name: "Macclenny",                  county: "Baker",              state: '12', countyFips: '003', lat: 30.2737, lon: -82.1325 },
  { zip: '32072', name: "Olustee",                    county: "Baker",              state: '12', countyFips: '003', lat: 30.2041, lon: -82.4287 },
  { zip: '32087', name: "Sanderson",                  county: "Baker",              state: '12', countyFips: '003', lat: 30.2522, lon: -82.2729 },
  { zip: '32401', name: "Panama City",                county: "Bay",                state: '12', countyFips: '005', lat: 30.1606, lon: -85.6494 },
  { zip: '32402', name: "Panama City",                county: "Bay",                state: '12', countyFips: '005', lat: 30.2345, lon: -85.692 },
  { zip: '32403', name: "Panama City",                county: "Bay",                state: '12', countyFips: '005', lat: 30.0583, lon: -85.5762 },
  { zip: '32404', name: "Panama City",                county: "Bay",                state: '12', countyFips: '005', lat: 30.1653, lon: -85.5763 },
  { zip: '32405', name: "Panama City",                county: "Bay",                state: '12', countyFips: '005', lat: 30.1949, lon: -85.6727 },
  { zip: '32406', name: "Panama City",                county: "Bay",                state: '12', countyFips: '005', lat: 30.2345, lon: -85.692 },
  { zip: '32407', name: "Panama City Beach",          county: "Bay",                state: '12', countyFips: '005', lat: 30.2007, lon: -85.8136 },
  { zip: '32408', name: "Panama City",                county: "Bay",                state: '12', countyFips: '005', lat: 30.1655, lon: -85.7116 },
  { zip: '32409', name: "Panama City",                county: "Bay",                state: '12', countyFips: '005', lat: 30.3117, lon: -85.6923 },
  { zip: '32410', name: "Mexico Beach",               county: "Bay",                state: '12', countyFips: '005', lat: 29.9395, lon: -85.4096 },
  { zip: '32411', name: "Panama City",                county: "Bay",                state: '12', countyFips: '005', lat: 30.2345, lon: -85.692 },
  { zip: '32412', name: "Panama City",                county: "Bay",                state: '12', countyFips: '005', lat: 30.2345, lon: -85.692 },
  { zip: '32413', name: "Panama City Beach",          county: "Bay",                state: '12', countyFips: '005', lat: 30.3105, lon: -85.9106 },
  { zip: '32417', name: "Panama City",                county: "Bay",                state: '12', countyFips: '005', lat: 30.1595, lon: -85.6598 },
  { zip: '32438', name: "Fountain",                   county: "Bay",                state: '12', countyFips: '005', lat: 30.4753, lon: -85.4293 },
  { zip: '32444', name: "Lynn Haven",                 county: "Bay",                state: '12', countyFips: '005', lat: 30.2362, lon: -85.6467 },
  { zip: '32466', name: "Youngstown",                 county: "Bay",                state: '12', countyFips: '005', lat: 30.3269, lon: -85.5169 },
  { zip: '32026', name: "Raiford",                    county: "Bradford",           state: '12', countyFips: '007', lat: 30.0699, lon: -82.1927 },
  { zip: '32042', name: "Graham",                     county: "Bradford",           state: '12', countyFips: '007', lat: 29.9689, lon: -82.1226 },
  { zip: '32044', name: "Hampton",                    county: "Bradford",           state: '12', countyFips: '007', lat: 29.8575, lon: -82.1483 },
  { zip: '32058', name: "Lawtey",                     county: "Bradford",           state: '12', countyFips: '007', lat: 30.0472, lon: -82.1055 },
  { zip: '32091', name: "Starke",                     county: "Bradford",           state: '12', countyFips: '007', lat: 29.9583, lon: -82.1185 },
  { zip: '32622', name: "Brooker",                    county: "Bradford",           state: '12', countyFips: '007', lat: 29.919, lon: -82.2956 },
  { zip: '32754', name: "Mims",                       county: "Brevard",            state: '12', countyFips: '009', lat: 28.6974, lon: -80.8663 },
  { zip: '32775', name: "Scottsmoor",                 county: "Brevard",            state: '12', countyFips: '009', lat: 28.7702, lon: -80.872 },
  { zip: '32780', name: "Titusville",                 county: "Brevard",            state: '12', countyFips: '009', lat: 28.5697, lon: -80.8191 },
  { zip: '32781', name: "Titusville",                 county: "Brevard",            state: '12', countyFips: '009', lat: 28.6122, lon: -80.8076 },
  { zip: '32783', name: "Titusville",                 county: "Brevard",            state: '12', countyFips: '009', lat: 28.6122, lon: -80.8076 },
  { zip: '32796', name: "Titusville",                 county: "Brevard",            state: '12', countyFips: '009', lat: 28.6271, lon: -80.8429 },
  { zip: '32815', name: "Orlando",                    county: "Brevard",            state: '12', countyFips: '009', lat: 28.3067, lon: -80.6862 },
  { zip: '32899', name: "Orlando",                    county: "Brevard",            state: '12', countyFips: '009', lat: 28.3067, lon: -80.6862 },
  { zip: '32901', name: "Melbourne",                  county: "Brevard",            state: '12', countyFips: '009', lat: 28.0691, lon: -80.62 },
  { zip: '32902', name: "Melbourne",                  county: "Brevard",            state: '12', countyFips: '009', lat: 28.0836, lon: -80.6081 },
  { zip: '32903', name: "Indialantic",                county: "Brevard",            state: '12', countyFips: '009', lat: 28.1091, lon: -80.5787 },
  { zip: '32904', name: "Melbourne",                  county: "Brevard",            state: '12', countyFips: '009', lat: 28.0673, lon: -80.678 },
  { zip: '32905', name: "Palm Bay",                   county: "Brevard",            state: '12', countyFips: '009', lat: 28.0313, lon: -80.5995 },
  { zip: '32906', name: "Palm Bay",                   county: "Brevard",            state: '12', countyFips: '009', lat: 28.0671, lon: -80.6503 },
  { zip: '32907', name: "Palm Bay",                   county: "Brevard",            state: '12', countyFips: '009', lat: 28.0168, lon: -80.6739 },
  { zip: '32908', name: "Palm Bay",                   county: "Brevard",            state: '12', countyFips: '009', lat: 27.9816, lon: -80.6894 },
  { zip: '32909', name: "Palm Bay",                   county: "Brevard",            state: '12', countyFips: '009', lat: 27.9694, lon: -80.6473 },
  { zip: '32910', name: "Palm Bay",                   county: "Brevard",            state: '12', countyFips: '009', lat: 28.0345, lon: -80.5887 },
  { zip: '32911', name: "Palm Bay",                   county: "Brevard",            state: '12', countyFips: '009', lat: 28.0345, lon: -80.5887 },
  { zip: '32912', name: "Melbourne",                  county: "Brevard",            state: '12', countyFips: '009', lat: 28.0836, lon: -80.6081 },
  { zip: '32919', name: "Melbourne",                  county: "Brevard",            state: '12', countyFips: '009', lat: 28.0836, lon: -80.6081 },
  { zip: '32920', name: "Cape Canaveral",             county: "Brevard",            state: '12', countyFips: '009', lat: 28.3903, lon: -80.6043 },
  { zip: '32922', name: "Cocoa",                      county: "Brevard",            state: '12', countyFips: '009', lat: 28.3672, lon: -80.7465 },
  { zip: '32923', name: "Cocoa",                      county: "Brevard",            state: '12', countyFips: '009', lat: 28.4275, lon: -80.829 },
  { zip: '32924', name: "Cocoa",                      county: "Brevard",            state: '12', countyFips: '009', lat: 28.3067, lon: -80.6862 },
  { zip: '32925', name: "Patrick Afb",                county: "Brevard",            state: '12', countyFips: '009', lat: 28.1743, lon: -80.584 },
  { zip: '32926', name: "Cocoa",                      county: "Brevard",            state: '12', countyFips: '009', lat: 28.391, lon: -80.787 },
  { zip: '32927', name: "Cocoa",                      county: "Brevard",            state: '12', countyFips: '009', lat: 28.4566, lon: -80.7978 },
  { zip: '32931', name: "Cocoa Beach",                county: "Brevard",            state: '12', countyFips: '009', lat: 28.3325, lon: -80.6121 },
  { zip: '32932', name: "Cocoa Beach",                county: "Brevard",            state: '12', countyFips: '009', lat: 28.3206, lon: -80.6092 },
  { zip: '32934', name: "Melbourne",                  county: "Brevard",            state: '12', countyFips: '009', lat: 28.1331, lon: -80.7112 },
  { zip: '32935', name: "Melbourne",                  county: "Brevard",            state: '12', countyFips: '009', lat: 28.1384, lon: -80.6524 },
  { zip: '32936', name: "Melbourne",                  county: "Brevard",            state: '12', countyFips: '009', lat: 28.0836, lon: -80.6081 },
  { zip: '32937', name: "Satellite Beach",            county: "Brevard",            state: '12', countyFips: '009', lat: 28.178, lon: -80.602 },
  { zip: '32940', name: "Melbourne",                  county: "Brevard",            state: '12', countyFips: '009', lat: 28.2061, lon: -80.685 },
  { zip: '32941', name: "Melbourne",                  county: "Brevard",            state: '12', countyFips: '009', lat: 27.9246, lon: -80.5235 },
  { zip: '32949', name: "Grant",                      county: "Brevard",            state: '12', countyFips: '009', lat: 27.9289, lon: -80.5264 },
  { zip: '32950', name: "Malabar",                    county: "Brevard",            state: '12', countyFips: '009', lat: 27.9761, lon: -80.5788 },
  { zip: '32951', name: "Melbourne Beach",            county: "Brevard",            state: '12', countyFips: '009', lat: 28.0219, lon: -80.5389 },
  { zip: '32952', name: "Merritt Island",             county: "Brevard",            state: '12', countyFips: '009', lat: 28.2764, lon: -80.6568 },
  { zip: '32953', name: "Merritt Island",             county: "Brevard",            state: '12', countyFips: '009', lat: 28.3888, lon: -80.7301 },
  { zip: '32954', name: "Merritt Island",             county: "Brevard",            state: '12', countyFips: '009', lat: 28.5392, lon: -80.672 },
  { zip: '32955', name: "Rockledge",                  county: "Brevard",            state: '12', countyFips: '009', lat: 28.3134, lon: -80.7319 },
  { zip: '32956', name: "Rockledge",                  county: "Brevard",            state: '12', countyFips: '009', lat: 28.3298, lon: -80.7323 },
  { zip: '32959', name: "Sharpes",                    county: "Brevard",            state: '12', countyFips: '009', lat: 28.3067, lon: -80.6862 },
  { zip: '32976', name: "Sebastian",                  county: "Brevard",            state: '12', countyFips: '009', lat: 27.8679, lon: -80.5416 },
  { zip: '33004', name: "Dania",                      county: "Broward",            state: '12', countyFips: '011', lat: 26.0476, lon: -80.1447 },
  { zip: '33008', name: "Hallandale",                 county: "Broward",            state: '12', countyFips: '011', lat: 25.9812, lon: -80.1484 },
  { zip: '33009', name: "Hallandale",                 county: "Broward",            state: '12', countyFips: '011', lat: 25.985, lon: -80.1407 },
  { zip: '33019', name: "Hollywood",                  county: "Broward",            state: '12', countyFips: '011', lat: 26.007, lon: -80.1219 },
  { zip: '33020', name: "Hollywood",                  county: "Broward",            state: '12', countyFips: '011', lat: 26.0161, lon: -80.1517 },
  { zip: '33021', name: "Hollywood",                  county: "Broward",            state: '12', countyFips: '011', lat: 26.0218, lon: -80.1891 },
  { zip: '33022', name: "Hollywood",                  county: "Broward",            state: '12', countyFips: '011', lat: 26.0134, lon: -80.1442 },
  { zip: '33023', name: "Hollywood",                  county: "Broward",            state: '12', countyFips: '011', lat: 25.9894, lon: -80.2153 },
  { zip: '33024', name: "Hollywood",                  county: "Broward",            state: '12', countyFips: '011', lat: 26.0296, lon: -80.2489 },
  { zip: '33025', name: "Hollywood",                  county: "Broward",            state: '12', countyFips: '011', lat: 25.9921, lon: -80.2712 },
  { zip: '33026', name: "Hollywood",                  county: "Broward",            state: '12', countyFips: '011', lat: 26.0229, lon: -80.2974 },
  { zip: '33027', name: "Hollywood",                  county: "Broward",            state: '12', countyFips: '011', lat: 25.9974, lon: -80.3248 },
  { zip: '33028', name: "Pembroke Pines",             county: "Broward",            state: '12', countyFips: '011', lat: 26.0185, lon: -80.3449 },
  { zip: '33029', name: "Hollywood",                  county: "Broward",            state: '12', countyFips: '011', lat: 25.9924, lon: -80.4089 },
  { zip: '33060', name: "Pompano Beach",              county: "Broward",            state: '12', countyFips: '011', lat: 26.2315, lon: -80.1235 },
  { zip: '33061', name: "Pompano Beach",              county: "Broward",            state: '12', countyFips: '011', lat: 26.2539, lon: -80.1342 },
  { zip: '33062', name: "Pompano Beach",              county: "Broward",            state: '12', countyFips: '011', lat: 26.2343, lon: -80.0941 },
  { zip: '33063', name: "Pompano Beach",              county: "Broward",            state: '12', countyFips: '011', lat: 26.2674, lon: -80.2092 },
  { zip: '33064', name: "Pompano Beach",              county: "Broward",            state: '12', countyFips: '011', lat: 26.2785, lon: -80.1157 },
  { zip: '33065', name: "Pompano Beach",              county: "Broward",            state: '12', countyFips: '011', lat: 26.2729, lon: -80.2603 },
  { zip: '33066', name: "Pompano Beach",              county: "Broward",            state: '12', countyFips: '011', lat: 26.2535, lon: -80.1775 },
  { zip: '33067', name: "Pompano Beach",              county: "Broward",            state: '12', countyFips: '011', lat: 26.3033, lon: -80.2415 },
  { zip: '33068', name: "Pompano Beach",              county: "Broward",            state: '12', countyFips: '011', lat: 26.216, lon: -80.2205 },
  { zip: '33069', name: "Pompano Beach",              county: "Broward",            state: '12', countyFips: '011', lat: 26.2288, lon: -80.1635 },
  { zip: '33071', name: "Pompano Beach",              county: "Broward",            state: '12', countyFips: '011', lat: 26.2435, lon: -80.2601 },
  { zip: '33072', name: "Pompano Beach",              county: "Broward",            state: '12', countyFips: '011', lat: 26.2335, lon: -80.0924 },
  { zip: '33073', name: "Pompano Beach",              county: "Broward",            state: '12', countyFips: '011', lat: 26.2997, lon: -80.181 },
  { zip: '33074', name: "Pompano Beach",              county: "Broward",            state: '12', countyFips: '011', lat: 26.2379, lon: -80.1248 },
  { zip: '33075', name: "Coral Springs",              county: "Broward",            state: '12', countyFips: '011', lat: 26.2712, lon: -80.2706 },
  { zip: '33076', name: "Pompano Beach",              county: "Broward",            state: '12', countyFips: '011', lat: 26.3168, lon: -80.2753 },
  { zip: '33077', name: "Pompano Beach",              county: "Broward",            state: '12', countyFips: '011', lat: 26.2379, lon: -80.1248 },
  { zip: '33081', name: "Hollywood",                  county: "Broward",            state: '12', countyFips: '011', lat: 26.0112, lon: -80.1495 },
  { zip: '33082', name: "Pembroke Pines",             county: "Broward",            state: '12', countyFips: '011', lat: 26.0031, lon: -80.2239 },
  { zip: '33083', name: "Hollywood",                  county: "Broward",            state: '12', countyFips: '011', lat: 26.0112, lon: -80.1495 },
  { zip: '33084', name: "Hollywood",                  county: "Broward",            state: '12', countyFips: '011', lat: 26.0112, lon: -80.1495 },
  { zip: '33093', name: "Margate",                    county: "Broward",            state: '12', countyFips: '011', lat: 26.2445, lon: -80.2064 },
  { zip: '33097', name: "Coconut Creek",              county: "Broward",            state: '12', countyFips: '011', lat: 26.2517, lon: -80.1789 },
  { zip: '33301', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1216, lon: -80.1288 },
  { zip: '33302', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1223, lon: -80.1434 },
  { zip: '33303', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1969, lon: -80.0952 },
  { zip: '33304', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1387, lon: -80.1218 },
  { zip: '33305', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1497, lon: -80.1229 },
  { zip: '33306', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1656, lon: -80.1118 },
  { zip: '33307', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1223, lon: -80.1434 },
  { zip: '33308', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.0984, lon: -80.1822 },
  { zip: '33309', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1817, lon: -80.1746 },
  { zip: '33310', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1443, lon: -80.2069 },
  { zip: '33311', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1421, lon: -80.1728 },
  { zip: '33312', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.0968, lon: -80.181 },
  { zip: '33313', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1487, lon: -80.2075 },
  { zip: '33314', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.0697, lon: -80.2246 },
  { zip: '33315', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.0989, lon: -80.1541 },
  { zip: '33316', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1042, lon: -80.126 },
  { zip: '33317', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1122, lon: -80.2264 },
  { zip: '33318', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1184, lon: -80.252 },
  { zip: '33319', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1848, lon: -80.2406 },
  { zip: '33320', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1625, lon: -80.2582 },
  { zip: '33321', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.212, lon: -80.2696 },
  { zip: '33322', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1502, lon: -80.2745 },
  { zip: '33323', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.152, lon: -80.3165 },
  { zip: '33324', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1255, lon: -80.2644 },
  { zip: '33325', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1097, lon: -80.3215 },
  { zip: '33326', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1158, lon: -80.3681 },
  { zip: '33327', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1168, lon: -80.4156 },
  { zip: '33328', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.0671, lon: -80.2723 },
  { zip: '33329', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1223, lon: -80.1434 },
  { zip: '33330', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.0663, lon: -80.3339 },
  { zip: '33331', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.048, lon: -80.3749 },
  { zip: '33332', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.0596, lon: -80.4146 },
  { zip: '33334', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1845, lon: -80.1344 },
  { zip: '33335', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.0892, lon: -80.336 },
  { zip: '33336', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1219, lon: -80.1436 },
  { zip: '33337', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.129, lon: -80.2601 },
  { zip: '33338', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1223, lon: -80.1434 },
  { zip: '33339', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1223, lon: -80.1434 },
  { zip: '33340', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1223, lon: -80.1434 },
  { zip: '33345', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1654, lon: -80.2959 },
  { zip: '33346', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1223, lon: -80.1434 },
  { zip: '33348', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1223, lon: -80.1434 },
  { zip: '33349', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1223, lon: -80.1434 },
  { zip: '33351', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1793, lon: -80.2746 },
  { zip: '33355', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1223, lon: -80.1434 },
  { zip: '33359', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1223, lon: -80.1434 },
  { zip: '33388', name: "Plantation",                 county: "Broward",            state: '12', countyFips: '011', lat: 26.1342, lon: -80.2318 },
  { zip: '33394', name: "Fort Lauderdale",            county: "Broward",            state: '12', countyFips: '011', lat: 26.1221, lon: -80.139 },
  { zip: '33441', name: "Deerfield Beach",            county: "Broward",            state: '12', countyFips: '011', lat: 26.3096, lon: -80.0992 },
  { zip: '33442', name: "Deerfield Beach",            county: "Broward",            state: '12', countyFips: '011', lat: 26.3124, lon: -80.1412 },
  { zip: '33443', name: "Deerfield Beach",            county: "Broward",            state: '12', countyFips: '011', lat: 26.3184, lon: -80.0998 },
  { zip: '32421', name: "Altha",                      county: "Calhoun",            state: '12', countyFips: '013', lat: 30.5319, lon: -85.1704 },
  { zip: '32424', name: "Blountstown",                county: "Calhoun",            state: '12', countyFips: '013', lat: 30.4394, lon: -85.062 },
  { zip: '32430', name: "Clarksville",                county: "Calhoun",            state: '12', countyFips: '013', lat: 30.3568, lon: -85.1898 },
  { zip: '32449', name: "Wewahitchka",                county: "Calhoun",            state: '12', countyFips: '013', lat: 30.4059, lon: -85.1974 },
  { zip: '33927', name: "El Jobean",                  county: "Charlotte",          state: '12', countyFips: '015', lat: 26.9324, lon: -82.2168 },
  { zip: '33938', name: "Murdock",                    county: "Charlotte",          state: '12', countyFips: '015', lat: 26.902, lon: -82.0 },
  { zip: '33946', name: "Placida",                    county: "Charlotte",          state: '12', countyFips: '015', lat: 26.8323, lon: -82.2648 },
  { zip: '33947', name: "Rotonda West",               county: "Charlotte",          state: '12', countyFips: '015', lat: 26.8842, lon: -82.2691 },
  { zip: '33948', name: "Port Charlotte",             county: "Charlotte",          state: '12', countyFips: '015', lat: 26.9827, lon: -82.1412 },
  { zip: '33949', name: "Port Charlotte",             county: "Charlotte",          state: '12', countyFips: '015', lat: 26.9939, lon: -82.0984 },
  { zip: '33950', name: "Punta Gorda",                county: "Charlotte",          state: '12', countyFips: '015', lat: 26.9152, lon: -82.0532 },
  { zip: '33951', name: "Punta Gorda",                county: "Charlotte",          state: '12', countyFips: '015', lat: 26.9708, lon: -81.9845 },
  { zip: '33952', name: "Port Charlotte",             county: "Charlotte",          state: '12', countyFips: '015', lat: 26.9905, lon: -82.0964 },
  { zip: '33953', name: "Port Charlotte",             county: "Charlotte",          state: '12', countyFips: '015', lat: 27.004, lon: -82.2117 },
  { zip: '33954', name: "Port Charlotte",             county: "Charlotte",          state: '12', countyFips: '015', lat: 27.0228, lon: -82.1108 },
  { zip: '33955', name: "Punta Gorda",                county: "Charlotte",          state: '12', countyFips: '015', lat: 26.824, lon: -81.9547 },
  { zip: '33980', name: "Punta Gorda",                county: "Charlotte",          state: '12', countyFips: '015', lat: 26.9298, lon: -82.0454 },
  { zip: '33981', name: "Port Charlotte",             county: "Charlotte",          state: '12', countyFips: '015', lat: 26.9379, lon: -82.2388 },
  { zip: '33982', name: "Punta Gorda",                county: "Charlotte",          state: '12', countyFips: '015', lat: 26.9668, lon: -81.9545 },
  { zip: '33983', name: "Punta Gorda",                county: "Charlotte",          state: '12', countyFips: '015', lat: 27.0074, lon: -82.0163 },
  { zip: '34224', name: "Englewood",                  county: "Charlotte",          state: '12', countyFips: '015', lat: 26.92, lon: -82.3048 },
  { zip: '34423', name: "Crystal River",              county: "Citrus",             state: '12', countyFips: '017', lat: 28.867, lon: -82.5727 },
  { zip: '34428', name: "Crystal River",              county: "Citrus",             state: '12', countyFips: '017', lat: 28.9584, lon: -82.5993 },
  { zip: '34429', name: "Crystal River",              county: "Citrus",             state: '12', countyFips: '017', lat: 28.8547, lon: -82.6669 },
  { zip: '34433', name: "Dunnellon",                  county: "Citrus",             state: '12', countyFips: '017', lat: 28.9949, lon: -82.5196 },
  { zip: '34434', name: "Dunnellon",                  county: "Citrus",             state: '12', countyFips: '017', lat: 28.9938, lon: -82.4241 },
  { zip: '34436', name: "Floral City",                county: "Citrus",             state: '12', countyFips: '017', lat: 28.7304, lon: -82.3077 },
  { zip: '34441', name: "Hernando",                   county: "Citrus",             state: '12', countyFips: '017', lat: 28.9311, lon: -82.372 },
  { zip: '34442', name: "Hernando",                   county: "Citrus",             state: '12', countyFips: '017', lat: 28.9223, lon: -82.39 },
  { zip: '34445', name: "Holder",                     county: "Citrus",             state: '12', countyFips: '017', lat: 28.9669, lon: -82.4207 },
  { zip: '34446', name: "Homosassa",                  county: "Citrus",             state: '12', countyFips: '017', lat: 28.7508, lon: -82.5139 },
  { zip: '34447', name: "Homosassa Springs",          county: "Citrus",             state: '12', countyFips: '017', lat: 28.8049, lon: -82.5743 },
  { zip: '34448', name: "Homosassa",                  county: "Citrus",             state: '12', countyFips: '017', lat: 28.788, lon: -82.568 },
  { zip: '34450', name: "Inverness",                  county: "Citrus",             state: '12', countyFips: '017', lat: 28.834, lon: -82.2822 },
  { zip: '34451', name: "Inverness",                  county: "Citrus",             state: '12', countyFips: '017', lat: 28.8358, lon: -82.3304 },
  { zip: '34452', name: "Inverness",                  county: "Citrus",             state: '12', countyFips: '017', lat: 28.8358, lon: -82.3304 },
  { zip: '34453', name: "Inverness",                  county: "Citrus",             state: '12', countyFips: '017', lat: 28.8723, lon: -82.3454 },
  { zip: '34460', name: "Lecanto",                    county: "Citrus",             state: '12', countyFips: '017', lat: 28.8593, lon: -82.5087 },
  { zip: '34461', name: "Lecanto",                    county: "Citrus",             state: '12', countyFips: '017', lat: 28.8516, lon: -82.4876 },
  { zip: '34464', name: "Beverly Hills",              county: "Citrus",             state: '12', countyFips: '017', lat: 28.9169, lon: -82.4582 },
  { zip: '34465', name: "Beverly Hills",              county: "Citrus",             state: '12', countyFips: '017', lat: 28.9295, lon: -82.4892 },
  { zip: '34487', name: "Homosassa",                  county: "Citrus",             state: '12', countyFips: '017', lat: 28.7814, lon: -82.6151 },
  { zip: '32003', name: "Fleming Island",             county: "Clay",               state: '12', countyFips: '019', lat: 30.0933, lon: -81.719 },
  { zip: '32006', name: "Fleming Island",             county: "Clay",               state: '12', countyFips: '019', lat: 30.107, lon: -81.7167 },
  { zip: '32030', name: "Doctors Inlet",              county: "Clay",               state: '12', countyFips: '019', lat: 30.1056, lon: -81.769 },
  { zip: '32043', name: "Green Cove Springs",         county: "Clay",               state: '12', countyFips: '019', lat: 29.9983, lon: -81.7647 },
  { zip: '32050', name: "Middleburg",                 county: "Clay",               state: '12', countyFips: '019', lat: 30.0689, lon: -81.8604 },
  { zip: '32065', name: "Orange Park",                county: "Clay",               state: '12', countyFips: '019', lat: 30.1382, lon: -81.7742 },
  { zip: '32067', name: "Orange Park",                county: "Clay",               state: '12', countyFips: '019', lat: 30.1661, lon: -81.7065 },
  { zip: '32068', name: "Middleburg",                 county: "Clay",               state: '12', countyFips: '019', lat: 30.084, lon: -81.8645 },
  { zip: '32073', name: "Orange Park",                county: "Clay",               state: '12', countyFips: '019', lat: 30.1637, lon: -81.7291 },
  { zip: '32079', name: "Penney Farms",               county: "Clay",               state: '12', countyFips: '019', lat: 29.9849, lon: -81.8022 },
  { zip: '32160', name: "Lake Geneva",                county: "Clay",               state: '12', countyFips: '019', lat: 29.7683, lon: -81.9907 },
  { zip: '32656', name: "Keystone Heights",           county: "Clay",               state: '12', countyFips: '019', lat: 29.7976, lon: -81.9899 },
  { zip: '34101', name: "Naples",                     county: "Collier",            state: '12', countyFips: '021', lat: 26.1423, lon: -81.796 },
  { zip: '34102', name: "Naples",                     county: "Collier",            state: '12', countyFips: '021', lat: 26.134, lon: -81.7953 },
  { zip: '34103', name: "Naples",                     county: "Collier",            state: '12', countyFips: '021', lat: 26.1917, lon: -81.8039 },
  { zip: '34104', name: "Naples",                     county: "Collier",            state: '12', countyFips: '021', lat: 26.1529, lon: -81.7417 },
  { zip: '34105', name: "Naples",                     county: "Collier",            state: '12', countyFips: '021', lat: 26.1938, lon: -81.7636 },
  { zip: '34106', name: "Naples",                     county: "Collier",            state: '12', countyFips: '021', lat: 26.1423, lon: -81.796 },
  { zip: '34107', name: "Naples",                     county: "Collier",            state: '12', countyFips: '021', lat: 26.1423, lon: -81.796 },
  { zip: '34108', name: "Naples",                     county: "Collier",            state: '12', countyFips: '021', lat: 26.2416, lon: -81.8071 },
  { zip: '34109', name: "Naples",                     county: "Collier",            state: '12', countyFips: '021', lat: 26.2534, lon: -81.7644 },
  { zip: '34110', name: "Naples",                     county: "Collier",            state: '12', countyFips: '021', lat: 26.2823, lon: -81.7573 },
  { zip: '34112', name: "Naples",                     county: "Collier",            state: '12', countyFips: '021', lat: 26.1184, lon: -81.7361 },
  { zip: '34113', name: "Naples",                     county: "Collier",            state: '12', countyFips: '021', lat: 26.0426, lon: -81.7182 },
  { zip: '34114', name: "Naples",                     county: "Collier",            state: '12', countyFips: '021', lat: 26.0143, lon: -81.5856 },
  { zip: '34116', name: "Naples",                     county: "Collier",            state: '12', countyFips: '021', lat: 26.1873, lon: -81.711 },
  { zip: '34117', name: "Naples",                     county: "Collier",            state: '12', countyFips: '021', lat: 26.1156, lon: -81.5239 },
  { zip: '34119', name: "Naples",                     county: "Collier",            state: '12', countyFips: '021', lat: 26.2665, lon: -81.7146 },
  { zip: '34120', name: "Naples",                     county: "Collier",            state: '12', countyFips: '021', lat: 26.3304, lon: -81.5871 },
  { zip: '34137', name: "Copeland",                   county: "Collier",            state: '12', countyFips: '021', lat: 25.9542, lon: -81.3575 },
  { zip: '34138', name: "Chokoloskee",                county: "Collier",            state: '12', countyFips: '021', lat: 25.8129, lon: -81.362 },
  { zip: '34139', name: "Everglades City",            county: "Collier",            state: '12', countyFips: '021', lat: 25.857, lon: -81.3778 },
  { zip: '34140', name: "Goodland",                   county: "Collier",            state: '12', countyFips: '021', lat: 25.9248, lon: -81.6456 },
  { zip: '34141', name: "Ochopee",                    county: "Collier",            state: '12', countyFips: '021', lat: 25.8734, lon: -81.1599 },
  { zip: '34142', name: "Immokalee",                  county: "Collier",            state: '12', countyFips: '021', lat: 26.1844, lon: -81.4152 },
  { zip: '34143', name: "Immokalee",                  county: "Collier",            state: '12', countyFips: '021', lat: 26.4642, lon: -81.5047 },
  { zip: '34145', name: "Marco Island",               county: "Collier",            state: '12', countyFips: '021', lat: 25.9388, lon: -81.6968 },
  { zip: '34146', name: "Marco Island",               county: "Collier",            state: '12', countyFips: '021', lat: 25.9412, lon: -81.7184 },
  { zip: '32024', name: "Lake City",                  county: "Columbia",           state: '12', countyFips: '023', lat: 30.1055, lon: -82.6878 },
  { zip: '32025', name: "Lake City",                  county: "Columbia",           state: '12', countyFips: '023', lat: 30.1601, lon: -82.6396 },
  { zip: '32038', name: "Fort White",                 county: "Columbia",           state: '12', countyFips: '023', lat: 29.9207, lon: -82.6879 },
  { zip: '32055', name: "Lake City",                  county: "Columbia",           state: '12', countyFips: '023', lat: 30.2702, lon: -82.6254 },
  { zip: '32056', name: "Lake City",                  county: "Columbia",           state: '12', countyFips: '023', lat: 30.1897, lon: -82.6393 },
  { zip: '32061', name: "Lulu",                       county: "Columbia",           state: '12', countyFips: '023', lat: 30.0754, lon: -82.5385 },
  { zip: '32096', name: "White Springs",              county: "Columbia",           state: '12', countyFips: '023', lat: 30.3387, lon: -82.7765 },
  { zip: '34265', name: "Arcadia",                    county: "DeSoto",             state: '12', countyFips: '027', lat: 27.1861, lon: -81.8099 },
  { zip: '34266', name: "Arcadia",                    county: "DeSoto",             state: '12', countyFips: '027', lat: 27.1861, lon: -81.8667 },
  { zip: '34267', name: "Fort Ogden",                 county: "DeSoto",             state: '12', countyFips: '027', lat: 27.1861, lon: -81.8099 },
  { zip: '34268', name: "Nocatee",                    county: "DeSoto",             state: '12', countyFips: '027', lat: 27.1603, lon: -81.8823 },
  { zip: '34269', name: "Arcadia",                    county: "DeSoto",             state: '12', countyFips: '027', lat: 27.0675, lon: -81.9855 },
  { zip: '32359', name: "Steinhatchee",               county: "Dixie",              state: '12', countyFips: '029', lat: 29.6739, lon: -83.3723 },
  { zip: '32628', name: "Cross City",                 county: "Dixie",              state: '12', countyFips: '029', lat: 29.6372, lon: -83.2032 },
  { zip: '32648', name: "Horseshoe Beach",            county: "Dixie",              state: '12', countyFips: '029', lat: 29.4869, lon: -83.2616 },
  { zip: '32680', name: "Old Town",                   county: "Dixie",              state: '12', countyFips: '029', lat: 29.6699, lon: -83.005 },
  { zip: '32692', name: "Suwannee",                   county: "Dixie",              state: '12', countyFips: '029', lat: 29.3295, lon: -83.14 },
  { zip: '32099', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.3375, lon: -81.7686 },
  { zip: '32201', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.3894, lon: -81.6808 },
  { zip: '32202', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.3299, lon: -81.6517 },
  { zip: '32203', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.3228, lon: -81.547 },
  { zip: '32204', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.3189, lon: -81.6854 },
  { zip: '32205', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.3172, lon: -81.722 },
  { zip: '32206', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.3511, lon: -81.6488 },
  { zip: '32207', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.2908, lon: -81.6321 },
  { zip: '32208', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.3937, lon: -81.6889 },
  { zip: '32209', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.3584, lon: -81.692 },
  { zip: '32210', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.2687, lon: -81.7473 },
  { zip: '32211', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.348, lon: -81.5882 },
  { zip: '32212', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.2132, lon: -81.69 },
  { zip: '32214', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.3449, lon: -81.6831 },
  { zip: '32216', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.2787, lon: -81.5831 },
  { zip: '32217', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.2407, lon: -81.617 },
  { zip: '32218', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.4507, lon: -81.6626 },
  { zip: '32219', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.4034, lon: -81.7635 },
  { zip: '32220', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.329, lon: -81.8176 },
  { zip: '32221', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.2837, lon: -81.8202 },
  { zip: '32222', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.2292, lon: -81.8131 },
  { zip: '32223', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.1548, lon: -81.63 },
  { zip: '32224', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.3031, lon: -81.4404 },
  { zip: '32225', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.351, lon: -81.5061 },
  { zip: '32226', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.4735, lon: -81.5448 },
  { zip: '32227', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.3802, lon: -81.416 },
  { zip: '32228', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.3824, lon: -81.4369 },
  { zip: '32229', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.3449, lon: -81.6831 },
  { zip: '32231', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.3449, lon: -81.6831 },
  { zip: '32232', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.3449, lon: -81.6831 },
  { zip: '32233', name: "Atlantic Beach",             county: "Duval",              state: '12', countyFips: '031', lat: 30.3483, lon: -81.4159 },
  { zip: '32234', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.2757, lon: -81.9686 },
  { zip: '32235', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.3449, lon: -81.6831 },
  { zip: '32236', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.3449, lon: -81.6831 },
  { zip: '32237', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.3449, lon: -81.6831 },
  { zip: '32238', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.3449, lon: -81.6831 },
  { zip: '32239', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.3449, lon: -81.6831 },
  { zip: '32240', name: "Jacksonville Beach",         county: "Duval",              state: '12', countyFips: '031', lat: 30.2947, lon: -81.3931 },
  { zip: '32241', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.3449, lon: -81.6831 },
  { zip: '32244', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.2231, lon: -81.7556 },
  { zip: '32245', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.3449, lon: -81.6831 },
  { zip: '32246', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.2933, lon: -81.5092 },
  { zip: '32247', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.3449, lon: -81.6831 },
  { zip: '32250', name: "Jacksonville Beach",         county: "Duval",              state: '12', countyFips: '031', lat: 30.2801, lon: -81.4165 },
  { zip: '32254', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.3415, lon: -81.7358 },
  { zip: '32255', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.3322, lon: -81.6557 },
  { zip: '32256', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.2214, lon: -81.5571 },
  { zip: '32257', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.1927, lon: -81.605 },
  { zip: '32258', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.1459, lon: -81.5739 },
  { zip: '32266', name: "Neptune Beach",              county: "Duval",              state: '12', countyFips: '031', lat: 30.3155, lon: -81.4051 },
  { zip: '32277', name: "Jacksonville",               county: "Duval",              state: '12', countyFips: '031', lat: 30.3704, lon: -81.5864 },
  { zip: '32501', name: "Pensacola",                  county: "Escambia",           state: '12', countyFips: '033', lat: 30.4223, lon: -87.2248 },
  { zip: '32502', name: "Pensacola",                  county: "Escambia",           state: '12', countyFips: '033', lat: 30.4095, lon: -87.2229 },
  { zip: '32503', name: "Pensacola",                  county: "Escambia",           state: '12', countyFips: '033', lat: 30.4564, lon: -87.2104 },
  { zip: '32504', name: "Pensacola",                  county: "Escambia",           state: '12', countyFips: '033', lat: 30.4873, lon: -87.1872 },
  { zip: '32505', name: "Pensacola",                  county: "Escambia",           state: '12', countyFips: '033', lat: 30.4481, lon: -87.2589 },
  { zip: '32506', name: "Pensacola",                  county: "Escambia",           state: '12', countyFips: '033', lat: 30.4129, lon: -87.3092 },
  { zip: '32507', name: "Pensacola",                  county: "Escambia",           state: '12', countyFips: '033', lat: 30.3737, lon: -87.3126 },
  { zip: '32508', name: "Pensacola",                  county: "Escambia",           state: '12', countyFips: '033', lat: 30.3511, lon: -87.2749 },
  { zip: '32509', name: "Pensacola",                  county: "Escambia",           state: '12', countyFips: '033', lat: 30.4643, lon: -87.3403 },
  { zip: '32511', name: "Pensacola",                  county: "Escambia",           state: '12', countyFips: '033', lat: 30.4061, lon: -87.2917 },
  { zip: '32512', name: "Pensacola",                  county: "Escambia",           state: '12', countyFips: '033', lat: 30.3943, lon: -87.2991 },
  { zip: '32513', name: "Pensacola",                  county: "Escambia",           state: '12', countyFips: '033', lat: 30.5571, lon: -87.2596 },
  { zip: '32514', name: "Pensacola",                  county: "Escambia",           state: '12', countyFips: '033', lat: 30.5241, lon: -87.2167 },
  { zip: '32516', name: "Pensacola",                  county: "Escambia",           state: '12', countyFips: '033', lat: 30.4213, lon: -87.2169 },
  { zip: '32520', name: "Pensacola",                  county: "Escambia",           state: '12', countyFips: '033', lat: 30.4124, lon: -87.2035 },
  { zip: '32521', name: "Pensacola",                  county: "Escambia",           state: '12', countyFips: '033', lat: 30.4213, lon: -87.2169 },
  { zip: '32522', name: "Pensacola",                  county: "Escambia",           state: '12', countyFips: '033', lat: 30.4213, lon: -87.2169 },
  { zip: '32523', name: "Pensacola",                  county: "Escambia",           state: '12', countyFips: '033', lat: 30.4213, lon: -87.2169 },
  { zip: '32524', name: "Pensacola",                  county: "Escambia",           state: '12', countyFips: '033', lat: 30.4213, lon: -87.2169 },
  { zip: '32526', name: "Pensacola",                  county: "Escambia",           state: '12', countyFips: '033', lat: 30.4756, lon: -87.3179 },
  { zip: '32533', name: "Cantonment",                 county: "Escambia",           state: '12', countyFips: '033', lat: 30.6143, lon: -87.3251 },
  { zip: '32534', name: "Pensacola",                  county: "Escambia",           state: '12', countyFips: '033', lat: 30.5301, lon: -87.2793 },
  { zip: '32535', name: "Century",                    county: "Escambia",           state: '12', countyFips: '033', lat: 30.9687, lon: -87.3216 },
  { zip: '32559', name: "Pensacola",                  county: "Escambia",           state: '12', countyFips: '033', lat: 30.3563, lon: -87.2773 },
  { zip: '32560', name: "Gonzalez",                   county: "Escambia",           state: '12', countyFips: '033', lat: 30.5818, lon: -87.2929 },
  { zip: '32561', name: "Gulf Breeze",                county: "Escambia",           state: '12', countyFips: '033', lat: 30.3571, lon: -87.1639 },
  { zip: '32568', name: "Mc David",                   county: "Escambia",           state: '12', countyFips: '033', lat: 30.8686, lon: -87.4539 },
  { zip: '32577', name: "Molino",                     county: "Escambia",           state: '12', countyFips: '033', lat: 30.6902, lon: -87.3852 },
  { zip: '32591', name: "Pensacola",                  county: "Escambia",           state: '12', countyFips: '033', lat: 30.4213, lon: -87.2169 },
  { zip: '32110', name: "Bunnell",                    county: "Flagler",            state: '12', countyFips: '035', lat: 29.4562, lon: -81.3244 },
  { zip: '32135', name: "Palm Coast",                 county: "Flagler",            state: '12', countyFips: '035', lat: 29.4661, lon: -81.2828 },
  { zip: '32136', name: "Flagler Beach",              county: "Flagler",            state: '12', countyFips: '035', lat: 29.475, lon: -81.1303 },
  { zip: '32137', name: "Palm Coast",                 county: "Flagler",            state: '12', countyFips: '035', lat: 29.5565, lon: -81.219 },
  { zip: '32142', name: "Palm Coast",                 county: "Flagler",            state: '12', countyFips: '035', lat: 29.4661, lon: -81.2828 },
  { zip: '32143', name: "Palm Coast",                 county: "Flagler",            state: '12', countyFips: '035', lat: 29.585, lon: -81.2078 },
  { zip: '32164', name: "Palm Coast",                 county: "Flagler",            state: '12', countyFips: '035', lat: 29.4861, lon: -81.2045 },
  { zip: '32318', name: "Tallahassee",                county: "Franklin",           state: '12', countyFips: '037', lat: 30.4383, lon: -84.2807 },
  { zip: '32320', name: "Apalachicola",               county: "Franklin",           state: '12', countyFips: '037', lat: 29.7255, lon: -85.0063 },
  { zip: '32322', name: "Carrabelle",                 county: "Franklin",           state: '12', countyFips: '037', lat: 29.8692, lon: -84.6358 },
  { zip: '32323', name: "Lanark Village",             county: "Franklin",           state: '12', countyFips: '037', lat: 29.8826, lon: -84.5964 },
  { zip: '32328', name: "Eastpoint",                  county: "Franklin",           state: '12', countyFips: '037', lat: 29.7495, lon: -84.8162 },
  { zip: '32329', name: "Apalachicola",               county: "Franklin",           state: '12', countyFips: '037', lat: 29.726, lon: -84.9856 },
  { zip: '32324', name: "Chattahoochee",              county: "Gadsden",            state: '12', countyFips: '039', lat: 30.6834, lon: -84.828 },
  { zip: '32330', name: "Greensboro",                 county: "Gadsden",            state: '12', countyFips: '039', lat: 30.5696, lon: -84.7453 },
  { zip: '32332', name: "Gretna",                     county: "Gadsden",            state: '12', countyFips: '039', lat: 30.6171, lon: -84.6599 },
  { zip: '32333', name: "Havana",                     county: "Gadsden",            state: '12', countyFips: '039', lat: 30.6092, lon: -84.4143 },
  { zip: '32343', name: "Midway",                     county: "Gadsden",            state: '12', countyFips: '039', lat: 30.485, lon: -84.4768 },
  { zip: '32351', name: "Quincy",                     county: "Gadsden",            state: '12', countyFips: '039', lat: 30.5867, lon: -84.6094 },
  { zip: '32352', name: "Quincy",                     county: "Gadsden",            state: '12', countyFips: '039', lat: 30.6512, lon: -84.5866 },
  { zip: '32353', name: "Quincy",                     county: "Gadsden",            state: '12', countyFips: '039', lat: 30.5497, lon: -84.6069 },
  { zip: '32619', name: "Bell",                       county: "Gilchrist",          state: '12', countyFips: '041', lat: 29.7837, lon: -82.8711 },
  { zip: '32693', name: "Trenton",                    county: "Gilchrist",          state: '12', countyFips: '041', lat: 29.6133, lon: -82.8176 },
  { zip: '33471', name: "Moore Haven",                county: "Glades",             state: '12', countyFips: '043', lat: 26.8327, lon: -81.2188 },
  { zip: '33944', name: "Palmdale",                   county: "Glades",             state: '12', countyFips: '043', lat: 26.9464, lon: -81.3091 },
  { zip: '34974', name: "Okeechobee",                 county: "Glades",             state: '12', countyFips: '043', lat: 27.2002, lon: -80.841 },
  { zip: '32456', name: "Port Saint Joe",             county: "Gulf",               state: '12', countyFips: '045', lat: 29.8119, lon: -85.303 },
  { zip: '32457', name: "Port Saint Joe",             county: "Gulf",               state: '12', countyFips: '045', lat: 29.8119, lon: -85.303 },
  { zip: '32465', name: "Wewahitchka",                county: "Gulf",               state: '12', countyFips: '045', lat: 30.0933, lon: -85.2048 },
  { zip: '32052', name: "Jasper",                     county: "Hamilton",           state: '12', countyFips: '047', lat: 30.5029, lon: -82.9322 },
  { zip: '32053', name: "Jennings",                   county: "Hamilton",           state: '12', countyFips: '047', lat: 30.5482, lon: -83.135 },
  { zip: '33834', name: "Bowling Green",              county: "Hardee",             state: '12', countyFips: '049', lat: 27.6019, lon: -81.8507 },
  { zip: '33865', name: "Ona",                        county: "Hardee",             state: '12', countyFips: '049', lat: 27.4127, lon: -81.928 },
  { zip: '33873', name: "Wauchula",                   county: "Hardee",             state: '12', countyFips: '049', lat: 27.5517, lon: -81.8074 },
  { zip: '33890', name: "Zolfo Springs",              county: "Hardee",             state: '12', countyFips: '049', lat: 27.48, lon: -81.7423 },
  { zip: '33440', name: "Clewiston",                  county: "Hendry",             state: '12', countyFips: '051', lat: 26.7172, lon: -80.9492 },
  { zip: '33930', name: "Felda",                      county: "Hendry",             state: '12', countyFips: '051', lat: 26.5398, lon: -81.4356 },
  { zip: '33935', name: "Labelle",                    county: "Hendry",             state: '12', countyFips: '051', lat: 26.7321, lon: -81.434 },
  { zip: '33936', name: "Lehigh Acres",               county: "Hendry",             state: '12', countyFips: '051', lat: 26.5936, lon: -81.6619 },
  { zip: '33975', name: "Labelle",                    county: "Hendry",             state: '12', countyFips: '051', lat: 26.7633, lon: -81.4388 },
  { zip: '34601', name: "Brooksville",                county: "Hernando",           state: '12', countyFips: '053', lat: 28.5658, lon: -82.3737 },
  { zip: '34602', name: "Brooksville",                county: "Hernando",           state: '12', countyFips: '053', lat: 28.5093, lon: -82.2957 },
  { zip: '34603', name: "Brooksville",                county: "Hernando",           state: '12', countyFips: '053', lat: 28.5642, lon: -82.4165 },
  { zip: '34604', name: "Brooksville",                county: "Hernando",           state: '12', countyFips: '053', lat: 28.4409, lon: -82.4612 },
  { zip: '34605', name: "Brooksville",                county: "Hernando",           state: '12', countyFips: '053', lat: 28.5059, lon: -82.4226 },
  { zip: '34606', name: "Spring Hill",                county: "Hernando",           state: '12', countyFips: '053', lat: 28.4655, lon: -82.5981 },
  { zip: '34607', name: "Spring Hill",                county: "Hernando",           state: '12', countyFips: '053', lat: 28.5065, lon: -82.6267 },
  { zip: '34608', name: "Spring Hill",                county: "Hernando",           state: '12', countyFips: '053', lat: 28.4797, lon: -82.5562 },
  { zip: '34609', name: "Spring Hill",                county: "Hernando",           state: '12', countyFips: '053', lat: 28.4794, lon: -82.5083 },
  { zip: '34611', name: "Spring Hill",                county: "Hernando",           state: '12', countyFips: '053', lat: 28.5642, lon: -82.4165 },
  { zip: '34613', name: "Brooksville",                county: "Hernando",           state: '12', countyFips: '053', lat: 28.5466, lon: -82.5213 },
  { zip: '34614', name: "Brooksville",                county: "Hernando",           state: '12', countyFips: '053', lat: 28.6622, lon: -82.5236 },
  { zip: '34636', name: "Istachatta",                 county: "Hernando",           state: '12', countyFips: '053', lat: 28.655, lon: -82.2677 },
  { zip: '34661', name: "Nobleton",                   county: "Hernando",           state: '12', countyFips: '053', lat: 28.6436, lon: -82.2638 },
  { zip: '33825', name: "Avon Park",                  county: "Highlands",          state: '12', countyFips: '055', lat: 27.6001, lon: -81.5015 },
  { zip: '33826', name: "Avon Park",                  county: "Highlands",          state: '12', countyFips: '055', lat: 27.5959, lon: -81.5062 },
  { zip: '33852', name: "Lake Placid",                county: "Highlands",          state: '12', countyFips: '055', lat: 27.2945, lon: -81.3649 },
  { zip: '33857', name: "Lorida",                     county: "Highlands",          state: '12', countyFips: '055', lat: 27.415, lon: -81.1965 },
  { zip: '33862', name: "Lake Placid",                county: "Highlands",          state: '12', countyFips: '055', lat: 27.2931, lon: -81.3629 },
  { zip: '33870', name: "Sebring",                    county: "Highlands",          state: '12', countyFips: '055', lat: 27.4924, lon: -81.4357 },
  { zip: '33871', name: "Sebring",                    county: "Highlands",          state: '12', countyFips: '055', lat: 27.4858, lon: -81.4079 },
  { zip: '33872', name: "Sebring",                    county: "Highlands",          state: '12', countyFips: '055', lat: 27.4703, lon: -81.4872 },
  { zip: '33875', name: "Sebring",                    county: "Highlands",          state: '12', countyFips: '055', lat: 27.4676, lon: -81.4581 },
  { zip: '33876', name: "Sebring",                    county: "Highlands",          state: '12', countyFips: '055', lat: 27.4287, lon: -81.3519 },
  { zip: '33960', name: "Venus",                      county: "Highlands",          state: '12', countyFips: '055', lat: 27.1203, lon: -81.3909 },
  { zip: '33503', name: "Balm",                       county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.7648, lon: -82.2734 },
  { zip: '33508', name: "Brandon",                    county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.9318, lon: -82.295 },
  { zip: '33509', name: "Brandon",                    county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.9378, lon: -82.2859 },
  { zip: '33510', name: "Brandon",                    county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.9551, lon: -82.2966 },
  { zip: '33511', name: "Brandon",                    county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.9056, lon: -82.2881 },
  { zip: '33527', name: "Dover",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.992, lon: -82.2138 },
  { zip: '33530', name: "Durant",                     county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.9068, lon: -82.1767 },
  { zip: '33534', name: "Gibsonton",                  county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.8411, lon: -82.3698 },
  { zip: '33547', name: "Lithia",                     county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.8293, lon: -82.1357 },
  { zip: '33548', name: "Lutz",                       county: "Hillsborough",       state: '12', countyFips: '057', lat: 28.1385, lon: -82.4821 },
  { zip: '33549', name: "Lutz",                       county: "Hillsborough",       state: '12', countyFips: '057', lat: 28.1367, lon: -82.461 },
  { zip: '33550', name: "Mango",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.9797, lon: -82.3065 },
  { zip: '33556', name: "Odessa",                     county: "Hillsborough",       state: '12', countyFips: '057', lat: 28.1421, lon: -82.5905 },
  { zip: '33558', name: "Lutz",                       county: "Hillsborough",       state: '12', countyFips: '057', lat: 28.1474, lon: -82.5152 },
  { zip: '33559', name: "Lutz",                       county: "Hillsborough",       state: '12', countyFips: '057', lat: 28.1801, lon: -82.4169 },
  { zip: '33563', name: "Plant City",                 county: "Hillsborough",       state: '12', countyFips: '057', lat: 28.013, lon: -82.1339 },
  { zip: '33564', name: "Plant City",                 county: "Hillsborough",       state: '12', countyFips: '057', lat: 28.0296, lon: -82.1347 },
  { zip: '33565', name: "Plant City",                 county: "Hillsborough",       state: '12', countyFips: '057', lat: 28.0699, lon: -82.1576 },
  { zip: '33566', name: "Plant City",                 county: "Hillsborough",       state: '12', countyFips: '057', lat: 28.0094, lon: -82.1138 },
  { zip: '33567', name: "Plant City",                 county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.922, lon: -82.1216 },
  { zip: '33568', name: "Riverview",                  county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.872, lon: -82.4388 },
  { zip: '33569', name: "Riverview",                  county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.845, lon: -82.3125 },
  { zip: '33570', name: "Ruskin",                     county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.7015, lon: -82.4355 },
  { zip: '33571', name: "Sun City Center",            county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.7201, lon: -82.453 },
  { zip: '33572', name: "Apollo Beach",               county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.7716, lon: -82.4102 },
  { zip: '33573', name: "Sun City Center",            county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.7147, lon: -82.3538 },
  { zip: '33575', name: "Ruskin",                     county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.7144, lon: -82.4291 },
  { zip: '33578', name: "Riverview",                  county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.8633, lon: -82.3499 },
  { zip: '33579', name: "Riverview",                  county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.8024, lon: -82.2755 },
  { zip: '33583', name: "Seffner",                    county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.872, lon: -82.4388 },
  { zip: '33584', name: "Seffner",                    county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.9922, lon: -82.2863 },
  { zip: '33586', name: "Sun City",                   county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.6784, lon: -82.4787 },
  { zip: '33587', name: "Sydney",                     county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.9634, lon: -82.2073 },
  { zip: '33592', name: "Thonotosassa",               county: "Hillsborough",       state: '12', countyFips: '057', lat: 28.0617, lon: -82.3082 },
  { zip: '33594', name: "Valrico",                    county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.9408, lon: -82.242 },
  { zip: '33595', name: "Valrico",                    county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.9379, lon: -82.2364 },
  { zip: '33596', name: "Valrico",                    county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.8925, lon: -82.243 },
  { zip: '33598', name: "Wimauma",                    county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.7015, lon: -82.3151 },
  { zip: '33601', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.9961, lon: -82.582 },
  { zip: '33602', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.9614, lon: -82.4597 },
  { zip: '33603', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.9845, lon: -82.463 },
  { zip: '33604', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 28.0173, lon: -82.4578 },
  { zip: '33605', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.9671, lon: -82.4334 },
  { zip: '33606', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.9475, lon: -82.4584 },
  { zip: '33607', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.9625, lon: -82.4895 },
  { zip: '33608', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.8434, lon: -82.4884 },
  { zip: '33609', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.9425, lon: -82.5057 },
  { zip: '33610', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.9951, lon: -82.4046 },
  { zip: '33611', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.8914, lon: -82.5067 },
  { zip: '33612', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 28.0502, lon: -82.45 },
  { zip: '33613', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 28.0772, lon: -82.4455 },
  { zip: '33614', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 28.0091, lon: -82.5034 },
  { zip: '33615', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 28.0081, lon: -82.5805 },
  { zip: '33616', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.8742, lon: -82.5203 },
  { zip: '33617', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 28.0384, lon: -82.3949 },
  { zip: '33618', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 28.0763, lon: -82.4852 },
  { zip: '33619', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.9382, lon: -82.3756 },
  { zip: '33620', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 28.06, lon: -82.4079 },
  { zip: '33621', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.8491, lon: -82.4946 },
  { zip: '33622', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.9475, lon: -82.4584 },
  { zip: '33623', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.9475, lon: -82.4584 },
  { zip: '33624', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 28.079, lon: -82.5268 },
  { zip: '33625', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 28.0726, lon: -82.559 },
  { zip: '33626', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 28.0509, lon: -82.6164 },
  { zip: '33629', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.921, lon: -82.5079 },
  { zip: '33630', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.872, lon: -82.4388 },
  { zip: '33631', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.872, lon: -82.4388 },
  { zip: '33633', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.872, lon: -82.4388 },
  { zip: '33634', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 28.0068, lon: -82.556 },
  { zip: '33635', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 28.0301, lon: -82.6048 },
  { zip: '33637', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 28.0338, lon: -82.3659 },
  { zip: '33646', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 28.094, lon: -82.4021 },
  { zip: '33647', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 28.1147, lon: -82.3678 },
  { zip: '33650', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.872, lon: -82.4388 },
  { zip: '33655', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.9475, lon: -82.4584 },
  { zip: '33660', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.872, lon: -82.4388 },
  { zip: '33661', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.872, lon: -82.4388 },
  { zip: '33662', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.872, lon: -82.4388 },
  { zip: '33663', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.872, lon: -82.4388 },
  { zip: '33664', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.872, lon: -82.4388 },
  { zip: '33672', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.9475, lon: -82.4584 },
  { zip: '33673', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.872, lon: -82.4388 },
  { zip: '33674', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.872, lon: -82.4388 },
  { zip: '33675', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.872, lon: -82.4388 },
  { zip: '33677', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.872, lon: -82.4388 },
  { zip: '33679', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.872, lon: -82.4388 },
  { zip: '33680', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.872, lon: -82.4388 },
  { zip: '33681', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.872, lon: -82.4388 },
  { zip: '33682', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.872, lon: -82.4388 },
  { zip: '33684', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.872, lon: -82.4388 },
  { zip: '33685', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.872, lon: -82.4388 },
  { zip: '33686', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.872, lon: -82.4388 },
  { zip: '33687', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.872, lon: -82.4388 },
  { zip: '33688', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.872, lon: -82.4388 },
  { zip: '33689', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.9475, lon: -82.4584 },
  { zip: '33694', name: "Tampa",                      county: "Hillsborough",       state: '12', countyFips: '057', lat: 27.872, lon: -82.4388 },
  { zip: '32425', name: "Bonifay",                    county: "Holmes",             state: '12', countyFips: '059', lat: 30.8464, lon: -85.69 },
  { zip: '32452', name: "Noma",                       county: "Holmes",             state: '12', countyFips: '059', lat: 30.9821, lon: -85.6185 },
  { zip: '32464', name: "Westville",                  county: "Holmes",             state: '12', countyFips: '059', lat: 30.8747, lon: -85.913 },
  { zip: '32948', name: "Fellsmere",                  county: "Indian River",       state: '12', countyFips: '061', lat: 27.7643, lon: -80.6019 },
  { zip: '32957', name: "Roseland",                   county: "Indian River",       state: '12', countyFips: '061', lat: 27.8359, lon: -80.4931 },
  { zip: '32958', name: "Sebastian",                  county: "Indian River",       state: '12', countyFips: '061', lat: 27.7901, lon: -80.4784 },
  { zip: '32960', name: "Vero Beach",                 county: "Indian River",       state: '12', countyFips: '061', lat: 27.633, lon: -80.4031 },
  { zip: '32961', name: "Vero Beach",                 county: "Indian River",       state: '12', countyFips: '061', lat: 27.6175, lon: -80.4231 },
  { zip: '32962', name: "Vero Beach",                 county: "Indian River",       state: '12', countyFips: '061', lat: 27.5885, lon: -80.3923 },
  { zip: '32963', name: "Vero Beach",                 county: "Indian River",       state: '12', countyFips: '061', lat: 27.6898, lon: -80.3757 },
  { zip: '32964', name: "Vero Beach",                 county: "Indian River",       state: '12', countyFips: '061', lat: 27.6386, lon: -80.3973 },
  { zip: '32965', name: "Vero Beach",                 county: "Indian River",       state: '12', countyFips: '061', lat: 27.6386, lon: -80.3973 },
  { zip: '32966', name: "Vero Beach",                 county: "Indian River",       state: '12', countyFips: '061', lat: 27.6372, lon: -80.4794 },
  { zip: '32967', name: "Vero Beach",                 county: "Indian River",       state: '12', countyFips: '061', lat: 27.6972, lon: -80.4416 },
  { zip: '32968', name: "Vero Beach",                 county: "Indian River",       state: '12', countyFips: '061', lat: 27.5999, lon: -80.4382 },
  { zip: '32969', name: "Vero Beach",                 county: "Indian River",       state: '12', countyFips: '061', lat: 27.709, lon: -80.5726 },
  { zip: '32970', name: "Wabasso",                    county: "Indian River",       state: '12', countyFips: '061', lat: 27.7484, lon: -80.4362 },
  { zip: '32971', name: "Winter Beach",               county: "Indian River",       state: '12', countyFips: '061', lat: 27.7192, lon: -80.4206 },
  { zip: '32978', name: "Sebastian",                  county: "Indian River",       state: '12', countyFips: '061', lat: 27.709, lon: -80.5726 },
  { zip: '32420', name: "Alford",                     county: "Jackson",            state: '12', countyFips: '063', lat: 30.6412, lon: -85.3756 },
  { zip: '32423', name: "Bascom",                     county: "Jackson",            state: '12', countyFips: '063', lat: 30.9514, lon: -85.0972 },
  { zip: '32426', name: "Campbellton",                county: "Jackson",            state: '12', countyFips: '063', lat: 30.9563, lon: -85.3766 },
  { zip: '32431', name: "Cottondale",                 county: "Jackson",            state: '12', countyFips: '063', lat: 30.8004, lon: -85.3847 },
  { zip: '32432', name: "Cypress",                    county: "Jackson",            state: '12', countyFips: '063', lat: 30.7158, lon: -85.0784 },
  { zip: '32440', name: "Graceville",                 county: "Jackson",            state: '12', countyFips: '063', lat: 30.9426, lon: -85.5136 },
  { zip: '32442', name: "Grand Ridge",                county: "Jackson",            state: '12', countyFips: '063', lat: 30.7148, lon: -85.021 },
  { zip: '32443', name: "Greenwood",                  county: "Jackson",            state: '12', countyFips: '063', lat: 30.8667, lon: -85.1153 },
  { zip: '32445', name: "Malone",                     county: "Jackson",            state: '12', countyFips: '063', lat: 30.9602, lon: -85.1639 },
  { zip: '32446', name: "Marianna",                   county: "Jackson",            state: '12', countyFips: '063', lat: 30.7996, lon: -85.2293 },
  { zip: '32447', name: "Marianna",                   county: "Jackson",            state: '12', countyFips: '063', lat: 30.7603, lon: -85.2022 },
  { zip: '32448', name: "Marianna",                   county: "Jackson",            state: '12', countyFips: '063', lat: 30.6749, lon: -85.2122 },
  { zip: '32460', name: "Sneads",                     county: "Jackson",            state: '12', countyFips: '063', lat: 30.7276, lon: -84.9337 },
  { zip: '32337', name: "Lloyd",                      county: "Jefferson",          state: '12', countyFips: '065', lat: 30.4778, lon: -84.0228 },
  { zip: '32344', name: "Monticello",                 county: "Jefferson",          state: '12', countyFips: '065', lat: 30.5197, lon: -83.8925 },
  { zip: '32345', name: "Monticello",                 county: "Jefferson",          state: '12', countyFips: '065', lat: 30.5451, lon: -83.8713 },
  { zip: '32361', name: "Wacissa",                    county: "Jefferson",          state: '12', countyFips: '065', lat: 30.3585, lon: -83.9871 },
  { zip: '32753', name: "Debary",                     county: "Jefferson",          state: '12', countyFips: '065', lat: 28.883, lon: -81.3087 },
  { zip: '32008', name: "Branford",                   county: "Lafayette",          state: '12', countyFips: '067', lat: 29.9395, lon: -82.8993 },
  { zip: '32013', name: "Day",                        county: "Lafayette",          state: '12', countyFips: '067', lat: 30.1941, lon: -83.2913 },
  { zip: '32066', name: "Mayo",                       county: "Lafayette",          state: '12', countyFips: '067', lat: 30.04, lon: -83.1462 },
  { zip: '32102', name: "Astor",                      county: "Lake",               state: '12', countyFips: '069', lat: 29.165, lon: -81.5399 },
  { zip: '32158', name: "Lady Lake",                  county: "Lake",               state: '12', countyFips: '069', lat: 28.9175, lon: -81.9229 },
  { zip: '32159', name: "Lady Lake",                  county: "Lake",               state: '12', countyFips: '069', lat: 28.9299, lon: -81.9256 },
  { zip: '32702', name: "Altoona",                    county: "Lake",               state: '12', countyFips: '069', lat: 29.0219, lon: -81.6323 },
  { zip: '32726', name: "Eustis",                     county: "Lake",               state: '12', countyFips: '069', lat: 28.855, lon: -81.6789 },
  { zip: '32727', name: "Eustis",                     county: "Lake",               state: '12', countyFips: '069', lat: 28.8555, lon: -81.6741 },
  { zip: '32735', name: "Grand Island",               county: "Lake",               state: '12', countyFips: '069', lat: 28.8866, lon: -81.7391 },
  { zip: '32736', name: "Eustis",                     county: "Lake",               state: '12', countyFips: '069', lat: 28.9102, lon: -81.5235 },
  { zip: '32756', name: "Mount Dora",                 county: "Lake",               state: '12', countyFips: '069', lat: 28.8111, lon: -81.6536 },
  { zip: '32757', name: "Mount Dora",                 county: "Lake",               state: '12', countyFips: '069', lat: 28.774, lon: -81.6439 },
  { zip: '32767', name: "Paisley",                    county: "Lake",               state: '12', countyFips: '069', lat: 28.9993, lon: -81.503 },
  { zip: '32776', name: "Sorrento",                   county: "Lake",               state: '12', countyFips: '069', lat: 28.8035, lon: -81.5323 },
  { zip: '32778', name: "Tavares",                    county: "Lake",               state: '12', countyFips: '069', lat: 28.801, lon: -81.734 },
  { zip: '34705', name: "Astatula",                   county: "Lake",               state: '12', countyFips: '069', lat: 28.7088, lon: -81.7195 },
  { zip: '34711', name: "Clermont",                   county: "Lake",               state: '12', countyFips: '069', lat: 28.5525, lon: -81.7574 },
  { zip: '34712', name: "Clermont",                   county: "Lake",               state: '12', countyFips: '069', lat: 28.5494, lon: -81.7729 },
  { zip: '34713', name: "Clermont",                   county: "Lake",               state: '12', countyFips: '069', lat: 28.5494, lon: -81.7729 },
  { zip: '34714', name: "Clermont",                   county: "Lake",               state: '12', countyFips: '069', lat: 28.4113, lon: -81.7812 },
  { zip: '34715', name: "Clermont",                   county: "Lake",               state: '12', countyFips: '069', lat: 28.6259, lon: -81.7306 },
  { zip: '34729', name: "Ferndale",                   county: "Lake",               state: '12', countyFips: '069', lat: 28.6219, lon: -81.7034 },
  { zip: '34731', name: "Fruitland Park",             county: "Lake",               state: '12', countyFips: '069', lat: 28.8639, lon: -81.8998 },
  { zip: '34736', name: "Groveland",                  county: "Lake",               state: '12', countyFips: '069', lat: 28.5644, lon: -81.8745 },
  { zip: '34737', name: "Howey In The Hills",         county: "Lake",               state: '12', countyFips: '069', lat: 28.6971, lon: -81.7976 },
  { zip: '34748', name: "Leesburg",                   county: "Lake",               state: '12', countyFips: '069', lat: 28.808, lon: -81.8858 },
  { zip: '34749', name: "Leesburg",                   county: "Lake",               state: '12', countyFips: '069', lat: 28.8108, lon: -81.8779 },
  { zip: '34753', name: "Mascotte",                   county: "Lake",               state: '12', countyFips: '069', lat: 28.583, lon: -81.8941 },
  { zip: '34755', name: "Minneola",                   county: "Lake",               state: '12', countyFips: '069', lat: 28.5744, lon: -81.7462 },
  { zip: '34756', name: "Montverde",                  county: "Lake",               state: '12', countyFips: '069', lat: 28.5972, lon: -81.6794 },
  { zip: '34762', name: "Okahumpka",                  county: "Lake",               state: '12', countyFips: '069', lat: 28.7545, lon: -81.9151 },
  { zip: '34788', name: "Leesburg",                   county: "Lake",               state: '12', countyFips: '069', lat: 28.8887, lon: -81.7827 },
  { zip: '34789', name: "Leesburg",                   county: "Lake",               state: '12', countyFips: '069', lat: 28.8108, lon: -81.8779 },
  { zip: '34797', name: "Yalaha",                     county: "Lake",               state: '12', countyFips: '069', lat: 28.7444, lon: -81.8263 },
  { zip: '33901', name: "Fort Myers",                 county: "Lee",                state: '12', countyFips: '071', lat: 26.6204, lon: -81.8725 },
  { zip: '33902', name: "Fort Myers",                 county: "Lee",                state: '12', countyFips: '071', lat: 26.6239, lon: -81.8836 },
  { zip: '33903', name: "North Fort Myers",           county: "Lee",                state: '12', countyFips: '071', lat: 26.693, lon: -81.9125 },
  { zip: '33904', name: "Cape Coral",                 county: "Lee",                state: '12', countyFips: '071', lat: 26.6065, lon: -81.9502 },
  { zip: '33905', name: "Fort Myers",                 county: "Lee",                state: '12', countyFips: '071', lat: 26.6693, lon: -81.7605 },
  { zip: '33906', name: "Fort Myers",                 county: "Lee",                state: '12', countyFips: '071', lat: 26.5529, lon: -81.9486 },
  { zip: '33907', name: "Fort Myers",                 county: "Lee",                state: '12', countyFips: '071', lat: 26.5681, lon: -81.8736 },
  { zip: '33908', name: "Fort Myers",                 county: "Lee",                state: '12', countyFips: '071', lat: 26.5025, lon: -81.9276 },
  { zip: '33909', name: "Cape Coral",                 county: "Lee",                state: '12', countyFips: '071', lat: 26.6939, lon: -81.9452 },
  { zip: '33910', name: "Cape Coral",                 county: "Lee",                state: '12', countyFips: '071', lat: 26.5529, lon: -81.9486 },
  { zip: '33911', name: "Fort Myers",                 county: "Lee",                state: '12', countyFips: '071', lat: 26.5963, lon: -81.8824 },
  { zip: '33912', name: "Fort Myers",                 county: "Lee",                state: '12', countyFips: '071', lat: 26.4972, lon: -81.8246 },
  { zip: '33913', name: "Fort Myers",                 county: "Lee",                state: '12', countyFips: '071', lat: 26.5228, lon: -81.7065 },
  { zip: '33914', name: "Cape Coral",                 county: "Lee",                state: '12', countyFips: '071', lat: 26.5557, lon: -82.0206 },
  { zip: '33915', name: "Cape Coral",                 county: "Lee",                state: '12', countyFips: '071', lat: 26.6599, lon: -81.8934 },
  { zip: '33916', name: "Fort Myers",                 county: "Lee",                state: '12', countyFips: '071', lat: 26.6466, lon: -81.8429 },
  { zip: '33917', name: "North Fort Myers",           county: "Lee",                state: '12', countyFips: '071', lat: 26.7357, lon: -81.8435 },
  { zip: '33918', name: "North Fort Myers",           county: "Lee",                state: '12', countyFips: '071', lat: 26.6673, lon: -81.8801 },
  { zip: '33919', name: "Fort Myers",                 county: "Lee",                state: '12', countyFips: '071', lat: 26.5567, lon: -81.9034 },
  { zip: '33920', name: "Alva",                       county: "Lee",                state: '12', countyFips: '071', lat: 26.7147, lon: -81.6351 },
  { zip: '33921', name: "Boca Grande",                county: "Lee",                state: '12', countyFips: '071', lat: 26.7545, lon: -82.2611 },
  { zip: '33922', name: "Bokeelia",                   county: "Lee",                state: '12', countyFips: '071', lat: 26.6627, lon: -82.1401 },
  { zip: '33924', name: "Captiva",                    county: "Lee",                state: '12', countyFips: '071', lat: 26.5215, lon: -82.1802 },
  { zip: '33928', name: "Estero",                     county: "Lee",                state: '12', countyFips: '071', lat: 26.4351, lon: -81.8102 },
  { zip: '33929', name: "Estero",                     county: "Lee",                state: '12', countyFips: '071', lat: 26.4381, lon: -81.8068 },
  { zip: '33931', name: "Fort Myers Beach",           county: "Lee",                state: '12', countyFips: '071', lat: 26.4527, lon: -81.9501 },
  { zip: '33932', name: "Fort Myers Beach",           county: "Lee",                state: '12', countyFips: '071', lat: 26.5529, lon: -81.9486 },
  { zip: '33945', name: "Pineland",                   county: "Lee",                state: '12', countyFips: '071', lat: 26.6583, lon: -82.1434 },
  { zip: '33956', name: "Saint James City",           county: "Lee",                state: '12', countyFips: '071', lat: 26.529, lon: -82.0916 },
  { zip: '33957', name: "Sanibel",                    county: "Lee",                state: '12', countyFips: '071', lat: 26.4514, lon: -82.0868 },
  { zip: '33965', name: "Fort Myers",                 county: "Lee",                state: '12', countyFips: '071', lat: 26.4637, lon: -81.7722 },
  { zip: '33966', name: "Fort Myers",                 county: "Lee",                state: '12', countyFips: '071', lat: 26.5824, lon: -81.832 },
  { zip: '33967', name: "Fort Myers",                 county: "Lee",                state: '12', countyFips: '071', lat: 26.4722, lon: -81.8122 },
  { zip: '33970', name: "Lehigh Acres",               county: "Lee",                state: '12', countyFips: '071', lat: 26.5647, lon: -81.6208 },
  { zip: '33971', name: "Lehigh Acres",               county: "Lee",                state: '12', countyFips: '071', lat: 26.6388, lon: -81.6992 },
  { zip: '33972', name: "Lehigh Acres",               county: "Lee",                state: '12', countyFips: '071', lat: 26.6492, lon: -81.6167 },
  { zip: '33973', name: "Lehigh Acres",               county: "Lee",                state: '12', countyFips: '071', lat: 26.602, lon: -81.7311 },
  { zip: '33974', name: "Lehigh Acres",               county: "Lee",                state: '12', countyFips: '071', lat: 26.5677, lon: -81.5954 },
  { zip: '33976', name: "Lehigh Acres",               county: "Lee",                state: '12', countyFips: '071', lat: 26.5952, lon: -81.6849 },
  { zip: '33990', name: "Cape Coral",                 county: "Lee",                state: '12', countyFips: '071', lat: 26.6265, lon: -81.9677 },
  { zip: '33991', name: "Cape Coral",                 county: "Lee",                state: '12', countyFips: '071', lat: 26.6281, lon: -82.0182 },
  { zip: '33993', name: "Cape Coral",                 county: "Lee",                state: '12', countyFips: '071', lat: 26.6786, lon: -82.0254 },
  { zip: '33994', name: "Fort Myers",                 county: "Lee",                state: '12', countyFips: '071', lat: 26.5529, lon: -81.9486 },
  { zip: '34133', name: "Bonita Springs",             county: "Lee",                state: '12', countyFips: '071', lat: 26.3398, lon: -81.7787 },
  { zip: '34134', name: "Bonita Springs",             county: "Lee",                state: '12', countyFips: '071', lat: 26.3626, lon: -81.8183 },
  { zip: '34135', name: "Bonita Springs",             county: "Lee",                state: '12', countyFips: '071', lat: 26.3771, lon: -81.7334 },
  { zip: '34136', name: "Bonita Springs",             county: "Lee",                state: '12', countyFips: '071', lat: 26.3398, lon: -81.7787 },
  { zip: '32301', name: "Tallahassee",                county: "Leon",               state: '12', countyFips: '073', lat: 30.4286, lon: -84.2593 },
  { zip: '32302', name: "Tallahassee",                county: "Leon",               state: '12', countyFips: '073', lat: 30.4383, lon: -84.2807 },
  { zip: '32303', name: "Tallahassee",                county: "Leon",               state: '12', countyFips: '073', lat: 30.4874, lon: -84.3189 },
  { zip: '32304', name: "Tallahassee",                county: "Leon",               state: '12', countyFips: '073', lat: 30.4478, lon: -84.3211 },
  { zip: '32305', name: "Tallahassee",                county: "Leon",               state: '12', countyFips: '073', lat: 30.334, lon: -84.287 },
  { zip: '32306', name: "Tallahassee",                county: "Leon",               state: '12', countyFips: '073', lat: 30.4425, lon: -84.2986 },
  { zip: '32307', name: "Tallahassee",                county: "Leon",               state: '12', countyFips: '073', lat: 30.4257, lon: -84.2877 },
  { zip: '32308', name: "Tallahassee",                county: "Leon",               state: '12', countyFips: '073', lat: 30.4771, lon: -84.2246 },
  { zip: '32309', name: "Tallahassee",                county: "Leon",               state: '12', countyFips: '073', lat: 30.5422, lon: -84.1413 },
  { zip: '32310', name: "Tallahassee",                county: "Leon",               state: '12', countyFips: '073', lat: 30.3991, lon: -84.3298 },
  { zip: '32311', name: "Tallahassee",                county: "Leon",               state: '12', countyFips: '073', lat: 30.4156, lon: -84.187 },
  { zip: '32312', name: "Tallahassee",                county: "Leon",               state: '12', countyFips: '073', lat: 30.5185, lon: -84.2627 },
  { zip: '32313', name: "Tallahassee",                county: "Leon",               state: '12', countyFips: '073', lat: 30.4793, lon: -84.3462 },
  { zip: '32314', name: "Tallahassee",                county: "Leon",               state: '12', countyFips: '073', lat: 30.4793, lon: -84.3462 },
  { zip: '32315', name: "Tallahassee",                county: "Leon",               state: '12', countyFips: '073', lat: 30.4793, lon: -84.3462 },
  { zip: '32316', name: "Tallahassee",                county: "Leon",               state: '12', countyFips: '073', lat: 30.4793, lon: -84.3462 },
  { zip: '32317', name: "Tallahassee",                county: "Leon",               state: '12', countyFips: '073', lat: 30.4651, lon: -84.1128 },
  { zip: '32362', name: "Woodville",                  county: "Leon",               state: '12', countyFips: '073', lat: 30.3193, lon: -84.2674 },
  { zip: '32395', name: "Tallahassee",                county: "Leon",               state: '12', countyFips: '073', lat: 30.4793, lon: -84.3462 },
  { zip: '32399', name: "Tallahassee",                county: "Leon",               state: '12', countyFips: '073', lat: 30.4383, lon: -84.2807 },
  { zip: '32621', name: "Bronson",                    county: "Levy",               state: '12', countyFips: '075', lat: 29.461, lon: -82.6356 },
  { zip: '32625', name: "Cedar Key",                  county: "Levy",               state: '12', countyFips: '075', lat: 29.171, lon: -83.0168 },
  { zip: '32626', name: "Chiefland",                  county: "Levy",               state: '12', countyFips: '075', lat: 29.4832, lon: -82.8809 },
  { zip: '32639', name: "Gulf Hammock",               county: "Levy",               state: '12', countyFips: '075', lat: 29.2447, lon: -82.7402 },
  { zip: '32644', name: "Chiefland",                  county: "Levy",               state: '12', countyFips: '075', lat: 29.4602, lon: -82.8553 },
  { zip: '32668', name: "Morriston",                  county: "Levy",               state: '12', countyFips: '075', lat: 29.2813, lon: -82.4917 },
  { zip: '32683', name: "Otter Creek",                county: "Levy",               state: '12', countyFips: '075', lat: 29.3109, lon: -82.7945 },
  { zip: '32696', name: "Williston",                  county: "Levy",               state: '12', countyFips: '075', lat: 29.3977, lon: -82.4856 },
  { zip: '34449', name: "Inglis",                     county: "Levy",               state: '12', countyFips: '075', lat: 29.0955, lon: -82.6561 },
  { zip: '34498', name: "Yankeetown",                 county: "Levy",               state: '12', countyFips: '075', lat: 29.0305, lon: -82.719 },
  { zip: '32321', name: "Bristol",                    county: "Liberty",            state: '12', countyFips: '077', lat: 30.4223, lon: -84.9466 },
  { zip: '32334', name: "Hosford",                    county: "Liberty",            state: '12', countyFips: '077', lat: 30.3639, lon: -84.8054 },
  { zip: '32335', name: "Sumatra",                    county: "Liberty",            state: '12', countyFips: '077', lat: 30.0206, lon: -84.9806 },
  { zip: '32360', name: "Telogia",                    county: "Liberty",            state: '12', countyFips: '077', lat: 30.3511, lon: -84.8203 },
  { zip: '32059', name: "Lee",                        county: "Madison",            state: '12', countyFips: '079', lat: 30.3979, lon: -83.2844 },
  { zip: '32331', name: "Greenville",                 county: "Madison",            state: '12', countyFips: '079', lat: 30.4512, lon: -83.6474 },
  { zip: '32340', name: "Madison",                    county: "Madison",            state: '12', countyFips: '079', lat: 30.4802, lon: -83.4067 },
  { zip: '32341', name: "Madison",                    county: "Madison",            state: '12', countyFips: '079', lat: 30.4776, lon: -83.3914 },
  { zip: '32350', name: "Pinetta",                    county: "Madison",            state: '12', countyFips: '079', lat: 30.5997, lon: -83.3405 },
  { zip: '34201', name: "Bradenton",                  county: "Manatee",            state: '12', countyFips: '081', lat: 27.4047, lon: -82.4705 },
  { zip: '34202', name: "Bradenton",                  county: "Manatee",            state: '12', countyFips: '081', lat: 27.4067, lon: -82.39 },
  { zip: '34203', name: "Bradenton",                  county: "Manatee",            state: '12', countyFips: '081', lat: 27.4547, lon: -82.5359 },
  { zip: '34204', name: "Bradenton",                  county: "Manatee",            state: '12', countyFips: '081', lat: 27.4272, lon: -82.4387 },
  { zip: '34205', name: "Bradenton",                  county: "Manatee",            state: '12', countyFips: '081', lat: 27.4841, lon: -82.5834 },
  { zip: '34206', name: "Bradenton",                  county: "Manatee",            state: '12', countyFips: '081', lat: 27.4989, lon: -82.5748 },
  { zip: '34207', name: "Bradenton",                  county: "Manatee",            state: '12', countyFips: '081', lat: 27.4394, lon: -82.5778 },
  { zip: '34208', name: "Bradenton",                  county: "Manatee",            state: '12', countyFips: '081', lat: 27.4678, lon: -82.512 },
  { zip: '34209', name: "Bradenton",                  county: "Manatee",            state: '12', countyFips: '081', lat: 27.4759, lon: -82.6167 },
  { zip: '34210', name: "Bradenton",                  county: "Manatee",            state: '12', countyFips: '081', lat: 27.4544, lon: -82.6358 },
  { zip: '34211', name: "Bradenton",                  county: "Manatee",            state: '12', countyFips: '081', lat: 27.45, lon: -82.3773 },
  { zip: '34212', name: "Bradenton",                  county: "Manatee",            state: '12', countyFips: '081', lat: 27.4978, lon: -82.4101 },
  { zip: '34215', name: "Cortez",                     county: "Manatee",            state: '12', countyFips: '081', lat: 27.4713, lon: -82.6823 },
  { zip: '34216', name: "Anna Maria",                 county: "Manatee",            state: '12', countyFips: '081', lat: 27.5291, lon: -82.7317 },
  { zip: '34217', name: "Bradenton Beach",            county: "Manatee",            state: '12', countyFips: '081', lat: 27.4859, lon: -82.7102 },
  { zip: '34218', name: "Holmes Beach",               county: "Manatee",            state: '12', countyFips: '081', lat: 27.4995, lon: -82.7099 },
  { zip: '34219', name: "Parrish",                    county: "Manatee",            state: '12', countyFips: '081', lat: 27.5572, lon: -82.396 },
  { zip: '34220', name: "Palmetto",                   county: "Manatee",            state: '12', countyFips: '081', lat: 27.5214, lon: -82.5723 },
  { zip: '34221', name: "Palmetto",                   county: "Manatee",            state: '12', countyFips: '081', lat: 27.5429, lon: -82.563 },
  { zip: '34222', name: "Ellenton",                   county: "Manatee",            state: '12', countyFips: '081', lat: 27.5382, lon: -82.5006 },
  { zip: '34243', name: "Sarasota",                   county: "Manatee",            state: '12', countyFips: '081', lat: 27.4072, lon: -82.5303 },
  { zip: '34250', name: "Terra Ceia",                 county: "Manatee",            state: '12', countyFips: '081', lat: 27.5722, lon: -82.5832 },
  { zip: '34251', name: "Myakka City",                county: "Manatee",            state: '12', countyFips: '081', lat: 27.3648, lon: -82.1849 },
  { zip: '34260', name: "Manasota",                   county: "Manatee",            state: '12', countyFips: '081', lat: 27.4272, lon: -82.4387 },
  { zip: '34264', name: "Oneco",                      county: "Manatee",            state: '12', countyFips: '081', lat: 27.4475, lon: -82.5462 },
  { zip: '34270', name: "Tallevast",                  county: "Manatee",            state: '12', countyFips: '081', lat: 27.4054, lon: -82.5435 },
  { zip: '34280', name: "Bradenton",                  county: "Manatee",            state: '12', countyFips: '081', lat: 27.4272, lon: -82.4387 },
  { zip: '34281', name: "Bradenton",                  county: "Manatee",            state: '12', countyFips: '081', lat: 27.4272, lon: -82.4387 },
  { zip: '34282', name: "Bradenton",                  county: "Manatee",            state: '12', countyFips: '081', lat: 27.4272, lon: -82.4387 },
  { zip: '32111', name: "Candler",                    county: "Marion",             state: '12', countyFips: '083', lat: 29.0607, lon: -81.969 },
  { zip: '32113', name: "Citra",                      county: "Marion",             state: '12', countyFips: '083', lat: 29.3918, lon: -82.1062 },
  { zip: '32133', name: "Eastlake Weir",              county: "Marion",             state: '12', countyFips: '083', lat: 29.0088, lon: -81.9094 },
  { zip: '32134', name: "Fort Mc Coy",                county: "Marion",             state: '12', countyFips: '083', lat: 29.391, lon: -81.8551 },
  { zip: '32179', name: "Ocklawaha",                  county: "Marion",             state: '12', countyFips: '083', lat: 29.0643, lon: -81.8857 },
  { zip: '32182', name: "Orange Springs",             county: "Marion",             state: '12', countyFips: '083', lat: 29.4856, lon: -81.9589 },
  { zip: '32183', name: "Ocklawaha",                  county: "Marion",             state: '12', countyFips: '083', lat: 29.0597, lon: -81.9051 },
  { zip: '32192', name: "Sparr",                      county: "Marion",             state: '12', countyFips: '083', lat: 29.3268, lon: -82.1046 },
  { zip: '32195', name: "Weirsdale",                  county: "Marion",             state: '12', countyFips: '083', lat: 28.9782, lon: -81.8932 },
  { zip: '32617', name: "Anthony",                    county: "Marion",             state: '12', countyFips: '083', lat: 29.3048, lon: -82.1262 },
  { zip: '32634', name: "Fairfield",                  county: "Marion",             state: '12', countyFips: '083', lat: 29.3509, lon: -82.2765 },
  { zip: '32663', name: "Lowell",                     county: "Marion",             state: '12', countyFips: '083', lat: 29.3424, lon: -82.2126 },
  { zip: '32664', name: "Mc Intosh",                  county: "Marion",             state: '12', countyFips: '083', lat: 29.438, lon: -82.2295 },
  { zip: '32681', name: "Orange Lake",                county: "Marion",             state: '12', countyFips: '083', lat: 29.4236, lon: -82.2168 },
  { zip: '32686', name: "Reddick",                    county: "Marion",             state: '12', countyFips: '083', lat: 29.3754, lon: -82.244 },
  { zip: '32784', name: "Umatilla",                   county: "Marion",             state: '12', countyFips: '083', lat: 28.9254, lon: -81.6801 },
  { zip: '34420', name: "Belleview",                  county: "Marion",             state: '12', countyFips: '083', lat: 29.0531, lon: -82.0375 },
  { zip: '34421', name: "Belleview",                  county: "Marion",             state: '12', countyFips: '083', lat: 29.2407, lon: -82.0875 },
  { zip: '34430', name: "Dunnellon",                  county: "Marion",             state: '12', countyFips: '083', lat: 29.0491, lon: -82.4609 },
  { zip: '34431', name: "Dunnellon",                  county: "Marion",             state: '12', countyFips: '083', lat: 29.1392, lon: -82.5328 },
  { zip: '34432', name: "Dunnellon",                  county: "Marion",             state: '12', countyFips: '083', lat: 29.1015, lon: -82.3413 },
  { zip: '34470', name: "Ocala",                      county: "Marion",             state: '12', countyFips: '083', lat: 29.1989, lon: -82.0874 },
  { zip: '34471', name: "Ocala",                      county: "Marion",             state: '12', countyFips: '083', lat: 29.1605, lon: -82.1288 },
  { zip: '34472', name: "Ocala",                      county: "Marion",             state: '12', countyFips: '083', lat: 29.1253, lon: -82.0086 },
  { zip: '34473', name: "Ocala",                      county: "Marion",             state: '12', countyFips: '083', lat: 29.0058, lon: -82.1828 },
  { zip: '34474', name: "Ocala",                      county: "Marion",             state: '12', countyFips: '083', lat: 29.1565, lon: -82.2095 },
  { zip: '34475', name: "Ocala",                      county: "Marion",             state: '12', countyFips: '083', lat: 29.2573, lon: -82.161 },
  { zip: '34476', name: "Ocala",                      county: "Marion",             state: '12', countyFips: '083', lat: 29.1159, lon: -82.2422 },
  { zip: '34477', name: "Ocala",                      county: "Marion",             state: '12', countyFips: '083', lat: 29.1872, lon: -82.1401 },
  { zip: '34478', name: "Ocala",                      county: "Marion",             state: '12', countyFips: '083', lat: 29.1872, lon: -82.1123 },
  { zip: '34479', name: "Ocala",                      county: "Marion",             state: '12', countyFips: '083', lat: 29.2541, lon: -82.1095 },
  { zip: '34480', name: "Ocala",                      county: "Marion",             state: '12', countyFips: '083', lat: 29.1056, lon: -82.098 },
  { zip: '34481', name: "Ocala",                      county: "Marion",             state: '12', countyFips: '083', lat: 29.1281, lon: -82.2975 },
  { zip: '34482', name: "Ocala",                      county: "Marion",             state: '12', countyFips: '083', lat: 29.2611, lon: -82.2195 },
  { zip: '34483', name: "Ocala",                      county: "Marion",             state: '12', countyFips: '083', lat: 29.2407, lon: -82.0875 },
  { zip: '34488', name: "Silver Springs",             county: "Marion",             state: '12', countyFips: '083', lat: 29.2635, lon: -81.9532 },
  { zip: '34489', name: "Silver Springs",             county: "Marion",             state: '12', countyFips: '083', lat: 29.2152, lon: -82.0972 },
  { zip: '34491', name: "Summerfield",                county: "Marion",             state: '12', countyFips: '083', lat: 29.0112, lon: -82.0325 },
  { zip: '34492', name: "Summerfield",                county: "Marion",             state: '12', countyFips: '083', lat: 28.998, lon: -82.0161 },
  { zip: '33438', name: "Canal Point",                county: "Martin",             state: '12', countyFips: '085', lat: 26.8592, lon: -80.6337 },
  { zip: '33455', name: "Hobe Sound",                 county: "Martin",             state: '12', countyFips: '085', lat: 27.0813, lon: -80.1509 },
  { zip: '33469', name: "Jupiter",                    county: "Martin",             state: '12', countyFips: '085', lat: 26.9831, lon: -80.108 },
  { zip: '33475', name: "Hobe Sound",                 county: "Martin",             state: '12', countyFips: '085', lat: 27.0595, lon: -80.1364 },
  { zip: '34956', name: "Indiantown",                 county: "Martin",             state: '12', countyFips: '085', lat: 27.0615, lon: -80.4803 },
  { zip: '34957', name: "Jensen Beach",               county: "Martin",             state: '12', countyFips: '085', lat: 27.2356, lon: -80.2277 },
  { zip: '34958', name: "Jensen Beach",               county: "Martin",             state: '12', countyFips: '085', lat: 27.2424, lon: -80.2246 },
  { zip: '34990', name: "Palm City",                  county: "Martin",             state: '12', countyFips: '085', lat: 27.1656, lon: -80.2916 },
  { zip: '34991', name: "Palm City",                  county: "Martin",             state: '12', countyFips: '085', lat: 27.1678, lon: -80.2662 },
  { zip: '34992', name: "Port Salerno",               county: "Martin",             state: '12', countyFips: '085', lat: 27.1442, lon: -80.2006 },
  { zip: '34994', name: "Stuart",                     county: "Martin",             state: '12', countyFips: '085', lat: 27.1968, lon: -80.2538 },
  { zip: '34995', name: "Stuart",                     county: "Martin",             state: '12', countyFips: '085', lat: 27.1754, lon: -80.2415 },
  { zip: '34996', name: "Stuart",                     county: "Martin",             state: '12', countyFips: '085', lat: 27.1929, lon: -80.2164 },
  { zip: '34997', name: "Stuart",                     county: "Martin",             state: '12', countyFips: '085', lat: 27.1398, lon: -80.2129 },
  { zip: '33002', name: "Hialeah",                    county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.8576, lon: -80.2781 },
  { zip: '33010', name: "Hialeah",                    county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.8325, lon: -80.2808 },
  { zip: '33011', name: "Hialeah",                    county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.8576, lon: -80.2781 },
  { zip: '33012', name: "Hialeah",                    county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.8654, lon: -80.3059 },
  { zip: '33013', name: "Hialeah",                    county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.8594, lon: -80.2725 },
  { zip: '33014', name: "Hialeah",                    county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.8963, lon: -80.3063 },
  { zip: '33015', name: "Hialeah",                    county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.9388, lon: -80.3165 },
  { zip: '33016', name: "Hialeah",                    county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.8803, lon: -80.3368 },
  { zip: '33017', name: "Hialeah",                    county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.8576, lon: -80.2781 },
  { zip: '33018', name: "Hialeah",                    county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.9098, lon: -80.3889 },
  { zip: '33030', name: "Homestead",                  county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.4766, lon: -80.4839 },
  { zip: '33031', name: "Homestead",                  county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.5323, lon: -80.5075 },
  { zip: '33032', name: "Homestead",                  county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.5303, lon: -80.3918 },
  { zip: '33033', name: "Homestead",                  county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.4906, lon: -80.438 },
  { zip: '33034', name: "Homestead",                  county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.2846, lon: -80.6246 },
  { zip: '33035', name: "Homestead",                  county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.4573, lon: -80.4572 },
  { zip: '33039', name: "Homestead",                  county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.5021, lon: -80.3997 },
  { zip: '33054', name: "Opa Locka",                  county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.9097, lon: -80.247 },
  { zip: '33055', name: "Opa Locka",                  county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.9476, lon: -80.2778 },
  { zip: '33056', name: "Miami Gardens",              county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.942, lon: -80.2456 },
  { zip: '33090', name: "Homestead",                  county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.5584, lon: -80.4582 },
  { zip: '33092', name: "Homestead",                  county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.5584, lon: -80.4582 },
  { zip: '33101', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7791, lon: -80.1978 },
  { zip: '33102', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33106', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.8527, lon: -80.3012 },
  { zip: '33109', name: "Miami Beach",                county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7588, lon: -80.1376 },
  { zip: '33111', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33114', name: "Coral Gables",               county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7215, lon: -80.2684 },
  { zip: '33116', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33119', name: "Miami Beach",                county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7845, lon: -80.132 },
  { zip: '33122', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.8001, lon: -80.281 },
  { zip: '33124', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33125', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7825, lon: -80.2341 },
  { zip: '33126', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7763, lon: -80.2919 },
  { zip: '33127', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.8143, lon: -80.2051 },
  { zip: '33128', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7756, lon: -80.2089 },
  { zip: '33129', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7559, lon: -80.2013 },
  { zip: '33130', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7672, lon: -80.2059 },
  { zip: '33131', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7629, lon: -80.1895 },
  { zip: '33132', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7867, lon: -80.18 },
  { zip: '33133', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7378, lon: -80.2248 },
  { zip: '33134', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.768, lon: -80.2714 },
  { zip: '33135', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7664, lon: -80.2317 },
  { zip: '33136', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7864, lon: -80.2042 },
  { zip: '33137', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.8156, lon: -80.1897 },
  { zip: '33138', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.8521, lon: -80.1821 },
  { zip: '33139', name: "Miami Beach",                county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7873, lon: -80.1564 },
  { zip: '33140', name: "Miami Beach",                county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.8198, lon: -80.1337 },
  { zip: '33141', name: "Miami Beach",                county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.8486, lon: -80.1446 },
  { zip: '33142', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.813, lon: -80.232 },
  { zip: '33143', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7022, lon: -80.2978 },
  { zip: '33144', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7626, lon: -80.3096 },
  { zip: '33145', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7539, lon: -80.2253 },
  { zip: '33146', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7205, lon: -80.2728 },
  { zip: '33147', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.8507, lon: -80.2366 },
  { zip: '33149', name: "Key Biscayne",               county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.6921, lon: -80.1625 },
  { zip: '33150', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.8512, lon: -80.207 },
  { zip: '33151', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.8321, lon: -80.2094 },
  { zip: '33152', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7955, lon: -80.3129 },
  { zip: '33153', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.8655, lon: -80.1936 },
  { zip: '33154', name: "Miami Beach",                county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7907, lon: -80.13 },
  { zip: '33155', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7392, lon: -80.3103 },
  { zip: '33156', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.6682, lon: -80.2973 },
  { zip: '33157', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.6062, lon: -80.3426 },
  { zip: '33158', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.6364, lon: -80.3187 },
  { zip: '33160', name: "North Miami Beach",          county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.9449, lon: -80.1391 },
  { zip: '33161', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.8934, lon: -80.1758 },
  { zip: '33162', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.9286, lon: -80.183 },
  { zip: '33163', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.945, lon: -80.2145 },
  { zip: '33164', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33165', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7343, lon: -80.3588 },
  { zip: '33166', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.8301, lon: -80.2926 },
  { zip: '33167', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.8856, lon: -80.2292 },
  { zip: '33168', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.8902, lon: -80.2101 },
  { zip: '33169', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.9441, lon: -80.2144 },
  { zip: '33170', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.5584, lon: -80.4582 },
  { zip: '33172', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7735, lon: -80.3572 },
  { zip: '33173', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.6992, lon: -80.3618 },
  { zip: '33174', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7628, lon: -80.3611 },
  { zip: '33175', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7341, lon: -80.4068 },
  { zip: '33176', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.6574, lon: -80.3627 },
  { zip: '33177', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.5968, lon: -80.4046 },
  { zip: '33178', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.8141, lon: -80.3549 },
  { zip: '33179', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.9571, lon: -80.1814 },
  { zip: '33180', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.9597, lon: -80.1403 },
  { zip: '33181', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.8965, lon: -80.157 },
  { zip: '33182', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7877, lon: -80.4166 },
  { zip: '33183', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7, lon: -80.413 },
  { zip: '33184', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7574, lon: -80.403 },
  { zip: '33185', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7274, lon: -80.4497 },
  { zip: '33186', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.6694, lon: -80.4085 },
  { zip: '33187', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.596, lon: -80.507 },
  { zip: '33188', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33189', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.573, lon: -80.3374 },
  { zip: '33190', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.5593, lon: -80.3483 },
  { zip: '33191', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33192', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33193', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.6964, lon: -80.4401 },
  { zip: '33194', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.5584, lon: -80.4582 },
  { zip: '33195', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7729, lon: -80.187 },
  { zip: '33196', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.6615, lon: -80.441 },
  { zip: '33197', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33198', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33199', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33206', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33222', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7577, lon: -80.3748 },
  { zip: '33231', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33233', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33234', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33238', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33239', name: "Miami Beach",                county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7907, lon: -80.13 },
  { zip: '33242', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33243', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33245', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33247', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33255', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33256', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33257', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33261', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33265', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33266', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33269', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33280', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33283', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33296', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33299', name: "Miami",                      county: "Miami-Dade",         state: '12', countyFips: '086', lat: 25.7743, lon: -80.1937 },
  { zip: '33001', name: "Long Key",                   county: "Monroe",             state: '12', countyFips: '087', lat: 24.8306, lon: -80.8049 },
  { zip: '33036', name: "Islamorada",                 county: "Monroe",             state: '12', countyFips: '087', lat: 24.9233, lon: -80.63 },
  { zip: '33037', name: "Key Largo",                  county: "Monroe",             state: '12', countyFips: '087', lat: 25.0865, lon: -80.4473 },
  { zip: '33040', name: "Key West",                   county: "Monroe",             state: '12', countyFips: '087', lat: 24.5552, lon: -81.7816 },
  { zip: '33041', name: "Key West",                   county: "Monroe",             state: '12', countyFips: '087', lat: 24.5552, lon: -81.7816 },
  { zip: '33042', name: "Summerland Key",             county: "Monroe",             state: '12', countyFips: '087', lat: 24.667, lon: -81.5099 },
  { zip: '33043', name: "Big Pine Key",               county: "Monroe",             state: '12', countyFips: '087', lat: 24.68, lon: -81.362 },
  { zip: '33045', name: "Key West",                   county: "Monroe",             state: '12', countyFips: '087', lat: 24.5552, lon: -81.7816 },
  { zip: '33050', name: "Marathon",                   county: "Monroe",             state: '12', countyFips: '087', lat: 24.7279, lon: -81.0386 },
  { zip: '33051', name: "Key Colony Beach",           county: "Monroe",             state: '12', countyFips: '087', lat: 24.7234, lon: -81.0203 },
  { zip: '33052', name: "Marathon Shores",            county: "Monroe",             state: '12', countyFips: '087', lat: 24.7233, lon: -81.0632 },
  { zip: '33070', name: "Tavernier",                  county: "Monroe",             state: '12', countyFips: '087', lat: 25.0108, lon: -80.5218 },
  { zip: '32009', name: "Bryceville",                 county: "Nassau",             state: '12', countyFips: '089', lat: 30.4193, lon: -81.9724 },
  { zip: '32011', name: "Callahan",                   county: "Nassau",             state: '12', countyFips: '089', lat: 30.552, lon: -81.8145 },
  { zip: '32034', name: "Fernandina Beach",           county: "Nassau",             state: '12', countyFips: '089', lat: 30.6697, lon: -81.4626 },
  { zip: '32035', name: "Fernandina Beach",           county: "Nassau",             state: '12', countyFips: '089', lat: 30.6697, lon: -81.4626 },
  { zip: '32041', name: "Yulee",                      county: "Nassau",             state: '12', countyFips: '089', lat: 30.6233, lon: -81.5902 },
  { zip: '32046', name: "Hilliard",                   county: "Nassau",             state: '12', countyFips: '089', lat: 30.6884, lon: -81.9345 },
  { zip: '32097', name: "Yulee",                      county: "Nassau",             state: '12', countyFips: '089', lat: 30.6222, lon: -81.5906 },
  { zip: '32531', name: "Baker",                      county: "Okaloosa",           state: '12', countyFips: '091', lat: 30.8316, lon: -86.677 },
  { zip: '32536', name: "Crestview",                  county: "Okaloosa",           state: '12', countyFips: '091', lat: 30.7644, lon: -86.5917 },
  { zip: '32537', name: "Milligan",                   county: "Okaloosa",           state: '12', countyFips: '091', lat: 30.742, lon: -86.6552 },
  { zip: '32539', name: "Crestview",                  county: "Okaloosa",           state: '12', countyFips: '091', lat: 30.7773, lon: -86.4832 },
  { zip: '32540', name: "Destin",                     county: "Okaloosa",           state: '12', countyFips: '091', lat: 30.3935, lon: -86.4958 },
  { zip: '32541', name: "Destin",                     county: "Okaloosa",           state: '12', countyFips: '091', lat: 30.3949, lon: -86.4692 },
  { zip: '32542', name: "Eglin Afb",                  county: "Okaloosa",           state: '12', countyFips: '091', lat: 30.5393, lon: -86.6087 },
  { zip: '32544', name: "Hurlburt Field",             county: "Okaloosa",           state: '12', countyFips: '091', lat: 30.4229, lon: -86.6985 },
  { zip: '32547', name: "Fort Walton Beach",          county: "Okaloosa",           state: '12', countyFips: '091', lat: 30.4487, lon: -86.6255 },
  { zip: '32548', name: "Fort Walton Beach",          county: "Okaloosa",           state: '12', countyFips: '091', lat: 30.4206, lon: -86.6286 },
  { zip: '32549', name: "Fort Walton Beach",          county: "Okaloosa",           state: '12', countyFips: '091', lat: 30.4208, lon: -86.6194 },
  { zip: '32567', name: "Laurel Hill",                county: "Okaloosa",           state: '12', countyFips: '091', lat: 30.9524, lon: -86.4003 },
  { zip: '32569', name: "Mary Esther",                county: "Okaloosa",           state: '12', countyFips: '091', lat: 30.4085, lon: -86.7352 },
  { zip: '32578', name: "Niceville",                  county: "Okaloosa",           state: '12', countyFips: '091', lat: 30.5169, lon: -86.4822 },
  { zip: '32579', name: "Shalimar",                   county: "Okaloosa",           state: '12', countyFips: '091', lat: 30.4456, lon: -86.5717 },
  { zip: '32580', name: "Valparaiso",                 county: "Okaloosa",           state: '12', countyFips: '091', lat: 30.5092, lon: -86.5009 },
  { zip: '32588', name: "Niceville",                  county: "Okaloosa",           state: '12', countyFips: '091', lat: 30.6612, lon: -86.5945 },
  { zip: '34972', name: "Okeechobee",                 county: "Okeechobee",         state: '12', countyFips: '093', lat: 27.4203, lon: -80.9454 },
  { zip: '34973', name: "Okeechobee",                 county: "Okeechobee",         state: '12', countyFips: '093', lat: 27.2439, lon: -80.8298 },
  { zip: '32703', name: "Apopka",                     county: "Orange",             state: '12', countyFips: '095', lat: 28.6354, lon: -81.4888 },
  { zip: '32704', name: "Apopka",                     county: "Orange",             state: '12', countyFips: '095', lat: 28.6762, lon: -81.5119 },
  { zip: '32709', name: "Christmas",                  county: "Orange",             state: '12', countyFips: '095', lat: 28.5462, lon: -81.0116 },
  { zip: '32710', name: "Clarcona",                   county: "Orange",             state: '12', countyFips: '095', lat: 28.6128, lon: -81.4987 },
  { zip: '32712', name: "Apopka",                     county: "Orange",             state: '12', countyFips: '095', lat: 28.712, lon: -81.5136 },
  { zip: '32751', name: "Maitland",                   county: "Orange",             state: '12', countyFips: '095', lat: 28.6255, lon: -81.3646 },
  { zip: '32768', name: "Plymouth",                   county: "Orange",             state: '12', countyFips: '095', lat: 28.6985, lon: -81.5698 },
  { zip: '32777', name: "Tangerine",                  county: "Orange",             state: '12', countyFips: '095', lat: 28.765, lon: -81.6306 },
  { zip: '32789', name: "Winter Park",                county: "Orange",             state: '12', countyFips: '095', lat: 28.5978, lon: -81.3534 },
  { zip: '32790', name: "Winter Park",                county: "Orange",             state: '12', countyFips: '095', lat: 28.5663, lon: -81.2608 },
  { zip: '32793', name: "Winter Park",                county: "Orange",             state: '12', countyFips: '095', lat: 28.5663, lon: -81.2608 },
  { zip: '32794', name: "Maitland",                   county: "Orange",             state: '12', countyFips: '095', lat: 28.6278, lon: -81.3631 },
  { zip: '32798', name: "Zellwood",                   county: "Orange",             state: '12', countyFips: '095', lat: 28.7194, lon: -81.5762 },
  { zip: '32801', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5399, lon: -81.3727 },
  { zip: '32802', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5383, lon: -81.3792 },
  { zip: '32803', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5559, lon: -81.3535 },
  { zip: '32804', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5754, lon: -81.3955 },
  { zip: '32805', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5302, lon: -81.4045 },
  { zip: '32806', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.514, lon: -81.357 },
  { zip: '32807', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5515, lon: -81.3051 },
  { zip: '32808', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5803, lon: -81.4396 },
  { zip: '32809', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.4637, lon: -81.3948 },
  { zip: '32810', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.6214, lon: -81.4294 },
  { zip: '32811', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5163, lon: -81.4516 },
  { zip: '32812', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.4998, lon: -81.3288 },
  { zip: '32814', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5702, lon: -81.3265 },
  { zip: '32816', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5663, lon: -81.2608 },
  { zip: '32817', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5891, lon: -81.2277 },
  { zip: '32818', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5801, lon: -81.4846 },
  { zip: '32819', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.4522, lon: -81.4678 },
  { zip: '32820', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5725, lon: -81.1219 },
  { zip: '32821', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.3957, lon: -81.4666 },
  { zip: '32822', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.4944, lon: -81.2902 },
  { zip: '32824', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.3932, lon: -81.3622 },
  { zip: '32825', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5469, lon: -81.2571 },
  { zip: '32826', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5826, lon: -81.1907 },
  { zip: '32827', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.4317, lon: -81.343 },
  { zip: '32828', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5523, lon: -81.1795 },
  { zip: '32829', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.4671, lon: -81.2417 },
  { zip: '32830', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.3822, lon: -81.569 },
  { zip: '32831', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.4656, lon: -81.151 },
  { zip: '32832', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.3774, lon: -81.1888 },
  { zip: '32833', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5088, lon: -81.0703 },
  { zip: '32834', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5663, lon: -81.2608 },
  { zip: '32835', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5289, lon: -81.4787 },
  { zip: '32836', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.4115, lon: -81.525 },
  { zip: '32837', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.3949, lon: -81.4179 },
  { zip: '32839', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.4871, lon: -81.4082 },
  { zip: '32853', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5663, lon: -81.2608 },
  { zip: '32854', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5663, lon: -81.2608 },
  { zip: '32855', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5383, lon: -81.3792 },
  { zip: '32856', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5484, lon: -81.4201 },
  { zip: '32857', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5663, lon: -81.2608 },
  { zip: '32858', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5663, lon: -81.2608 },
  { zip: '32859', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.4429, lon: -81.4026 },
  { zip: '32860', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5663, lon: -81.2608 },
  { zip: '32861', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5663, lon: -81.2608 },
  { zip: '32862', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5383, lon: -81.3792 },
  { zip: '32867', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5663, lon: -81.2608 },
  { zip: '32868', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5663, lon: -81.2608 },
  { zip: '32869', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5663, lon: -81.2608 },
  { zip: '32872', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5383, lon: -81.3792 },
  { zip: '32877', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5663, lon: -81.2608 },
  { zip: '32878', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5663, lon: -81.2608 },
  { zip: '32885', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5456, lon: -81.3782 },
  { zip: '32886', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5383, lon: -81.3792 },
  { zip: '32887', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5663, lon: -81.2608 },
  { zip: '32891', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5663, lon: -81.2608 },
  { zip: '32896', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5419, lon: -81.3791 },
  { zip: '32897', name: "Orlando",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5383, lon: -81.3792 },
  { zip: '34734', name: "Gotha",                      county: "Orange",             state: '12', countyFips: '095', lat: 28.5384, lon: -81.5208 },
  { zip: '34740', name: "Killarney",                  county: "Orange",             state: '12', countyFips: '095', lat: 28.5454, lon: -81.6507 },
  { zip: '34760', name: "Oakland",                    county: "Orange",             state: '12', countyFips: '095', lat: 28.5547, lon: -81.6322 },
  { zip: '34761', name: "Ocoee",                      county: "Orange",             state: '12', countyFips: '095', lat: 28.5837, lon: -81.5326 },
  { zip: '34777', name: "Winter Garden",              county: "Orange",             state: '12', countyFips: '095', lat: 28.5416, lon: -81.6058 },
  { zip: '34778', name: "Winter Garden",              county: "Orange",             state: '12', countyFips: '095', lat: 28.5653, lon: -81.5862 },
  { zip: '34786', name: "Windermere",                 county: "Orange",             state: '12', countyFips: '095', lat: 28.5006, lon: -81.5354 },
  { zip: '34787', name: "Winter Garden",              county: "Orange",             state: '12', countyFips: '095', lat: 28.5423, lon: -81.5911 },
  { zip: '33848', name: "Intercession City",          county: "Osceola",            state: '12', countyFips: '097', lat: 28.2774, lon: -81.5069 },
  { zip: '33896', name: "Davenport",                  county: "Osceola",            state: '12', countyFips: '097', lat: 28.2531, lon: -81.6509 },
  { zip: '34739', name: "Kenansville",                county: "Osceola",            state: '12', countyFips: '097', lat: 27.8767, lon: -81.05 },
  { zip: '34741', name: "Kissimmee",                  county: "Osceola",            state: '12', countyFips: '097', lat: 28.3051, lon: -81.4242 },
  { zip: '34742', name: "Kissimmee",                  county: "Osceola",            state: '12', countyFips: '097', lat: 28.3047, lon: -81.4167 },
  { zip: '34743', name: "Kissimmee",                  county: "Osceola",            state: '12', countyFips: '097', lat: 28.3306, lon: -81.3544 },
  { zip: '34744', name: "Kissimmee",                  county: "Osceola",            state: '12', countyFips: '097', lat: 28.3078, lon: -81.3681 },
  { zip: '34745', name: "Kissimmee",                  county: "Osceola",            state: '12', countyFips: '097', lat: 28.3047, lon: -81.4167 },
  { zip: '34746', name: "Kissimmee",                  county: "Osceola",            state: '12', countyFips: '097', lat: 28.268, lon: -81.4675 },
  { zip: '34747', name: "Kissimmee",                  county: "Osceola",            state: '12', countyFips: '097', lat: 28.3037, lon: -81.5898 },
  { zip: '34758', name: "Kissimmee",                  county: "Osceola",            state: '12', countyFips: '097', lat: 28.1984, lon: -81.487 },
  { zip: '34769', name: "Saint Cloud",                county: "Osceola",            state: '12', countyFips: '097', lat: 28.248, lon: -81.2876 },
  { zip: '34770', name: "Saint Cloud",                county: "Osceola",            state: '12', countyFips: '097', lat: 28.2489, lon: -81.2812 },
  { zip: '34771', name: "Saint Cloud",                county: "Osceola",            state: '12', countyFips: '097', lat: 28.273, lon: -81.2003 },
  { zip: '34772', name: "Saint Cloud",                county: "Osceola",            state: '12', countyFips: '097', lat: 28.1905, lon: -81.2645 },
  { zip: '34773', name: "Saint Cloud",                county: "Osceola",            state: '12', countyFips: '097', lat: 28.1293, lon: -81.0176 },
  { zip: '33401', name: "West Palm Beach",            county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.7165, lon: -80.0679 },
  { zip: '33402', name: "West Palm Beach",            county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.7153, lon: -80.0534 },
  { zip: '33403', name: "West Palm Beach",            county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.8035, lon: -80.0756 },
  { zip: '33404', name: "West Palm Beach",            county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.7832, lon: -80.0638 },
  { zip: '33405', name: "West Palm Beach",            county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.67, lon: -80.0582 },
  { zip: '33406', name: "West Palm Beach",            county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.6396, lon: -80.0827 },
  { zip: '33407', name: "West Palm Beach",            county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.7492, lon: -80.0725 },
  { zip: '33408', name: "North Palm Beach",           county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.8289, lon: -80.0603 },
  { zip: '33409', name: "West Palm Beach",            county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.7162, lon: -80.0965 },
  { zip: '33410', name: "Palm Beach Gardens",         county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.8234, lon: -80.1387 },
  { zip: '33411', name: "West Palm Beach",            county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.6644, lon: -80.1741 },
  { zip: '33412', name: "West Palm Beach",            county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.8055, lon: -80.2482 },
  { zip: '33413', name: "West Palm Beach",            county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.6555, lon: -80.1596 },
  { zip: '33414', name: "Wellington",                 county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.6587, lon: -80.2414 },
  { zip: '33415', name: "West Palm Beach",            county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.656, lon: -80.126 },
  { zip: '33416', name: "West Palm Beach",            county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.6654, lon: -80.0929 },
  { zip: '33417', name: "West Palm Beach",            county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.7197, lon: -80.1248 },
  { zip: '33418', name: "Palm Beach Gardens",         county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.8234, lon: -80.1387 },
  { zip: '33419', name: "West Palm Beach",            county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.7153, lon: -80.0534 },
  { zip: '33420', name: "West Palm Beach",            county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.7153, lon: -80.0534 },
  { zip: '33421', name: "Royal Palm Beach",           county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.7084, lon: -80.2306 },
  { zip: '33422', name: "West Palm Beach",            county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.7153, lon: -80.0534 },
  { zip: '33424', name: "Boynton Beach",              county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.5253, lon: -80.0664 },
  { zip: '33425', name: "Boynton Beach",              county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.5253, lon: -80.0664 },
  { zip: '33426', name: "Boynton Beach",              county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.5175, lon: -80.0834 },
  { zip: '33427', name: "Boca Raton",                 county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.376, lon: -80.1072 },
  { zip: '33428', name: "Boca Raton",                 county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.3446, lon: -80.2109 },
  { zip: '33429', name: "Boca Raton",                 county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.3587, lon: -80.0831 },
  { zip: '33430', name: "Belle Glade",                county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.6843, lon: -80.6724 },
  { zip: '33431', name: "Boca Raton",                 county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.3799, lon: -80.0975 },
  { zip: '33432', name: "Boca Raton",                 county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.3462, lon: -80.0844 },
  { zip: '33433', name: "Boca Raton",                 county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.3464, lon: -80.1564 },
  { zip: '33434', name: "Boca Raton",                 county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.3839, lon: -80.1749 },
  { zip: '33435', name: "Boynton Beach",              county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.5254, lon: -80.061 },
  { zip: '33436', name: "Boynton Beach",              county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.5354, lon: -80.1124 },
  { zip: '33437', name: "Boynton Beach",              county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.5312, lon: -80.1418 },
  { zip: '33444', name: "Delray Beach",               county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.4564, lon: -80.0793 },
  { zip: '33445', name: "Delray Beach",               county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.4564, lon: -80.1054 },
  { zip: '33446', name: "Delray Beach",               county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.4517, lon: -80.158 },
  { zip: '33448', name: "Delray Beach",               county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.4615, lon: -80.0728 },
  { zip: '33449', name: "Lake Worth",                 county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.6048, lon: -80.2149 },
  { zip: '33454', name: "Greenacres",                 county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.6237, lon: -80.1253 },
  { zip: '33458', name: "Jupiter",                    county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.9339, lon: -80.1201 },
  { zip: '33459', name: "Lake Harbor",                county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.6931, lon: -80.8145 },
  { zip: '33460', name: "Lake Worth",                 county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.6182, lon: -80.056 },
  { zip: '33461', name: "Lake Worth",                 county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.6232, lon: -80.0946 },
  { zip: '33462', name: "Lake Worth",                 county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.5747, lon: -80.0794 },
  { zip: '33463', name: "Lake Worth",                 county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.5955, lon: -80.1291 },
  { zip: '33464', name: "Boca Raton",                 county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.3587, lon: -80.0831 },
  { zip: '33465', name: "Lake Worth",                 county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.6283, lon: -80.1326 },
  { zip: '33466', name: "Lake Worth",                 county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.6171, lon: -80.0723 },
  { zip: '33467', name: "Lake Worth",                 county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.6104, lon: -80.1683 },
  { zip: '33468', name: "Jupiter",                    county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.9342, lon: -80.0942 },
  { zip: '33470', name: "Loxahatchee",                county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.7383, lon: -80.276 },
  { zip: '33472', name: "Boynton Beach",              county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.5384, lon: -80.1856 },
  { zip: '33473', name: "Boynton Beach",              county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.5088, lon: -80.1896 },
  { zip: '33474', name: "Boynton Beach",              county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.5253, lon: -80.0664 },
  { zip: '33476', name: "Pahokee",                    county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.8142, lon: -80.6629 },
  { zip: '33477', name: "Jupiter",                    county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.9217, lon: -80.077 },
  { zip: '33478', name: "Jupiter",                    county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.9212, lon: -80.2144 },
  { zip: '33480', name: "Palm Beach",                 county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.7206, lon: -80.0388 },
  { zip: '33481', name: "Boca Raton",                 county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.3587, lon: -80.0831 },
  { zip: '33482', name: "Delray Beach",               county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.4615, lon: -80.0728 },
  { zip: '33483', name: "Delray Beach",               county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.4546, lon: -80.0656 },
  { zip: '33484', name: "Delray Beach",               county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.4543, lon: -80.1346 },
  { zip: '33486', name: "Boca Raton",                 county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.3481, lon: -80.1104 },
  { zip: '33487', name: "Boca Raton",                 county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.4116, lon: -80.0928 },
  { zip: '33488', name: "Boca Raton",                 county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.3587, lon: -80.0831 },
  { zip: '33493', name: "South Bay",                  county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.6701, lon: -80.7312 },
  { zip: '33496', name: "Boca Raton",                 county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.403, lon: -80.1813 },
  { zip: '33497', name: "Boca Raton",                 county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.3587, lon: -80.0831 },
  { zip: '33498', name: "Boca Raton",                 county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.3907, lon: -80.2161 },
  { zip: '33499', name: "Boca Raton",                 county: "Palm Beach",         state: '12', countyFips: '099', lat: 26.3587, lon: -80.0831 },
  { zip: '33523', name: "Dade City",                  county: "Pasco",              state: '12', countyFips: '101', lat: 28.4247, lon: -82.2185 },
  { zip: '33524', name: "Crystal Springs",            county: "Pasco",              state: '12', countyFips: '101', lat: 28.1822, lon: -82.1523 },
  { zip: '33525', name: "Dade City",                  county: "Pasco",              state: '12', countyFips: '101', lat: 28.3318, lon: -82.2446 },
  { zip: '33526', name: "Dade City",                  county: "Pasco",              state: '12', countyFips: '101', lat: 28.3101, lon: -82.2478 },
  { zip: '33537', name: "Lacoochee",                  county: "Pasco",              state: '12', countyFips: '101', lat: 28.4658, lon: -82.172 },
  { zip: '33539', name: "Zephyrhills",                county: "Pasco",              state: '12', countyFips: '101', lat: 28.213, lon: -82.1657 },
  { zip: '33540', name: "Zephyrhills",                county: "Pasco",              state: '12', countyFips: '101', lat: 28.2151, lon: -82.1506 },
  { zip: '33541', name: "Zephyrhills",                county: "Pasco",              state: '12', countyFips: '101', lat: 28.2311, lon: -82.2057 },
  { zip: '33542', name: "Zephyrhills",                county: "Pasco",              state: '12', countyFips: '101', lat: 28.2303, lon: -82.1779 },
  { zip: '33543', name: "Wesley Chapel",              county: "Pasco",              state: '12', countyFips: '101', lat: 28.2397, lon: -82.3279 },
  { zip: '33544', name: "Wesley Chapel",              county: "Pasco",              state: '12', countyFips: '101', lat: 28.2397, lon: -82.3279 },
  { zip: '33545', name: "Wesley Chapel",              county: "Pasco",              state: '12', countyFips: '101', lat: 28.2697, lon: -82.2903 },
  { zip: '33574', name: "Saint Leo",                  county: "Pasco",              state: '12', countyFips: '101', lat: 28.3348, lon: -82.2693 },
  { zip: '33576', name: "San Antonio",                county: "Pasco",              state: '12', countyFips: '101', lat: 28.3371, lon: -82.2882 },
  { zip: '33593', name: "Trilby",                     county: "Pasco",              state: '12', countyFips: '101', lat: 28.4625, lon: -82.1948 },
  { zip: '34610', name: "Spring Hill",                county: "Pasco",              state: '12', countyFips: '101', lat: 28.4079, lon: -82.5398 },
  { zip: '34637', name: "Land O Lakes",               county: "Pasco",              state: '12', countyFips: '101', lat: 28.2782, lon: -82.4625 },
  { zip: '34638', name: "Land O Lakes",               county: "Pasco",              state: '12', countyFips: '101', lat: 28.2478, lon: -82.4962 },
  { zip: '34639', name: "Land O Lakes",               county: "Pasco",              state: '12', countyFips: '101', lat: 28.2258, lon: -82.4547 },
  { zip: '34652', name: "New Port Richey",            county: "Pasco",              state: '12', countyFips: '101', lat: 28.2326, lon: -82.7327 },
  { zip: '34653', name: "New Port Richey",            county: "Pasco",              state: '12', countyFips: '101', lat: 28.2444, lon: -82.6986 },
  { zip: '34654', name: "New Port Richey",            county: "Pasco",              state: '12', countyFips: '101', lat: 28.3022, lon: -82.6264 },
  { zip: '34655', name: "New Port Richey",            county: "Pasco",              state: '12', countyFips: '101', lat: 28.2129, lon: -82.6807 },
  { zip: '34656', name: "New Port Richey",            county: "Pasco",              state: '12', countyFips: '101', lat: 28.2442, lon: -82.7193 },
  { zip: '34667', name: "Hudson",                     county: "Pasco",              state: '12', countyFips: '101', lat: 28.3648, lon: -82.6757 },
  { zip: '34668', name: "Port Richey",                county: "Pasco",              state: '12', countyFips: '101', lat: 28.3011, lon: -82.6927 },
  { zip: '34669', name: "Hudson",                     county: "Pasco",              state: '12', countyFips: '101', lat: 28.3506, lon: -82.6288 },
  { zip: '34673', name: "Port Richey",                county: "Pasco",              state: '12', countyFips: '101', lat: 28.2717, lon: -82.7195 },
  { zip: '34674', name: "Hudson",                     county: "Pasco",              state: '12', countyFips: '101', lat: 28.3644, lon: -82.6934 },
  { zip: '34679', name: "Aripeka",                    county: "Pasco",              state: '12', countyFips: '101', lat: 28.4302, lon: -82.6616 },
  { zip: '34680', name: "Elfers",                     county: "Pasco",              state: '12', countyFips: '101', lat: 28.2167, lon: -82.7223 },
  { zip: '34690', name: "Holiday",                    county: "Pasco",              state: '12', countyFips: '101', lat: 28.1913, lon: -82.7279 },
  { zip: '34691', name: "Holiday",                    county: "Pasco",              state: '12', countyFips: '101', lat: 28.1913, lon: -82.756 },
  { zip: '34692', name: "Holiday",                    county: "Pasco",              state: '12', countyFips: '101', lat: 28.188, lon: -82.7346 },
  { zip: '33701', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.7723, lon: -82.6386 },
  { zip: '33702', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8427, lon: -82.6448 },
  { zip: '33703', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.817, lon: -82.6264 },
  { zip: '33704', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.7954, lon: -82.6373 },
  { zip: '33705', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.7391, lon: -82.6435 },
  { zip: '33706', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.7456, lon: -82.7516 },
  { zip: '33707', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.7549, lon: -82.7208 },
  { zip: '33708', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8116, lon: -82.8014 },
  { zip: '33709', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8201, lon: -82.7308 },
  { zip: '33710', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.7898, lon: -82.7243 },
  { zip: '33711', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.7465, lon: -82.6897 },
  { zip: '33712', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.7353, lon: -82.6663 },
  { zip: '33713', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.789, lon: -82.6779 },
  { zip: '33714', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8176, lon: -82.6776 },
  { zip: '33715', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.6705, lon: -82.7119 },
  { zip: '33716', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8738, lon: -82.64 },
  { zip: '33729', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8819, lon: -82.6644 },
  { zip: '33730', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.7709, lon: -82.6793 },
  { zip: '33731', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8918, lon: -82.7248 },
  { zip: '33732', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8918, lon: -82.7248 },
  { zip: '33733', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.7709, lon: -82.6793 },
  { zip: '33734', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8918, lon: -82.7248 },
  { zip: '33736', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8918, lon: -82.7248 },
  { zip: '33737', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8918, lon: -82.7248 },
  { zip: '33738', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8918, lon: -82.7248 },
  { zip: '33740', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8918, lon: -82.7248 },
  { zip: '33741', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8918, lon: -82.7248 },
  { zip: '33742', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8918, lon: -82.7248 },
  { zip: '33743', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8918, lon: -82.7248 },
  { zip: '33744', name: "Bay Pines",                  county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8142, lon: -82.7782 },
  { zip: '33747', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8918, lon: -82.7248 },
  { zip: '33755', name: "Clearwater",                 county: "Pinellas",           state: '12', countyFips: '103', lat: 27.9781, lon: -82.7815 },
  { zip: '33756', name: "Clearwater",                 county: "Pinellas",           state: '12', countyFips: '103', lat: 27.947, lon: -82.7943 },
  { zip: '33757', name: "Clearwater",                 county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8918, lon: -82.7248 },
  { zip: '33758', name: "Clearwater",                 county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8918, lon: -82.7248 },
  { zip: '33759', name: "Clearwater",                 county: "Pinellas",           state: '12', countyFips: '103', lat: 27.975, lon: -82.7019 },
  { zip: '33760', name: "Clearwater",                 county: "Pinellas",           state: '12', countyFips: '103', lat: 27.9004, lon: -82.7152 },
  { zip: '33761', name: "Clearwater",                 county: "Pinellas",           state: '12', countyFips: '103', lat: 28.031, lon: -82.7239 },
  { zip: '33762', name: "Clearwater",                 county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8942, lon: -82.6746 },
  { zip: '33763', name: "Clearwater",                 county: "Pinellas",           state: '12', countyFips: '103', lat: 28.0173, lon: -82.7461 },
  { zip: '33764', name: "Clearwater",                 county: "Pinellas",           state: '12', countyFips: '103', lat: 27.916, lon: -82.7343 },
  { zip: '33765', name: "Clearwater",                 county: "Pinellas",           state: '12', countyFips: '103', lat: 27.9902, lon: -82.7433 },
  { zip: '33766', name: "Clearwater",                 county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8918, lon: -82.7248 },
  { zip: '33767', name: "Clearwater Beach",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.9598, lon: -82.8286 },
  { zip: '33769', name: "Clearwater",                 county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8918, lon: -82.7248 },
  { zip: '33770', name: "Largo",                      county: "Pinellas",           state: '12', countyFips: '103', lat: 27.917, lon: -82.8027 },
  { zip: '33771', name: "Largo",                      county: "Pinellas",           state: '12', countyFips: '103', lat: 27.9085, lon: -82.7568 },
  { zip: '33772', name: "Seminole",                   county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8466, lon: -82.7954 },
  { zip: '33773', name: "Largo",                      county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8802, lon: -82.7534 },
  { zip: '33774', name: "Largo",                      county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8839, lon: -82.8265 },
  { zip: '33775', name: "Seminole",                   county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8397, lon: -82.7912 },
  { zip: '33776', name: "Seminole",                   county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8505, lon: -82.8263 },
  { zip: '33777', name: "Seminole",                   county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8688, lon: -82.7344 },
  { zip: '33778', name: "Largo",                      county: "Pinellas",           state: '12', countyFips: '103', lat: 27.884, lon: -82.8025 },
  { zip: '33779', name: "Largo",                      county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8397, lon: -82.7725 },
  { zip: '33780', name: "Pinellas Park",              county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8918, lon: -82.7248 },
  { zip: '33781', name: "Pinellas Park",              county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8387, lon: -82.7151 },
  { zip: '33782', name: "Pinellas Park",              county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8681, lon: -82.7086 },
  { zip: '33784', name: "Saint Petersburg",           county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8918, lon: -82.7248 },
  { zip: '33785', name: "Indian Rocks Beach",         county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8868, lon: -82.8435 },
  { zip: '33786', name: "Belleair Beach",             county: "Pinellas",           state: '12', countyFips: '103', lat: 27.9229, lon: -82.8393 },
  { zip: '34660', name: "Ozona",                      county: "Pinellas",           state: '12', countyFips: '103', lat: 28.067, lon: -82.7784 },
  { zip: '34677', name: "Oldsmar",                    county: "Pinellas",           state: '12', countyFips: '103', lat: 28.046, lon: -82.6848 },
  { zip: '34681', name: "Crystal Beach",              county: "Pinellas",           state: '12', countyFips: '103', lat: 28.0914, lon: -82.7798 },
  { zip: '34682', name: "Palm Harbor",                county: "Pinellas",           state: '12', countyFips: '103', lat: 28.0781, lon: -82.7637 },
  { zip: '34683', name: "Palm Harbor",                county: "Pinellas",           state: '12', countyFips: '103', lat: 28.0662, lon: -82.7585 },
  { zip: '34684', name: "Palm Harbor",                county: "Pinellas",           state: '12', countyFips: '103', lat: 28.0848, lon: -82.7253 },
  { zip: '34685', name: "Palm Harbor",                county: "Pinellas",           state: '12', countyFips: '103', lat: 28.0967, lon: -82.6964 },
  { zip: '34688', name: "Tarpon Springs",             county: "Pinellas",           state: '12', countyFips: '103', lat: 28.1458, lon: -82.6825 },
  { zip: '34689', name: "Tarpon Springs",             county: "Pinellas",           state: '12', countyFips: '103', lat: 28.1385, lon: -82.743 },
  { zip: '34695', name: "Safety Harbor",              county: "Pinellas",           state: '12', countyFips: '103', lat: 28.0096, lon: -82.6967 },
  { zip: '34697', name: "Dunedin",                    county: "Pinellas",           state: '12', countyFips: '103', lat: 27.8918, lon: -82.7248 },
  { zip: '34698', name: "Dunedin",                    county: "Pinellas",           state: '12', countyFips: '103', lat: 28.0284, lon: -82.7794 },
  { zip: '33801', name: "Lakeland",                   county: "Polk",               state: '12', countyFips: '105', lat: 28.0381, lon: -81.9392 },
  { zip: '33802', name: "Lakeland",                   county: "Polk",               state: '12', countyFips: '105', lat: 28.021, lon: -81.9852 },
  { zip: '33803', name: "Lakeland",                   county: "Polk",               state: '12', countyFips: '105', lat: 28.014, lon: -81.9523 },
  { zip: '33804', name: "Lakeland",                   county: "Polk",               state: '12', countyFips: '105', lat: 28.0395, lon: -81.9498 },
  { zip: '33805', name: "Lakeland",                   county: "Polk",               state: '12', countyFips: '105', lat: 28.072, lon: -81.9609 },
  { zip: '33806', name: "Lakeland",                   county: "Polk",               state: '12', countyFips: '105', lat: 28.0395, lon: -81.9498 },
  { zip: '33807', name: "Lakeland",                   county: "Polk",               state: '12', countyFips: '105', lat: 28.0395, lon: -81.9498 },
  { zip: '33809', name: "Lakeland",                   county: "Polk",               state: '12', countyFips: '105', lat: 28.1762, lon: -81.9591 },
  { zip: '33810', name: "Lakeland",                   county: "Polk",               state: '12', countyFips: '105', lat: 28.1479, lon: -82.0372 },
  { zip: '33811', name: "Lakeland",                   county: "Polk",               state: '12', countyFips: '105', lat: 27.9865, lon: -82.0139 },
  { zip: '33812', name: "Lakeland",                   county: "Polk",               state: '12', countyFips: '105', lat: 27.9729, lon: -81.8931 },
  { zip: '33813', name: "Lakeland",                   county: "Polk",               state: '12', countyFips: '105', lat: 27.9611, lon: -81.9398 },
  { zip: '33815', name: "Lakeland",                   county: "Polk",               state: '12', countyFips: '105', lat: 28.0496, lon: -82.0069 },
  { zip: '33820', name: "Alturas",                    county: "Polk",               state: '12', countyFips: '105', lat: 28.0026, lon: -81.6186 },
  { zip: '33823', name: "Auburndale",                 county: "Polk",               state: '12', countyFips: '105', lat: 28.0724, lon: -81.8122 },
  { zip: '33827', name: "Babson Park",                county: "Polk",               state: '12', countyFips: '105', lat: 27.8163, lon: -81.5139 },
  { zip: '33830', name: "Bartow",                     county: "Polk",               state: '12', countyFips: '105', lat: 27.8957, lon: -81.8127 },
  { zip: '33831', name: "Bartow",                     county: "Polk",               state: '12', countyFips: '105', lat: 27.8964, lon: -81.8431 },
  { zip: '33835', name: "Bradley",                    county: "Polk",               state: '12', countyFips: '105', lat: 27.6993, lon: -81.9494 },
  { zip: '33836', name: "Davenport",                  county: "Polk",               state: '12', countyFips: '105', lat: 28.1672, lon: -81.6316 },
  { zip: '33837', name: "Davenport",                  county: "Polk",               state: '12', countyFips: '105', lat: 28.1963, lon: -81.6079 },
  { zip: '33838', name: "Dundee",                     county: "Polk",               state: '12', countyFips: '105', lat: 28.0194, lon: -81.6212 },
  { zip: '33839', name: "Eagle Lake",                 county: "Polk",               state: '12', countyFips: '105', lat: 27.9787, lon: -81.7564 },
  { zip: '33840', name: "Eaton Park",                 county: "Polk",               state: '12', countyFips: '105', lat: 28.0086, lon: -81.9076 },
  { zip: '33841', name: "Fort Meade",                 county: "Polk",               state: '12', countyFips: '105', lat: 27.7464, lon: -81.7823 },
  { zip: '33843', name: "Frostproof",                 county: "Polk",               state: '12', countyFips: '105', lat: 27.7211, lon: -81.5148 },
  { zip: '33844', name: "Haines City",                county: "Polk",               state: '12', countyFips: '105', lat: 28.1145, lon: -81.6201 },
  { zip: '33845', name: "Haines City",                county: "Polk",               state: '12', countyFips: '105', lat: 28.0026, lon: -81.6186 },
  { zip: '33846', name: "Highland City",              county: "Polk",               state: '12', countyFips: '105', lat: 27.9647, lon: -81.8672 },
  { zip: '33847', name: "Homeland",                   county: "Polk",               state: '12', countyFips: '105', lat: 27.8178, lon: -81.8245 },
  { zip: '33849', name: "Kathleen",                   county: "Polk",               state: '12', countyFips: '105', lat: 28.1975, lon: -82.0396 },
  { zip: '33850', name: "Lake Alfred",                county: "Polk",               state: '12', countyFips: '105', lat: 28.0895, lon: -81.7271 },
  { zip: '33851', name: "Lake Hamilton",              county: "Polk",               state: '12', countyFips: '105', lat: 28.0369, lon: -81.628 },
  { zip: '33853', name: "Lake Wales",                 county: "Polk",               state: '12', countyFips: '105', lat: 27.9002, lon: -81.5847 },
  { zip: '33854', name: "Lakeshore",                  county: "Polk",               state: '12', countyFips: '105', lat: 27.966, lon: -81.6965 },
  { zip: '33855', name: "Indian Lake Estates",        county: "Polk",               state: '12', countyFips: '105', lat: 27.798, lon: -81.3572 },
  { zip: '33856', name: "Nalcrest",                   county: "Polk",               state: '12', countyFips: '105', lat: 27.8557, lon: -81.4309 },
  { zip: '33858', name: "Loughman",                   county: "Polk",               state: '12', countyFips: '105', lat: 28.242, lon: -81.5667 },
  { zip: '33859', name: "Lake Wales",                 county: "Polk",               state: '12', countyFips: '105', lat: 27.8774, lon: -81.6221 },
  { zip: '33860', name: "Mulberry",                   county: "Polk",               state: '12', countyFips: '105', lat: 27.902, lon: -82.0015 },
  { zip: '33863', name: "Nichols",                    county: "Polk",               state: '12', countyFips: '105', lat: 27.8903, lon: -82.0315 },
  { zip: '33867', name: "River Ranch",                county: "Polk",               state: '12', countyFips: '105', lat: 27.7686, lon: -81.1966 },
  { zip: '33868', name: "Polk City",                  county: "Polk",               state: '12', countyFips: '105', lat: 28.1987, lon: -81.8083 },
  { zip: '33877', name: "Waverly",                    county: "Polk",               state: '12', countyFips: '105', lat: 27.9769, lon: -81.6144 },
  { zip: '33880', name: "Winter Haven",               county: "Polk",               state: '12', countyFips: '105', lat: 27.9873, lon: -81.7625 },
  { zip: '33881', name: "Winter Haven",               county: "Polk",               state: '12', countyFips: '105', lat: 28.0452, lon: -81.7325 },
  { zip: '33882', name: "Winter Haven",               county: "Polk",               state: '12', countyFips: '105', lat: 28.0294, lon: -81.7321 },
  { zip: '33883', name: "Winter Haven",               county: "Polk",               state: '12', countyFips: '105', lat: 28.0222, lon: -81.7329 },
  { zip: '33884', name: "Winter Haven",               county: "Polk",               state: '12', countyFips: '105', lat: 27.981, lon: -81.6736 },
  { zip: '33885', name: "Winter Haven",               county: "Polk",               state: '12', countyFips: '105', lat: 28.0026, lon: -81.6186 },
  { zip: '33888', name: "Winter Haven",               county: "Polk",               state: '12', countyFips: '105', lat: 28.0231, lon: -81.7234 },
  { zip: '33897', name: "Davenport",                  county: "Polk",               state: '12', countyFips: '105', lat: 28.3112, lon: -81.6643 },
  { zip: '33898', name: "Lake Wales",                 county: "Polk",               state: '12', countyFips: '105', lat: 27.8643, lon: -81.5719 },
  { zip: '34759', name: "Kissimmee",                  county: "Polk",               state: '12', countyFips: '105', lat: 28.0946, lon: -81.499 },
  { zip: '32007', name: "Bostwick",                   county: "Putnam",             state: '12', countyFips: '107', lat: 29.7996, lon: -81.6273 },
  { zip: '32112', name: "Crescent City",              county: "Putnam",             state: '12', countyFips: '107', lat: 29.4272, lon: -81.5579 },
  { zip: '32131', name: "East Palatka",               county: "Putnam",             state: '12', countyFips: '107', lat: 29.6609, lon: -81.5879 },
  { zip: '32138', name: "Grandin",                    county: "Putnam",             state: '12', countyFips: '107', lat: 29.7277, lon: -81.9184 },
  { zip: '32139', name: "Georgetown",                 county: "Putnam",             state: '12', countyFips: '107', lat: 29.3842, lon: -81.6183 },
  { zip: '32140', name: "Florahome",                  county: "Putnam",             state: '12', countyFips: '107', lat: 29.7581, lon: -81.8622 },
  { zip: '32147', name: "Hollister",                  county: "Putnam",             state: '12', countyFips: '107', lat: 29.6227, lon: -81.8137 },
  { zip: '32148', name: "Interlachen",                county: "Putnam",             state: '12', countyFips: '107', lat: 29.627, lon: -81.8894 },
  { zip: '32149', name: "Interlachen",                county: "Putnam",             state: '12', countyFips: '107', lat: 29.6242, lon: -81.8926 },
  { zip: '32157', name: "Lake Como",                  county: "Putnam",             state: '12', countyFips: '107', lat: 29.4839, lon: -81.5729 },
  { zip: '32177', name: "Palatka",                    county: "Putnam",             state: '12', countyFips: '107', lat: 29.6577, lon: -81.6595 },
  { zip: '32178', name: "Palatka",                    county: "Putnam",             state: '12', countyFips: '107', lat: 29.6486, lon: -81.6376 },
  { zip: '32181', name: "Pomona Park",                county: "Putnam",             state: '12', countyFips: '107', lat: 29.5002, lon: -81.5915 },
  { zip: '32185', name: "Putnam Hall",                county: "Putnam",             state: '12', countyFips: '107', lat: 29.7368, lon: -81.958 },
  { zip: '32187', name: "San Mateo",                  county: "Putnam",             state: '12', countyFips: '107', lat: 29.5888, lon: -81.5921 },
  { zip: '32189', name: "Satsuma",                    county: "Putnam",             state: '12', countyFips: '107', lat: 29.5594, lon: -81.6406 },
  { zip: '32193', name: "Welaka",                     county: "Putnam",             state: '12', countyFips: '107', lat: 29.4905, lon: -81.653 },
  { zip: '32666', name: "Melrose",                    county: "Putnam",             state: '12', countyFips: '107', lat: 29.7325, lon: -82.0279 },
  { zip: '33112', name: "Miami",                      county: "Putnam",             state: '12', countyFips: '107', lat: 25.7964, lon: -80.3849 },
  { zip: '32004', name: "Ponte Vedra Beach",          county: "St. Johns",          state: '12', countyFips: '109', lat: 30.2397, lon: -81.3856 },
  { zip: '32085', name: "Saint Augustine",            county: "St. Johns",          state: '12', countyFips: '109', lat: 29.9377, lon: -81.4206 },
  { zip: '32260', name: "Jacksonville",               county: "St. Johns",          state: '12', countyFips: '109', lat: 29.9377, lon: -81.4206 },
  { zip: '32530', name: "Bagdad",                     county: "Santa Rosa",         state: '12', countyFips: '113', lat: 30.5986, lon: -87.0315 },
  { zip: '32562', name: "Gulf Breeze",                county: "Santa Rosa",         state: '12', countyFips: '113', lat: 30.3571, lon: -87.1639 },
  { zip: '32563', name: "Gulf Breeze",                county: "Santa Rosa",         state: '12', countyFips: '113', lat: 30.3962, lon: -87.0274 },
  { zip: '32564', name: "Holt",                       county: "Santa Rosa",         state: '12', countyFips: '113', lat: 30.7416, lon: -86.7198 },
  { zip: '32565', name: "Jay",                        county: "Santa Rosa",         state: '12', countyFips: '113', lat: 30.8985, lon: -87.1332 },
  { zip: '32566', name: "Navarre",                    county: "Santa Rosa",         state: '12', countyFips: '113', lat: 30.4212, lon: -86.8926 },
  { zip: '32570', name: "Milton",                     county: "Santa Rosa",         state: '12', countyFips: '113', lat: 30.6604, lon: -87.0473 },
  { zip: '32571', name: "Milton",                     county: "Santa Rosa",         state: '12', countyFips: '113', lat: 30.6698, lon: -87.1794 },
  { zip: '32572', name: "Milton",                     county: "Santa Rosa",         state: '12', countyFips: '113', lat: 30.6592, lon: -87.0497 },
  { zip: '32583', name: "Milton",                     county: "Santa Rosa",         state: '12', countyFips: '113', lat: 30.5761, lon: -87.0663 },
  { zip: '34223', name: "Englewood",                  county: "Sarasota",           state: '12', countyFips: '115', lat: 26.9667, lon: -82.3599 },
  { zip: '34228', name: "Longboat Key",               county: "Sarasota",           state: '12', countyFips: '115', lat: 27.4125, lon: -82.659 },
  { zip: '34229', name: "Osprey",                     county: "Sarasota",           state: '12', countyFips: '115', lat: 27.1838, lon: -82.4853 },
  { zip: '34230', name: "Sarasota",                   county: "Sarasota",           state: '12', countyFips: '115', lat: 27.335, lon: -82.5372 },
  { zip: '34231', name: "Sarasota",                   county: "Sarasota",           state: '12', countyFips: '115', lat: 27.2666, lon: -82.5163 },
  { zip: '34232', name: "Sarasota",                   county: "Sarasota",           state: '12', countyFips: '115', lat: 27.3262, lon: -82.4724 },
  { zip: '34233', name: "Sarasota",                   county: "Sarasota",           state: '12', countyFips: '115', lat: 27.2866, lon: -82.477 },
  { zip: '34234', name: "Sarasota",                   county: "Sarasota",           state: '12', countyFips: '115', lat: 27.3688, lon: -82.5268 },
  { zip: '34235', name: "Sarasota",                   county: "Sarasota",           state: '12', countyFips: '115', lat: 27.3672, lon: -82.4848 },
  { zip: '34236', name: "Sarasota",                   county: "Sarasota",           state: '12', countyFips: '115', lat: 27.3269, lon: -82.5433 },
  { zip: '34237', name: "Sarasota",                   county: "Sarasota",           state: '12', countyFips: '115', lat: 27.3369, lon: -82.5128 },
  { zip: '34238', name: "Sarasota",                   county: "Sarasota",           state: '12', countyFips: '115', lat: 27.2427, lon: -82.4751 },
  { zip: '34239', name: "Sarasota",                   county: "Sarasota",           state: '12', countyFips: '115', lat: 27.3111, lon: -82.5195 },
  { zip: '34240', name: "Sarasota",                   county: "Sarasota",           state: '12', countyFips: '115', lat: 27.339, lon: -82.3473 },
  { zip: '34241', name: "Sarasota",                   county: "Sarasota",           state: '12', countyFips: '115', lat: 27.2822, lon: -82.4181 },
  { zip: '34242', name: "Sarasota",                   county: "Sarasota",           state: '12', countyFips: '115', lat: 27.2566, lon: -82.5398 },
  { zip: '34249', name: "Sarasota",                   county: "Sarasota",           state: '12', countyFips: '115', lat: 27.2664, lon: -82.4841 },
  { zip: '34272', name: "Laurel",                     county: "Sarasota",           state: '12', countyFips: '115', lat: 27.147, lon: -82.4255 },
  { zip: '34274', name: "Nokomis",                    county: "Sarasota",           state: '12', countyFips: '115', lat: 27.144, lon: -82.4645 },
  { zip: '34275', name: "Nokomis",                    county: "Sarasota",           state: '12', countyFips: '115', lat: 27.1384, lon: -82.4518 },
  { zip: '34276', name: "Sarasota",                   county: "Sarasota",           state: '12', countyFips: '115', lat: 27.3364, lon: -82.5307 },
  { zip: '34277', name: "Sarasota",                   county: "Sarasota",           state: '12', countyFips: '115', lat: 27.3364, lon: -82.5307 },
  { zip: '34278', name: "Sarasota",                   county: "Sarasota",           state: '12', countyFips: '115', lat: 27.3316, lon: -82.5285 },
  { zip: '34284', name: "Venice",                     county: "Sarasota",           state: '12', countyFips: '115', lat: 27.1675, lon: -82.381 },
  { zip: '34285', name: "Venice",                     county: "Sarasota",           state: '12', countyFips: '115', lat: 27.0933, lon: -82.4498 },
  { zip: '34286', name: "North Port",                 county: "Sarasota",           state: '12', countyFips: '115', lat: 27.0748, lon: -82.1756 },
  { zip: '34287', name: "North Port",                 county: "Sarasota",           state: '12', countyFips: '115', lat: 27.0478, lon: -82.2416 },
  { zip: '34288', name: "North Port",                 county: "Sarasota",           state: '12', countyFips: '115', lat: 27.0498, lon: -82.1288 },
  { zip: '34289', name: "North Port",                 county: "Sarasota",           state: '12', countyFips: '115', lat: 27.0808, lon: -82.1516 },
  { zip: '34290', name: "North Port",                 county: "Sarasota",           state: '12', countyFips: '115', lat: 27.0459, lon: -82.2491 },
  { zip: '34291', name: "North Port",                 county: "Sarasota",           state: '12', countyFips: '115', lat: 27.0997, lon: -82.2095 },
  { zip: '34292', name: "Venice",                     county: "Sarasota",           state: '12', countyFips: '115', lat: 27.09, lon: -82.37 },
  { zip: '34293', name: "Venice",                     county: "Sarasota",           state: '12', countyFips: '115', lat: 27.0606, lon: -82.352 },
  { zip: '34295', name: "Englewood",                  county: "Sarasota",           state: '12', countyFips: '115', lat: 27.086, lon: -82.4389 },
  { zip: '32701', name: "Altamonte Springs",          county: "Seminole",           state: '12', countyFips: '117', lat: 28.6666, lon: -81.365 },
  { zip: '32707', name: "Casselberry",                county: "Seminole",           state: '12', countyFips: '117', lat: 28.6617, lon: -81.3122 },
  { zip: '32708', name: "Winter Springs",             county: "Seminole",           state: '12', countyFips: '117', lat: 28.6831, lon: -81.2814 },
  { zip: '32714', name: "Altamonte Springs",          county: "Seminole",           state: '12', countyFips: '117', lat: 28.6625, lon: -81.4117 },
  { zip: '32715', name: "Altamonte Springs",          county: "Seminole",           state: '12', countyFips: '117', lat: 28.6611, lon: -81.3656 },
  { zip: '32716', name: "Altamonte Springs",          county: "Seminole",           state: '12', countyFips: '117', lat: 28.7448, lon: -81.2233 },
  { zip: '32718', name: "Casselberry",                county: "Seminole",           state: '12', countyFips: '117', lat: 28.7448, lon: -81.2233 },
  { zip: '32719', name: "Winter Springs",             county: "Seminole",           state: '12', countyFips: '117', lat: 28.7448, lon: -81.2233 },
  { zip: '32730', name: "Casselberry",                county: "Seminole",           state: '12', countyFips: '117', lat: 28.6513, lon: -81.3418 },
  { zip: '32732', name: "Geneva",                     county: "Seminole",           state: '12', countyFips: '117', lat: 28.7503, lon: -81.1114 },
  { zip: '32733', name: "Goldenrod",                  county: "Seminole",           state: '12', countyFips: '117', lat: 28.6133, lon: -81.2581 },
  { zip: '32746', name: "Lake Mary",                  county: "Seminole",           state: '12', countyFips: '117', lat: 28.7577, lon: -81.3508 },
  { zip: '32747', name: "Lake Monroe",                county: "Seminole",           state: '12', countyFips: '117', lat: 28.8272, lon: -81.3329 },
  { zip: '32750', name: "Longwood",                   county: "Seminole",           state: '12', countyFips: '117', lat: 28.712, lon: -81.3552 },
  { zip: '32752', name: "Longwood",                   county: "Seminole",           state: '12', countyFips: '117', lat: 28.7448, lon: -81.2233 },
  { zip: '32762', name: "Oviedo",                     county: "Seminole",           state: '12', countyFips: '117', lat: 28.7448, lon: -81.2233 },
  { zip: '32765', name: "Oviedo",                     county: "Seminole",           state: '12', countyFips: '117', lat: 28.6513, lon: -81.2066 },
  { zip: '32766', name: "Oviedo",                     county: "Seminole",           state: '12', countyFips: '117', lat: 28.6607, lon: -81.1134 },
  { zip: '32771', name: "Sanford",                    county: "Seminole",           state: '12', countyFips: '117', lat: 28.8013, lon: -81.285 },
  { zip: '32772', name: "Sanford",                    county: "Seminole",           state: '12', countyFips: '117', lat: 28.8072, lon: -81.2502 },
  { zip: '32773', name: "Sanford",                    county: "Seminole",           state: '12', countyFips: '117', lat: 28.7644, lon: -81.282 },
  { zip: '32779', name: "Longwood",                   county: "Seminole",           state: '12', countyFips: '117', lat: 28.7168, lon: -81.4126 },
  { zip: '32791', name: "Longwood",                   county: "Seminole",           state: '12', countyFips: '117', lat: 28.7448, lon: -81.2233 },
  { zip: '32792', name: "Winter Park",                county: "Seminole",           state: '12', countyFips: '117', lat: 28.5974, lon: -81.3036 },
  { zip: '32795', name: "Lake Mary",                  county: "Seminole",           state: '12', countyFips: '117', lat: 28.7448, lon: -81.2233 },
  { zip: '32799', name: "Mid Florida",                county: "Seminole",           state: '12', countyFips: '117', lat: 28.7448, lon: -81.2233 },
  { zip: '32033', name: "Elkton",                     county: "St. Johns",          state: '12', countyFips: '109', lat: 29.7882, lon: -81.462 },
  { zip: '32080', name: "Saint Augustine",            county: "St. Johns",          state: '12', countyFips: '109', lat: 29.7964, lon: -81.2649 },
  { zip: '32081', name: "Ponte Vedra",                county: "St. Johns",          state: '12', countyFips: '109', lat: 30.1204, lon: -81.4128 },
  { zip: '32082', name: "Ponte Vedra Beach",          county: "St. Johns",          state: '12', countyFips: '109', lat: 30.1223, lon: -81.3627 },
  { zip: '32084', name: "Saint Augustine",            county: "St. Johns",          state: '12', countyFips: '109', lat: 29.9175, lon: -81.3668 },
  { zip: '32086', name: "Saint Augustine",            county: "St. Johns",          state: '12', countyFips: '109', lat: 29.8285, lon: -81.3237 },
  { zip: '32092', name: "Saint Augustine",            county: "St. Johns",          state: '12', countyFips: '109', lat: 29.9475, lon: -81.5264 },
  { zip: '32095', name: "Saint Augustine",            county: "St. Johns",          state: '12', countyFips: '109', lat: 30.011, lon: -81.4108 },
  { zip: '32145', name: "Hastings",                   county: "St. Johns",          state: '12', countyFips: '109', lat: 29.7051, lon: -81.4909 },
  { zip: '32259', name: "Saint Johns",                county: "St. Johns",          state: '12', countyFips: '109', lat: 30.0815, lon: -81.5477 },
  { zip: '34945', name: "Fort Pierce",                county: "St. Lucie",          state: '12', countyFips: '111', lat: 27.4382, lon: -80.444 },
  { zip: '34946', name: "Fort Pierce",                county: "St. Lucie",          state: '12', countyFips: '111', lat: 27.5008, lon: -80.36 },
  { zip: '34947', name: "Fort Pierce",                county: "St. Lucie",          state: '12', countyFips: '111', lat: 27.4493, lon: -80.3592 },
  { zip: '34948', name: "Fort Pierce",                county: "St. Lucie",          state: '12', countyFips: '111', lat: 27.3822, lon: -80.409 },
  { zip: '34949', name: "Fort Pierce",                county: "St. Lucie",          state: '12', countyFips: '111', lat: 27.3896, lon: -80.2615 },
  { zip: '34950', name: "Fort Pierce",                county: "St. Lucie",          state: '12', countyFips: '111', lat: 27.4486, lon: -80.3385 },
  { zip: '34951', name: "Fort Pierce",                county: "St. Lucie",          state: '12', countyFips: '111', lat: 27.5391, lon: -80.4052 },
  { zip: '34952', name: "Port Saint Lucie",           county: "St. Lucie",          state: '12', countyFips: '111', lat: 27.2889, lon: -80.298 },
  { zip: '34953', name: "Port Saint Lucie",           county: "St. Lucie",          state: '12', countyFips: '111', lat: 27.2625, lon: -80.3793 },
  { zip: '34954', name: "Fort Pierce",                county: "St. Lucie",          state: '12', countyFips: '111', lat: 27.3822, lon: -80.409 },
  { zip: '34979', name: "Fort Pierce",                county: "St. Lucie",          state: '12', countyFips: '111', lat: 27.3822, lon: -80.409 },
  { zip: '34981', name: "Fort Pierce",                county: "St. Lucie",          state: '12', countyFips: '111', lat: 27.4049, lon: -80.3623 },
  { zip: '34982', name: "Fort Pierce",                county: "St. Lucie",          state: '12', countyFips: '111', lat: 27.3908, lon: -80.3246 },
  { zip: '34983', name: "Port Saint Lucie",           county: "St. Lucie",          state: '12', countyFips: '111', lat: 27.3094, lon: -80.345 },
  { zip: '34984', name: "Port Saint Lucie",           county: "St. Lucie",          state: '12', countyFips: '111', lat: 27.2655, lon: -80.3389 },
  { zip: '34985', name: "Port Saint Lucie",           county: "St. Lucie",          state: '12', countyFips: '111', lat: 27.2939, lon: -80.3503 },
  { zip: '34986', name: "Port Saint Lucie",           county: "St. Lucie",          state: '12', countyFips: '111', lat: 27.3215, lon: -80.403 },
  { zip: '34987', name: "Port Saint Lucie",           county: "St. Lucie",          state: '12', countyFips: '111', lat: 27.2606, lon: -80.4771 },
  { zip: '34988', name: "Port Saint Lucie",           county: "St. Lucie",          state: '12', countyFips: '111', lat: 27.3868, lon: -80.5037 },
  { zip: '32162', name: "The Villages",               county: "Sumter",             state: '12', countyFips: '119', lat: 28.9341, lon: -81.9599 },
  { zip: '32163', name: "The Villages",               county: "Sumter",             state: '12', countyFips: '119', lat: 28.9338, lon: -81.9914 },
  { zip: '33513', name: "Bushnell",                   county: "Sumter",             state: '12', countyFips: '119', lat: 28.6611, lon: -82.1553 },
  { zip: '33514', name: "Center Hill",                county: "Sumter",             state: '12', countyFips: '119', lat: 28.6635, lon: -81.9963 },
  { zip: '33521', name: "Coleman",                    county: "Sumter",             state: '12', countyFips: '119', lat: 28.7997, lon: -82.0701 },
  { zip: '33538', name: "Lake Panasoffkee",           county: "Sumter",             state: '12', countyFips: '119', lat: 28.7953, lon: -82.1363 },
  { zip: '33585', name: "Sumterville",                county: "Sumter",             state: '12', countyFips: '119', lat: 28.7356, lon: -82.0616 },
  { zip: '33597', name: "Webster",                    county: "Sumter",             state: '12', countyFips: '119', lat: 28.549, lon: -82.0805 },
  { zip: '34484', name: "Oxford",                     county: "Sumter",             state: '12', countyFips: '119', lat: 28.9059, lon: -82.0612 },
  { zip: '34785', name: "Wildwood",                   county: "Sumter",             state: '12', countyFips: '119', lat: 28.8454, lon: -82.0347 },
  { zip: '32060', name: "Live Oak",                   county: "Suwannee",           state: '12', countyFips: '121', lat: 30.1759, lon: -83.0304 },
  { zip: '32062', name: "Mc Alpin",                   county: "Suwannee",           state: '12', countyFips: '121', lat: 30.1509, lon: -82.9662 },
  { zip: '32064', name: "Live Oak",                   county: "Suwannee",           state: '12', countyFips: '121', lat: 30.2956, lon: -82.9844 },
  { zip: '32071', name: "O Brien",                    county: "Suwannee",           state: '12', countyFips: '121', lat: 30.0381, lon: -82.93 },
  { zip: '32094', name: "Wellborn",                   county: "Suwannee",           state: '12', countyFips: '121', lat: 30.1796, lon: -82.8505 },
  { zip: '32336', name: "Lamont",                     county: "Taylor",             state: '12', countyFips: '123', lat: 30.3772, lon: -83.8129 },
  { zip: '32347', name: "Perry",                      county: "Taylor",             state: '12', countyFips: '123', lat: 30.1668, lon: -83.616 },
  { zip: '32348', name: "Perry",                      county: "Taylor",             state: '12', countyFips: '123', lat: 29.9665, lon: -83.6594 },
  { zip: '32356', name: "Salem",                      county: "Taylor",             state: '12', countyFips: '123', lat: 29.8539, lon: -83.4421 },
  { zip: '32357', name: "Shady Grove",                county: "Taylor",             state: '12', countyFips: '123', lat: 30.288, lon: -83.6318 },
  { zip: '32054', name: "Lake Butler",                county: "Union",              state: '12', countyFips: '125', lat: 30.0035, lon: -82.3828 },
  { zip: '32083', name: "Raiford",                    county: "Union",              state: '12', countyFips: '125', lat: 30.0704, lon: -82.2001 },
  { zip: '32697', name: "Worthington Springs",        county: "Union",              state: '12', countyFips: '125', lat: 29.9315, lon: -82.4255 },
  { zip: '32105', name: "Barberville",                county: "Volusia",            state: '12', countyFips: '127', lat: 29.2005, lon: -81.4065 },
  { zip: '32114', name: "Daytona Beach",              county: "Volusia",            state: '12', countyFips: '127', lat: 29.2012, lon: -81.0371 },
  { zip: '32115', name: "Daytona Beach",              county: "Volusia",            state: '12', countyFips: '127', lat: 29.2108, lon: -81.0228 },
  { zip: '32116', name: "Daytona Beach",              county: "Volusia",            state: '12', countyFips: '127', lat: 29.1091, lon: -80.9843 },
  { zip: '32117', name: "Daytona Beach",              county: "Volusia",            state: '12', countyFips: '127', lat: 29.2353, lon: -81.0658 },
  { zip: '32118', name: "Daytona Beach",              county: "Volusia",            state: '12', countyFips: '127', lat: 29.2219, lon: -81.0095 },
  { zip: '32119', name: "Daytona Beach",              county: "Volusia",            state: '12', countyFips: '127', lat: 29.16, lon: -81.0269 },
  { zip: '32120', name: "Daytona Beach",              county: "Volusia",            state: '12', countyFips: '127', lat: 29.2108, lon: -81.0228 },
  { zip: '32121', name: "Daytona Beach",              county: "Volusia",            state: '12', countyFips: '127', lat: 29.2108, lon: -81.0228 },
  { zip: '32122', name: "Daytona Beach",              county: "Volusia",            state: '12', countyFips: '127', lat: 29.2108, lon: -81.0228 },
  { zip: '32123', name: "Port Orange",                county: "Volusia",            state: '12', countyFips: '127', lat: 29.1383, lon: -80.9956 },
  { zip: '32124', name: "Daytona Beach",              county: "Volusia",            state: '12', countyFips: '127', lat: 29.1419, lon: -81.1402 },
  { zip: '32125', name: "Daytona Beach",              county: "Volusia",            state: '12', countyFips: '127', lat: 29.2108, lon: -81.0228 },
  { zip: '32126', name: "Daytona Beach",              county: "Volusia",            state: '12', countyFips: '127', lat: 29.2108, lon: -81.0228 },
  { zip: '32127', name: "Port Orange",                county: "Volusia",            state: '12', countyFips: '127', lat: 29.1383, lon: -80.9956 },
  { zip: '32128', name: "Port Orange",                county: "Volusia",            state: '12', countyFips: '127', lat: 29.1383, lon: -80.9956 },
  { zip: '32129', name: "Port Orange",                county: "Volusia",            state: '12', countyFips: '127', lat: 29.1372, lon: -81.0241 },
  { zip: '32130', name: "De Leon Springs",            county: "Volusia",            state: '12', countyFips: '127', lat: 29.1166, lon: -81.3488 },
  { zip: '32132', name: "Edgewater",                  county: "Volusia",            state: '12', countyFips: '127', lat: 28.9818, lon: -80.9103 },
  { zip: '32141', name: "Edgewater",                  county: "Volusia",            state: '12', countyFips: '127', lat: 28.9455, lon: -80.8969 },
  { zip: '32168', name: "New Smyrna Beach",           county: "Volusia",            state: '12', countyFips: '127', lat: 29.0247, lon: -80.9584 },
  { zip: '32169', name: "New Smyrna Beach",           county: "Volusia",            state: '12', countyFips: '127', lat: 29.0172, lon: -80.8885 },
  { zip: '32170', name: "New Smyrna Beach",           county: "Volusia",            state: '12', countyFips: '127', lat: 29.0258, lon: -80.927 },
  { zip: '32173', name: "Ormond Beach",               county: "Volusia",            state: '12', countyFips: '127', lat: 29.2858, lon: -81.0559 },
  { zip: '32174', name: "Ormond Beach",               county: "Volusia",            state: '12', countyFips: '127', lat: 29.2833, lon: -81.0882 },
  { zip: '32175', name: "Ormond Beach",               county: "Volusia",            state: '12', countyFips: '127', lat: 29.2858, lon: -81.0559 },
  { zip: '32176', name: "Ormond Beach",               county: "Volusia",            state: '12', countyFips: '127', lat: 29.3222, lon: -81.0584 },
  { zip: '32180', name: "Pierson",                    county: "Volusia",            state: '12', countyFips: '127', lat: 29.2226, lon: -81.4353 },
  { zip: '32190', name: "Seville",                    county: "Volusia",            state: '12', countyFips: '127', lat: 29.3201, lon: -81.5279 },
  { zip: '32198', name: "Daytona Beach",              county: "Volusia",            state: '12', countyFips: '127', lat: 29.2108, lon: -81.0228 },
  { zip: '32706', name: "Cassadaga",                  county: "Volusia",            state: '12', countyFips: '127', lat: 28.9664, lon: -81.2371 },
  { zip: '32713', name: "Debary",                     county: "Volusia",            state: '12', countyFips: '127', lat: 28.8846, lon: -81.3065 },
  { zip: '32720', name: "Deland",                     county: "Volusia",            state: '12', countyFips: '127', lat: 29.0266, lon: -81.3349 },
  { zip: '32721', name: "Deland",                     county: "Volusia",            state: '12', countyFips: '127', lat: 28.9973, lon: -81.2995 },
  { zip: '32722', name: "Glenwood",                   county: "Volusia",            state: '12', countyFips: '127', lat: 29.0861, lon: -81.3542 },
  { zip: '32723', name: "Deland",                     county: "Volusia",            state: '12', countyFips: '127', lat: 29.0275, lon: -81.3068 },
  { zip: '32724', name: "Deland",                     county: "Volusia",            state: '12', countyFips: '127', lat: 29.0422, lon: -81.2863 },
  { zip: '32725', name: "Deltona",                    county: "Volusia",            state: '12', countyFips: '127', lat: 28.8989, lon: -81.2473 },
  { zip: '32728', name: "Deltona",                    county: "Volusia",            state: '12', countyFips: '127', lat: 29.0227, lon: -81.1722 },
  { zip: '32738', name: "Deltona",                    county: "Volusia",            state: '12', countyFips: '127', lat: 28.9093, lon: -81.1922 },
  { zip: '32739', name: "Deltona",                    county: "Volusia",            state: '12', countyFips: '127', lat: 29.0227, lon: -81.1722 },
  { zip: '32744', name: "Lake Helen",                 county: "Volusia",            state: '12', countyFips: '127', lat: 28.9806, lon: -81.2334 },
  { zip: '32745', name: "Mid Florida",                county: "Volusia",            state: '12', countyFips: '127', lat: 28.7676, lon: -81.3522 },
  { zip: '32759', name: "Oak Hill",                   county: "Volusia",            state: '12', countyFips: '127', lat: 28.87, lon: -80.8551 },
  { zip: '32763', name: "Orange City",                county: "Volusia",            state: '12', countyFips: '127', lat: 28.9453, lon: -81.2995 },
  { zip: '32764', name: "Osteen",                     county: "Volusia",            state: '12', countyFips: '127', lat: 28.8426, lon: -81.1562 },
  { zip: '32774', name: "Orange City",                county: "Volusia",            state: '12', countyFips: '127', lat: 28.9489, lon: -81.2987 },
  { zip: '32326', name: "Crawfordville",              county: "Wakulla",            state: '12', countyFips: '129', lat: 30.176, lon: -84.3752 },
  { zip: '32327', name: "Crawfordville",              county: "Wakulla",            state: '12', countyFips: '129', lat: 30.2108, lon: -84.3205 },
  { zip: '32346', name: "Panacea",                    county: "Wakulla",            state: '12', countyFips: '129', lat: 30.0153, lon: -84.3912 },
  { zip: '32355', name: "Saint Marks",                county: "Wakulla",            state: '12', countyFips: '129', lat: 30.1631, lon: -84.2083 },
  { zip: '32358', name: "Sopchoppy",                  county: "Wakulla",            state: '12', countyFips: '129', lat: 30.0714, lon: -84.4549 },
  { zip: '32422', name: "Argyle",                     county: "Walton",             state: '12', countyFips: '131', lat: 30.7056, lon: -86.0314 },
  { zip: '32433', name: "Defuniak Springs",           county: "Walton",             state: '12', countyFips: '131', lat: 30.8494, lon: -86.2023 },
  { zip: '32434', name: "Mossy Head",                 county: "Walton",             state: '12', countyFips: '131', lat: 30.7432, lon: -86.3149 },
  { zip: '32435', name: "Defuniak Springs",           county: "Walton",             state: '12', countyFips: '131', lat: 30.721, lon: -86.1152 },
  { zip: '32439', name: "Freeport",                   county: "Walton",             state: '12', countyFips: '131', lat: 30.4896, lon: -86.1684 },
  { zip: '32455', name: "Ponce De Leon",              county: "Walton",             state: '12', countyFips: '131', lat: 30.7041, lon: -85.9546 },
  { zip: '32459', name: "Santa Rosa Beach",           county: "Walton",             state: '12', countyFips: '131', lat: 30.3659, lon: -86.2458 },
  { zip: '32461', name: "Rosemary Beach",             county: "Walton",             state: '12', countyFips: '131', lat: 30.2835, lon: -86.0305 },
  { zip: '32538', name: "Paxton",                     county: "Walton",             state: '12', countyFips: '131', lat: 30.9709, lon: -86.3111 },
  { zip: '32550', name: "Miramar Beach",              county: "Walton",             state: '12', countyFips: '131', lat: 30.385, lon: -86.3473 },
  { zip: '32427', name: "Caryville",                  county: "Washington",         state: '12', countyFips: '133', lat: 30.7123, lon: -85.8014 },
  { zip: '32428', name: "Chipley",                    county: "Washington",         state: '12', countyFips: '133', lat: 30.7107, lon: -85.5486 },
  { zip: '32437', name: "Ebro",                       county: "Washington",         state: '12', countyFips: '133', lat: 30.4352, lon: -85.8881 },
  { zip: '32462', name: "Vernon",                     county: "Washington",         state: '12', countyFips: '133', lat: 30.6267, lon: -85.7553 },
  { zip: '32463', name: "Wausau",                     county: "Washington",         state: '12', countyFips: '133', lat: 30.6321, lon: -85.5888 },
];

// ── NAICS sector reference (2-digit codes we care about) ──────────────────────
const NAICS_SECTORS = {
  '23':  { label: 'Construction',                   oracle_vertical: 'construction' },
  '42':  { label: 'Wholesale Trade',                oracle_vertical: null           },
  '44':  { label: 'Retail Trade',                   oracle_vertical: 'retail'       },
  '45':  { label: 'Retail Trade (Other)',            oracle_vertical: 'retail'       },
  '48':  { label: 'Transportation & Warehousing',    oracle_vertical: null           },
  '51':  { label: 'Information / Tech',              oracle_vertical: null           },
  '52':  { label: 'Finance & Insurance',             oracle_vertical: null           },
  '53':  { label: 'Real Estate & Rental',            oracle_vertical: 'realtor'      },
  '54':  { label: 'Professional Services',           oracle_vertical: null           },
  '56':  { label: 'Admin & Support Services',        oracle_vertical: null           },
  '61':  { label: 'Educational Services',            oracle_vertical: null           },
  '62':  { label: 'Health Care & Social Assistance', oracle_vertical: 'healthcare'   },
  '71':  { label: 'Arts, Entertainment & Recreation', oracle_vertical: null          },
  '72':  { label: 'Accommodation & Food Services',   oracle_vertical: 'restaurant'   },
  '81':  { label: 'Other Services',                  oracle_vertical: null           },
};

// ── History snapshot helper ───────────────────────────────────────────────────
// Appends current census_layer state to census_layer_history (one row per ZIP per day)
// UNIQUE(zip, snapshot_date) means re-running same day is safe — idempotent upsert
async function snapshotToHistory(zip) {
  try {
    const current = await pgStore.getCensusLayer(zip);
    if (!current) return;
    const { _confidence, ...layerJson } = current;
    await db.query(
      `INSERT INTO census_layer_history (zip, snapshot_date, layer_json, confidence)
       VALUES ($1, CURRENT_DATE, $2, $3)
       ON CONFLICT (zip, snapshot_date) DO UPDATE
         SET layer_json  = EXCLUDED.layer_json,
             confidence  = EXCLUDED.confidence`,
      [zip, JSON.stringify(layerJson), JSON.stringify(_confidence || null)]
    );
  } catch (err) {
    console.warn(`[censusLayer] History snapshot failed for ${zip}:`, err.message);
  }
}

// ── HTTP helper ────────────────────────────────────────────────────────────────
function fetchJson(url, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'LocalIntel-CensusLayer/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJson(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} — ${url}`));
      let b = '';
      res.setEncoding('utf8');
      res.on('data', c => { b += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(b)); }
        catch (e) { reject(new Error(`JSON parse failed: ${b.slice(0, 100)}`)); }
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
    req.on('error', reject);
  });
}

function parseCensus(raw) {
  if (!Array.isArray(raw) || raw.length < 2) return [];
  const [headers, ...rows] = raw;
  return rows.map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

const toN = v => { const n = parseFloat(v); return isNaN(n) || n < -9000000 ? 0 : n; };

// Strip Postgres-only metadata (e.g. _confidence) before re-upserting layer JSON
function stripMeta(layer) {
  if (!layer || typeof layer !== 'object') return layer;
  const { _confidence, ...rest } = layer;
  return rest;
}

// ── LAYER 1: ZBP — ZIP Business Patterns 2018 ─────────────────────────────────
// Employment + establishment count by NAICS sector, per ZIP
// Vintage 2018 — pulled once on startup, never re-fetched (data doesn't change)

async function ingestZBP(targetZips = FL_ZIP_SEED) {
  // Skip per-ZIP: only fetch ZIPs that don't already have ZBP data in zip_signals.
  // (Previous logic checked census_layer with a global 80% threshold, which caused
  // premature skip when census_layer had data from other workers but zip_signals
  // didn't have zbp_total_establishments populated.)
  let pendingZips = targetZips;
  if (true) {  // always skip already-ingested ZIPs (FULL_REFRESH mode removed)
    try {
      const db = require('../lib/db');
      const zipList = targetZips.map(z => z.zip);
      const rows = await db.query(
        `SELECT zip FROM zip_signals WHERE zbp_total_establishments IS NOT NULL AND zip = ANY($1::text[])`,
        [zipList]
      );
      const haveZbp = new Set(rows.map(r => r.zip));
      pendingZips = targetZips.filter(z => !haveZbp.has(z.zip));
      if (pendingZips.length === 0) {
        console.log(`[censusLayer] ZBP already ingested for all ${targetZips.length} ZIPs (zip_signals.zbp_total_establishments populated) — skipping`);
        return;
      }
      console.log(`[censusLayer] ZBP: ${haveZbp.size}/${targetZips.length} ZIPs have zbp in zip_signals — fetching remaining ${pendingZips.length}`);
    } catch (e) {
      console.warn('[censusLayer] ZBP skip-check failed, fetching all:', e.message);
      pendingZips = targetZips;
    }
  }

  console.log(`[censusLayer] ZBP: fetching 2018 ZIP Business Patterns for ${pendingZips.length} ZIPs...`);
  const ZIP_LIST = pendingZips.map(z => z.zip).join(',');

  // Fetch all sectors for all ZIPs in one call
  const raw = await fetchJson(
    `https://api.census.gov/data/2018/zbp?get=ESTAB,EMP,PAYANN,NAICS2017&for=zipcode:${ZIP_LIST}`
  );
  const rows = parseCensus(raw);

  // Group by ZIP
  const byZip = {};
  for (const row of rows) {
    const zip = row['zip code'] || row['zipcode'] || row['ZIPCODE'];
    if (!zip) continue;
    if (!byZip[zip]) byZip[zip] = [];
    byZip[zip].push(row);
  }

  const zipMeta = Object.fromEntries(targetZips.map(z => [z.zip, z]));

  for (const [zip, zipRows] of Object.entries(byZip)) {
    const total    = zipRows.find(r => r.NAICS2017 === '00') || {};
    const existing = stripMeta(await pgStore.getCensusLayer(zip)) || {};

    // Build sector breakdown (2-digit NAICS only)
    const sectors = {};
    for (const [code, meta] of Object.entries(NAICS_SECTORS)) {
      const row = zipRows.find(r => r.NAICS2017 === code);
      if (row) {
        sectors[code] = {
          label:           meta.label,
          oracle_vertical: meta.oracle_vertical,
          establishments: toN(row.ESTAB),
          employees:       toN(row.EMP),       // 0 = withheld by Census for privacy
          payroll_k:       Math.round(toN(row.PAYANN) / 1000),
          emp_withheld:    toN(row.EMP) === 0 && toN(row.ESTAB) > 0,
        };
      }
    }

    // Employment density (employees per 1000 residents) — population sourced from zip_intelligence
    const intelRow = await pgStore.getZipIntelligenceRow(zip).catch(() => null);
    const population = intelRow?._population || intelRow?.population || 0;
    const totalEmp   = toN(total.EMP);
    const totalEstab = toN(total.ESTAB);
    const empDensity = population > 0 && totalEmp > 0
      ? Math.round((totalEmp / population) * 1000)
      : 0;

    // Dominant sector by establishment count
    let dominantSector = null;
    let maxEstab = 0;
    for (const [code, s] of Object.entries(sectors)) {
      if (s.establishments > maxEstab) { maxEstab = s.establishments; dominantSector = code; }
    }

    const zbpData = {
      total_establishments: totalEstab,
      total_employees:      totalEmp,
      total_payroll_k:      Math.round(toN(total.PAYANN) / 1000),
      employment_density:   empDensity,
      dominant_sector:      dominantSector ? { code: dominantSector, label: NAICS_SECTORS[dominantSector]?.label } : null,
      sectors,
      zbp_vintage:          2018,
      zbp_note:             'ZBP 2018 is the most recent ZIP-level vintage. Use as structural baseline, not current count.',
    };

    const zbpLayerData = {
      ...existing,
      zip,
      name:   zipMeta[zip]?.name || zip,
      county: zipMeta[zip]?.county || '',
      zbp:    zbpData,
      updated_at: new Date().toISOString(),
    };
    await pgStore.upsertCensusLayer(zip, zbpLayerData, existing._confidence || null);
    await snapshotToHistory(zip);

    // World model — write zbp_* signals into zip_signals
    await pgStore.upsertZipSignals(zip, {
      zbp_total_establishments: zbpData.total_establishments || null,
      zbp_total_employees:      zbpData.total_employees      || null,
      zbp_sector_json:          Object.keys(zbpData.sectors).length ? zbpData.sectors : null,
      zbp_updated_at:           new Date(),
    });
  }

  console.log(`[censusLayer] ZBP: ingested ${Object.keys(byZip).length} ZIPs into census_layer`);
}

// ── LAYER 2: CBP — County Business Patterns 2023 ──────────────────────────────
// Current (2023) sector health at county level
// Pulled monthly — data updates annually, but monthly check catches the update

async function ingestCBP(targetZips = FL_ZIP_SEED) {
  console.log('[censusLayer] CBP: fetching 2023 County Business Patterns...');

  // Skip if CBP data was written to zip_signals in the last 30 days
  const [fresh] = await db.query(
    `SELECT 1 FROM zip_signals WHERE cbp_updated_at > NOW() - INTERVAL '30 days' LIMIT 1`
  );
  if (fresh) {
    console.log('[censusLayer] CBP: data fresh in zip_signals — skipping fetch');
    return;
  }

  const countySectors = {};

  for (const { name, state, county } of COUNTY_CONFIG) {
    try {
      // Fetch 2-digit NAICS totals for this county — 10s timeout, Census API is flaky
      const raw = await fetchJson(
        `https://api.census.gov/data/2023/cbp?get=ESTAB,EMP,PAYANN,NAICS2017&for=county:${county}&in=state:${state}`,
        10000
      );
      const rows = parseCensus(raw);

      const sectors = {};
      const total   = rows.find(r => r.NAICS2017 === '00') || {};

      for (const [code, meta] of Object.entries(NAICS_SECTORS)) {
        const row = rows.find(r => r.NAICS2017 === code);
        if (row) {
          sectors[code] = {
            label:           meta.label,
            oracle_vertical: meta.oracle_vertical,
            establishments: toN(row.ESTAB),
            employees:       toN(row.EMP),
            payroll_k:       Math.round(toN(row.PAYANN) / 1000),
          };
        }
      }

      // Employment mix — what % of county jobs are in each sector
      const totalEmp = toN(total.EMP) || 1;
      for (const s of Object.values(sectors)) {
        s.county_emp_share_pct = Math.round((s.employees / totalEmp) * 1000) / 10;
      }

      countySectors[name] = {
        total_establishments: toN(total.ESTAB),
        total_employees:      toN(total.EMP),
        total_payroll_k:      Math.round(toN(total.PAYANN) / 1000),
        sectors,
        cbp_vintage:          2023,
        fetched_at:           new Date().toISOString(),
      };

      console.log(`[censusLayer] CBP: ${name} — ${toN(total.ESTAB)} estab, ${toN(total.EMP).toLocaleString()} emp`);

      // Merge county share into each ZIP's census layer record (Postgres)
      const countyZips = targetZips.filter(z => z.county === name);
      for (const { zip } of countyZips) {
        const existing = stripMeta(await pgStore.getCensusLayer(zip)) || { zip };
        const prevConf = (await pgStore.getCensusLayer(zip))?._confidence || null;
        existing.cbp = countySectors[name];
        existing.updated_at = new Date().toISOString();

        // Derive sector gaps: sectors present at county but ZIP has 0 establishments (from ZBP)
        if (existing.zbp?.sectors) {
          const sectorGaps = [];
          for (const [code, countySector] of Object.entries(countySectors[name].sectors)) {
            const zipSector = existing.zbp.sectors[code];
            if (!zipSector || zipSector.establishments === 0) {
              sectorGaps.push({
                naics:           code,
                label:           countySector.label,
                oracle_vertical: countySector.oracle_vertical,
                county_estab:    countySector.establishments,
                county_emp_share: countySector.county_emp_share_pct,
              });
            }
          }
          // Sort by county employment share — biggest economic sectors absent from ZIP first
          sectorGaps.sort((a, b) => b.county_emp_share - a.county_emp_share);
          existing.sector_gaps = sectorGaps;
        }

        await pgStore.upsertCensusLayer(zip, existing, prevConf);
        await snapshotToHistory(zip);

        // World model — write cbp_* signals into zip_signals
        const cbp = countySectors[name];
        if (cbp) {
          const s = cbp.sectors || {};
          await pgStore.upsertZipSignals(zip, {
            // County totals
            cbp_total_establishments: cbp.total_establishments || null,
            cbp_total_employees:      cbp.total_employees      || null,
            cbp_total_payroll_k:      cbp.total_payroll_k      || null,
            cbp_dominant_sector:      existing.zbp?.dominant_sector?.code || null,
            cbp_updated_at:           new Date(),
            // NAICS 236 — Construction of Buildings
            cbp_bldg_estab:           s['23']  ? (s['236']?.establishments || s['23']?.establishments || null) : null,
            cbp_bldg_emp:             s['23']  ? (s['236']?.employees      || s['23']?.employees      || null) : null,
            // NAICS 237 — Heavy and Civil Engineering
            cbp_civil_estab:          s['237'] ? s['237'].establishments || null : null,
            cbp_civil_emp:            s['237'] ? s['237'].employees      || null : null,
            // NAICS 238 — Specialty Trade Contractors
            cbp_trade_estab:          s['238'] ? s['238'].establishments || null : null,
            cbp_trade_emp:            s['238'] ? s['238'].employees      || null : null,
            cbp_trade_payroll_k:      s['238'] ? s['238'].payroll_k      || null : null,
            cbp_construction_updated_at: new Date(),
          });
        }
      }

      // Small delay between counties
      await new Promise(r => setTimeout(r, 1000));

    } catch (err) {
      console.error(`[censusLayer] CBP failed for ${name}:`, err.message);
    }
  }

  console.log(`[censusLayer] CBP: county sectors merged into census_layer for ${Object.keys(countySectors).length} counties`);
}

// ── LAYER 3: PDB — Planning Database 2024 ─────────────────────────────────────
// Census tract: low response score, college attainment, poverty, vacancy, new units
// Aggregated to ZIP using population-weighted average across tracts
// Produces data_confidence_score per ZIP

// Tract-to-ZIP mapping — pre-computed from Census TIGER/ZCTA relationships
// Key: tract FIPS (6-digit) → ZIP codes it overlaps with
// This is a static mapping that rarely changes
// We derive it from known ZIP geometries + tract population data
// For our covered ZIPs, we use the dominant ZIP for each tract

// SJC tract-to-ZIP (based on geographic centroids + population distribution)
// Each entry: tractFips → [{ zip, weight }] (weights sum to 1.0)
const SJC_TRACT_ZIP = {
  // 32082 — Ponte Vedra Beach area tracts
  '12109020200': [{ zip: '32082', w: 1.0 }],
  '12109020300': [{ zip: '32082', w: 1.0 }],
  '12109020400': [{ zip: '32082', w: 0.7 }, { zip: '32095', w: 0.3 }],
  '12109020500': [{ zip: '32082', w: 1.0 }],
  '12109020600': [{ zip: '32082', w: 0.5 }, { zip: '32081', w: 0.5 }],
  // 32081 — Nocatee area
  '12109020700': [{ zip: '32081', w: 1.0 }],
  '12109020800': [{ zip: '32081', w: 1.0 }],
  '12109020900': [{ zip: '32081', w: 0.8 }, { zip: '32259', w: 0.2 }],
  '12109021000': [{ zip: '32081', w: 0.5 }, { zip: '32259', w: 0.5 }],
  // 32259 — Fruit Cove / Saint Johns
  '12109021100': [{ zip: '32259', w: 1.0 }],
  '12109021200': [{ zip: '32259', w: 1.0 }],
  '12109021300': [{ zip: '32259', w: 0.8 }, { zip: '32092', w: 0.2 }],
  '12109021400': [{ zip: '32259', w: 1.0 }],
  '12109021500': [{ zip: '32259', w: 0.7 }, { zip: '32092', w: 0.3 }],
  // 32092 — World Golf Village
  '12109021600': [{ zip: '32092', w: 1.0 }],
  '12109021700': [{ zip: '32092', w: 1.0 }],
  '12109021800': [{ zip: '32092', w: 0.6 }, { zip: '32084', w: 0.4 }],
  // 32084 / 32086 — St Augustine
  '12109020100': [{ zip: '32084', w: 1.0 }],
  '12109010100': [{ zip: '32084', w: 1.0 }],
  '12109010200': [{ zip: '32084', w: 0.6 }, { zip: '32086', w: 0.4 }],
  '12109010300': [{ zip: '32086', w: 1.0 }],
  '12109010400': [{ zip: '32086', w: 1.0 }],
  '12109010500': [{ zip: '32086', w: 0.8 }, { zip: '32080', w: 0.2 }],
  '12109010600': [{ zip: '32080', w: 1.0 }],
  '12109010700': [{ zip: '32080', w: 1.0 }],
  // 32095 — Palm Valley
  '12109022000': [{ zip: '32095', w: 1.0 }],
};

async function ingestPDB(targetZips = FL_ZIP_SEED) {
  console.log('[censusLayer] PDB: fetching 2024 Planning Database (SJC + Duval + Clay + Nassau)...');

  // Accumulators for weighted averages per ZIP
  const zipAccum = {};
  const initZip = zip => {
    if (!zipAccum[zip]) zipAccum[zip] = {
      pop_sum: 0, lrs_sum: 0, college_sum: 0, poverty_sum: 0,
      vacancy_sum: 0, new_units_sum: 0, tract_count: 0,
    };
  };

  for (const { name, state, county } of COUNTY_CONFIG) {
    try {
      const raw = await fetchJson(
        `https://api.census.gov/data/2024/pdb/tract?get=Tot_Population_ACS_18_22,Low_Response_Score,pct_College_ACS_18_22,pct_Pov_Univ_ACS_18_22,pct_Vacant_Units_ACS_18_22,Diff_HU_1yr_Ago_ACS_18_22&for=tract:*&in=state:${state}%20county:${county}`
      );
      if (!Array.isArray(raw)) throw new Error('non-array response');

      const [headers, ...rows] = raw;
      const hMap = {};
      headers.forEach((h, i) => { hMap[h] = i; });

      for (const row of rows) {
        const tractFull = `${state}${county.padStart(3,'0')}${row[hMap['tract']]}`;
        const pop      = toN(row[hMap['Tot_Population_ACS_18_22']]);
        const lrs      = toN(row[hMap['Low_Response_Score']]);       // 0-100, higher = harder to reach
        const college  = toN(row[hMap['pct_College_ACS_18_22']]);    // % with college degree
        const poverty  = toN(row[hMap['pct_Pov_Univ_ACS_18_22']]);  // % in poverty
        const vacancy  = toN(row[hMap['pct_Vacant_Units_ACS_18_22']]);
        const newUnits = toN(row[hMap['Diff_HU_1yr_Ago_ACS_18_22']]); // new housing units added

        if (pop === 0) continue;

        // Map tract to ZIP(s) using our crosswalk
        const mappings = SJC_TRACT_ZIP[tractFull] || [];
        if (mappings.length === 0) {
          // Unknown tract — assign to county's primary ZIP if we can figure it out
          // For now skip — these are tracts outside our specific ZIP coverage
          continue;
        }

        for (const { zip, w } of mappings) {
          initZip(zip);
          const weight = pop * w;
          zipAccum[zip].pop_sum     += weight;
          zipAccum[zip].lrs_sum     += lrs * weight;
          zipAccum[zip].college_sum += college * weight;
          zipAccum[zip].poverty_sum += poverty * weight;
          zipAccum[zip].vacancy_sum += vacancy * weight;
          zipAccum[zip].new_units_sum += newUnits * w; // not population-weighted
          zipAccum[zip].tract_count++;
        }
      }

      console.log(`[censusLayer] PDB: ${name} — ${rows.length} tracts processed`);
      await new Promise(r => setTimeout(r, 800));

    } catch (err) {
      console.error(`[censusLayer] PDB failed for ${name}:`, err.message);
    }
  }

  // Write PDB layer to each ZIP + compute confidence score
  const confidenceIndex = {};

  for (const [zip, acc] of Object.entries(zipAccum)) {
    if (acc.pop_sum === 0) continue;

    const lowResponseScore  = Math.round(acc.lrs_sum     / acc.pop_sum * 10) / 10;
    const collegePct        = Math.round(acc.college_sum / acc.pop_sum * 10) / 10;
    const povertyPct        = Math.round(acc.poverty_sum / acc.pop_sum * 10) / 10;
    const vacancyPct        = Math.round(acc.vacancy_sum / acc.pop_sum * 10) / 10;
    const newUnitsAdded     = Math.round(acc.new_units_sum);

    // ── Data Confidence Score ─────────────────────────────────────────────────
    // Combines Census data quality signals with our own coverage metrics
    //
    // Components (each 0-25 points):
    //   A. Census response quality: 25 - (lowResponseScore × 0.25)
    //      LRS 0 = perfect response → 25pts. LRS 40 = 15pts. LRS 100 = 0pts.
    //   B. Business index coverage: count of indexed businesses vs ZBP total
    //   C. Demographic data presence: has spending zone + ocean floor data
    //   D. Oracle cycle count: more cycles = more validated signals
    //
    const censusQuality    = Math.max(0, Math.round(25 - (lowResponseScore * 0.25)));

    const bizData          = (await pgStore.getBusinessesByZip(zip).catch(() => null)) || [];
    const censusLayer      = stripMeta(await pgStore.getCensusLayer(zip));
    const zbpTotal         = censusLayer?.zbp?.total_establishments || 0;
    const bizCoverage      = zbpTotal > 0
      ? Math.min(25, Math.round((bizData.length / zbpTotal) * 25))
      : (bizData.length > 10 ? 15 : bizData.length > 3 ? 8 : 2);

    const intelRow         = await pgStore.getZipIntelligenceRow(zip).catch(() => null);
    const oceanRow         = (await db.queryOne('SELECT zip FROM ocean_floor WHERE zip = $1', [zip]).catch(() => null));
    const hasZoneData      = !!(intelRow?._population || intelRow?.population);
    const hasOceanData     = !!oceanRow;
    const demoQuality      = hasZoneData ? (hasOceanData ? 25 : 18) : 8;

    const oracleCycles     = intelRow ? (intelRow.oracle_cycles || 0) : 0;
    const oracleQuality    = Math.min(25, oracleCycles * 3);  // 25pts at 8+ cycles

    const dataConfidenceScore = censusQuality + bizCoverage + demoQuality + oracleQuality;

    const confidenceTier   = dataConfidenceScore >= 80 ? 'VERIFIED'
      : dataConfidenceScore >= 55 ? 'ESTIMATED'
      : dataConfidenceScore >= 30 ? 'PROXY'
      : 'SPARSE';

    const pdbData = {
      low_response_score:  lowResponseScore,
      college_pct:         collegePct,
      poverty_pct:         povertyPct,
      vacancy_pct_tract:   vacancyPct,
      new_units_added:     newUnitsAdded,
      tracts_mapped:       acc.tract_count,
      pdb_vintage:         2024,
      fetched_at:          new Date().toISOString(),
    };

    const confidence = {
      data_confidence_score: dataConfidenceScore,
      confidence_tier:       confidenceTier,
      components: {
        census_response_quality: censusQuality,
        business_index_coverage: bizCoverage,
        demographic_data_quality: demoQuality,
        oracle_validation_depth: oracleQuality,
      },
      business_index_count: bizData.length,
      zbp_total_estab:      zbpTotal,
      oracle_cycles:        oracleCycles,
      has_zone_data:        hasZoneData,
      has_ocean_data:       hasOceanData,
    };

    // Merge into census layer (Postgres)
    const existing = stripMeta(await pgStore.getCensusLayer(zip)) || { zip };
    const pdbLayerData = {
      ...existing,
      pdb:        pdbData,
      confidence,
      updated_at: new Date().toISOString(),
    };
    await pgStore.upsertCensusLayer(zip, pdbLayerData, confidence);
    await snapshotToHistory(zip);

    // World model — stamp confidence score into zip_signals for MCP tools
    await pgStore.upsertZipSignals(zip, {
      data_confidence_score: dataConfidenceScore,
      data_confidence_tier:  confidenceTier,
    });

    confidenceIndex[zip] = {
      score:           dataConfidenceScore,
      tier:            confidenceTier,
      lrs:             lowResponseScore,
      oracle_cycles:   oracleCycles,
    };

    console.log(`[censusLayer] PDB: ${zip} confidence=${dataConfidenceScore} (${confidenceTier}) lrs=${lowResponseScore} college=${collegePct}%`);
  }

  console.log(`[censusLayer] PDB: confidence index built for ${Object.keys(confidenceIndex).length} ZIPs`);
  return confidenceIndex;
}

// ── Oracle integration: inject confidence into oracle output ───────────────────
// Called after PDB ingest — stamps confidence tier onto existing oracle files
// so that MCP callers see it without needing a separate fetch

async function stampOracleConfidence(confidenceIndex) {
  if (!confidenceIndex || !Object.keys(confidenceIndex).length) return;
  if (!db.isReady()) return;

  let stamped = 0;
  for (const [zip, c] of Object.entries(confidenceIndex)) {
    const confidenceBlock = {
      score:         c.score,
      tier:          c.tier,
      oracle_cycles: c.oracle_cycles,
      lrs:           c.lrs,
      note: c.tier === 'SPARSE'    ? 'Low signal density — treat signals as directional only'
          : c.tier === 'PROXY'     ? 'Moderate confidence — demographic data estimated from proxies'
          : c.tier === 'ESTIMATED' ? 'Good confidence — Census-backed with growing oracle history'
          : 'High confidence — Census-verified with validated oracle signal history',
    };
    await db.query(
      `UPDATE zip_intelligence
       SET oracle_json = jsonb_set(COALESCE(oracle_json, '{}'), '{data_confidence}', $2::jsonb),
           updated_at  = NOW()
       WHERE zip = $1`,
      [zip, JSON.stringify(confidenceBlock)]
    ).catch(() => {});
    stamped++;
  }
  console.log(`[censusLayer] Stamped confidence scores on ${stamped} ZIPs in zip_intelligence`);
}

// ── Refresh schedule management (Postgres-backed via worker_heartbeat) ─────────
async function shouldRun(workerName, intervalMs) {
  try {
    const rows = await db.query(
      `SELECT last_run FROM worker_heartbeat WHERE worker_name = $1`,
      [workerName]
    );
    if (!Array.isArray(rows) || !rows.length || !rows[0].last_run) return true;
    return Date.now() - new Date(rows[0].last_run).getTime() >= intervalMs;
  } catch (_) {
    return true;
  }
}

async function pingHeartbeat(workerName) {
  await db.query(
    `INSERT INTO worker_heartbeat (worker_name, last_run) VALUES ($1, NOW())
     ON CONFLICT (worker_name) DO UPDATE SET last_run = NOW()`,
    [workerName]
  );
}

// ── Main run ───────────────────────────────────────────────────────────────────

// Returns the working ZIP list: Postgres-discovered ZIPs enriched with county metadata
// from zip_intelligence. Falls back to FL_ZIP_SEED (all 1,473 FL ZIPs) if Postgres unavailable.
async function getTargetZips() {
  if (process.env.LOCAL_INTEL_DB_URL) {
    try {
      const { getDistinctZips } = require('../lib/pgStore');
      const pgZips = await getDistinctZips();
      if (pgZips.length > 0) {
        // Enrich with county/state metadata from FL_ZIP_SEED where known
        const metaIndex = Object.fromEntries(FL_ZIP_SEED.map(z => [z.zip, z]));
        const result = pgZips.map(zip => metaIndex[zip] || { zip, name: zip, county: 'Unknown', state: '12', countyFips: '000' });
        console.log(`[censusLayer] ZIP discovery: ${result.length} ZIPs from Postgres (${FL_ZIP_SEED.length} had county metadata)`);
        return result;
      }
    } catch (e) {
      // Fallback is intentional — not an error
      if (process.env.NODE_ENV !== 'production') console.log('[censusLayer] ZIP discovery fallback to FL_ZIP_SEED:', e.message);
    }
  }
  return FL_ZIP_SEED;
}

async function runCensusLayer() {
  console.log('[censusLayer] Starting census layer update...');

  const MS_MONTHLY  = 24 * 24 * 60 * 60 * 1000; // 24 days — 30d overflows 32-bit signed int (2^31-1)
  const MS_QUARTERLY = 24 * 24 * 60 * 60 * 1000; // 24 days — 90d overflows 32-bit signed int; re-arms itself

  // Discover ZIPs once — reused for all layers. Short delay lets pool settle on fresh deploy.
  await new Promise(r => setTimeout(r, 5000));
  const targetZips = await getTargetZips();

  // ZBP: once only (Postgres-backed flag)
  try {
    await ingestZBP(targetZips);
  } catch (err) {
    console.error('[censusLayer] ZBP error:', err.message);
  }

  // CBP: monthly
  if (await shouldRun('censusLayerWorker_cbp', MS_MONTHLY)) {
    try {
      await ingestCBP(targetZips);
      await pingHeartbeat('censusLayerWorker_cbp');
    } catch (err) {
      console.error('[censusLayer] CBP error:', err.message);
    }
  } else {
    console.log('[censusLayer] CBP: skipping (last run was recent)');
  }

  // PDB: quarterly
  if (await shouldRun('censusLayerWorker_pdb', MS_QUARTERLY)) {
    try {
      const targetZips3 = targetZips;
      const confidenceIndex = await ingestPDB(targetZips3);
      await pingHeartbeat('censusLayerWorker_pdb');
      await stampOracleConfidence(confidenceIndex);
    } catch (err) {
      console.error('[censusLayer] PDB error:', err.message);
    }
  } else {
    console.log('[censusLayer] PDB: skipping (last run was recent)');
  }

  console.log('[censusLayer] Done.');
}

// ── Schedule: run on startup, then check daily ─────────────────────────────────
// The schedule file controls whether each sub-layer actually re-fetches —
// daily check is cheap, actual Census fetches only happen on their cadence.

const CENSUS_INTERVAL = 30 * 24 * 60 * 60 * 1000; // 30d — census data is annual
(async () => {
  const hb = require('../lib/workerHeartbeat');
  if (await hb.isFresh('censusLayerWorker', CENSUS_INTERVAL)) {
    console.log('[censusLayer] Fresh — skipping startup run');
  } else {
    await runCensusLayer().catch(err => console.error('[censusLayer] Fatal on startup:', err.message));
    await hb.ping('censusLayerWorker');
  }
  setInterval(async () => {
    await runCensusLayer().catch(err => console.error('[censusLayer] Scheduled error:', err.message));
    await hb.ping('censusLayerWorker');
  }, CENSUS_INTERVAL);
})();

console.log('[censusLayer] Worker started. ZBP=once, CBP=monthly, PDB=quarterly.');

process.on('uncaughtException',  err => console.error('[censusLayer] Uncaught:', err.message));
process.on('unhandledRejection', r   => console.error('[censusLayer] Rejection:', r));

module.exports = { runCensusLayer, ingestZBP, ingestCBP, ingestPDB };
