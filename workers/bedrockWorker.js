'use strict';
/**
 * bedrockWorker.js
 *
 * Layer 0 — BEDROCK
 * Monthly + weekly incremental infrastructure signals.
 *
 * Pulls:
 *  - SJC building permits  (ArcGIS FeatureServer)
 *  - FDOT road projects     (ArcGIS REST)
 *  - FEMA flood zone data   (NFHL REST, hardcoded fallback)
 *
 * Computes infrastructure_momentum_score 0-100 for each SJC ZIP.
 * Writes data/bedrock/{zip}.json + data/bedrock/_index.json
 *
 * Schedule: runs immediately on start, then:
 *   - weekly  incremental  (~7 days)
 *   - monthly full refresh (~30 days)
 */

const path    = require('path');
const fs      = require('fs');
const pgStore = require('../lib/pgStore');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const BEDROCK_DIR = path.join(DATA_DIR, 'bedrock');
const ERRORS_FILE = path.join(BEDROCK_DIR, '_errors.json');
const INDEX_FILE  = path.join(BEDROCK_DIR, '_index.json');

// ── ZIP registry ─────────────────────────────────────────────────────────────
const SJC_ZIPS = [
  { zip: '32082', lat: 30.1893, lon: -81.3815, name: 'Ponte Vedra Beach' },
  { zip: '32081', lat: 30.1100, lon: -81.4175, name: 'Nocatee'           },
  { zip: '32092', lat: 30.1200, lon: -81.4800, name: 'World Golf Village' },
  { zip: '32084', lat: 29.8900, lon: -81.3150, name: 'St. Augustine'      },
  { zip: '32086', lat: 29.8100, lon: -81.3000, name: 'St. Augustine South' },
  { zip: '32080', lat: 29.8600, lon: -81.2700, name: 'St. Augustine Beach' },
];

// ── Known flood zone percentages (FEMA NFHL fallback) ─────────────────────────
// Values: estimated % of ZIP land area in high-risk zones (A/AE/VE).
const FEMA_FLOOD_FALLBACK = {
  '32081': 65,  // Nocatee — extensive wetlands + tidal
  '32082':  8,  // Ponte Vedra Beach — mostly X zone
  '32084': 15,  // St. Augustine
  '32086': 12,  // St. Augustine South
  '32092': 10,  // World Golf Village
  '32080': 20,  // St. Augustine Beach
};

// ── Utilities ─────────────────────────────────────────────────────────────────

function ensureDirs() {
  [DATA_DIR, BEDROCK_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function logError(context, err) {
  console.error(`[bedrockWorker] ERROR [${context}]:`, err.message || err);
  let errors = [];
  try { errors = JSON.parse(fs.readFileSync(ERRORS_FILE, 'utf8')); } catch (_) {}
  errors.push({ ts: new Date().toISOString(), context, message: err.message || String(err) });
  if (errors.length > 200) errors = errors.slice(-200);
  try { atomicWrite(ERRORS_FILE, errors); } catch (_) {}
}

async function safeFetch(url, opts = {}) {
  const timeoutMs = opts._timeout || 20_000;
  delete opts._timeout;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Bounding box helper (degrees) ─────────────────────────────────────────────
function bbox(lat, lon, deg = 0.07) {
  return {
    xmin: lon - deg, ymin: lat - deg,
    xmax: lon + deg, ymax: lat + deg,
  };
}

// ── Data fetchers ─────────────────────────────────────────────────────────────

/**
 * Derive construction activity signals from our own ZIP business data.
 * External permit ArcGIS endpoints (SJC, FDOT) are unreliable — we own this data.
 * Signals:
 *   new_construction_count  — OSM nodes tagged construction/building_construction in our ZIP file
 *   renovation_count        — businesses in construction/home_improvement/hardware categories
 *   utility_extensions      — proxy: business count growth vs ocean_floor baseline
 *   zoning_changes          — proxy: new businesses added since last ocean_floor snapshot
 */
function fetchPermits(zipEntry) {
  const { zip } = zipEntry;
  const ZIPS_DIR = path.join(DATA_DIR, 'zips');
  const zipFile  = path.join(ZIPS_DIR, `${zip}.json`);

  let new_construction_count = 0;
  let renovation_count       = 0;
  let utility_extensions     = 0;
  let zoning_changes         = 0;

  try {
    const raw  = fs.readFileSync(zipFile, 'utf8');
    const data = JSON.parse(raw);
    const businesses = Array.isArray(data) ? data : (data?.businesses || []);

    for (const b of businesses) {
      const cat = ((b.category || b.type || b.amenity || '')).toLowerCase();
      if (/construction|building.*supply|general.*contractor|home.*builder/.test(cat)) new_construction_count++;
      if (/renovation|remodel|home.*improve|hardware|lumber|paint/.test(cat))          renovation_count++;
      if (/electrician|plumber|hvac|utility|sewer|water.*service/.test(cat))           utility_extensions++;
    }

    // Business density vs population proxy for zoning activity
    const oceanFile = path.join(DATA_DIR, 'ocean_floor', `${zip}.json`);
    if (fs.existsSync(oceanFile)) {
      const ocean    = JSON.parse(fs.readFileSync(oceanFile, 'utf8'));
      const baseline = ocean?.total_businesses || 0;
      const current  = businesses.length;
      // Each 5% growth above baseline = 1 zoning signal
      if (baseline > 0 && current > baseline) {
        zoning_changes = Math.floor(((current - baseline) / baseline) * 20);
      }
    }
  } catch (err) {
    // No zip data yet — zeros are correct
  }

  return Promise.resolve({ new_construction_count, renovation_count, utility_extensions, zoning_changes });
}

/**
 * FDOT road project data — API endpoint returns HTTP 400 (confirmed broken 2026-05-02).
 * Returns zeros until a working endpoint is found. Logs once at startup.
 * TODO: find replacement endpoint at https://gis.fdot.gov/arcgis/rest/services/
 */
let _fdotWarned = false;
async function fetchFdotProjects(zipEntry) {
  if (!_fdotWarned) {
    _fdotWarned = true;
    console.warn('[bedrockWorker] ⚠️  FDOT API returning HTTP 400 — road project data unavailable. road_investment_score will be 0 until fixed.');
  }
  return { active_road_projects: 0, planned_projects: 0 };
}

/**
 * Fetch FEMA NFHL flood zone data for a ZIP centroid.
 * Returns { flood_zone_pct }
 * Falls back to FEMA_FLOOD_FALLBACK table on timeout or error.
 */
async function fetchFloodZone(zipEntry) {
  const { zip, lat, lon } = zipEntry;
  const bb = bbox(lat, lon, 0.05);
  const geometry = encodeURIComponent(
    JSON.stringify({ xmin: bb.xmin, ymin: bb.ymin, xmax: bb.xmax, ymax: bb.ymax, spatialReference: { wkid: 4326 } })
  );
  const url =
    `https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query` +
    `?geometry=${geometry}` +
    `&geometryType=esriGeometryEnvelope` +
    `&spatialRel=esriSpatialRelIntersects` +
    `&outFields=FLD_ZONE,ZONE_SUBTY` +
    `&returnGeometry=false` +
    `&f=json` +
    `&resultRecordCount=500`;

  try {
    const data = await safeFetch(url, { _timeout: 8_000 });
    const features = data.features || [];

    if (features.length === 0) {
      // Zero features likely means timeout returned empty — use fallback
      const fallback = FEMA_FLOOD_FALLBACK[zip] ?? 10;
      return { flood_zone_pct: fallback, raw_zone_counts: {}, source: 'fallback-empty' };
    }

    const zoneCounts = {};
    for (const f of features) {
      const z = (f.attributes?.FLD_ZONE || 'X').toUpperCase();
      zoneCounts[z] = (zoneCounts[z] || 0) + 1;
    }

    const highRisk = Object.entries(zoneCounts)
      .filter(([z]) => /^[AV]/.test(z))
      .reduce((s, [, c]) => s + c, 0);

    const flood_zone_pct = Math.round((highRisk / features.length) * 100);
    return { flood_zone_pct, raw_zone_counts: zoneCounts, source: 'live' };
  } catch (err) {
    // Timeout or network error — use hardcoded fallback silently
    const fallback = FEMA_FLOOD_FALLBACK[zip] ?? 10;
    if (!fetchFloodZone._warned) fetchFloodZone._warned = {};
    if (!fetchFloodZone._warned[zip]) {
      console.warn(`[bedrockWorker] FEMA unavailable for ${zip} — using fallback ${fallback}% (won't repeat)`);
      fetchFloodZone._warned[zip] = true;
    }
    return { flood_zone_pct: fallback, raw_zone_counts: {}, source: 'fallback-error' };
  }
}

// ── Scoring algorithm ─────────────────────────────────────────────────────────

function computeScore({ new_construction_count, renovation_count, utility_extensions, zoning_changes,
                        active_road_projects, planned_projects, flood_zone_pct }) {
  const construction_activity_score = Math.min(25, new_construction_count * 2 + renovation_count * 0.5);
  const road_investment_score       = Math.min(25, active_road_projects * 8 + planned_projects * 3);
  const utility_score               = Math.min(15, utility_extensions * 5);
  const zoning_score                = Math.min(10, zoning_changes * 3);
  const natural_resource_penalty    = Math.min(25, flood_zone_pct * 0.25);

  const raw = construction_activity_score + road_investment_score + utility_score + zoning_score - natural_resource_penalty;
  const infrastructure_momentum_score = Math.max(0, Math.min(100, Math.round(raw)));

  return {
    infrastructure_momentum_score,
    components: {
      construction_activity_score: Math.round(construction_activity_score * 10) / 10,
      road_investment_score:       Math.round(road_investment_score       * 10) / 10,
      utility_score:               Math.round(utility_score               * 10) / 10,
      zoning_score:                Math.round(zoning_score                * 10) / 10,
      natural_resource_penalty:    Math.round(natural_resource_penalty    * 10) / 10,
    },
  };
}

// ── Per-ZIP run ───────────────────────────────────────────────────────────────

async function processZip(zipEntry, mode = 'incremental') {
  const { zip, lat, lon, name } = zipEntry;

  const [permits, fdot, fema] = await Promise.all([
    fetchPermits(zipEntry),
    fetchFdotProjects(zipEntry),
    fetchFloodZone(zipEntry),
  ]);

  const inputs = { ...permits, ...fdot, ...fema };
  const scoring = computeScore(inputs);

  const result = {
    zip,
    name,
    lat,
    lon,
    updated_at: new Date().toISOString(),
    mode,
    inputs,
    ...scoring,
  };

  const outPath = path.join(BEDROCK_DIR, `${zip}.json`);
  atomicWrite(outPath, result);
  // Mirror to Postgres (fire-and-forget — never block the flat-file write)
  pgStore.upsertBedrockScore(zip, result).catch(() => {});
  return result;
}

// ── Full run ──────────────────────────────────────────────────────────────────

async function runBedrock(mode = 'incremental') {
  console.log(`[bedrockWorker] Starting ${mode} run at ${new Date().toISOString()}`);
  ensureDirs();

  // ZIP discovery: Postgres first (all ZIPs we have businesses for),
  // fall back to hardcoded SJC_ZIPS so bedrock always runs something.
  // processZip needs {zip, lat, lon, name} — we pull lat/lon from flZipRegistry.
  let targetZips = SJC_ZIPS;
  if (process.env.LOCAL_INTEL_DB_URL) {
    try {
      const { getDistinctZips } = require('../lib/pgStore');
      const { getAllZips: flGetAll } = require('./flZipRegistry');
      const pgZips = await getDistinctZips();
      if (pgZips.length > 0) {
        const flIndex = Object.fromEntries(flGetAll().map(z => [z.zip, z]));
        // SJC_ZIPS index for lat/lon on known ZIPs
        const sjcIndex = Object.fromEntries(SJC_ZIPS.map(z => [z.zip, z]));
        targetZips = pgZips.map(zip => {
          const known = sjcIndex[zip] || flIndex[zip];
          return {
            zip,
            lat:  known?.lat  || known?.centroid?.lat  || 0,
            lon:  known?.lon  || known?.centroid?.lon  || 0,
            name: known?.name || known?.label          || zip,
          };
        }).filter(z => z.lat !== 0 || z.lon !== 0); // skip ZIPs with no centroid data
        console.log(`[bedrockWorker] ZIP discovery: ${targetZips.length} ZIPs from Postgres`);
      }
    } catch (e) {
      console.warn('[bedrockWorker] Postgres ZIP discovery failed, using SJC_ZIPS:', e.message);
    }
  }

  const index = {
    updated_at: new Date().toISOString(),
    mode,
    zips: [],
  };

  const scores = [];
  for (const zipEntry of targetZips) {
    try {
      const result = await processZip(zipEntry, mode);
      index.zips.push({
        zip:  result.zip,
        name: result.name,
        infrastructure_momentum_score: result.infrastructure_momentum_score,
        updated_at: result.updated_at,
      });
      scores.push(`${result.zip}=${result.infrastructure_momentum_score}`);
    } catch (err) {
      logError(`processZip-${zipEntry.zip}`, err);
    }
  }

  atomicWrite(INDEX_FILE, index);
  const scoresSummary = scores.join(', ') || 'no ZIPs processed';
  console.log(`[bedrockWorker] ${mode} run complete — ${scoresSummary}`);

  // Alert owner if FEMA fell back on all ZIPs (means API is down, not just slow)
  const allFallback = index.zips.length > 0 && index.zips.every(z => z.infrastructure_momentum_score === 0);
  if (allFallback) {
    console.error('[bedrockWorker] ❌ ALL ZIPs scored 0 — FEMA and permit data may both be unavailable. Check API endpoints.');
    try {
      const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await twilio.messages.create({
        body: `[LocalIntel] bedrockWorker: all ZIPs scored 0 — FEMA/permit APIs may be down. Check Railway logs.`,
        from: process.env.TWILIO_FROM_NUMBER,
        to: process.env.OWNER_ALERT_PHONE || '+19045867887',
      });
    } catch (_) {}
  }

  // Write heartbeat to Postgres so restarts skip if fresh
  try {
    if (process.env.LOCAL_INTEL_DB_URL) {
      const db = require('../lib/db');
      await db.query(
        `INSERT INTO worker_heartbeat (worker_name, last_run) VALUES ('bedrockWorker', NOW())
         ON CONFLICT (worker_name) DO UPDATE SET last_run = NOW()`
      );
    }
  } catch (_) {}
}

// ── Scheduling ────────────────────────────────────────────────────────────────

// No recurring intervals — runs once per deploy, Railway redeploys handle monthly cadence.

// ── Error guard ───────────────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  try { logError('uncaughtException', err); } catch (_) {}
  console.error('[bedrockWorker] Uncaught exception (recovered):', err.message);
});

process.on('unhandledRejection', (reason) => {
  try { logError('unhandledRejection', { message: String(reason) }); } catch (_) {}
  console.error('[bedrockWorker] Unhandled rejection (recovered):', reason);
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

(async () => {
  // Bedrock only needs to run once a month — permits, FDOT road projects,
  // and FEMA flood zones don't change week-to-week.
  // Skip if last run was within 25 days. Railway deploys act as the monthly trigger.
  const SKIP_IF_FRESH_MS = 25 * 24 * 60 * 60 * 1000;
  let skipRun = false;
  try {
    if (process.env.LOCAL_INTEL_DB_URL) {
      const db = require('../lib/db');
      await db.query(`CREATE TABLE IF NOT EXISTS worker_heartbeat (
        worker_name TEXT PRIMARY KEY, last_run TIMESTAMPTZ
      )`);
      const row = await db.queryOne(
        `SELECT last_run FROM worker_heartbeat WHERE worker_name = 'bedrockWorker'`
      );
      if (row && row.last_run && (Date.now() - new Date(row.last_run).getTime()) < SKIP_IF_FRESH_MS) {
        console.log(`[bedrockWorker] Last run was ${row.last_run} — fresh, skipping. Next run in ~${Math.round((SKIP_IF_FRESH_MS - (Date.now() - new Date(row.last_run).getTime())) / 86400000)}d`);
        skipRun = true;
      }
    }
  } catch (_) {}

  if (!skipRun) {
    await runBedrock('full');
  }

  // Keep process alive so spawnLocalIntelWorker doesn't auto-restart it.
  // No setInterval for re-runs — Railway redeploys handle monthly cadence.
  console.log('[bedrockWorker] Done. Staying alive until next deploy.');
  setInterval(() => {}, 60 * 60 * 1000); // 1hr keep-alive, well under 32-bit limit
})();
