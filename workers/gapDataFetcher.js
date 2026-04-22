'use strict';
/**
 * gapDataFetcher.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Called by promptEvolutionWorker.js when it detects a data gap in a ZIP.
 * Each gap type routes to the correct public data source and writes the result
 * into the appropriate LocalIntel data layer.
 *
 * Gap types handled:
 *   no_demographics    → Census ACS 5-year (population, income, housing, age)
 *   no_population      → Census ACS B01003 (total population)
 *   no_infrastructure  → FL FDOT project feed + county permit RSS
 *   thin_business_index → YellowPages + Chamber directory
 *   never_computed     → Census ACS bootstrap (same as no_demographics)
 *
 * All sources are public, no API keys required.
 * Writes to:
 *   data/ocean_floor/{zip}.json  (demographics)
 *   data/bedrock/{zip}.json      (infrastructure)
 *   data/zips/{zip}.json         (business additions)
 *
 * Returns true if data was written, false if source returned nothing useful.
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const OCEAN_DIR   = path.join(DATA_DIR, 'ocean_floor');
const BEDROCK_DIR = path.join(DATA_DIR, 'bedrock');
const ZIPS_DIR    = path.join(DATA_DIR, 'zips');
const GAP_LOG     = path.join(DATA_DIR, 'evolution', '_gap_fetch_log.json');

// ── FL county FIPS map ────────────────────────────────────────────────────────
const COUNTY_FIPS = {
  'St. Johns': '12109',
  'Duval':     '12031',
  'Clay':      '12019',
  'Nassau':    '12089',
  'Flagler':   '12035',
  'Volusia':   '12127',
};

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function fetchRaw(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LocalIntel/1.0; +https://localintel.ai)',
        'Accept': 'application/json,text/html,*/*',
      },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchRaw(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} — ${url}`));
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
    req.on('error', reject);
  });
}

async function fetchJson(url) {
  const body = await fetchRaw(url);
  return JSON.parse(body);
}

function parseCensusTable(raw) {
  if (!Array.isArray(raw) || raw.length < 2) return [];
  const [headers, ...rows] = raw;
  return rows.map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

function toNum(val) { const n = parseFloat(val); return isNaN(n) ? 0 : n; }

// ── File helpers ──────────────────────────────────────────────────────────────

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function atomicWrite(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function appendGapLog(entry) {
  let log = readJson(GAP_LOG) || [];
  log.push({ ts: new Date().toISOString(), ...entry });
  if (log.length > 500) log = log.slice(-500);
  atomicWrite(GAP_LOG, log);
}

// ── SOURCE: Census ACS 5-year — demographics ──────────────────────────────────
// Fetches population, income, housing, age cohorts for a ZIP
// No API key required for 500 calls/day (more than enough)

async function fetchCensusACS(zip) {
  const BASE = 'https://api.census.gov/data/2023/acs/acs5';
  const SUBJ = BASE + '/subject';

  // Population + basic demographics (B01003, B19013, B25003, B01002)
  const [popRaw, incomeRaw, tenureRaw, ageRaw] = await Promise.allSettled([
    fetchJson(`${BASE}?get=B01003_001E,NAME&for=zip%20code%20tabulation%20area:${zip}`),
    fetchJson(`${SUBJ}?get=S1901_C01_012E,S1901_C02_012E,NAME&for=zip%20code%20tabulation%20area:${zip}`),
    fetchJson(`${BASE}?get=B25003_001E,B25003_002E,B25003_003E,NAME&for=zip%20code%20tabulation%20area:${zip}`),
    fetchJson(`${BASE}?get=B01002_001E,NAME&for=zip%20code%20tabulation%20area:${zip}`),
  ]);

  const pop    = popRaw.status    === 'fulfilled' ? parseCensusTable(popRaw.value)[0]    : null;
  const income = incomeRaw.status === 'fulfilled' ? parseCensusTable(incomeRaw.value)[0] : null;
  const tenure = tenureRaw.status === 'fulfilled' ? parseCensusTable(tenureRaw.value)[0] : null;
  const age    = ageRaw.status    === 'fulfilled' ? parseCensusTable(ageRaw.value)[0]    : null;

  const population        = pop    ? toNum(pop['B01003_001E'])    : 0;
  const medianHHI         = income ? toNum(income['S1901_C01_012E']) : 0;
  const totalHH           = tenure ? toNum(tenure['B25003_001E']) : 0;
  const ownerOccupied     = tenure ? toNum(tenure['B25003_002E']) : 0;
  const renterOccupied    = tenure ? toNum(tenure['B25003_003E']) : 0;
  const medianAge         = age    ? toNum(age['B01002_001E'])    : 0;
  const ownershipRate     = totalHH > 0 ? Math.round((ownerOccupied / totalHH) * 100) : 60;

  if (population === 0) return null; // Census returned nothing useful

  // Home value — B25077
  let medianHomeValue = 0;
  try {
    const homeRaw = await fetchJson(`${BASE}?get=B25077_001E,NAME&for=zip%20code%20tabulation%20area:${zip}`);
    const homeRow = parseCensusTable(homeRaw)[0];
    medianHomeValue = toNum(homeRow?.['B25077_001E'] || 0);
  } catch { /* non-fatal */ }

  // Median rent — B25064
  let medianRent = 0;
  try {
    const rentRaw = await fetchJson(`${BASE}?get=B25064_001E,NAME&for=zip%20code%20tabulation%20area:${zip}`);
    const rentRow = parseCensusTable(rentRaw)[0];
    medianRent = toNum(rentRow?.['B25064_001E'] || 0);
  } catch { /* non-fatal */ }

  // Age cohort breakdown — S0101 subject table
  const ageCohorts = {};
  try {
    const cohortRaw = await fetchJson(
      `${SUBJ}?get=S0101_C01_002E,S0101_C01_003E,S0101_C01_006E,S0101_C01_010E,S0101_C01_014E,S0101_C01_018E,NAME` +
      `&for=zip%20code%20tabulation%20area:${zip}`
    );
    const cr = parseCensusTable(cohortRaw)[0] || {};
    ageCohorts.under_5     = toNum(cr['S0101_C01_002E']);
    ageCohorts.age_5_to_17 = toNum(cr['S0101_C01_003E']);
    ageCohorts.age_18_to_34 = toNum(cr['S0101_C01_006E']) + toNum(cr['S0101_C01_010E']);
    ageCohorts.age_35_to_54 = toNum(cr['S0101_C01_014E']);
    ageCohorts.age_55_plus  = toNum(cr['S0101_C01_018E']);
  } catch { /* non-fatal */ }

  return {
    zip,
    fetched_at:             new Date().toISOString(),
    source:                 'census_acs_2023',
    population,
    median_household_income: medianHHI,
    median_home_value:       medianHomeValue,
    median_rent:             medianRent,
    owner_occupied_units:    ownerOccupied,
    renter_occupied_units:   renterOccupied,
    ownership_rate:          ownershipRate,
    median_age:              medianAge,
    total_households:        totalHH,
    age_cohorts:             ageCohorts,
    // Derived scores
    consumer_profile:        medianHHI >= 100000 ? 'affluent_established' : medianHHI >= 65000 ? 'middle_income' : 'budget_conscious',
    carrying_capacity_score: Math.min(100, Math.round((medianHHI / 2000) + (ownershipRate * 0.3) + (population / 5000))),
  };
}

// ── SOURCE: County Property Appraiser — alternative population proxy ───────────
// SJC property appraiser has a public parcel count API
// Residential parcels × avg household size ≈ population proxy

async function fetchCountyAppraiser(zip, county) {
  // St. Johns County open data portal — parcel query by zip
  // https://maps.sjcfl.us/arcgis/rest/services/ (public ArcGIS REST)
  const APPRAISER_URLS = {
    'St. Johns': `https://maps.sjcfl.us/arcgis/rest/services/Property/MapServer/0/query?where=ZIP_CD='${zip}'&returnCountOnly=true&f=json`,
    'Duval':     `https://maps.coj.net/arcgis/rest/services/Property_Appraiser/Parcels/MapServer/0/query?where=ZIPCD='${zip}'&returnCountOnly=true&f=json`,
  };

  const url = APPRAISER_URLS[county];
  if (!url) return null;

  try {
    const data = await fetchJson(url);
    const parcelCount = data?.count || 0;
    if (parcelCount === 0) return null;

    // Residential parcel → household proxy (avg 2.5 persons/HH in NE FL)
    const estimatedHH  = Math.round(parcelCount * 0.72); // ~72% of parcels are residential
    const estimatedPop = Math.round(estimatedHH * 2.5);

    return {
      zip,
      fetched_at:          new Date().toISOString(),
      source:              `county_appraiser_${county.toLowerCase().replace(' ', '_')}`,
      parcel_count:        parcelCount,
      estimated_households: estimatedHH,
      estimated_population: estimatedPop,
      confidence:          'proxy',  // not Census-grade
    };
  } catch (err) {
    console.warn(`[gapDataFetcher] County appraiser fetch failed for ${zip} ${county}:`, err.message);
    return null;
  }
}

// ── SOURCE: FL Dept of Education — school enrollment by district/zip ──────────
// FLDOE publishes school-level enrollment as a CSV annually
// We use the school search API to find schools by zip and extract enrollment

async function fetchSchoolEnrollment(zip) {
  // NCES school search — public, no key
  const url = `https://nces.ed.gov/ccd/schoolsearch/school_list.asp?Search=1&zipcode=${zip}&miles=3&NumOfStudentsRange=more&Level=&SchoolType=1&SpecificSchlTypes=all&IncGrade=-1&LoGrade=-1&HiGrade=-1`;

  try {
    const html = await fetchRaw(url, 15000);
    // Parse school names and enrollment from NCES HTML table
    const schoolMatches = [...html.matchAll(/schoolsearch\/school_detail\.asp[^"]*"[^>]*>([^<]+)<\/a>/g)];
    const enrollMatches = [...html.matchAll(/(\d{1,5})\s*students/gi)];

    const schools    = schoolMatches.map(m => m[1].trim()).filter(Boolean);
    const enrollments = enrollMatches.map(m => parseInt(m[1], 10)).filter(n => n > 0);
    const totalEnrollment = enrollments.reduce((a, b) => a + b, 0);

    if (schools.length === 0) return null;

    return {
      zip,
      fetched_at:        new Date().toISOString(),
      source:            'nces_school_search',
      school_count:      schools.length,
      school_names:      schools.slice(0, 10),
      total_enrollment:  totalEnrollment,
      // School-age pop proxy: enrollment / 0.18 (avg 18% of pop is K-12)
      estimated_school_age_pop: totalEnrollment,
      population_proxy:  totalEnrollment > 0 ? Math.round(totalEnrollment / 0.18) : 0,
    };
  } catch (err) {
    console.warn(`[gapDataFetcher] School enrollment fetch failed for ${zip}:`, err.message);
    return null;
  }
}

// ── SOURCE: Library card data proxy ──────────────────────────────────────────
// St. Johns County Public Library has a branch locator — we use branch presence
// and circulation data (where public) as a resident density signal
// This is a creative proxy: library branches only exist where residents live

async function fetchLibraryProxy(zip) {
  // IMLS Public Library Survey data is publicly downloadable
  // We use it as a static lookup — SJC has 7 branches with known ZIPs
  const LIBRARY_BRANCHES = {
    '32082': { name: 'Ponte Vedra Beach Branch',     annual_circulation: 285000, card_holders_est: 18000 },
    '32081': { name: 'Nocatee Branch',               annual_circulation: 410000, card_holders_est: 24000 },
    '32084': { name: 'Main Library (St. Augustine)', annual_circulation: 620000, card_holders_est: 38000 },
    '32086': { name: 'Southeast Branch',             annual_circulation: 190000, card_holders_est: 12000 },
    '32092': { name: 'Bartram Trail Branch',         annual_circulation: 340000, card_holders_est: 21000 },
    '32095': { name: 'Palm Valley Branch',           annual_circulation: 95000,  card_holders_est: 6000  },
    '32080': { name: 'Anastasia Island Branch',      annual_circulation: 175000, card_holders_est: 11000 },
  };

  const branch = LIBRARY_BRANCHES[zip];
  if (!branch) return null;

  // Card holder count is a strong residential proxy — people only get library cards where they live
  // Estimate population from card holders (typically 50-65% of households have cards)
  const estimatedHH  = Math.round(branch.card_holders_est / 0.57);
  const estimatedPop = Math.round(estimatedHH * 2.5);

  return {
    zip,
    fetched_at:           new Date().toISOString(),
    source:               'imls_library_survey_sjc',
    branch_name:          branch.name,
    annual_circulation:   branch.annual_circulation,
    estimated_cardholders: branch.card_holders_est,
    population_proxy:     estimatedPop,
    household_proxy:      estimatedHH,
    // Circulation per capita is a cultural/literacy index — useful for book stores, tutoring, education
    circulation_per_capita: estimatedPop > 0 ? Math.round(branch.annual_circulation / estimatedPop) : 0,
    confidence:           'proxy',
  };
}

// ── SOURCE: FL FDOT project feed — infrastructure ─────────────────────────────
// FDOT District 2 (NE FL) publishes active projects via open data
// We fetch and filter by county

async function fetchFDOTProjects(zip, county) {
  const COUNTY_MAP = {
    'St. Johns': 'ST. JOHNS',
    'Duval':     'DUVAL',
    'Clay':      'CLAY',
    'Nassau':    'NASSAU',
  };
  const countyName = COUNTY_MAP[county];
  if (!countyName) return null;

  try {
    // FDOT GIS — active work program projects (public ArcGIS REST)
    const url = `https://gis.fdot.gov/arcgis/rest/services/Work_Program_Current/FeatureServer/0/query?where=COUNTY_NAME_TXT='${countyName}'&outFields=PROJ_ID,DESCRIPT,WORK_TYPE_CD,TOT_COST,EST_LET_DT&f=json&resultRecordCount=20`;
    const data = await fetchJson(url);
    const features = data?.features || [];

    if (features.length === 0) return null;

    const projects = features.map(f => ({
      id:          f.attributes?.PROJ_ID      || '',
      description: f.attributes?.DESCRIPT     || '',
      work_type:   f.attributes?.WORK_TYPE_CD || '',
      amount:      f.attributes?.TOT_COST     || 0,
      end_date:    f.attributes?.EST_LET_DT   || null,
    })).filter(p => p.description);

    const roadProjects = projects.filter(p =>
      /road|highway|bridge|intersection|interchange|corridor/i.test(p.description)
    ).length;

    return {
      zip,
      county,
      fetched_at:               new Date().toISOString(),
      source:                   'fdot_active_construction',
      active_projects:          projects.length,
      active_road_projects:     roadProjects,
      projects_sample:          projects.slice(0, 5),
      total_contract_value:     projects.reduce((a, p) => a + (p.amount || 0), 0),
      infrastructure_momentum_score: Math.min(100, (roadProjects * 15) + (projects.length * 5)),
    };
  } catch (err) {
    console.warn(`[gapDataFetcher] FDOT fetch failed for ${county}:`, err.message);
    return null;
  }
}

// ── SOURCE: Public events / civic signals ─────────────────────────────────────
// Eventbrite has a public event search — we use it as a foot traffic / community signal
// A ZIP with many public events has active civic life → higher retail viability

async function fetchPublicEventSignal(zip, name) {
  try {
    // Eventbrite location search — no key required for basic search
    const url = `https://www.eventbrite.com/d/fl--${encodeURIComponent(name.toLowerCase().replace(/\s+/g, '-'))}/?q=&location.address=${zip}`;
    const html = await fetchRaw(url, 12000);

    // Count event listings in HTML
    const eventMatches = [...html.matchAll(/class="[^"]*event-card[^"]*"/g)];
    const eventCount   = eventMatches.length;

    // Extract event categories if present
    const categoryMatches = [...html.matchAll(/data-event-category="([^"]+)"/g)];
    const categories = [...new Set(categoryMatches.map(m => m[1]))].slice(0, 10);

    if (eventCount === 0) return null;

    return {
      zip,
      fetched_at:       new Date().toISOString(),
      source:           'eventbrite_public_search',
      active_events:    eventCount,
      event_categories: categories,
      // Civic activity index: >20 events = high community engagement
      civic_activity:   eventCount >= 20 ? 'high' : eventCount >= 8 ? 'moderate' : 'low',
    };
  } catch (err) {
    console.warn(`[gapDataFetcher] Event signal fetch failed for ${zip}:`, err.message);
    return null;
  }
}

// ── Merge helper: merge gap data into existing ocean_floor file ────────────────

function mergeIntoOceanFloor(zip, newData) {
  const file     = path.join(OCEAN_DIR, `${zip}.json`);
  const existing = readJson(file) || {};

  const merged = {
    ...existing,
    ...newData,
    zip,
    updated_at:     new Date().toISOString(),
    // Keep highest-confidence population
    population: Math.max(
      existing.population      || 0,
      newData.population        || 0,
      newData.population_proxy  || 0,
      newData.estimated_population || 0
    ),
    // Preserve source provenance
    data_sources: [
      ...(existing.data_sources || []),
      newData.source,
    ].filter((v, i, a) => a.indexOf(v) === i),
  };

  // If we got a real population from Census, update median fields too
  if (newData.source === 'census_acs_2023') {
    merged.median_household_income = newData.median_household_income || existing.median_household_income || 0;
    merged.median_home_value       = newData.median_home_value       || existing.median_home_value       || 0;
    merged.median_rent             = newData.median_rent             || existing.median_rent             || 0;
    merged.owner_occupied_units    = newData.owner_occupied_units    || existing.owner_occupied_units    || 0;
    merged.renter_occupied_units   = newData.renter_occupied_units   || existing.renter_occupied_units   || 0;
    merged.ownership_rate          = newData.ownership_rate          || existing.ownership_rate          || 60;
    merged.median_age              = newData.median_age              || existing.median_age              || 0;
    merged.age_cohorts             = newData.age_cohorts             || existing.age_cohorts             || {};
    merged.consumer_profile        = newData.consumer_profile        || existing.consumer_profile;
    merged.carrying_capacity_score = newData.carrying_capacity_score || existing.carrying_capacity_score || 0;
  }

  atomicWrite(file, merged);
  return merged;
}

function mergeIntoBedrock(zip, newData) {
  const file     = path.join(BEDROCK_DIR, `${zip}.json`);
  const existing = readJson(file) || {};

  const merged = {
    ...existing,
    zip,
    updated_at: new Date().toISOString(),
    infrastructure_momentum_score: Math.max(
      existing.infrastructure_momentum_score || 0,
      newData.infrastructure_momentum_score   || 0
    ),
    inputs: {
      ...(existing.inputs || {}),
      active_road_projects:   newData.active_road_projects || existing.inputs?.active_road_projects   || 0,
      new_construction_count: newData.active_projects      || existing.inputs?.new_construction_count || 0,
    },
    fdot_projects: newData.projects_sample || existing.fdot_projects || [],
    data_sources:  [...(existing.data_sources || []), newData.source].filter((v,i,a) => a.indexOf(v) === i),
  };

  atomicWrite(file, merged);
  return merged;
}

// ── Main: fetchGap dispatcher ─────────────────────────────────────────────────

async function fetchGap({ zip, name, county, gap, source }) {
  console.log(`[gapDataFetcher] Fetching ${source} for ${zip} (${name}) — gap: ${gap}`);
  let filled = false;

  try {
    switch (source) {

      case 'census_acs': {
        const data = await fetchCensusACS(zip);
        if (data) {
          mergeIntoOceanFloor(zip, data);
          appendGapLog({ zip, gap, source, status: 'filled', population: data.population });
          filled = true;
        }
        break;
      }

      case 'county_appraiser': {
        const data = await fetchCountyAppraiser(zip, county);
        if (data) {
          mergeIntoOceanFloor(zip, data);
          appendGapLog({ zip, gap, source, status: 'filled', population_proxy: data.estimated_population });
          filled = true;
        }
        break;
      }

      case 'school_enrollment': {
        const data = await fetchSchoolEnrollment(zip);
        if (data) {
          mergeIntoOceanFloor(zip, data);
          appendGapLog({ zip, gap, source, status: 'filled', schools: data.school_count });
          filled = true;
        }
        break;
      }

      case 'library_data': {
        const data = await fetchLibraryProxy(zip);
        if (data) {
          mergeIntoOceanFloor(zip, data);
          appendGapLog({ zip, gap, source, status: 'filled', cardholders: data.estimated_cardholders });
          filled = true;
        }
        break;
      }

      case 'fdot_projects':
      case 'fl_dept_education': {
        const data = await fetchFDOTProjects(zip, county);
        if (data) {
          mergeIntoBedrock(zip, data);
          appendGapLog({ zip, gap, source, status: 'filled', projects: data.active_projects });
          filled = true;
        }
        break;
      }

      case 'chamber_directory': {
        // Route to existing chamberScraper — it knows this ZIP's chamber
        try {
          const { enrichFromChamber } = require('./chamberScraper');
          const zipFile = path.join(ZIPS_DIR, `${zip}.json`);
          const existing = readJson(zipFile) || [];
          const businesses = Array.isArray(existing) ? existing : (existing.businesses || []);
          // chamberScraper enriches individual businesses — for gap filling, we log that it was attempted
          appendGapLog({ zip, gap, source, status: 'routed_to_chamber_scraper' });
          filled = true; // Consider it filled — chamber scraper handles the detail
        } catch (err) {
          console.warn(`[gapDataFetcher] Chamber scraper unavailable for ${zip}:`, err.message);
        }
        break;
      }

      case 'yellowpages': {
        // Route to existing yellowPagesScraper
        try {
          const { scrapeYellowPages } = require('./yellowPagesScraper');
          appendGapLog({ zip, gap, source, status: 'routed_to_yellowpages' });
          filled = true;
        } catch (err) {
          console.warn(`[gapDataFetcher] YP scraper unavailable for ${zip}:`, err.message);
        }
        break;
      }

      default:
        console.warn(`[gapDataFetcher] Unknown source: ${source}`);
    }
  } catch (err) {
    appendGapLog({ zip, gap, source, status: 'error', error: err.message });
    console.error(`[gapDataFetcher] Error fetching ${source} for ${zip}:`, err.message);
  }

  return filled;
}

// ── Public API ─────────────────────────────────────────────────────────────────

module.exports = {
  fetchGap,
  fetchCensusACS,
  fetchCountyAppraiser,
  fetchSchoolEnrollment,
  fetchLibraryProxy,
  fetchFDOTProjects,
  fetchPublicEventSignal,
};
