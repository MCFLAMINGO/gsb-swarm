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
 * NO API KEY REQUIRED. Census ACS ZCTA endpoint is public.
 * Runs once on startup, then every 24 hours.
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ACS_DIR  = path.join(DATA_DIR, 'acs');
const ZIPS_DIR = path.join(DATA_DIR, 'zips');

// All ZIPs we cover — read dynamically from zips/ directory
function getAllZips() {
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

// ── Fetch ACS table for a list of variables, ZCTA level ─────────────────────
async function fetchACS(zip, variables) {
  const varStr = variables.join(',');
  // Census API: ZCTA5 level (ZIP Code Tabulation Areas)
  const url = `https://api.census.gov/data/2022/acs/acs5?get=NAME,${varStr}&for=zip%20code%20tabulation%20area:${zip}`;
  try {
    const data = await fetchJson(url);
    if (!Array.isArray(data) || data.length < 2) return null;
    const headers = data[0];
    const row     = data[1];
    const result  = {};
    headers.forEach((h, i) => { result[h] = row[i]; });
    return result;
  } catch(e) {
    return null;
  }
}

function toN(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

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
    // raw for debugging
    _raw: {
      totalWorkers, wfhWorkers,
      totalHH, over100k, over200k,
      totalPop, seniors,
    },
  };

  fs.mkdirSync(ACS_DIR, { recursive: true });
  fs.writeFileSync(path.join(ACS_DIR, `${zip}.json`), JSON.stringify(result, null, 2));
  return result;
}

// ── Main run ─────────────────────────────────────────────────────────────────
async function run() {
  const zips = getAllZips();
  console.log(`[acsWorker] Starting ACS pull for ${zips.length} ZIPs`);
  let ok = 0, fail = 0;

  for (const zip of zips) {
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
    await sleep(300); // 300ms between requests — Census API is rate-limited
  }

  console.log(`[acsWorker] Done: ${ok} populated, ${fail} empty/failed`);
}

// ── Schedule ──────────────────────────────────────────────────────────────────
const CYCLE_MS = 24 * 60 * 60 * 1000; // 24 hours
run().catch(e => console.error('[acsWorker] Fatal:', e.message));
setInterval(() => run().catch(e => console.error('[acsWorker] Interval error:', e.message)), CYCLE_MS);
