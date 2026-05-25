/**
 * chamberDirectory.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Maps ZIP codes to their local Chamber of Commerce directory URLs.
 * As LocalIntel expands to new ZIPs, add the chamber here.
 *
 * Each entry has:
 *   - url:      the member directory page
 *   - name:     human-readable chamber name
 *   - parser:   'growthzone' | 'chambermaster' | 'custom' | 'unknown'
 *   - zips:     ZIP codes this chamber covers
 *   - state:    two-letter state code
 *   - county:   county name (no "County" suffix)
 *
 * GrowthZone chambers share the same HTML structure — one parser handles all.
 * ChamberMaster chambers are similar but use /list endpoints.
 * Custom/unknown chambers need dedicated extractors (TODO per entry).
 */

'use strict';

const CHAMBER_DIRECTORY = [

  // ══════════════════════════════════════════════════════════════════════════
  // NORTHEAST FLORIDA
  // ══════════════════════════════════════════════════════════════════════════

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

  // ── Nassau County, FL ─────────────────────────────────────────────────────
  {
    name:   'Nassau County Chamber of Commerce',
    url:    'https://business.nassaucountyflchamber.com/member-directory/Search',
    parser: 'growthzone',
    zips:   ['32011', '32034', '32035', '32046'],
    state:  'FL',
    county: 'Nassau',
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

  // ── Putnam County / Palatka, FL ───────────────────────────────────────────
  {
    name:   'Putnam County Chamber of Commerce',
    url:    'https://business.putnamcountychamber.com',
    parser: 'custom',
    zips:   ['32177', '32148', '32140', '32112', '32139'],
    state:  'FL',
    county: 'Putnam',
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

  // ══════════════════════════════════════════════════════════════════════════
  // NORTH FLORIDA
  // ══════════════════════════════════════════════════════════════════════════

  // ── Leon County / Tallahassee, FL ─────────────────────────────────────────
  {
    name:   'Greater Tallahassee Chamber of Commerce',
    url:    'https://web.talchamber.com/chamber/search',
    parser: 'custom',
    zips:   ['32301', '32303', '32304', '32305', '32308', '32309', '32310', '32311',
             '32312', '32313', '32317', '32399'],
    state:  'FL',
    county: 'Leon',
  },

  // ── Columbia County / Lake City, FL ──────────────────────────────────────
  {
    name:   'Columbia County Chamber of Commerce',
    url:    'https://business.columbiacountychamber.com/list',
    parser: 'custom',
    zips:   ['32024', '32025', '32055', '32056', '32058'],
    state:  'FL',
    county: 'Columbia',
  },

  // ── Escambia County / Pensacola, FL ──────────────────────────────────────
  {
    name:   'Greater Pensacola Chamber of Commerce',
    url:    'https://business.pensacolachamber.com',
    parser: 'custom',
    zips:   ['32501', '32502', '32503', '32504', '32505', '32506', '32507', '32508',
             '32514', '32526', '32533', '32534', '32577'],
    state:  'FL',
    county: 'Escambia',
  },

  // ── Santa Rosa County / Milton, FL ───────────────────────────────────────
  {
    name:   'Santa Rosa County Chamber of Commerce',
    url:    'https://www.srchamber.com/member-directory/',
    parser: 'custom',
    zips:   ['32561', '32563', '32564', '32565', '32568', '32570', '32571', '32583'],
    state:  'FL',
    county: 'Santa Rosa',
  },

  // ── Okaloosa County / Fort Walton Beach, FL ──────────────────────────────
  {
    name:   'Greater Fort Walton Beach Chamber of Commerce',
    url:    'https://www.fwbchamber.org/list',
    parser: 'custom',
    zips:   ['32547', '32548', '32549', '32531', '32536', '32539', '32542', '32544', '32579', '32580'],
    state:  'FL',
    county: 'Okaloosa',
  },

  // ── Bay County / Panama City, FL ─────────────────────────────────────────
  {
    name:   'Bay County Chamber of Commerce',
    url:    'https://www.panamacity.org/business-directory/',
    parser: 'unknown',
    zips:   ['32401', '32403', '32404', '32405', '32407', '32408', '32409', '32413'],
    state:  'FL',
    county: 'Bay',
  },

  // ══════════════════════════════════════════════════════════════════════════
  // CENTRAL FLORIDA
  // ══════════════════════════════════════════════════════════════════════════

  // ── Seminole County, FL ───────────────────────────────────────────────────
  {
    name:   'Seminole County Chamber',
    url:    'https://business.seminolebusiness.org/list',
    parser: 'chambermaster',
    zips:   ['32701', '32703', '32707', '32708', '32714', '32730', '32732', '32746',
             '32750', '32751', '32765', '32771', '32772', '32773', '32779'],
    state:  'FL',
    county: 'Seminole',
  },

  // ── Orange County / Orlando, FL ───────────────────────────────────────────
  {
    name:   'Orlando Regional Chamber of Commerce',
    url:    'https://orlando.org/companies/',
    parser: 'custom',
    zips:   ['32801', '32802', '32803', '32804', '32805', '32806', '32807', '32808',
             '32809', '32810', '32811', '32812', '32817', '32819', '32820', '32824',
             '32825', '32826', '32827', '32828', '32829', '32835', '32839'],
    state:  'FL',
    county: 'Orange',
  },

  // ── Osceola County / Kissimmee, FL ───────────────────────────────────────
  {
    name:   'Kissimmee / Osceola County Chamber of Commerce',
    url:    'https://www.kissimmeechamber.com/business-directory/',
    parser: 'custom',
    zips:   ['34741', '34742', '34743', '34744', '34746', '34747', '34758', '34759',
             '34769', '34771', '34772', '34773'],
    state:  'FL',
    county: 'Osceola',
  },

  // ── Lake County, FL ───────────────────────────────────────────────────────
  {
    name:   'Lake County Chamber of Commerce',
    url:    'https://business.lakecountychamber.com/list',
    parser: 'growthzone',
    zips:   ['34711', '34712', '34714', '34715', '34731', '34736', '34737', '34748',
             '34753', '34756', '34762', '34787', '32159', '32162'],
    state:  'FL',
    county: 'Lake',
  },

  // ── Citrus County, FL ─────────────────────────────────────────────────────
  {
    name:   'Citrus County Chamber of Commerce',
    url:    'https://business.citruscountychamber.com/Member-Directory',
    parser: 'growthzone',
    zips:   ['34428', '34429', '34431', '34432', '34433', '34434', '34436', '34442',
             '34446', '34448', '34450', '34452', '34453', '34461', '34465'],
    state:  'FL',
    county: 'Citrus',
  },

  // ── Marion County / Ocala, FL ─────────────────────────────────────────────
  {
    name:   'Ocala / Marion County Chamber of Commerce',
    url:    'https://www.ocalamarion.com/directory/',
    parser: 'custom',
    zips:   ['34470', '34471', '34472', '34473', '34474', '34475', '34476', '34478',
             '34479', '34480', '34481', '34482', '34488', '32113'],
    state:  'FL',
    county: 'Marion',
  },

  // ── Alachua County / Gainesville, FL ─────────────────────────────────────
  {
    name:   'Greater Gainesville Chamber of Commerce',
    url:    'https://members.gainesvillechamber.com/list',
    parser: 'custom',
    zips:   ['32601', '32603', '32605', '32606', '32607', '32608', '32609', '32610',
             '32612', '32615', '32616', '32618', '32640', '32641', '32643', '32653',
             '32667', '32669'],
    state:  'FL',
    county: 'Alachua',
  },

  // ── Polk County / Lakeland, FL ────────────────────────────────────────────
  {
    name:   'Lakeland Area Chamber of Commerce',
    url:    'https://web.lakelandchamber.com/wcdirectory/results/searchalpha.aspx',
    parser: 'custom',
    zips:   ['33801', '33803', '33805', '33809', '33810', '33811', '33812', '33813',
             '33815', '33823', '33830', '33849', '33859', '33880', '33881'],
    state:  'FL',
    county: 'Polk',
  },

  // ── Hernando County / Spring Hill, FL ────────────────────────────────────
  {
    name:   'Greater Hernando County Chamber of Commerce',
    url:    'https://business.hernandochamber.com/list',
    parser: 'custom',
    zips:   ['34601', '34602', '34604', '34606', '34607', '34608', '34609', '34613',
             '34614', '33523', '33597'],
    state:  'FL',
    county: 'Hernando',
  },

  // ── Pasco County, FL ──────────────────────────────────────────────────────
  {
    name:   'Greater Pasco Chamber of Commerce',
    url:    'https://members.greaterpasco.com/list/searchalpha/a',
    parser: 'growthzone',
    zips:   ['34638', '34652', '34653', '34654', '34655', '34656', '34657', '34667',
             '34668', '34669', '34690', '34691', '34692', '33541', '33542', '33543',
             '33544', '33545', '33559', '33576'],
    state:  'FL',
    county: 'Pasco',
  },

  // ══════════════════════════════════════════════════════════════════════════
  // TAMPA BAY / SOUTHWEST FLORIDA
  // ══════════════════════════════════════════════════════════════════════════

  // ── Hillsborough County / Tampa, FL ──────────────────────────────────────
  {
    name:   'Tampa Bay Chamber of Commerce',
    url:    'https://www.tampabaychamber.com/membership/',
    parser: 'custom',
    zips:   ['33511', '33573', '33578', '33602', '33603', '33604', '33605', '33606',
             '33607', '33609', '33610', '33611', '33612', '33613', '33614', '33615',
             '33616', '33617', '33618', '33619', '33620', '33621', '33624', '33625',
             '33626', '33629', '33634', '33637', '33647'],
    state:  'FL',
    county: 'Hillsborough',
  },

  // ── Pinellas County / St. Petersburg, FL ──────────────────────────────────
  {
    name:   'St. Petersburg Area Chamber of Commerce',
    url:    'https://www.stpete.com/directory/',
    parser: 'custom',
    zips:   ['33701', '33702', '33703', '33704', '33705', '33706', '33707', '33708',
             '33709', '33710', '33711', '33712', '33713', '33714', '33715', '33716',
             '33730', '33755', '33756', '33759', '33760', '33761', '33762', '33763',
             '33764', '33765', '33770', '33771', '33772', '33773', '33774', '33776',
             '33777', '33778', '33781', '33782'],
    state:  'FL',
    county: 'Pinellas',
  },

  // ── Manatee County / Bradenton, FL ───────────────────────────────────────
  {
    name:   'Manatee Chamber of Commerce',
    url:    'https://business.manateechamber.com/list',
    parser: 'chambermaster',
    zips:   ['34201', '34202', '34203', '34205', '34208', '34209', '34210', '34211',
             '34212', '34215', '34217', '34219', '34220', '34221', '34228', '34240',
             '34241', '34243'],
    state:  'FL',
    county: 'Manatee',
  },

  // ── Sarasota County, FL ───────────────────────────────────────────────────
  {
    name:   'Greater Sarasota Chamber of Commerce',
    url:    'https://business.sarasotachamber.com/active-member-directory',
    parser: 'growthzone',
    zips:   ['34229', '34231', '34232', '34233', '34234', '34235', '34236', '34237',
             '34238', '34239', '34240', '34241', '34242', '34243'],
    state:  'FL',
    county: 'Sarasota',
  },

  // ── Charlotte County / Port Charlotte, FL ─────────────────────────────────
  {
    name:   'Charlotte County Chamber of Commerce',
    url:    'https://business.charlottecountychamber.org/list/',
    parser: 'custom',
    zips:   ['33946', '33947', '33948', '33950', '33952', '33953', '33954', '33955',
             '33980', '33981', '33982', '33983', '34223', '34224'],
    state:  'FL',
    county: 'Charlotte',
  },

  // ── Lee County / Fort Myers, FL ───────────────────────────────────────────
  {
    name:   'Greater Fort Myers Chamber of Commerce',
    url:    'https://fortmyers.org/member-directory/',
    parser: 'custom',
    zips:   ['33901', '33903', '33905', '33907', '33908', '33912', '33913', '33916',
             '33917', '33919', '33965', '33966', '33967', '33971', '33972', '33973',
             '33990', '33991', '33993', '33956', '33928', '33931', '34134', '34135'],
    state:  'FL',
    county: 'Lee',
  },

  // ── Collier County / Naples, FL ───────────────────────────────────────────
  {
    name:   'Greater Naples Chamber of Commerce',
    url:    'https://www.napleschamber.org/member-directory/',
    parser: 'unknown',
    zips:   ['34101', '34102', '34103', '34104', '34105', '34108', '34109', '34110',
             '34112', '34113', '34114', '34116', '34117', '34119', '34120', '34134',
             '34140', '34141', '34142', '34145'],
    state:  'FL',
    county: 'Collier',
  },

  // ══════════════════════════════════════════════════════════════════════════
  // SOUTH FLORIDA
  // ══════════════════════════════════════════════════════════════════════════

  // ── Miami-Dade County, FL ─────────────────────────────────────────────────
  {
    name:   'Greater Miami Chamber of Commerce',
    url:    'https://www.miamichamber.com/business-directory/',
    parser: 'unknown',
    zips:   ['33101', '33109', '33122', '33125', '33126', '33127', '33128', '33129',
             '33130', '33131', '33132', '33133', '33134', '33135', '33136', '33137',
             '33138', '33139', '33140', '33141', '33142', '33143', '33144', '33145',
             '33146', '33147', '33149', '33150', '33154', '33155', '33156', '33157',
             '33158', '33160', '33161', '33162', '33165', '33166', '33167', '33168',
             '33169', '33170', '33172', '33173', '33174', '33175', '33176', '33177',
             '33178', '33179', '33180', '33181', '33182', '33183', '33184', '33185',
             '33186', '33187', '33189', '33190', '33193', '33194', '33196'],
    state:  'FL',
    county: 'Miami-Dade',
  },

  // ── Broward County / Fort Lauderdale, FL ─────────────────────────────────
  {
    name:   'Greater Fort Lauderdale Chamber of Commerce',
    url:    'https://www.ftlchamber.com/member-directory/',
    parser: 'unknown',
    zips:   ['33004', '33009', '33010', '33012', '33019', '33020', '33021', '33023',
             '33024', '33025', '33026', '33027', '33028', '33029', '33060', '33062',
             '33063', '33064', '33065', '33067', '33068', '33069', '33071', '33073',
             '33301', '33304', '33305', '33306', '33308', '33309', '33310', '33311',
             '33312', '33313', '33314', '33315', '33316', '33317', '33319', '33321',
             '33322', '33323', '33324', '33325', '33326', '33327', '33328', '33329',
             '33330', '33331', '33332', '33334'],
    state:  'FL',
    county: 'Broward',
  },

  // ── Palm Beach County, FL ─────────────────────────────────────────────────
  {
    name:   'Palm Beach Chamber of Commerce',
    url:    'https://members.palmbeachchamber.com',
    parser: 'unknown',
    zips:   ['33401', '33403', '33404', '33405', '33406', '33407', '33408', '33409',
             '33410', '33411', '33412', '33413', '33414', '33415', '33416', '33417',
             '33418', '33426', '33428', '33430', '33431', '33432', '33433', '33434',
             '33435', '33436', '33437', '33438', '33444', '33445', '33446', '33458',
             '33460', '33461', '33462', '33463', '33467', '33469', '33470', '33472',
             '33473', '33477', '33478', '33480', '33483', '33484', '33486', '33487',
             '33493', '33496', '33498'],
    state:  'FL',
    county: 'Palm Beach',
  },

  // ── Martin County / Stuart, FL ────────────────────────────────────────────
  {
    name:   'Stuart / Martin County Chamber of Commerce',
    url:    'https://business.stuartmartinchamber.org/directory',
    parser: 'chambermaster',
    zips:   ['34990', '34994', '34996', '34997', '34957', '34958'],
    state:  'FL',
    county: 'Martin',
  },

  // ── St. Lucie County / Port St. Lucie, FL ────────────────────────────────
  {
    name:   'St. Lucie County Chamber of Commerce',
    url:    'https://stluciechamber.org/membership-account/directory/',
    parser: 'custom',
    zips:   ['34945', '34946', '34947', '34949', '34950', '34952', '34953', '34981',
             '34982', '34983', '34984', '34986', '34987', '34990'],
    state:  'FL',
    county: 'St. Lucie',
  },

  // ── Indian River County / Vero Beach, FL ─────────────────────────────────
  {
    name:   'Indian River County Chamber of Commerce',
    url:    'https://business.indianriverchamber.com/list',
    parser: 'custom',
    zips:   ['32948', '32958', '32960', '32962', '32963', '32966', '32967', '32968'],
    state:  'FL',
    county: 'Indian River',
  },

  // ── Brevard County / Space Coast, FL ─────────────────────────────────────
  {
    name:   'Space Coast Chamber of Commerce',
    url:    'https://members.spacecoastchamber.com/directory/Search',
    parser: 'growthzone',
    zips:   ['32901', '32903', '32904', '32905', '32907', '32908', '32909', '32920',
             '32922', '32925', '32926', '32927', '32931', '32934', '32935', '32937',
             '32940', '32941', '32949', '32950', '32951', '32952', '32953', '32955',
             '32976'],
    state:  'FL',
    county: 'Brevard',
  },

  // ── Okaloosa County already listed above (Fort Walton Beach) ──────────────

  // ══════════════════════════════════════════════════════════════════════════
  // Template for new chambers
  // ══════════════════════════════════════════════════════════════════════════
  // {
  //   name:   'XYZ Chamber of Commerce',
  //   url:    'https://business.xyzchamber.com/member-directory/FindStartsWith?term=%23%21',
  //   parser: 'growthzone',   // or 'chambermaster' | 'custom' | 'unknown'
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
 * Get all unique chamber entries for a given state.
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

  const https = require('https');

  for (const url of candidates) {
    try {
      const found = await new Promise((resolve) => {
        const req = https.get(url, { timeout: 8000 }, (res) => {
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
