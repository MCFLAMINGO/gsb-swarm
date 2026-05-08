'use strict';
/**
 * sjcArcGisWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * St. Johns County GIS — permit + development signal ingestion
 *
 * Sources (all public REST, no key required):
 *   activePermits  — current open building permits (FeatureServer)
 *   CO_Permits     — certificates of occupancy (FeatureServer)
 *   Future_Land_Use — zoning/land use layer (FeatureServer)
 *
 * GIS REST base: https://www.gis.sjcfl.us/portal_sjcgis/rest/services
 *
 * What it does:
 *   - Fetches active permits filtered to our covered ZIPs by bounding box
 *   - Classifies permit type: commercial, residential, industrial
 *   - Counts permits per ZIP for last 6 months
 *   - Upserts into sjc_permits table in Postgres
 *   - Logs summary to worker_events as 'sjc_arcgis'
 *   - Runs every 24h
 *
 * sjc_permits table schema (auto-created):
 *   zip TEXT, permit_no TEXT UNIQUE, address TEXT, use_desc TEXT,
 *   permit_type TEXT, co_date TIMESTAMPTZ, fetched_at TIMESTAMPTZ
 */

const https  = require('https');
const db     = require('../lib/db');

const GIS_BASE  = 'https://www.gis.sjcfl.us/portal_sjcgis/rest/services';
const LOOP_H    = 24;
const FULL_REFRESH = process.env.FULL_REFRESH === 'true';

// SJC bounding box (covers all our ZIPs + buffer)
// SW: 29.62, -81.69   NE: 30.25, -81.21
const BBOX = '-81.69,29.62,-81.21,30.25';

// ZIP → approximate centroid for spatial assignment
const ZIP_CENTROIDS = {
  '32082': { lat: 30.199, lon: -81.382 },
  '32081': { lat: 30.098, lon: -81.397 },
  '32092': { lat: 30.010, lon: -81.494 },
  '32084': { lat: 29.889, lon: -81.315 },
  '32086': { lat: 29.789, lon: -81.275 },
  '32095': { lat: 30.153, lon: -81.432 },
  '32080': { lat: 29.857, lon: -81.268 },
  '32259': { lat: 30.028, lon: -81.477 },
  '32250': { lat: 30.283, lon: -81.398 },
  '32266': { lat: 30.320, lon: -81.403 },
  '32258': { lat: 30.091, lon: -81.501 },
  '32223': { lat: 30.160, lon: -81.613 },
  '32233': { lat: 30.335, lon: -81.400 },
  '32206': { lat: 30.348, lon: -81.630 },
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function logWorkerEvent({ eventType, recordsIn, recordsOut, durationMs, error }) {
  try {
    await db.query(
      `INSERT INTO worker_events (worker_name, event_type, records_in, records_out, duration_ms, error_message, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      ['sjc_arcgis', eventType, recordsIn || 0, recordsOut || 0, durationMs || 0, error || null]
    );
  } catch (e) { console.warn('[sjcArcGis] worker_events log failed:', e.message); }
}

async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS sjc_permits (
      id          SERIAL PRIMARY KEY,
      zip         TEXT,
      permit_no   TEXT UNIQUE,
      address     TEXT,
      use_desc    TEXT,
      permit_type TEXT,
      co_date     TIMESTAMPTZ,
      fetched_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS sjc_permits_zip_idx ON sjc_permits (zip)`);
  await db.query(`CREATE INDEX IF NOT EXISTS sjc_permits_type_idx ON sjc_permits (permit_type)`);
}

function fetchGIS(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'LocalIntel-SJC/1.0' } }, res => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let b = '';
      res.setEncoding('utf8');
      res.on('data', c => { b += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(b)); }
        catch (e) { reject(new Error('JSON parse failed')); }
      });
      res.on('error', reject);
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

// Assign a ZIP to a lat/lon point by nearest centroid
function assignZip(x, y) {
  if (!x || !y) return null;
  // GIS uses Web Mercator (EPSG:3857) — convert to WGS84
  const lon = x / 20037508.34 * 180;
  const lat = Math.atan(Math.exp(y / 20037508.34 * Math.PI)) * 360 / Math.PI - 90;

  let nearestZip = null;
  let minDist = Infinity;
  for (const [zip, c] of Object.entries(ZIP_CENTROIDS)) {
    const d = Math.hypot(lat - c.lat, lon - c.lon);
    if (d < minDist) { minDist = d; nearestZip = zip; }
  }
  // Only assign if within ~5 miles (~0.07 degrees)
  return minDist < 0.07 ? nearestZip : null;
}

function classifyPermit(useDesc) {
  if (!useDesc) return 'unknown';
  const u = useDesc.toUpperCase();
  if (u.includes('SINGLE FAMILY') || u.includes('RESIDENTIAL') || u.includes('MOBILE HOME')) return 'residential';
  if (u.includes('COMMERCIAL') || u.includes('OFFICE') || u.includes('STORE') || u.includes('RESTAURANT') || u.includes('HOTEL')) return 'commercial';
  if (u.includes('INDUSTRIAL') || u.includes('FACTORY') || u.includes('WAREHOUSE')) return 'industrial';
  if (u.includes('SCHOOL') || u.includes('CHURCH') || u.includes('PUBLIC')) return 'civic';
  return 'other';
}

async function fetchActivePermits() {
  console.log('[sjcArcGis] Fetching active permits...');
  // Use geometry filter — spatial envelope over our coverage area
  const url = `${GIS_BASE}/activePermits/FeatureServer/0/query?` +
    `geometry=${encodeURIComponent(BBOX)}&geometryType=esriGeometryEnvelope` +
    `&spatialRel=esriSpatialRelIntersects` +
    `&outFields=PermitNo,ProjAddrCombined,PropUseDesc,CoDate` +
    `&resultRecordCount=2000&f=json`;

  const data = await fetchGIS(url);
  return (data.features || []).map(f => {
    const a = f.attributes || {};
    const g = f.geometry || {};
    return {
      permit_no:   a.PermitNo,
      address:     a.ProjAddrCombined,
      use_desc:    a.PropUseDesc,
      co_date:     a.CoDate ? new Date(a.CoDate) : null,
      permit_type: classifyPermit(a.PropUseDesc),
      zip:         assignZip(g.x, g.y),
    };
  }).filter(p => p.permit_no && p.zip);
}

async function fetchCOPermits() {
  console.log('[sjcArcGis] Fetching CO permits...');
  // Filter to last 6 months
  const sixMonthsAgo = Date.now() - (180 * 24 * 60 * 60 * 1000);
  const url = `${GIS_BASE}/CO_Permits/FeatureServer/0/query?` +
    `geometry=${encodeURIComponent(BBOX)}&geometryType=esriGeometryEnvelope` +
    `&spatialRel=esriSpatialRelIntersects` +
    `&where=${encodeURIComponent(`CoDate >= ${sixMonthsAgo}`)}` +
    `&outFields=*&resultRecordCount=2000&f=json`;

  try {
    const data = await fetchGIS(url);
    return (data.features || []).map(f => {
      const a = f.attributes || {};
      const g = f.geometry || {};
      return {
        permit_no:   a.PermitNo || a.PERMITNO || a.permit_no,
        address:     a.ProjAddrCombined || a.ADDRESS,
        use_desc:    a.PropUseDesc || a.USEDESC,
        co_date:     a.CoDate ? new Date(a.CoDate) : null,
        permit_type: classifyPermit(a.PropUseDesc || a.USEDESC),
        zip:         assignZip(g.x, g.y),
      };
    }).filter(p => p.permit_no && p.zip);
  } catch (e) {
    console.warn('[sjcArcGis] CO_Permits fetch failed:', e.message);
    return [];
  }
}

async function upsertPermits(permits) {
  let upserted = 0;
  for (const p of permits) {
    try {
      await db.query(
        `INSERT INTO sjc_permits (zip, permit_no, address, use_desc, permit_type, co_date, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (permit_no) DO UPDATE SET
           zip = EXCLUDED.zip, address = EXCLUDED.address,
           use_desc = EXCLUDED.use_desc, permit_type = EXCLUDED.permit_type,
           co_date = EXCLUDED.co_date, fetched_at = NOW()`,
        [p.zip, p.permit_no, p.address, p.use_desc, p.permit_type, p.co_date]
      );
      upserted++;
    } catch (e) {
      if (!e.message.includes('unique')) console.warn('[sjcArcGis] upsert failed:', e.message);
    }
  }
  return upserted;
}

async function runPass() {
  const t0 = Date.now();
  await ensureSchema();
  await logWorkerEvent({ eventType: 'start' });

  let total = 0;
  try {
    const active = await fetchActivePermits();
    console.log(`[sjcArcGis] Active permits fetched: ${active.length}`);
    total += await upsertPermits(active);
  } catch (e) {
    console.error('[sjcArcGis] activePermits error:', e.message);
  }

  await sleep(2000);

  try {
    const co = await fetchCOPermits();
    console.log(`[sjcArcGis] CO permits fetched: ${co.length}`);
    total += await upsertPermits(co);
  } catch (e) {
    console.error('[sjcArcGis] CO_Permits error:', e.message);
  }

  // Summary by ZIP
  try {
    const rows = await db.query(
      `SELECT zip, permit_type, COUNT(*) as cnt
       FROM sjc_permits
       WHERE fetched_at > NOW() - INTERVAL '48 hours'
       GROUP BY zip, permit_type ORDER BY zip, cnt DESC`
    );
    const byZip = {};
    rows.forEach(r => {
      if (!byZip[r.zip]) byZip[r.zip] = {};
      byZip[r.zip][r.permit_type] = parseInt(r.cnt);
    });
    console.log('[sjcArcGis] ZIP permit summary:', JSON.stringify(byZip));
  } catch (_) {}

  const durationMs = Date.now() - t0;
  await logWorkerEvent({ eventType: 'complete', recordsOut: total, durationMs });
  console.log(`[sjcArcGis] Pass complete — ${total} permits upserted in ${durationMs}ms`);
}

// ── Daemon loop ───────────────────────────────────────────────────────────────
(async function main() {
  console.log('[sjcArcGis] Worker started');
  while (true) {
    try { await runPass(); }
    catch (err) { console.error('[sjcArcGis] Pass crashed:', err.message); }
    console.log(`[sjcArcGis] Sleeping ${LOOP_H}h`);
    await sleep(LOOP_H * 60 * 60 * 1000);
  }
})();

module.exports = { runPass };
