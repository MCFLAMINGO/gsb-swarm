/**
 * boundaryWorker.js — LocalIntel ZIP Boundary Layer
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches ZCTA (ZIP Code Tabulation Area) polygon boundaries from Census
 * TIGER/Line GeoJSON API and stores them in zip_intelligence.boundary_geojson.
 *
 * Source: https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/
 *         PUMA_TAD_TAZ_UGA_ZCTA/MapServer/2/query
 * Free, no API key, official Census boundaries.
 *
 * Worker contract: START → read Postgres (skip already fetched) → WORK new
 *                  → upsert → END. FULL_REFRESH=true re-fetches all.
 *
 * Usage:
 *   node workers/boundaryWorker.js               # only missing ZIPs
 *   FULL_REFRESH=true node workers/boundaryWorker.js  # re-fetch all
 *   ZIPS=32202,32205,32207 node workers/boundaryWorker.js  # specific ZIPs
 */

'use strict';

const db = require('../lib/db');
const { fetchZctaBoundary, computeCentroid } = require('../lib/fetchZctaBoundary');

const FULL_REFRESH = process.env.FULL_REFRESH === 'true';
const ZIP_OVERRIDE = process.env.ZIPS ? process.env.ZIPS.split(',').map(z => z.trim()) : null;

async function run() {
  console.log('[boundaryWorker] START');

  // Determine which ZIPs to process
  let zips;
  if (ZIP_OVERRIDE) {
    zips = ZIP_OVERRIDE;
    console.log(`[boundaryWorker] processing ${zips.length} override ZIPs`);
  } else if (FULL_REFRESH) {
    const rows = await db.query('SELECT zip FROM zip_intelligence ORDER BY zip');
    zips = rows.map(r => r.zip);
    console.log(`[boundaryWorker] FULL_REFRESH — ${zips.length} ZIPs`);
  } else {
    // Only ZIPs missing boundary
    const rows = await db.query(
      'SELECT zip FROM zip_intelligence WHERE boundary_geojson IS NULL ORDER BY zip'
    );
    zips = rows.map(r => r.zip);
    console.log(`[boundaryWorker] ${zips.length} ZIPs missing boundary`);
  }

  if (!zips.length) {
    console.log('[boundaryWorker] nothing to do');
    process.exit(0);
  }

  let fetched = 0, failed = 0, skipped = 0;

  for (const zip of zips) {
    try {
      const geometry = await fetchZctaBoundary(zip);
      if (!geometry) {
        console.warn(`[boundaryWorker] no polygon for ${zip}`);
        skipped++;
        continue;
      }

      const centroid = computeCentroid(geometry);

      await db.query(
        `UPDATE zip_intelligence
         SET boundary_geojson = $1,
             lat = COALESCE(lat, $2),
             lon = COALESCE(lon, $3),
             updated_at = now()
         WHERE zip = $4`,
        [
          JSON.stringify(geometry),
          centroid?.lat ?? null,
          centroid?.lon ?? null,
          zip,
        ]
      );

      fetched++;
      if (fetched % 10 === 0) console.log(`[boundaryWorker] ${fetched}/${zips.length} done`);

      // Polite delay — avoid hammering Census API
      await new Promise(r => setTimeout(r, 300));

    } catch (e) {
      console.error(`[boundaryWorker] error for ${zip}:`, e.message);
      failed++;
      await new Promise(r => setTimeout(r, 1000)); // back off on error
    }
  }

  // Log to worker_events
  await db.query(
    `INSERT INTO worker_events
       (worker_name, event_type, input_summary, output_summary, records_in, records_out, success_rate)
     VALUES ('boundaryWorker','fetch_run',$1,$2,$3,$4,$5)`,
    [
      `${zips.length} ZIPs`,
      `fetched:${fetched} skipped:${skipped} failed:${failed}`,
      zips.length, fetched,
      zips.length ? Math.round(fetched / zips.length * 100) / 100 : 0,
    ]
  );

  console.log(`[boundaryWorker] END — fetched:${fetched} skipped:${skipped} failed:${failed}`);
  process.exit(failed > 0 && fetched === 0 ? 1 : 0);
}

run().catch(e => {
  console.error('[boundaryWorker] FATAL:', e.message);
  process.exit(1);
});
