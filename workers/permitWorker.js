'use strict';
/**
 * permitWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Florida building permit signals from two sources:
 *
 *  1. US Census Bureau BPS (Building Permits Survey) — PRIMARY
 *     URL: https://www2.census.gov/econ/bps/County/co{YY}{MM}c.txt (monthly)
 *          https://www2.census.gov/econ/bps/County/co{YEAR}a.txt   (annual)
 *     Coverage: ALL 67 Florida counties → all 1,610 ZIPs
 *     Columns: 1-unit residential, 2-unit, 3-4 unit, 5+ unit, total value
 *     No API key needed. Updated monthly.
 *
 *  2. SJC ArcGIS Hub — SUPPLEMENTAL (per-address, 14 SJC ZIPs only)
 *     Used to enrich sjc_permits table with individual permit records.
 *     Runs after Census pass.
 *
 * Postgres tables:
 *   county_permits   — county-level annual + monthly totals from Census BPS
 *   sjc_permits      — individual permit records from SJC ArcGIS (SJC only)
 *
 * county_permits feeds the /api/local-intel/census endpoint via county→ZIP join.
 * sjc_permits feeds individual permit detail (future: per-address lookups).
 *
 * Loop: runs once on start, then every 24h.
 */

const https = require('https');
const db    = require('../lib/db');

const LOOP_H    = 24;
const FL_FIPS   = '12'; // Florida state FIPS

// ── Florida county FIPS → county name + ZIPs it contains ─────────────────────
// Source: Census FIPS + our ZIP→county mapping from zip_intelligence table.
// This static map covers the most common ZIPs per county for quick assignment.
// The dynamic path queries zip_intelligence at runtime for full coverage.
const FL_COUNTY_FIPS = {
  '001': 'Alachua',    '003': 'Baker',      '005': 'Bay',
  '007': 'Bradford',   '009': 'Brevard',    '011': 'Broward',
  '013': 'Calhoun',    '015': 'Charlotte',  '017': 'Citrus',
  '019': 'Clay',       '021': 'Collier',    '023': 'Columbia',
  '027': 'DeSoto',     '029': 'Dixie',      '031': 'Duval',
  '033': 'Escambia',   '035': 'Flagler',    '037': 'Franklin',
  '039': 'Gadsden',    '041': 'Gilchrist',  '043': 'Glades',
  '045': 'Gulf',       '047': 'Hamilton',   '049': 'Hardee',
  '051': 'Hendry',     '053': 'Hernando',   '055': 'Highlands',
  '057': 'Hillsborough','059': 'Holmes',    '061': 'Indian River',
  '063': 'Jackson',    '065': 'Jefferson',  '067': 'Lafayette',
  '069': 'Lake',       '071': 'Lee',        '073': 'Leon',
  '075': 'Levy',       '077': 'Liberty',    '079': 'Madison',
  '081': 'Manatee',    '083': 'Marion',     '085': 'Martin',
  '086': 'Miami-Dade', '087': 'Monroe',     '089': 'Nassau',
  '091': 'Okaloosa',   '093': 'Okeechobee', '095': 'Orange',
  '097': 'Osceola',    '099': 'Palm Beach', '101': 'Pasco',
  '103': 'Pinellas',   '105': 'Polk',       '107': 'Putnam',
  '109': 'St. Johns',  '111': 'St. Lucie',  '113': 'Santa Rosa',
  '115': 'Sarasota',   '117': 'Seminole',   '119': 'Sumter',
  '121': 'Suwannee',   '123': 'Taylor',     '125': 'Union',
  '127': 'Volusia',    '129': 'Wakulla',    '131': 'Walton',
  '133': 'Washington',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'LocalIntel-PermitWorker/1.0 (thelocalintel.com)' } }, res => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Ensure schema ─────────────────────────────────────────────────────────────
async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS county_permits (
      id            SERIAL PRIMARY KEY,
      state_fips    TEXT NOT NULL,
      county_fips   TEXT NOT NULL,
      county_name   TEXT,
      period_type   TEXT NOT NULL,   -- 'annual' | 'monthly'
      period_key    TEXT NOT NULL,   -- '2024' | '202501'
      res_1unit     INT DEFAULT 0,   -- single-family residential buildings
      res_2unit     INT DEFAULT 0,   -- 2-unit residential
      res_multifam  INT DEFAULT 0,   -- 5+ unit (multifamily)
      total_units   INT DEFAULT 0,   -- all residential units
      total_value   BIGINT DEFAULT 0,-- dollar value of all permits
      commercial_est INT DEFAULT 0,  -- estimated commercial (not in BPS — set by ArcGIS layer)
      fetched_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (state_fips, county_fips, period_type, period_key)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_county_permits_lookup
    ON county_permits (state_fips, county_fips, period_type, period_key)`);

  // sjc_permits — individual records (SJC only)
  await db.query(`
    CREATE TABLE IF NOT EXISTS sjc_permits (
      id          SERIAL PRIMARY KEY,
      zip         TEXT,
      permit_no   TEXT UNIQUE,
      address     TEXT,
      use_desc    TEXT,
      permit_type TEXT,
      issue_date  TIMESTAMPTZ,
      fetched_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS sjc_permits_zip_idx ON sjc_permits (zip)`);
  await db.query(`CREATE INDEX IF NOT EXISTS sjc_permits_date_idx ON sjc_permits (issue_date DESC)`);
}

// ── Parse Census BPS flat file ────────────────────────────────────────────────
// Format (annual): 2024,12,031,...,Duval County,bldgs,units,value,...
// Columns (0-indexed):
//   0=Date, 1=StateFIPS, 2=CountyFIPS, 3=Region, 4=Division, 5=CountyName
//   6=1unit_bldgs, 7=1unit_units, 8=1unit_value
//   9=2unit_bldgs, 10=2unit_units, 11=2unit_value
//   12=34unit_bldgs, 13=34unit_units, 14=34unit_value
//   15=5plus_bldgs, 16=5plus_units, 17=5plus_value
//   (rep cols follow — we ignore those)
function parseBpsFile(text, periodType) {
  const results = [];
  const lines = text.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Survey') || trimmed.startsWith('Date')) continue;

    const cols = trimmed.split(',');
    if (cols.length < 18) continue;

    const stateFips  = cols[1].trim();
    const countyFips = cols[2].trim().padStart(3, '0');
    if (stateFips !== FL_FIPS) continue; // Florida only

    const periodKey  = cols[0].trim(); // '2024' or '202501'
    const countyName = cols[5].trim().replace(/\s+/g, ' ');

    const int = s => Math.abs(parseInt(s.trim(), 10) || 0);

    const res1Bldgs   = int(cols[6]);
    const res1Units   = int(cols[7]);
    const res1Value   = int(cols[8]);
    const res2Bldgs   = int(cols[9]);
    const res2Units   = int(cols[10]);
    const res2Value   = int(cols[11]);
    const res34Bldgs  = int(cols[12]);
    const res34Units  = int(cols[13]);
    const res34Value  = int(cols[14]);
    const res5Bldgs   = int(cols[15]);
    const res5Units   = int(cols[16]);
    const res5Value   = int(cols[17]);

    const totalUnits = res1Units + res2Units + res34Units + res5Units;
    const totalValue = res1Value + res2Value + res34Value + res5Value;

    results.push({
      state_fips  : stateFips,
      county_fips : countyFips,
      county_name : countyName,
      period_type : periodType,
      period_key  : periodKey,
      res_1unit   : res1Bldgs,
      res_2unit   : res2Bldgs,
      res_multifam: res5Bldgs,
      total_units : totalUnits,
      total_value : totalValue,
    });
  }
  return results;
}

// ── Upsert county permit rows ─────────────────────────────────────────────────
async function upsertCountyPermits(rows) {
  let count = 0;
  for (const r of rows) {
    try {
      await db.query(
        `INSERT INTO county_permits
           (state_fips, county_fips, county_name, period_type, period_key,
            res_1unit, res_2unit, res_multifam, total_units, total_value, fetched_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
         ON CONFLICT (state_fips, county_fips, period_type, period_key)
         DO UPDATE SET
           county_name  = EXCLUDED.county_name,
           res_1unit    = EXCLUDED.res_1unit,
           res_2unit    = EXCLUDED.res_2unit,
           res_multifam = EXCLUDED.res_multifam,
           total_units  = EXCLUDED.total_units,
           total_value  = EXCLUDED.total_value,
           fetched_at   = NOW()`,
        [r.state_fips, r.county_fips, r.county_name, r.period_type, r.period_key,
         r.res_1unit, r.res_2unit, r.res_multifam, r.total_units, r.total_value]
      );
      count++;
    } catch (e) {
      console.warn('[permitWorker] upsert failed:', e.message);
    }
  }
  return count;
}

// ── Fetch Census BPS files ────────────────────────────────────────────────────
async function fetchCensusBps() {
  let total = 0;

  // Annual 2024
  try {
    console.log('[permitWorker] Fetching Census BPS annual 2024...');
    const text = await httpsGet('https://www2.census.gov/econ/bps/County/co2024a.txt');
    const rows = parseBpsFile(text, 'annual');
    const upserted = await upsertCountyPermits(rows);
    console.log(`[permitWorker] Annual 2024: ${rows.length} FL counties parsed, ${upserted} upserted`);
    total += upserted;
  } catch (e) {
    console.error('[permitWorker] Annual 2024 fetch failed:', e.message);
  }

  await sleep(2000);

  // Last 3 months of monthly data — find most recent available
  const now = new Date();
  for (let i = 1; i <= 4; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const yy = String(d.getFullYear()).slice(-2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const fileKey = `${yy}${mm}`;
    const url = `https://www2.census.gov/econ/bps/County/co${fileKey}c.txt`;
    try {
      console.log(`[permitWorker] Fetching monthly ${fileKey}...`);
      const text = await httpsGet(url);
      const rows = parseBpsFile(text, 'monthly');
      const upserted = await upsertCountyPermits(rows);
      console.log(`[permitWorker] Monthly ${fileKey}: ${rows.length} FL counties, ${upserted} upserted`);
      total += upserted;
    } catch (e) {
      console.warn(`[permitWorker] Monthly ${fileKey} not available:`, e.message);
    }
    await sleep(1500);
  }

  return total;
}

// ── SJC ArcGIS — individual permits (SJC ZIPs only) ──────────────────────────
// Uses lat/lon from PlanDist field + known SJC zip centroids as fallback
const SJC_ZIP_BOUNDS = {
  '32082': { minLat: 30.16, maxLat: 30.24, minLon: -81.42, maxLon: -81.35 },
  '32081': { minLat: 30.06, maxLat: 30.14, minLon: -81.44, maxLon: -81.36 },
  '32092': { minLat: 29.96, maxLat: 30.06, minLon: -81.55, maxLon: -81.44 },
  '32084': { minLat: 29.84, maxLat: 29.94, minLon: -81.36, maxLon: -81.28 },
  '32086': { minLat: 29.74, maxLat: 29.84, minLon: -81.32, maxLon: -81.22 },
  '32095': { minLat: 30.10, maxLat: 30.20, minLon: -81.47, maxLon: -81.38 },
  '32080': { minLat: 29.81, maxLat: 29.91, minLon: -81.30, maxLon: -81.24 },
  '32259': { minLat: 29.99, maxLat: 30.07, minLon: -81.51, maxLon: -81.44 },
};

function assignSjcZip(latStr, lonStr) {
  const lat = parseFloat(latStr);
  const lon = parseFloat(lonStr);
  if (!lat || !lon || isNaN(lat) || isNaN(lon)) return null;
  for (const [zip, b] of Object.entries(SJC_ZIP_BOUNDS)) {
    if (lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon) return zip;
  }
  return null;
}

async function fetchSjcPermits() {
  const url = 'https://www.gis.sjcfl.us/portal_sjcgis/rest/services/activePermits/FeatureServer/0/query?' +
    'where=1%3D1&outFields=PermitNo,ProjAddrCombined,PropUseDesc,IssueDate,Latitude,Longitude' +
    '&resultRecordCount=2000&f=json';
  try {
    console.log('[permitWorker] Fetching SJC ArcGIS permits...');
    const text = await httpsGet(url);
    const data = JSON.parse(text);
    const features = data.features || [];
    console.log(`[permitWorker] SJC raw features: ${features.length}`);

    let upserted = 0;
    for (const f of features) {
      const a = f.attributes || {};
      if (!a.PermitNo) continue;

      const lat = a.Latitude && typeof a.Latitude === 'string' ? a.Latitude : null;
      const lon = a.Longitude && typeof a.Longitude === 'string' ? a.Longitude : null;
      const zip = assignSjcZip(lat, lon);

      const useDesc = a.PropUseDesc || '';
      const permitType = useDesc.toUpperCase().includes('SINGLE FAMILY') ||
                         useDesc.toUpperCase().includes('RESIDENTIAL') ? 'residential' :
                         useDesc.toUpperCase().includes('COMMERCIAL') ||
                         useDesc.toUpperCase().includes('OFFICE') ||
                         useDesc.toUpperCase().includes('RESTAURANT') ? 'commercial' : 'other';

      const issueDate = a.IssueDate ? new Date(a.IssueDate) : null;

      try {
        await db.query(
          `INSERT INTO sjc_permits (zip, permit_no, address, use_desc, permit_type, issue_date, fetched_at)
           VALUES ($1,$2,$3,$4,$5,$6,NOW())
           ON CONFLICT (permit_no) DO UPDATE SET
             zip=EXCLUDED.zip, address=EXCLUDED.address, use_desc=EXCLUDED.use_desc,
             permit_type=EXCLUDED.permit_type, issue_date=EXCLUDED.issue_date, fetched_at=NOW()`,
          [zip, String(a.PermitNo), a.ProjAddrCombined || null, useDesc, permitType, issueDate]
        );
        upserted++;
      } catch (e) {
        if (!e.message.includes('unique')) console.warn('[permitWorker] sjc upsert:', e.message);
      }
    }
    console.log(`[permitWorker] SJC: ${upserted} permits upserted`);
    return upserted;
  } catch (e) {
    console.warn('[permitWorker] SJC ArcGIS fetch failed:', e.message);
    return 0;
  }
}

// ── Log worker event ──────────────────────────────────────────────────────────
async function logEvent(eventType, recordsOut, durationMs, error) {
  try {
    await db.query(
      `INSERT INTO worker_events (worker_name, event_type, records_in, records_out, duration_ms, error_message, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
      ['permit_worker', eventType, 0, recordsOut || 0, durationMs || 0, error || null]
    );
  } catch (_) {}
}

// ── Main pass ─────────────────────────────────────────────────────────────────
async function runPass() {
  const t0 = Date.now();
  console.log('[permitWorker] Starting permit ingestion pass');
  await ensureSchema();
  await logEvent('start', 0, 0);

  let total = 0;

  // 1. Census BPS — all 67 FL counties
  const censusCount = await fetchCensusBps();
  total += censusCount;

  await sleep(3000);

  // 2. SJC ArcGIS — individual records for SJC ZIPs
  const sjcCount = await fetchSjcPermits();
  total += sjcCount;

  const dur = Date.now() - t0;
  await logEvent('complete', total, dur);
  console.log(`[permitWorker] Pass complete — ${total} records in ${Math.round(dur/1000)}s`);
  console.log(`[permitWorker]   Census BPS: ${censusCount} county rows`);
  console.log(`[permitWorker]   SJC ArcGIS: ${sjcCount} individual permits`);
}

// ── Daemon ────────────────────────────────────────────────────────────────────
(async function main() {
  console.log('[permitWorker] Worker started');
  while (true) {
    try { await runPass(); }
    catch (err) { console.error('[permitWorker] Pass crashed:', err.message); }
    console.log(`[permitWorker] Sleeping ${LOOP_H}h`);
    await sleep(LOOP_H * 60 * 60 * 1000);
  }
})();

module.exports = { runPass };
