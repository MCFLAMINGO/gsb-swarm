/**
 * neighborhoodWorker.js — LocalIntel Neighborhood Layer
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. ensureSchema()    — creates neighborhoods table, adds neighborhood_id to businesses
 * 2. seedNeighborhoods() — inserts/updates neighborhood records from seed JSON
 * 3. assignBusinesses()  — point-in-bbox assignment for every unassigned business w/ lat/lon
 *
 * Self-improving: run on schedule. New businesses get assigned automatically.
 * FULL_REFRESH=true env var clears all assignments and re-runs.
 *
 * Worker contract: START → read Postgres (skip done) → WORK new → END → upsert → SAFE
 */

'use strict';

const db   = require('../lib/db');
const path = require('path');
const fs   = require('fs');

const FULL_REFRESH = process.env.FULL_REFRESH === 'true';

// ── Jacksonville neighborhood seed ───────────────────────────────────────────
const SEED_PATH = path.join(__dirname, 'jaxNeighborhoods.json');

// ── Schema ───────────────────────────────────────────────────────────────────
async function ensureSchema() {
  // neighborhoods table
  await db.query(`
    CREATE TABLE IF NOT EXISTS neighborhoods (
      id           SERIAL PRIMARY KEY,
      slug         TEXT UNIQUE NOT NULL,
      name         TEXT NOT NULL,
      city         TEXT NOT NULL,
      county       TEXT NOT NULL,
      state        TEXT NOT NULL DEFAULT 'FL',
      region       TEXT,
      zip_codes    TEXT[],
      lat          NUMERIC,
      lon          NUMERIC,
      bbox         JSONB,
      polygon      JSONB,
      description  TEXT,
      business_count INTEGER DEFAULT 0,
      created_at   TIMESTAMPTZ DEFAULT now(),
      updated_at   TIMESTAMPTZ DEFAULT now()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_neighborhoods_city    ON neighborhoods(city)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_neighborhoods_county  ON neighborhoods(county)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_neighborhoods_slug    ON neighborhoods(slug)`);

  // Add neighborhood_id to businesses
  await db.query(`
    ALTER TABLE businesses
      ADD COLUMN IF NOT EXISTS neighborhood_id INTEGER REFERENCES neighborhoods(id),
      ADD COLUMN IF NOT EXISTS neighborhood_slug TEXT
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_businesses_neighborhood_id ON businesses(neighborhood_id)`);

  console.log('[neighborhood] schema ready');
}

// ── Seed neighborhoods ───────────────────────────────────────────────────────
async function seedNeighborhoods() {
  if (!fs.existsSync(SEED_PATH)) {
    console.warn('[neighborhood] no seed file at', SEED_PATH);
    return 0;
  }
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  let upserted = 0;

  for (const n of seed) {
    const desc = `${n.name} is a neighborhood in ${n.city}, ${n.county} County, Florida. ` +
      `LocalIntel tracks live business activity, sector gaps, and market signals for ${n.name}. ` +
      `Businesses operating in ${n.name} can claim a verified listing to receive routed job requests ` +
      `from AI agents and local customers searching in ${n.city}.`;

    await db.query(`
      INSERT INTO neighborhoods (slug, name, city, county, state, region, zip_codes, lat, lon, bbox, description)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (slug) DO UPDATE SET
        name=$2, city=$3, county=$4, region=$6, zip_codes=$7,
        lat=$8, lon=$9, bbox=$10, description=$11, updated_at=now()
    `, [
      n.slug, n.name, n.city, n.county, n.state,
      n.region || null,
      n.zips || [],
      n.lat, n.lon,
      JSON.stringify(n.bbox),
      desc
    ]);
    upserted++;
  }

  console.log(`[neighborhood] seeded ${upserted} neighborhoods`);
  return upserted;
}

// ── Assign businesses via bounding box ───────────────────────────────────────
async function assignBusinesses() {
  if (FULL_REFRESH) {
    await db.query(`UPDATE businesses SET neighborhood_id=NULL, neighborhood_slug=NULL`);
    console.log('[neighborhood] FULL_REFRESH — cleared all assignments');
  }

  // Load all neighborhoods with bboxes
  const hoods = await db.query(`
    SELECT id, slug, name, lat, lon, bbox, zip_codes FROM neighborhoods ORDER BY id
  `);
  if (!hoods.length) {
    console.warn('[neighborhood] no neighborhoods in DB — run seed first');
    return 0;
  }

  // Get unassigned businesses that have lat/lon
  const businesses = await db.query(`
    SELECT business_id, name, lat, lon, zip
    FROM businesses
    WHERE lat IS NOT NULL AND lon IS NOT NULL
      AND neighborhood_id IS NULL
    LIMIT 50000
  `);

  console.log(`[neighborhood] assigning ${businesses.length} unassigned businesses to ${hoods.length} neighborhoods`);

  let assigned = 0, skipped = 0;

  for (const biz of businesses) {
    const bizLat = parseFloat(biz.lat);
    const bizLon = parseFloat(biz.lon);
    if (isNaN(bizLat) || isNaN(bizLon)) { skipped++; continue; }

    let bestHood = null;

    // First pass: bbox check
    for (const hood of hoods) {
      const bbox = hood.bbox;
      if (!bbox) continue;
      if (
        bizLat >= bbox.south && bizLat <= bbox.north &&
        bizLon >= bbox.west  && bizLon <= bbox.east
      ) {
        // If multiple match, pick closest centroid
        if (!bestHood) {
          bestHood = hood;
        } else {
          const dOld = Math.hypot(bizLat - bestHood.lat, bizLon - bestHood.lon);
          const dNew = Math.hypot(bizLat - hood.lat,     bizLon - hood.lon);
          if (dNew < dOld) bestHood = hood;
        }
      }
    }

    // Fallback: ZIP match if no bbox hit
    if (!bestHood && biz.zip) {
      for (const hood of hoods) {
        if (hood.zip_codes && hood.zip_codes.includes(biz.zip)) {
          if (!bestHood) bestHood = hood;
        }
      }
    }

    if (bestHood) {
      await db.query(
        `UPDATE businesses SET neighborhood_id=$1, neighborhood_slug=$2 WHERE business_id=$3`,
        [bestHood.id, bestHood.slug, biz.business_id]
      );
      assigned++;
    } else {
      skipped++;
    }
  }

  // Update business_count on neighborhoods
  await db.query(`
    UPDATE neighborhoods n SET
      business_count = (SELECT COUNT(*) FROM businesses b WHERE b.neighborhood_id = n.id),
      updated_at = now()
  `);

  console.log(`[neighborhood] assigned: ${assigned}, skipped (no match): ${skipped}`);

  await db.query(`INSERT INTO worker_events
    (worker_name, event_type, input_summary, output_summary, records_in, records_out, success_rate)
    VALUES ('neighborhoodWorker','assignment_run',
      $1, $2, $3, $4, $5)`,
    [
      `${businesses.length} unassigned businesses`,
      `assigned:${assigned} skipped:${skipped}`,
      businesses.length, assigned,
      businesses.length ? Math.round(assigned / businesses.length * 100) / 100 : 0
    ]
  );

  return assigned;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  console.log('[neighborhoodWorker] START');
  try {
    await ensureSchema();
    await seedNeighborhoods();
    const assigned = await assignBusinesses();
    console.log(`[neighborhoodWorker] END — ${assigned} businesses assigned`);
    process.exit(0);
  } catch (e) {
    console.error('[neighborhoodWorker] FATAL:', e.message);
    await db.query(`INSERT INTO worker_events
      (worker_name, event_type, error_message, success_rate)
      VALUES ('neighborhoodWorker','fatal_error',$1,0)`, [e.message]).catch(()=>{});
    process.exit(1);
  }
}

run();
