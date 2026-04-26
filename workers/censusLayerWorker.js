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

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const pgStore = require('../lib/pgStore');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const LAYER_DIR   = path.join(DATA_DIR, 'census_layer');
const ZIPS_DIR    = path.join(DATA_DIR, 'zips');
const ORACLE_DIR  = path.join(DATA_DIR, 'oracle');

// ── County FIPS map ────────────────────────────────────────────────────────────
const COUNTY_CONFIG = [
  { name: 'St. Johns', state: '12', county: '109', fips: '12109' },
  { name: 'Duval',     state: '12', county: '031', fips: '12031' },
  { name: 'Clay',      state: '12', county: '019', fips: '12019' },
  { name: 'Nassau',    state: '12', county: '089', fips: '12089' },
];

// ── ZIP registry ───────────────────────────────────────────────────────────────
const ALL_ZIPS = [
  { zip: '32081', name: 'Nocatee',                  county: 'St. Johns', state: '12', countyFips: '109' },
  { zip: '32082', name: 'Ponte Vedra Beach',         county: 'St. Johns', state: '12', countyFips: '109' },
  { zip: '32092', name: 'World Golf Village',        county: 'St. Johns', state: '12', countyFips: '109' },
  { zip: '32084', name: 'St. Augustine',             county: 'St. Johns', state: '12', countyFips: '109' },
  { zip: '32086', name: 'St. Augustine South',       county: 'St. Johns', state: '12', countyFips: '109' },
  { zip: '32095', name: 'Palm Valley',               county: 'St. Johns', state: '12', countyFips: '109' },
  { zip: '32080', name: 'St. Augustine Beach',       county: 'St. Johns', state: '12', countyFips: '109' },
  { zip: '32259', name: 'Fruit Cove / Saint Johns',  county: 'St. Johns', state: '12', countyFips: '109' },
  { zip: '32250', name: 'Jacksonville Beach',        county: 'Duval',     state: '12', countyFips: '031' },
  { zip: '32266', name: 'Neptune Beach',             county: 'Duval',     state: '12', countyFips: '031' },
  { zip: '32258', name: 'Bartram Park',              county: 'Duval',     state: '12', countyFips: '031' },
  { zip: '32226', name: 'North Jacksonville',        county: 'Duval',     state: '12', countyFips: '031' },
  { zip: '32003', name: 'Fleming Island',            county: 'Clay',      state: '12', countyFips: '019' },
  { zip: '32034', name: 'Fernandina Beach',          county: 'Nassau',    state: '12', countyFips: '089' },
  { zip: '32065', name: 'Orange Park / Oakleaf',     county: 'Clay',      state: '12', countyFips: '019' },
  { zip: '32097', name: 'Yulee',                     county: 'Nassau',    state: '12', countyFips: '089' },
  { zip: '32256', name: 'Baymeadows / Tinseltown',   county: 'Duval',     state: '12', countyFips: '031' },
  { zip: '32257', name: 'Mandarin South',            county: 'Duval',     state: '12', countyFips: '031' },
  { zip: '32224', name: 'Jacksonville Intracoastal', county: 'Duval',     state: '12', countyFips: '031' },
  { zip: '32225', name: 'Jacksonville Arlington',    county: 'Duval',     state: '12', countyFips: '031' },
  { zip: '32246', name: 'Jacksonville Regency',      county: 'Duval',     state: '12', countyFips: '031' },
  { zip: '32233', name: 'Atlantic Beach',            county: 'Duval',     state: '12', countyFips: '031' },
  { zip: '32211', name: 'Jacksonville East',         county: 'Duval',     state: '12', countyFips: '031' },
  { zip: '32216', name: 'Southside Blvd',            county: 'Duval',     state: '12', countyFips: '031' },
  { zip: '32217', name: 'San Jose',                  county: 'Duval',     state: '12', countyFips: '031' },
  { zip: '32207', name: 'Jacksonville Southbank',    county: 'Duval',     state: '12', countyFips: '031' },
  { zip: '32073', name: 'Orange Park',               county: 'Clay',      state: '12', countyFips: '019' },
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

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function atomicWrite(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function ensureDirs() {
  [LAYER_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
}

// ── LAYER 1: ZBP — ZIP Business Patterns 2018 ─────────────────────────────────
// Employment + establishment count by NAICS sector, per ZIP
// Vintage 2018 — pulled once on startup, never re-fetched (data doesn't change)

async function ingestZBP() {
  const stateFile = path.join(LAYER_DIR, '_zbp_ingested.json');
  if (fs.existsSync(stateFile)) {
    const s = readJson(stateFile);
    console.log('[censusLayer] ZBP already ingested at', s?.ingested_at, '— skipping');
    return;
  }

  console.log('[censusLayer] ZBP: fetching 2018 ZIP Business Patterns for all ZIPs...');
  const ZIP_LIST = ALL_ZIPS.map(z => z.zip).join(',');

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

  const zipMeta = Object.fromEntries(ALL_ZIPS.map(z => [z.zip, z]));

  for (const [zip, zipRows] of Object.entries(byZip)) {
    const total    = zipRows.find(r => r.NAICS2017 === '00') || {};
    const existing = readJson(path.join(LAYER_DIR, `${zip}.json`)) || {};

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

    // Employment density (employees per 1000 residents)
    const zone = readJson(path.join(DATA_DIR, 'spendingZones.json'))?.zones?.[zip] || {};
    const population = zone.population || 0;
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
    atomicWrite(path.join(LAYER_DIR, `${zip}.json`), zbpLayerData);
    // Mirror to Postgres (fire-and-forget)
    pgStore.upsertCensusLayer(zip, zbpLayerData, null).catch(() => {});
  }

  atomicWrite(stateFile, { ingested_at: new Date().toISOString(), zips: Object.keys(byZip).length });
  console.log(`[censusLayer] ZBP: ingested ${Object.keys(byZip).length} ZIPs`);
}

// ── LAYER 2: CBP — County Business Patterns 2023 ──────────────────────────────
// Current (2023) sector health at county level
// Pulled monthly — data updates annually, but monthly check catches the update

async function ingestCBP() {
  console.log('[censusLayer] CBP: fetching 2023 County Business Patterns...');

  const countySectors = {};

  for (const { name, state, county } of COUNTY_CONFIG) {
    try {
      // Fetch 2-digit NAICS totals for this county
      const raw = await fetchJson(
        `https://api.census.gov/data/2023/cbp?get=ESTAB,EMP,PAYANN,NAICS2017&for=county:${county}&in=state:${state}`
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

      // Merge county share into each ZIP's census layer file
      const countyZips = ALL_ZIPS.filter(z => z.county === name);
      for (const { zip } of countyZips) {
        const file     = path.join(LAYER_DIR, `${zip}.json`);
        const existing = readJson(file) || { zip };
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

        atomicWrite(file, existing);
      }

      // Small delay between counties
      await new Promise(r => setTimeout(r, 1000));

    } catch (err) {
      console.error(`[censusLayer] CBP failed for ${name}:`, err.message);
    }
  }

  atomicWrite(path.join(LAYER_DIR, '_county_sectors.json'), {
    generated_at: new Date().toISOString(),
    cbp_vintage:  2023,
    counties:     countySectors,
  });

  console.log('[censusLayer] CBP: county sectors written to _county_sectors.json');
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

async function ingestPDB() {
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

    const zipFile          = path.join(ZIPS_DIR, `${zip}.json`);
    const bizData          = fs.existsSync(zipFile)
      ? (() => { const d = readJson(zipFile); return Array.isArray(d) ? d : (d?.businesses || []); })()
      : [];
    const censusLayer      = readJson(path.join(LAYER_DIR, `${zip}.json`));
    const zbpTotal         = censusLayer?.zbp?.total_establishments || 0;
    const bizCoverage      = zbpTotal > 0
      ? Math.min(25, Math.round((bizData.length / zbpTotal) * 25))
      : (bizData.length > 10 ? 15 : bizData.length > 3 ? 8 : 2);

    const zones            = readJson(path.join(DATA_DIR, 'spendingZones.json'));
    const hasZoneData      = !!(zones?.zones?.[zip]?.population);
    const hasOceanData     = fs.existsSync(path.join(DATA_DIR, 'ocean_floor', `${zip}.json`));
    const demoQuality      = hasZoneData ? (hasOceanData ? 25 : 18) : 8;

    const oracleHistory    = readJson(path.join(ORACLE_DIR, 'history', `${zip}.json`)) || [];
    const oracleCycles     = oracleHistory.length;
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

    // Merge into census layer file
    const layerFile = path.join(LAYER_DIR, `${zip}.json`);
    const existing  = readJson(layerFile) || { zip };
    const pdbLayerData = {
      ...existing,
      pdb:        pdbData,
      confidence,
      updated_at: new Date().toISOString(),
    };
    atomicWrite(layerFile, pdbLayerData);
    // Mirror to Postgres with confidence (fire-and-forget)
    pgStore.upsertCensusLayer(zip, pdbLayerData, confidence).catch(() => {});

    confidenceIndex[zip] = {
      score:           dataConfidenceScore,
      tier:            confidenceTier,
      lrs:             lowResponseScore,
      oracle_cycles:   oracleCycles,
    };

    console.log(`[censusLayer] PDB: ${zip} confidence=${dataConfidenceScore} (${confidenceTier}) lrs=${lowResponseScore} college=${collegePct}%`);
  }

  atomicWrite(path.join(LAYER_DIR, '_confidence.json'), {
    generated_at: new Date().toISOString(),
    zips:         confidenceIndex,
  });

  console.log('[censusLayer] PDB: confidence index written');
}

// ── Oracle integration: inject confidence into oracle output ───────────────────
// Called after PDB ingest — stamps confidence tier onto existing oracle files
// so that MCP callers see it without needing a separate fetch

function stampOracleConfidence() {
  const confFile = path.join(LAYER_DIR, '_confidence.json');
  const conf     = readJson(confFile);
  if (!conf?.zips) return;

  let stamped = 0;
  for (const [zip, c] of Object.entries(conf.zips)) {
    const oracleFile = path.join(ORACLE_DIR, `${zip}.json`);
    if (!fs.existsSync(oracleFile)) continue;
    const oracle = readJson(oracleFile);
    if (!oracle) continue;

    oracle.data_confidence = {
      score:           c.score,
      tier:            c.tier,
      oracle_cycles:   c.oracle_cycles,
      lrs:             c.lrs,
      note:            c.tier === 'SPARSE'    ? 'Low signal density — treat signals as directional only'
                     : c.tier === 'PROXY'     ? 'Moderate confidence — demographic data estimated from proxies'
                     : c.tier === 'ESTIMATED' ? 'Good confidence — Census-backed with growing oracle history'
                     : 'High confidence — Census-verified with validated oracle signal history',
    };
    atomicWrite(oracleFile, oracle);
    stamped++;
  }
  console.log(`[censusLayer] Stamped confidence scores on ${stamped} oracle files`);
}

// ── Refresh schedule management ────────────────────────────────────────────────

const SCHEDULE_FILE = path.join(LAYER_DIR, '_schedule.json');

function readSchedule() {
  return readJson(SCHEDULE_FILE) || {};
}

function writeSchedule(updates) {
  const current = readSchedule();
  atomicWrite(SCHEDULE_FILE, { ...current, ...updates });
}

function shouldRun(key, intervalMs) {
  const schedule = readSchedule();
  const last     = schedule[key] ? new Date(schedule[key]).getTime() : 0;
  return Date.now() - last >= intervalMs;
}

// ── Main run ───────────────────────────────────────────────────────────────────

async function runCensusLayer() {
  ensureDirs();
  console.log('[censusLayer] Starting census layer update...');

  const MS_MONTHLY  = 30 * 24 * 60 * 60 * 1000;
  const MS_QUARTERLY = 90 * 24 * 60 * 60 * 1000;

  // ZBP: once only (state file controls this internally)
  try {
    await ingestZBP();
  } catch (err) {
    console.error('[censusLayer] ZBP error:', err.message);
  }

  // CBP: monthly
  if (shouldRun('cbp_last_run', MS_MONTHLY)) {
    try {
      await ingestCBP();
      writeSchedule({ cbp_last_run: new Date().toISOString() });
    } catch (err) {
      console.error('[censusLayer] CBP error:', err.message);
    }
  } else {
    console.log('[censusLayer] CBP: skipping (last run was recent)');
  }

  // PDB: quarterly
  if (shouldRun('pdb_last_run', MS_QUARTERLY)) {
    try {
      await ingestPDB();
      writeSchedule({ pdb_last_run: new Date().toISOString() });
      stampOracleConfidence();
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

const CENSUS_INTERVAL = 24 * 60 * 60 * 1000;
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
