'use strict';
/**
 * acsWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pulls ACS 5-year estimates for every ZIP in our registry:
 *   B08301 — commute mode → wfh_pct (% working from home)
 *   B19001 — household income buckets → affluence_pct (>$100k), ultra_affluence_pct (>$200k)
 *   B25077 — median home value → median_home_value
 *   B01001 — age by sex → retiree_index (% 65+)
 *   B25003 — tenure → owner_occupied_pct
 *   B11001 — households → total_households
 *   B01003 — total population
 *
 * Writes output to data/acs/{zip}.json
 * Oracle worker reads this on next cycle — fills in the zeros.
 *
 * API KEY: set Census_Data_API in Railway for authenticated requests
 * (500 req/min authenticated vs 50 req/min unauthenticated).
 * Runs once on startup, then every 24 hours.
 */

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const db      = require('../lib/db');
const pgStore = require('../lib/pgStore');
const { getZipsByPriority } = require('./flZipRegistry');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ACS_DIR  = path.join(DATA_DIR, 'acs');
const ZIPS_DIR = path.join(DATA_DIR, 'zips');

// FL ZIPs with no Census ZCTA coverage — ACS returns HTTP 204 for these.
// Skip silently to prevent log spam.
const ACS_SKIP_ZIPS = new Set([
  '32004', '32006', '32007', '32013', '32026', '32030', '32035', '32041', '32042', '32050',
  '32052', '32053', '32054', '32055', '32056', '32058', '32059', '32067', '32068', '32080',
  '32082', '32083', '32085', '32086', '32091', '32092', '32094', '32099', '32105', '32111',
  '32115', '32116', '32120', '32121', '32122', '32123', '32125', '32126', '32135', '32138',
  '32142', '32143', '32149', '32158', '32160', '32170', '32173', '32175', '32178', '32182',
  '32183', '32185', '32192', '32198', '32201', '32203', '32214', '32229', '32231', '32232',
  '32235', '32236', '32237', '32238', '32239', '32240', '32241', '32245', '32247', '32251',
  '32255', '32260', '32302', '32313', '32314', '32315', '32316', '32318', '32326', '32329',
  '32335', '32337', '32341', '32345', '32353', '32356', '32357', '32362', '32395', '32399',
  '32402', '32406', '32411', '32412', '32417', '32422', '32432', '32434', '32790', '32791',
  '32793', '32795', '32802', '32815', '32831', '32848', '32854', '32855', '32856', '32857',
  '32858', '32859', '32861', '32862', '32867', '32868', '32872', '32877', '32878', '32899',
  '32906', '32954', '32961', '33022', '33195', '33199', '33205', '33283', '33318', '33320',
  '33338', '33355', '33359', '33388', '33422', '33427', '33447', '33907', '33908', '33909',
  '33912', '33913', '33914', '33916', '33928', '33931', '33935', '33936', '33938', '33955',
  '33966', '33967', '33971', '33976', '33980', '33981', '33982', '33983', '33990', '33993',
  '34103', '34105', '34108', '34114', '34116', '34119', '34120', '34480', '34481', '34484',
  '34498', '34608', '34613', '34614', '34637', '34654', '34655', '34656', '34660', '34667',
  '34669', '34673', '34674', '34677', '34680', '34682', '34683', '34685', '34689', '34692',
  '34695', '34697', '34712', '34713', '34729', '34740', '34742', '34745', '34749', '34762',
  '34769', '34771', '34786', '34787', '34788', '34946', '34956', '34979', '34982', '34984',
  '34985', '34986', '34987', '34988', '34991', '34992', '34995', '34996', '34997',
  '33499', '33508', '33509', '33524', '33526', '33537', '33539', '33564', '33568', '33571',
  '33575', '33682', '33685',
]);

// All ZIPs we cover — fl_zip_geo is the authoritative FL ZIP registry (POSTGRES IS KING)
// Falls back to businesses table ZIPs, then flat files for local dev
async function getAllZips() {
  if (process.env.LOCAL_INTEL_DB_URL) {
    try {
      const { getAllZipsFromGeo } = require('../lib/pgStore');
      const zips = await getAllZipsFromGeo();
      if (zips.length > 0) {
        console.log(`[acsWorker] ZIP discovery: ${zips.length} FL ZIPs from fl_zip_geo`);
        return zips;
      }
    } catch (e) {
      console.warn('[acsWorker] fl_zip_geo query failed, falling back to businesses table:', e.message);
    }
    // Secondary fallback: businesses table (only ZIPs with known businesses)
    try {
      const { getDistinctZips } = require('../lib/pgStore');
      const zips = await getDistinctZips();
      if (zips.length > 0) {
        console.log(`[acsWorker] ZIP discovery: ${zips.length} ZIPs from businesses table (fl_zip_geo not ready)`);
        return zips;
      }
    } catch (e) {
      console.warn('[acsWorker] Postgres ZIP discovery failed, falling back to flat files:', e.message);
    }
  }
  // Local dev fallback
  if (!fs.existsSync(ZIPS_DIR)) return [];
  return fs.readdirSync(ZIPS_DIR)
    .filter(f => f.endsWith('.json') && f !== '_index.json')
    .map(f => f.replace('.json', ''));
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'LocalIntel-ACS/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      if (res.statusCode !== 200)
        return reject(new Error(`HTTP ${res.statusCode}`));
      let b = '';
      res.setEncoding('utf8');
      res.on('data', c => { b += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(b)); }
        catch(e) { reject(new Error('JSON parse failed')); }
      });
      res.on('error', reject);
    });
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Census API key — authenticated = 500 req/min, unauthenticated = 50 req/min
const CENSUS_API_KEY = process.env.Census_Data_API || process.env.CENSUS_API_KEY || null;

if (CENSUS_API_KEY) {
  console.log('[acsWorker] Census API key found — authenticated mode (500 req/min)');
} else {
  console.log('[acsWorker] No Census API key — unauthenticated (50 req/min). Set Census_Data_API in Railway.');
}

// ── Fetch ACS table for a list of variables, ZCTA level ─────────────────────
// Network errors that are transient (Census TCP resets, rate limits) — worth retrying.
const TRANSIENT_ERRORS = ['socket hang up', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'read ECONNRESET'];
function isTransient(msg) { return TRANSIENT_ERRORS.some(e => msg.includes(e)); }

async function fetchACS(zip, variables) {
  const varStr = variables.join(',');
  const keyParam = CENSUS_API_KEY ? `&key=${CENSUS_API_KEY}` : '';
  const url = `https://api.census.gov/data/2022/acs/acs5?get=NAME,${varStr}&for=zip%20code%20tabulation%20area:${zip}${keyParam}`;
  // Retry transient network errors up to 3x with backoff (2s, 5s, 10s).
  // Non-transient errors (bad ZIP, suppressed data) return null immediately.
  const retryDelays = [2000, 5000, 10000];
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      const data = await fetchJson(url);
      if (!Array.isArray(data) || data.length < 2) {
        if (data && data.error) console.warn(`[acsWorker] Census API error for ${zip} (${varStr.slice(0,20)}): ${data.error}`);
        return null;
      }
      const headers = data[0];
      const row     = data[1];
      const result  = {};
      headers.forEach((h, i) => { result[h] = row[i]; });
      return result;
    } catch(e) {
      if (isTransient(e.message) && attempt < retryDelays.length) {
        await sleep(retryDelays[attempt]);
        continue;
      }
      // Non-transient or exhausted retries — log once and return null
      console.warn(`[acsWorker] fetchACS failed for ${zip} vars=${varStr.slice(0,30)}: ${e.message}`);
      return null;
    }
  }
}

// Census API returns -666666666 (and other negatives) for suppressed/missing values — treat as 0
function toN(v) { const n = parseFloat(v); return (isNaN(n) || n < 0) ? 0 : n; }

// ── Process one ZIP ──────────────────────────────────────────────────────────
async function processZip(zip) {
  // B08301: Means of transportation to work
  // B08301_001E = total workers, B08301_021E = worked from home
  const commute = await fetchACS(zip, ['B08301_001E', 'B08301_021E']);

  // B19001: Household income
  // B19001_001E = total HH, B19001_013E to B19001_017E = $100k+ brackets, B19001_017E = $200k+
  const income = await fetchACS(zip, [
    'B19001_001E',
    'B19001_013E','B19001_014E','B19001_015E','B19001_016E','B19001_017E',
  ]);

  // B25077: Median home value
  const homeVal = await fetchACS(zip, ['B25077_001E']);

  // B01001: Age by sex — sum 65+ for retiree_index
  const age = await fetchACS(zip, [
    'B01001_001E',  // total
    'B01001_020E','B01001_021E','B01001_022E','B01001_023E','B01001_024E','B01001_025E', // male 65+
    'B01001_044E','B01001_045E','B01001_046E','B01001_047E','B01001_048E','B01001_049E', // female 65+
  ]);

  // B25003: Tenure (owner vs renter)
  const tenure = await fetchACS(zip, ['B25003_001E', 'B25003_002E']); // total, owner-occupied

  // B11001: Household count
  const hh = await fetchACS(zip, ['B11001_001E']);

  // B01003: Total population
  const pop = await fetchACS(zip, ['B01003_001E']);

  // B19013: Median household income (the number everyone wants)
  const medHhi = await fetchACS(zip, ['B19013_001E']);

  // B01002: Median age
  const medAge = await fetchACS(zip, ['B01002_001E']);

  // B15003: Educational attainment — B15003_022E = bachelor's, _023E = master's, _024E = prof, _025E = doctorate
  // B15003_001E = total 25+ population
  const edu = await fetchACS(zip, ['B15003_001E','B15003_022E','B15003_023E','B15003_024E','B15003_025E']);

  // B17001: Poverty status — B17001_002E = below poverty, B17001_001E = total
  const poverty = await fetchACS(zip, ['B17001_001E','B17001_002E']);

  // B25002: Occupancy status — B25002_001E = total units, B25002_003E = vacant
  const vacancy = await fetchACS(zip, ['B25002_001E','B25002_003E']);

  // B05001: Nativity — B05001_001E = total, B05001_006E = not a US citizen (foreign-born proxy)
  const foreign = await fetchACS(zip, ['B05001_001E','B05001_006E']);

  // B11001: Family households — B11001_002E = family, B11001_001E = total (already fetched above)
  const family = await fetchACS(zip, ['B11001_001E','B11001_002E']);

  // B08303: Travel time to work — B08303_001E = total workers, compute weighted avg bucket midpoints
  // Simpler: use B08135_001E = aggregate travel time, B08101_001E = total workers for commute
  const commute2 = await fetchACS(zip, ['B08135_001E','B08101_001E']);

  // B63: C24010 — occupation by sex (civilian employed 16+)
  // _001E = total, _038E = computer/math, _039E = architecture/engineering, _041E = life/physical/social science
  const stem = await fetchACS(zip, ['C24010_001E','C24010_038E','C24010_039E','C24010_041E']);

  // ── Compute derived fields ───────────────────────────────────────────────
  const totalWorkers = toN(commute?.B08301_001E);
  const wfhWorkers   = toN(commute?.B08301_021E);
  const wfh_pct      = totalWorkers > 0 ? Math.round((wfhWorkers / totalWorkers) * 100 * 10) / 10 : 0;

  const totalHH        = toN(income?.B19001_001E);
  const over100k       = ['B19001_013E','B19001_014E','B19001_015E','B19001_016E','B19001_017E']
                           .reduce((s, k) => s + toN(income?.[k]), 0);
  const over200k       = toN(income?.B19001_017E);
  const affluence_pct  = totalHH > 0 ? Math.round((over100k / totalHH) * 100 * 10) / 10 : 0;
  const ultra_pct      = totalHH > 0 ? Math.round((over200k / totalHH) * 100 * 10) / 10 : 0;

  const median_home_value = toN(homeVal?.B25077_001E);

  const totalPop = toN(age?.B01001_001E);
  const seniors  = [
    'B01001_020E','B01001_021E','B01001_022E','B01001_023E','B01001_024E','B01001_025E',
    'B01001_044E','B01001_045E','B01001_046E','B01001_047E','B01001_048E','B01001_049E',
  ].reduce((s, k) => s + toN(age?.[k]), 0);
  const retiree_index = totalPop > 0 ? Math.round((seniors / totalPop) * 100 * 10) / 10 : 0;

  const totalTenure      = toN(tenure?.B25003_001E);
  const ownerOccupied    = toN(tenure?.B25003_002E);
  const owner_occupied_pct = totalTenure > 0 ? Math.round((ownerOccupied / totalTenure) * 100 * 10) / 10 : 0;

  const total_households = toN(hh?.B11001_001E);
  const population       = toN(pop?.B01003_001E);

  // Median HHI (B19013) — the primary income signal
  const median_hhi_raw = toN(medHhi?.B19013_001E);
  const median_hhi = median_hhi_raw > 0 ? median_hhi_raw : null;

  // Median age (B01002)
  const median_age = toN(medAge?.B01002_001E) || null;

  // College attainment — % of 25+ with bachelor's or higher
  const totalEdu   = toN(edu?.B15003_001E);
  const collegeUp  = ['B15003_022E','B15003_023E','B15003_024E','B15003_025E']
                       .reduce((s,k) => s + toN(edu?.[k]), 0);
  const college_pct = totalEdu > 0 ? Math.round((collegeUp / totalEdu) * 100 * 10) / 10 : null;

  // Poverty rate
  const totalPov   = toN(poverty?.B17001_001E);
  const belowPov   = toN(poverty?.B17001_002E);
  const poverty_pct = totalPov > 0 ? Math.round((belowPov / totalPov) * 100 * 10) / 10 : null;

  // Vacancy rate
  const totalUnits  = toN(vacancy?.B25002_001E);
  const vacantUnits = toN(vacancy?.B25002_003E);
  const vacancy_pct = totalUnits > 0 ? Math.round((vacantUnits / totalUnits) * 100 * 10) / 10 : null;

  // Foreign-born pct
  const totalNat    = toN(foreign?.B05001_001E);
  const foreignBorn = toN(foreign?.B05001_006E);
  const foreign_born_pct = totalNat > 0 ? Math.round((foreignBorn / totalNat) * 100 * 10) / 10 : null;

  // Family household pct
  const totalHhFam  = toN(family?.B11001_001E);
  const familyHh    = toN(family?.B11001_002E);
  const family_pct  = totalHhFam > 0 ? Math.round((familyHh / totalHhFam) * 100 * 10) / 10 : null;

  // Average commute time (minutes) — aggregate minutes / total workers
  const aggCommute   = toN(commute2?.B08135_001E);
  const commuteWrkrs = toN(commute2?.B08101_001E);
  const commute_time_min = commuteWrkrs > 0 ? Math.round((aggCommute / commuteWrkrs) * 10) / 10 : null;

  // B63 — explicit bachelors+ pct and STEM occupations pct for psycho_index
  const acs_pct_bachelors_plus = totalEdu > 0
    ? Math.round((collegeUp / totalEdu) * 100 * 10) / 10
    : null;
  const totalEmployed = toN(stem?.C24010_001E);
  const stemEmployed  = toN(stem?.C24010_038E) + toN(stem?.C24010_039E) + toN(stem?.C24010_041E);
  const acs_pct_stem_occupations = totalEmployed > 0
    ? Math.round((stemEmployed / totalEmployed) * 100 * 10) / 10
    : null;

  // Consumer profile heuristic
  let consumer_profile = 'mixed';
  if (affluence_pct > 55 && retiree_index < 20)      consumer_profile = 'affluent_family';
  else if (retiree_index > 30)                         consumer_profile = 'retiree_belt';
  else if (affluence_pct > 40 && retiree_index < 15)  consumer_profile = 'young_professional';
  else if (affluence_pct < 25)                         consumer_profile = 'working_class';

  const result = {
    zip,
    fetched_at:          new Date().toISOString(),
    acs_vintage:         '2022',
    population,
    total_households,
    wfh_pct,
    affluence_pct,
    ultra_affluence_pct: ultra_pct,
    median_home_value,
    retiree_index,
    owner_occupied_pct,
    consumer_profile,
    // B54 additions
    median_hhi,
    median_age,
    college_pct,
    poverty_pct,
    vacancy_pct,
    foreign_born_pct,
    family_pct,
    commute_time_min,
    // B63 — psychographic inputs
    acs_pct_bachelors_plus,
    acs_pct_stem_occupations,
    // raw for debugging
    _raw: {
      totalWorkers, wfhWorkers,
      totalHH, over100k, over200k,
      totalPop, seniors,
    },
  };

  // Write to Postgres — the only durable store on Railway
  pgStore.upsertAcsDemographics(zip, result).catch(() => {});

  // World model — write acs_* signals into zip_signals
  // Compute partial psycho_index from ACS signals alone.
  // OSM signals (golf/arts/worship/fitness) are omitted here — overpassWorker
  // will overwrite with a fuller score once POI data is available.
  // Formula mirrors lib/scoringEngine.js computePsychoIndex().
  const _edu  = Math.min(1, (result.acs_pct_bachelors_plus  || 0) / 60);
  const _stem = Math.min(1, (result.acs_pct_stem_occupations || 0) / 30);
  const _age  = result.median_age
    ? Math.exp(-0.5 * Math.pow((Number(result.median_age) - 42) / 12, 2))
    : 0;
  // Weights for ACS-only components (arts 0.30 + golf 0.25 = 0.55 missing — rescale remaining)
  // edu=0.20 stem=0.10 age=0.02 → total available = 0.32 out of 0.67 non-worship/fitness
  const psycho_index_acs = Math.round(Math.min(100, Math.max(0,
    (_edu * 0.20 + _stem * 0.10 + _age * 0.02) * 100
  )));

  pgStore.upsertZipSignals(zip, {
    acs_population:       result.population || null,
    acs_households:       result.total_households || null,
    acs_owner_occ_pct:    result.owner_occupied_pct || null,
    acs_median_hhi:       result.median_hhi,
    acs_median_age:       result.median_age,
    acs_college_pct:      result.college_pct,
    acs_poverty_pct:      result.poverty_pct,
    acs_vacancy_pct:      result.vacancy_pct,
    acs_foreign_born_pct: result.foreign_born_pct,
    acs_family_pct:       result.family_pct,
    acs_commute_time_min:    result.commute_time_min,
    acs_pct_bachelors_plus:  result.acs_pct_bachelors_plus,
    acs_pct_stem_occupations: result.acs_pct_stem_occupations,
    acs_vintage:             '2022 5-year',
    acs_updated_at:          new Date(),
    psycho_index:            psycho_index_acs || null,
  }).catch(() => {});

  // Drop _raw before returning — reduces per-ZIP heap footprint, helps GC
  delete result._raw;
  return result;
}

// ── Main run ─────────────────────────────────────────────────────────────────
async function run() {
  const zips = await getAllZips();
  const registryZips = new Set(getZipsByPriority().map(z => String(z.zip || z)));
  console.log(`[acsWorker] Starting ACS pull for ${zips.length} ZIPs (registry has ${registryZips.size} valid FL ZCTAs)`);
  let ok = 0, fail = 0, skipped = 0;

  // ── Per-ZIP freshness: bulk-load already-done ZIPs (one query) ──────────
  // Skips ZIPs written in the last 25 days so restarts don't re-process the
  // whole state. ACS data is annual — 25 days is safe.
  const freshZips = new Set();
  try {
    if (process.env.LOCAL_INTEL_DB_URL) {
      const db = require('../lib/db');
      const rows = await db.query(
        `SELECT zip FROM acs_demographics WHERE updated_at > NOW() - INTERVAL '25 days'`
      );
      rows.forEach(r => freshZips.add(r.zip));
      if (freshZips.size > 0) console.log(`[acsWorker] ${freshZips.size} ZIPs already fresh — skipping`);
    }
  } catch (e) {
    console.warn('[acsWorker] freshness check failed (non-fatal):', e.message);
  }

  for (const zip of zips) {
    if (!registryZips.has(zip)) continue; // not a valid ZCTA — skip
    if (ACS_SKIP_ZIPS.has(zip)) continue;
    if (freshZips.has(zip)) { skipped++; continue; } // already written this cycle
    try {
      const r = await processZip(zip);
      if (r.wfh_pct > 0 || r.affluence_pct > 0 || r.median_home_value > 0) {
        console.log(`[acsWorker] ${zip} ✓ WFH:${r.wfh_pct}% Affluent:${r.affluence_pct}% HomeVal:$${r.median_home_value?.toLocaleString()} Retiree:${r.retiree_index}%`);
        ok++;
      } else {
        console.log(`[acsWorker] ${zip} — no ACS data (ZCTA may not exist)`);
        fail++;
      }
    } catch(e) {
      console.error(`[acsWorker] ${zip} error:`, e.message);
      fail++;
    }
    // 120ms authenticated (500/min), 300ms unauthenticated (50/min)
    await sleep(CENSUS_API_KEY ? 120 : 300);
  }

  console.log(`[acsWorker] Done: ${ok} populated, ${fail} empty/failed, ${skipped} skipped (fresh)`);
  // Write heartbeat so restarts skip if fresh
  try {
    if (process.env.LOCAL_INTEL_DB_URL) {
      const db = require('../lib/db');
      await db.query(`INSERT INTO worker_heartbeat (worker_name, last_run) VALUES ('acsWorker', NOW()) ON CONFLICT (worker_name) DO UPDATE SET last_run = NOW()`);
    }
  } catch (_) {}
}

// ── Daemon loop ───────────────────────────────────────────────────────────────
const CYCLE_MS    = 30 * 24 * 60 * 60 * 1000; // 30d freshness window
const SLEEP_MS    = 24 * 60 * 60 * 1000;       // 24h sleep — Node setTimeout overflows >24.8d
async function runWorker() {
  const hb = require('../lib/workerHeartbeat');
  console.log('[acsWorker] Worker started');
  if (await hb.isFresh('acsWorker', CYCLE_MS)) {
    console.log('[acsWorker] Fresh — skipping pass');
  } else {
    try { await run(); await hb.ping('acsWorker'); }
    catch (e) { console.error('[acsWorker] Pass crashed:', e.message); await hb.pingError('acsWorker', e.message); }
  }
  console.log('[acsWorker] Done.');
}

if (require.main === module) {
  runWorker().then(() => process.exit(0)).catch(e => { console.error('[acsWorker] fatal:', e.message); process.exit(1); });
}
module.exports = { runWorker };
