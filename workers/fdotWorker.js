'use strict';
/**
 * fdotWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Florida Department of Transportation (FDOT) Annual Average Daily Traffic
 * (AADT) signals per ZIP code.
 *
 * Source: FDOT Florida Traffic Online (FTO) ArcGIS REST API
 *   Layer 7 (AADT):
 *   https://gis.fdot.gov/arcgis/rest/services/FTO/fto_PROD/MapServer/7
 *   No API key required. Public layer. 2025 data current.
 *
 * Strategy:
 *   1. Load all 1,473 FL ZIPs from fl_zip_geo (lat, lon centroids).
 *   2. For each ZIP: query FDOT layer 7 with a bbox spatial filter (~5km radius
 *      around the ZIP centroid). Filter YEAR_=2025, AADT > 0.
 *   3. Aggregate: MAX(AADT), AVG(AADT), segment count, top road name.
 *   4. Upsert to zip_signals: fdot_max_aadt, fdot_avg_aadt, fdot_segment_count,
 *      fdot_top_road, fdot_year, fdot_updated_at.
 *
 * Worker contract:
 *   START → read Postgres for ZIPs that already have fdot_max_aadt (skip) →
 *   fetch only new ZIPs → upsert → END → REDEPLOY SAFE (idempotent).
 *
 * Throttle: 8 concurrent ZIP requests. FDOT max 1000 records/query (bbox
 * queries return far fewer). Rate limit ~120ms delay between batches.
 *
 * Loop: runs once on start, then every 48h (AADT is annual data).
 */

const https  = require('https');
const db     = require('../lib/db');

const LOOP_H         = 48;
const CONCURRENCY    = 8;
const BATCH_DELAY_MS = 120;
const BBOX_DEG       = 0.045; // ~5km radius bounding box in decimal degrees
const FDOT_YEAR      = 2025;

// FDOT ArcGIS Layer 7 — AADT polylines
const FDOT_BASE = 'https://gis.fdot.gov/arcgis/rest/services/FTO/fto_PROD/MapServer/7/query';

// ── worker_events logger ──────────────────────────────────────────────────────
async function logWorkerEvent({ eventType, recordsIn, recordsOut, durationMs, error }) {
  try {
    await db.query(
      `INSERT INTO worker_events (worker_name, event_type, records_in, records_out, duration_ms, error_message, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
      ['fdotWorker', eventType, recordsIn || 0, recordsOut || 0, durationMs || 0, error || null]
    );
  } catch (e) { console.warn('[fdot] worker_events log failed:', e.message); }
}

// ── Simple HTTPS GET returning parsed JSON ────────────────────────────────────
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 20000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('FDOT request timeout')); });
  });
}

// ── Query FDOT AADT for a single ZIP centroid ─────────────────────────────────
async function fetchAadtForZip(zip, lat, lon) {
  // Build bbox around centroid
  const minX = lon - BBOX_DEG;
  const minY = lat - BBOX_DEG;
  const maxX = lon + BBOX_DEG;
  const maxY = lat + BBOX_DEG;

  const params = new URLSearchParams({
    where:             `YEAR_=${FDOT_YEAR} AND AADT > 0`,
    outFields:         'AADT,ROADWAY,DESC_FRM,DESC_TO,COUNTY',
    geometry:          `${minX},${minY},${maxX},${maxY}`,
    geometryType:      'esriGeometryEnvelope',
    inSR:              '4326',
    spatialRel:        'esriSpatialRelIntersects',
    returnGeometry:    'false',
    f:                 'json',
    resultRecordCount: '1000',
  });

  const url = `${FDOT_BASE}?${params.toString()}`;
  const data = await fetchJson(url);

  if (!data.features || data.features.length === 0) {
    return null; // no road segments in this ZIP bbox
  }

  const aadts = data.features.map(f => f.attributes.AADT || 0).filter(v => v > 0);
  if (aadts.length === 0) return null;

  const maxAadt = Math.max(...aadts);
  const avgAadt = Math.round(aadts.reduce((s, v) => s + v, 0) / aadts.length);

  // Top road = DESC_FRM of highest-AADT segment
  const topFeature = data.features.reduce((best, f) =>
    (f.attributes.AADT || 0) > (best.attributes.AADT || 0) ? f : best
  );
  const topRoad = [topFeature.attributes.DESC_FRM, topFeature.attributes.DESC_TO]
    .filter(Boolean).join(' → ').slice(0, 200) || topFeature.attributes.ROADWAY || null;

  return {
    zip,
    fdot_max_aadt:      maxAadt,
    fdot_avg_aadt:      avgAadt,
    fdot_segment_count: aadts.length,
    fdot_top_road:      topRoad,
    fdot_year:          FDOT_YEAR,
  };
}

// ── Upsert one ZIP's AADT signals into zip_signals ────────────────────────────
async function upsertAadt(result) {
  await db.query(
    `INSERT INTO zip_signals (zip, fdot_max_aadt, fdot_avg_aadt, fdot_segment_count, fdot_top_road, fdot_year, fdot_updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (zip) DO UPDATE SET
       fdot_max_aadt      = EXCLUDED.fdot_max_aadt,
       fdot_avg_aadt      = EXCLUDED.fdot_avg_aadt,
       fdot_segment_count = EXCLUDED.fdot_segment_count,
       fdot_top_road      = EXCLUDED.fdot_top_road,
       fdot_year          = EXCLUDED.fdot_year,
       fdot_updated_at    = NOW()`,
    [result.zip, result.fdot_max_aadt, result.fdot_avg_aadt,
     result.fdot_segment_count, result.fdot_top_road, result.fdot_year]
  );
}

// ── Batch processor with concurrency limit ────────────────────────────────────
async function processBatch(zips) {
  let done = 0;
  let skipped = 0;

  for (let i = 0; i < zips.length; i += CONCURRENCY) {
    const batch = zips.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(({ zip, lat, lon }) => fetchAadtForZip(zip, lat, lon))
    );

    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      const { zip } = batch[j];
      if (r.status === 'fulfilled' && r.value) {
        await upsertAadt(r.value).catch(e =>
          console.warn(`[fdot] upsert failed for ${zip}:`, e.message)
        );
        done++;
      } else if (r.status === 'fulfilled' && r.value === null) {
        // No segments in this ZIP — upsert zeros so we don't re-query next cycle
        await db.query(
          `INSERT INTO zip_signals (zip, fdot_max_aadt, fdot_segment_count, fdot_year, fdot_updated_at)
           VALUES ($1, 0, 0, $2, NOW())
           ON CONFLICT (zip) DO UPDATE SET
             fdot_max_aadt      = 0,
             fdot_segment_count = 0,
             fdot_year          = $2,
             fdot_updated_at    = NOW()`,
          [zip, FDOT_YEAR]
        ).catch(() => {});
        skipped++;
      } else {
        console.warn(`[fdot] fetch failed for ${zip}:`, r.reason?.message);
      }
    }

    if (i + CONCURRENCY < zips.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }

    if ((i + CONCURRENCY) % 80 === 0) {
      console.log(`[fdot] progress: ${i + CONCURRENCY}/${zips.length} ZIPs processed`);
    }
  }

  return { done, skipped };
}

// ── Main run ─────────────────────────────────────────────────────────────────
async function run() {
  const t0 = Date.now();
  console.log('[fdot] START');

  // Load all FL ZIPs with centroids from fl_zip_geo
  let allZips;
  try {
    allZips = await db.query(
      `SELECT zip, lat, lon FROM fl_zip_geo WHERE state = 'FL' AND lat IS NOT NULL AND lon IS NOT NULL ORDER BY zip`
    );
  } catch (e) {
    console.error('[fdot] Failed to load ZIPs from fl_zip_geo:', e.message);
    await logWorkerEvent({ eventType: 'error', error: e.message });
    return;
  }

  if (!allZips || allZips.length === 0) {
    console.warn('[fdot] No ZIPs found in fl_zip_geo — skipping');
    return;
  }

  // Worker contract: skip ZIPs that already have fdot_max_aadt populated
  let alreadyDone = new Set();
  try {
    const existing = await db.query(
      `SELECT zip FROM zip_signals WHERE fdot_max_aadt IS NOT NULL AND fdot_year = $1`,
      [FDOT_YEAR]
    );
    if (Array.isArray(existing)) {
      existing.forEach(r => alreadyDone.add(r.zip));
    }
  } catch (e) {
    console.warn('[fdot] Could not load existing AADT rows — will process all:', e.message);
  }

  const pending = allZips.filter(r => !alreadyDone.has(r.zip));
  console.log(`[fdot] ${allZips.length} FL ZIPs total | ${alreadyDone.size} already done | ${pending.length} to fetch`);

  if (pending.length === 0) {
    console.log('[fdot] All ZIPs already have AADT data — nothing to do');
    await logWorkerEvent({ eventType: 'complete', recordsIn: 0, recordsOut: 0, durationMs: Date.now() - t0 });
    return;
  }

  await logWorkerEvent({ eventType: 'start', recordsIn: pending.length });

  const { done, skipped } = await processBatch(pending);

  const durationMs = Date.now() - t0;
  console.log(`[fdot] END — ${done} ZIPs written, ${skipped} with no road data, ${durationMs}ms`);
  await logWorkerEvent({ eventType: 'complete', recordsIn: pending.length, recordsOut: done, durationMs });
}

// ── Boot + loop ───────────────────────────────────────────────────────────────
(async function main() {
  const hb = require('../lib/workerHeartbeat');
  const FRESH_MS = LOOP_H * 60 * 60 * 1000;
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  console.log('[fdot] Worker started');
  while (true) {
    if (await hb.isFresh('fdotWorker', FRESH_MS)) {
      console.log('[fdot] Fresh — skipping pass');
    } else {
      try { await run(); await hb.ping('fdotWorker'); }
      catch (e) { console.error('[fdot] Pass crashed:', e.message); await hb.pingError('fdotWorker', e.message); }
    }
    console.log(`[fdot] Sleeping ${LOOP_H}h`);
    await sleep(FRESH_MS);
  }
})();
