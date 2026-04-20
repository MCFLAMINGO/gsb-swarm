'use strict';
/**
 * oceanFloorWorker.js
 *
 * Layer 1 — OCEAN FLOOR
 * Weekly Census ACS + CBP pull for SJC ZIPs.
 *
 * Fetches:
 *  - Census ACS 5-year: S1501 (education), S1201 (marital status),
 *    S2501/B25003 (occupancy), S1901 (income)
 *  - Census CBP 2021: St. Johns County FIPS 12109 (NAICS by estab + emp)
 *
 * Computes per-ZIP:
 *  - carrying_capacity_score (0-100)
 *  - consumer_profile
 *  - market_saturation_index
 *  - missing_sectors
 *
 * Writes data/ocean_floor/{zip}.json + data/ocean_floor/_index.json
 * Schedule: immediate on start, then weekly (~7 days)
 */

const path = require('path');
const fs   = require('fs');

const DATA_DIR       = path.join(__dirname, '..', 'data');
const OCEAN_DIR      = path.join(DATA_DIR, 'ocean_floor');
const ERRORS_FILE    = path.join(OCEAN_DIR, '_errors.json');
const INDEX_FILE     = path.join(OCEAN_DIR, '_index.json');

// ── ZIP registry ─────────────────────────────────────────────────────────────
const SJC_ZIPS = [
  { zip: '32082', name: 'Ponte Vedra Beach'  },
  { zip: '32081', name: 'Nocatee'            },
  { zip: '32092', name: 'World Golf Village' },
  { zip: '32084', name: 'St. Augustine'      },
  { zip: '32086', name: 'St. Augustine South' },
  { zip: '32080', name: 'St. Augustine Beach' },
];

// ── NAICS sector reference (top-level 2-digit) ────────────────────────────────
const NAICS_SECTORS = {
  '11': 'Agriculture, Forestry, Fishing',
  '21': 'Mining, Quarrying, Oil & Gas',
  '22': 'Utilities',
  '23': 'Construction',
  '31': 'Manufacturing',
  '32': 'Manufacturing',
  '33': 'Manufacturing',
  '42': 'Wholesale Trade',
  '44': 'Retail Trade',
  '45': 'Retail Trade',
  '48': 'Transportation & Warehousing',
  '49': 'Transportation & Warehousing',
  '51': 'Information',
  '52': 'Finance & Insurance',
  '53': 'Real Estate & Rental',
  '54': 'Professional & Technical Services',
  '55': 'Management of Companies',
  '56': 'Admin & Support Services',
  '61': 'Educational Services',
  '62': 'Health Care & Social Assistance',
  '71': 'Arts, Entertainment & Recreation',
  '72': 'Accommodation & Food Services',
  '81': 'Other Services',
  '92': 'Public Administration',
};

// ── Utilities ─────────────────────────────────────────────────────────────────

function ensureDirs() {
  [DATA_DIR, OCEAN_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function logError(context, err) {
  console.log(`[oceanFloorWorker] ERROR [${context}]:`, err.message || err);
  let errors = [];
  try { errors = JSON.parse(fs.readFileSync(ERRORS_FILE, 'utf8')); } catch (_) {}
  errors.push({ ts: new Date().toISOString(), context, message: err.message || String(err) });
  if (errors.length > 200) errors = errors.slice(-200);
  try { atomicWrite(ERRORS_FILE, errors); } catch (_) {}
}

async function safeFetch(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parse Census API array response.
 * Row 0 = headers, rows 1+ = data.
 * Returns array of objects keyed by header names.
 */
function parseCensusTable(raw) {
  if (!Array.isArray(raw) || raw.length < 2) return [];
  const [headers, ...rows] = raw;
  return rows.map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

function toNum(val) {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

// ── ACS fetchers ──────────────────────────────────────────────────────────────

/**
 * S1501 — Educational Attainment
 * S1501_C02_015E = % bachelor's or higher (civilian 25+)
 * S1501_C02_012E = % HS diploma or higher (civilian 25+)
 */
async function fetchEducation(zip) {
  const url =
    `https://api.census.gov/data/2023/acs/acs5/subject` +
    `?get=S1501_C02_015E,S1501_C02_012E,NAME` +
    `&for=zip%20code%20tabulation%20area:${zip}`;
  try {
    const raw = await safeFetch(url);
    const rows = parseCensusTable(raw);
    if (!rows.length) throw new Error('empty response');
    const r = rows[0];
    return {
      pct_bachelors_plus: toNum(r['S1501_C02_015E']),
      pct_hs_plus:        toNum(r['S1501_C02_012E']),
    };
  } catch (err) {
    logError(`education-${zip}`, err);
    return { pct_bachelors_plus: 0, pct_hs_plus: 0 };
  }
}

/**
 * S1201 — Marital Status
 * S1201_C01_001E = total pop 15+
 * S1201_C02_001E = now married (excl separated)
 * S1201_C05_001E = divorced
 * We compute pct_never_married from remainder.
 */
async function fetchMaritalStatus(zip) {
  const url =
    `https://api.census.gov/data/2023/acs/acs5/subject` +
    `?get=S1201_C01_001E,S1201_C02_001E,S1201_C05_001E,NAME` +
    `&for=zip%20code%20tabulation%20area:${zip}`;
  try {
    const raw = await safeFetch(url);
    const rows = parseCensusTable(raw);
    if (!rows.length) throw new Error('empty response');
    const r = rows[0];
    const total   = toNum(r['S1201_C01_001E']);
    const married = toNum(r['S1201_C02_001E']);
    const divorced = toNum(r['S1201_C05_001E']);
    if (total === 0) return { pct_married: 0, pct_divorced: 0, pct_never_married: 0 };
    const pct_married      = Math.round((married  / total) * 1000) / 10;
    const pct_divorced     = Math.round((divorced / total) * 1000) / 10;
    // never married estimated as remainder of major categories
    const pct_never_married = Math.max(0, Math.round((100 - pct_married - pct_divorced) * 10) / 10);
    return { pct_married, pct_divorced, pct_never_married };
  } catch (err) {
    logError(`marital-${zip}`, err);
    return { pct_married: 0, pct_divorced: 0, pct_never_married: 0 };
  }
}

/**
 * B25003 — Housing tenure (Occupancy)
 * B25003_001E = total occupied housing units
 * B25003_002E = owner-occupied
 * B25003_003E = renter-occupied
 * Note: S2501 seasonal vacancy requires subject endpoint; we fall back to B25004 for vacant/seasonal.
 */
async function fetchOccupancy(zip) {
  const tenureUrl =
    `https://api.census.gov/data/2023/acs/acs5` +
    `?get=B25003_001E,B25003_002E,B25003_003E,NAME` +
    `&for=zip%20code%20tabulation%20area:${zip}`;
  // B25004_006E = vacant — for seasonal/recreational use
  const vacantUrl =
    `https://api.census.gov/data/2023/acs/acs5` +
    `?get=B25002_001E,B25004_006E,NAME` +
    `&for=zip%20code%20tabulation%20area:${zip}`;

  let owner_pct = 0, renter_pct = 0, seasonal_pct = 0;

  try {
    const raw = await safeFetch(tenureUrl);
    const rows = parseCensusTable(raw);
    if (rows.length) {
      const r = rows[0];
      const total  = toNum(r['B25003_001E']);
      const owner  = toNum(r['B25003_002E']);
      const renter = toNum(r['B25003_003E']);
      if (total > 0) {
        owner_pct  = Math.round((owner  / total) * 1000) / 10;
        renter_pct = Math.round((renter / total) * 1000) / 10;
      }
    }
  } catch (err) {
    logError(`occupancy-tenure-${zip}`, err);
  }

  try {
    const raw2 = await safeFetch(vacantUrl);
    const rows2 = parseCensusTable(raw2);
    if (rows2.length) {
      const r2 = rows2[0];
      const totalHousing  = toNum(r2['B25002_001E']);
      const seasonalVacant = toNum(r2['B25004_006E']);
      if (totalHousing > 0) {
        seasonal_pct = Math.round((seasonalVacant / totalHousing) * 1000) / 10;
      }
    }
  } catch (err) {
    logError(`occupancy-seasonal-${zip}`, err);
  }

  return { owner_pct, renter_pct, seasonal_pct };
}

/**
 * S1901 — Household Income
 * S1901_C01_012E = median household income in the past 12 months
 */
async function fetchIncome(zip) {
  const url =
    `https://api.census.gov/data/2023/acs/acs5/subject` +
    `?get=S1901_C01_012E,NAME` +
    `&for=zip%20code%20tabulation%20area:${zip}`;
  try {
    const raw = await safeFetch(url);
    const rows = parseCensusTable(raw);
    if (!rows.length) throw new Error('empty response');
    const r = rows[0];
    return { median_household_income: toNum(r['S1901_C01_012E']) };
  } catch (err) {
    logError(`income-${zip}`, err);
    return { median_household_income: 0 };
  }
}

// ── CBP fetcher ───────────────────────────────────────────────────────────────

/**
 * County Business Patterns — St. Johns County FIPS 12109
 * Returns { total_establishments, total_employees, by_naics2 }
 */
async function fetchCBP() {
  const url =
    `https://api.census.gov/data/2021/cbp` +
    `?get=NAICS2017,ESTAB,EMP` +
    `&for=county:109&in=state:12`;
  try {
    const raw = await safeFetch(url);
    const rows = parseCensusTable(raw);
    console.log(`[oceanFloorWorker] CBP rows: ${rows.length}`);

    let total_establishments = 0;
    let total_employees      = 0;
    const by_naics2 = {};

    for (const r of rows) {
      const naics = (r['NAICS2017'] || '').trim();
      if (!naics || naics === '00' || naics.includes('-')) continue; // skip totals / ranges
      const estab = toNum(r['ESTAB']);
      const emp   = toNum(r['EMP']);
      const sector = naics.substring(0, 2);
      if (!by_naics2[sector]) by_naics2[sector] = { establishments: 0, employees: 0 };
      by_naics2[sector].establishments += estab;
      by_naics2[sector].employees      += emp;
      total_establishments += estab;
      total_employees      += emp;
    }

    return { total_establishments, total_employees, by_naics2 };
  } catch (err) {
    logError('cbp', err);
    console.log('[oceanFloorWorker] CBP unavailable — using empty data');
    return { total_establishments: 0, total_employees: 0, by_naics2: {} };
  }
}

// ── Scoring & profiling ───────────────────────────────────────────────────────

/**
 * carrying_capacity_score (0-100): weighted blend of income + education + owner_occupied rate.
 *
 * Income weight 50%:  normalise $0–$200k → 0–50
 * Education weight 30%: % bachelor's → 0–30  (100% → 30)
 * Owner-occupied 20%: % owner → 0–20  (100% → 20)
 */
function computeCarryingCapacity({ median_household_income, pct_bachelors_plus, owner_pct }) {
  const income_score    = Math.min(50, (median_household_income / 200_000) * 50);
  const education_score = Math.min(30, (pct_bachelors_plus / 100) * 30);
  const owner_score     = Math.min(20, (owner_pct / 100) * 20);
  return Math.round(income_score + education_score + owner_score);
}

/**
 * consumer_profile determination based on income, age/marital proxy, tenure.
 */
function computeConsumerProfile({ median_household_income, pct_bachelors_plus, owner_pct,
                                   renter_pct, pct_married, pct_never_married }) {
  if (median_household_income >= 100_000 && owner_pct >= 65) {
    return 'affluent_established';
  }
  if (median_household_income >= 70_000 && pct_married >= 50 && owner_pct >= 55) {
    return 'growing_families';
  }
  if (renter_pct >= 45 && pct_never_married >= 35) {
    return 'young_renters';
  }
  if (median_household_income < 50_000 && owner_pct < 50) {
    return 'working_class';
  }
  return 'mixed';
}

/**
 * market_saturation_index: establishments per 1,000 residents vs US average.
 * US average ≈ 30 establishments per 1,000 people.
 * Negative = under-served, positive = saturated.
 */
function computeMarketSaturation(total_establishments, zip_population) {
  const NATIONAL_AVG_PER_1K = 30;
  if (!zip_population || zip_population <= 0) return null;
  const local_per_1k = (total_establishments / zip_population) * 1000;
  return Math.round((local_per_1k - NATIONAL_AVG_PER_1K) * 10) / 10;
}

/**
 * missing_sectors: NAICS 2-digit sectors with 0 CBP estabs, but ZIP has high income/edu signal.
 * "High signal" = carrying_capacity_score >= 60.
 */
function computeMissingSectors(by_naics2, carrying_capacity_score) {
  if (carrying_capacity_score < 60) return [];
  // Sectors most likely to have demand in affluent communities
  const TARGET_SECTORS = ['52', '54', '61', '62', '71', '72', '53', '44', '45'];
  return TARGET_SECTORS
    .filter(s => !by_naics2[s] || by_naics2[s].establishments === 0)
    .map(s => ({ naics2: s, description: NAICS_SECTORS[s] || s }));
}

// ── Per-ZIP process ───────────────────────────────────────────────────────────

async function processZip(zipEntry, cbpData) {
  const { zip, name } = zipEntry;
  console.log(`[oceanFloorWorker] Processing ${zip} (${name})`);

  // Fetch all ACS tables in parallel
  const [education, marital, occupancy, income] = await Promise.all([
    fetchEducation(zip),
    fetchMaritalStatus(zip),
    fetchOccupancy(zip),
    fetchIncome(zip),
  ]);

  const carrying_capacity_score = computeCarryingCapacity({
    median_household_income: income.median_household_income,
    pct_bachelors_plus:      education.pct_bachelors_plus,
    owner_pct:               occupancy.owner_pct,
  });

  const consumer_profile = computeConsumerProfile({
    median_household_income: income.median_household_income,
    pct_bachelors_plus:      education.pct_bachelors_plus,
    owner_pct:               occupancy.owner_pct,
    renter_pct:              occupancy.renter_pct,
    pct_married:             marital.pct_married,
    pct_never_married:       marital.pct_never_married,
  });

  // Estimate population from CBP: use total_employees as a loose proxy if no other data
  // We don't have per-ZIP pop from CBP; use median income to scale a rough estimate
  // Better: use ACS B01003_001E if available; for now we note it as null for saturation
  const market_saturation_index = null; // Requires population figure not in scope here

  const missing_sectors = computeMissingSectors(cbpData.by_naics2, carrying_capacity_score);

  const result = {
    zip,
    name,
    updated_at: new Date().toISOString(),
    census: {
      education,
      marital_status: marital,
      occupancy,
      income,
    },
    carrying_capacity_score,
    consumer_profile,
    market_saturation_index,
    missing_sectors,
    cbp_county_summary: {
      total_establishments: cbpData.total_establishments,
      total_employees:      cbpData.total_employees,
      sectors_present:      Object.keys(cbpData.by_naics2).length,
    },
  };

  const outPath = path.join(OCEAN_DIR, `${zip}.json`);
  atomicWrite(outPath, result);
  console.log(`[oceanFloorWorker] Wrote ${outPath} — profile: ${consumer_profile}, score: ${carrying_capacity_score}`);
  return result;
}

// ── Full run ──────────────────────────────────────────────────────────────────

async function runOceanFloor() {
  console.log(`[oceanFloorWorker] Starting run at ${new Date().toISOString()}`);
  ensureDirs();

  // Fetch CBP once for the county (shared across all ZIPs)
  const cbpData = await fetchCBP();

  const index = {
    updated_at: new Date().toISOString(),
    zips: [],
  };

  for (const zipEntry of SJC_ZIPS) {
    try {
      const result = await processZip(zipEntry, cbpData);
      index.zips.push({
        zip:                    result.zip,
        name:                   result.name,
        carrying_capacity_score: result.carrying_capacity_score,
        consumer_profile:        result.consumer_profile,
        updated_at:              result.updated_at,
      });
    } catch (err) {
      logError(`processZip-${zipEntry.zip}`, err);
      console.log(`[oceanFloorWorker] Skipping ${zipEntry.zip} after error`);
    }
  }

  atomicWrite(INDEX_FILE, index);
  console.log(`[oceanFloorWorker] Run complete. Index written to ${INDEX_FILE}`);
}

// ── Scheduling ────────────────────────────────────────────────────────────────

const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;

// ── Error guard ───────────────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  try { logError('uncaughtException', err); } catch (_) {}
  console.log('[oceanFloorWorker] Uncaught exception (recovered):', err.message);
});

process.on('unhandledRejection', (reason) => {
  try { logError('unhandledRejection', { message: String(reason) }); } catch (_) {}
  console.log('[oceanFloorWorker] Unhandled rejection (recovered):', reason);
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

(async () => {
  // Initial run on start
  await runOceanFloor();

  // Weekly recurring
  setInterval(async () => {
    try { await runOceanFloor(); }
    catch (err) { logError('weeklyInterval', err); }
  }, WEEKLY_MS);

  console.log(`[oceanFloorWorker] Scheduled: weekly (${WEEKLY_MS}ms)`);
})();
