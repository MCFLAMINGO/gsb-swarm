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

const path = require('path');
const fs   = require('fs');

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
 * Fetch building permits from SJC ArcGIS FeatureServer.
 * Replaces dead Socrata endpoint (data.sjcfl.us — connection refused).
 */
async function fetchPermits(zipEntry) {
  const { zip } = zipEntry;
  // SJC ArcGIS permits layer — publicly accessible, no key required
  const url =
    `https://services1.arcgis.com/AVP60cs0Q9PEA8rH/arcgis/rest/services/Building_Permits/FeatureServer/0/query` +
    `?where=${encodeURIComponent(`ZIP_CODE='${zip}'`)}` +
    `&outFields=PERMIT_TYPE,WORK_TYPE,ISSUED_DATE` +
    `&returnGeometry=false` +
    `&f=json` +
    `&resultRecordCount=1000`;

  let features = [];
  try {
    const data = await safeFetch(url, { _timeout: 15_000 });
    features = data.features || [];
  } catch (err) {
    if (!fetchPermits._warned) fetchPermits._warned = {};
    if (!fetchPermits._warned[zip]) {
      console.warn(`[bedrockWorker] Permits unavailable for ${zip} — using zeros (won't repeat)`);
      fetchPermits._warned[zip] = true;
    }
    return { new_construction_count: 0, renovation_count: 0, utility_extensions: 0, zoning_changes: 0 };
  }

  let new_construction_count = 0;
  let renovation_count       = 0;
  let utility_extensions     = 0;
  let zoning_changes         = 0;

  for (const f of features) {
    const attrs = f.attributes || {};
    const type = ((attrs.PERMIT_TYPE || attrs.WORK_TYPE || '')).toLowerCase();
    if (/new.*(construction|building|residential|commercial)/.test(type)) new_construction_count++;
    else if (/renov|remodel|addition|alter/.test(type)) renovation_count++;
    else if (/utilit|sewer|water.*(main|ext)|electric.*ext/.test(type)) utility_extensions++;
    else if (/zoning|rezone|variance/.test(type)) zoning_changes++;
  }

  return { new_construction_count, renovation_count, utility_extensions, zoning_changes };
}

/**
 * Fetch active FDOT road projects near a ZIP centroid.
 * Returns { active_road_projects, planned_projects }
 */
async function fetchFdotProjects(zipEntry) {
  const { zip, lat, lon } = zipEntry;
  const bb = bbox(lat, lon);
  const geometry = encodeURIComponent(
    JSON.stringify({ xmin: bb.xmin, ymin: bb.ymin, xmax: bb.xmax, ymax: bb.ymax, spatialReference: { wkid: 4326 } })
  );
  const url =
    `https://gis.fdot.gov/arcgis/rest/services/Work_Program_Current/FeatureServer/0/query` +
    `?geometry=${geometry}` +
    `&geometryType=esriGeometryEnvelope` +
    `&spatialRel=esriSpatialRelIntersects` +
    `&outFields=PROJECT_STATUS,PHASE_DESC` +
    `&returnGeometry=false` +
    `&f=json` +
    `&resultRecordCount=200`;

  try {
    const data = await safeFetch(url, { _timeout: 10_000 });
    const features = data.features || [];

    let active_road_projects = 0;
    let planned_projects     = 0;

    for (const f of features) {
      const status = ((f.attributes?.PROJECT_STATUS || f.attributes?.PHASE_DESC || '')).toLowerCase();
      if (/active|construction|under.way|in.progress|let/.test(status)) active_road_projects++;
      else planned_projects++;
    }

    return { active_road_projects, planned_projects };
  } catch (err) {
    logError(`fdot-${zip}`, err);
    return { active_road_projects: 0, planned_projects: 0 };
  }
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
  return result;
}

// ── Full run ──────────────────────────────────────────────────────────────────

async function runBedrock(mode = 'incremental') {
  console.log(`[bedrockWorker] Starting ${mode} run at ${new Date().toISOString()}`);
  ensureDirs();

  let targetZips = SJC_ZIPS;
  const queueFile    = path.join(DATA_DIR, 'zipQueue.json');
  const coverageFile = path.join(DATA_DIR, 'zipCoverage.json');

  try {
    const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    if (Array.isArray(queue) && queue.length > 0) {
      const queueZips = queue.map(z => typeof z === 'string' ? z : z.zip).filter(Boolean);
      const filtered = SJC_ZIPS.filter(z => queueZips.includes(z.zip));
      if (filtered.length > 0) targetZips = filtered;
    }
  } catch (_) {
    try {
      const coverage = JSON.parse(fs.readFileSync(coverageFile, 'utf8'));
      const coveredZips = Array.isArray(coverage)
        ? coverage.map(z => typeof z === 'string' ? z : z.zip).filter(Boolean)
        : Object.keys(coverage);
      const filtered = SJC_ZIPS.filter(z => coveredZips.includes(z.zip));
      if (filtered.length > 0) targetZips = filtered;
    } catch (_2) {
      // Use hardcoded SJC_ZIPS
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
  console.log(`[bedrockWorker] ${mode} run complete — ${scores.join(', ')}`);
}

// ── Scheduling ────────────────────────────────────────────────────────────────

const WEEKLY_MS  = 7  * 24 * 60 * 60 * 1000;
const MONTHLY_MS = 30 * 24 * 60 * 60 * 1000;

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
  await runBedrock('full');

  setInterval(async () => {
    try { await runBedrock('incremental'); }
    catch (err) { logError('weeklyInterval', err); }
  }, WEEKLY_MS);

  setInterval(async () => {
    try { await runBedrock('full'); }
    catch (err) { logError('monthlyInterval', err); }
  }, MONTHLY_MS);

  // Keep-alive: prevents Node from exiting between interval ticks,
  // which would trigger spawnLocalIntelWorker's auto-restart loop.
  setInterval(() => {}, 1 << 30);

  console.log(`[bedrockWorker] Scheduled — weekly incremental every ${WEEKLY_MS}ms, monthly full every ${MONTHLY_MS}ms`);
})();
