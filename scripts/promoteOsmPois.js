'use strict';
/**
 * scripts/promoteOsmPois.js
 *
 * One-time script: reads all rows in zip_enrichment that have osm_pois
 * and upserts each named POI into the businesses table via db.upsertBusiness().
 *
 * Uses the same entity resolution (trigram dedup) as the live pipeline.
 * Safe to run multiple times — upserts are idempotent.
 *
 * Usage:
 *   LOCAL_INTEL_DB_URL="postgresql://..." node scripts/promoteOsmPois.js
 *   node scripts/promoteOsmPois.js --zip 32082   (single ZIP only)
 *
 * Expected output: ~166 records for 32082 alone (Home Depot, Ace, Target, etc.)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const db = require('../lib/db');

const PG_GROUP_MAP = {
  restaurant:'food', fast_food:'food', cafe:'food', bar:'food', pub:'food',
  doctor:'health', dentist:'health', clinic:'health', hospital:'health', pharmacy:'health',
  chiropractor:'health', physical_therapy:'health', optometrist:'health',
  bank:'finance', insurance:'finance', finance:'finance', accounting:'finance', mortgage:'finance',
  legal:'legal', attorney:'legal',
  retail:'retail', boutique:'retail', salon:'retail', spa:'retail', gym:'retail', fitness:'retail',
  school:'civic', church:'civic', government:'civic', library:'civic',
};
function pgGroup(cat) {
  if (!cat) return 'services';
  return PG_GROUP_MAP[cat.toLowerCase().replace(/[^a-z_]/g,'_')] || 'services';
}

// Map overpass POI category/subtype to a normalised category string
function resolveCategory(poi) {
  const cat = poi.category || 'other';
  const sub = poi.subtype || '';
  const catMap = {
    amenity: sub,
    shop: sub,
    healthcare: 'clinic',
    leisure: sub === 'fitness_centre' ? 'gym' : sub,
    tourism: sub === 'hotel' || sub === 'motel' ? 'hotel' : sub,
    office: sub || 'office',
  };
  return catMap[cat] || cat;
}

async function run() {
  const targetZip = process.argv.find(a => /^\d{5}$/.test(a)) || null;

  const rows = targetZip
    ? await db.query(
        `SELECT zip, osm_json, osm_updated_at FROM zip_enrichment WHERE zip = $1`,
        [targetZip]
      )
    : await db.query(
        `SELECT zip, osm_json, osm_updated_at FROM zip_enrichment WHERE osm_json IS NOT NULL ORDER BY zip`
      );

  if (!rows.length) {
    console.log('[promoteOsmPois] No zip_enrichment rows found.');
    process.exit(0);
  }

  console.log(`[promoteOsmPois] Processing ${rows.length} ZIP(s)…`);

  let totalWritten = 0, totalFailed = 0, totalSkipped = 0;

  for (const row of rows) {
    const zip = row.zip;
    const pois = row.osm_json?.osm_pois || [];
    const named = pois.filter(p => p.name);

    if (!named.length) {
      console.log(`[promoteOsmPois] ${zip}: 0 named POIs — skipping`);
      continue;
    }

    let written = 0, failed = 0, skipped = 0;

    for (const poi of named) {
      try {
        const category = resolveCategory(poi);
        const addr = poi.addr || {};
        const address = [addr.street, addr.city].filter(Boolean).join(', ') || null;

        await db.upsertBusiness({
          name:             poi.name,
          zip:              addr.postcode || zip,
          address,
          city:             addr.city || null,
          phone:            poi.phone || null,
          website:          poi.website || null,
          hours:            poi.hours || null,
          category,
          category_group:   pgGroup(category),
          status:           'active',
          lat:              poi.lat || null,
          lon:              poi.lon || null,
          confidence_score: 0.70,
          tags:             [],
          description:      null,
          source_id:        'osm',
          source_weight:    0.3,
          source_raw:       null,
        });
        written++;
      } catch (e) {
        failed++;
        if (failed === 1) console.warn(`[promoteOsmPois] ${zip} first error:`, e.message);
      }
    }

    console.log(`[promoteOsmPois] ${zip}: ${written} written, ${failed} failed, ${named.length - written - failed} skipped`);
    totalWritten += written;
    totalFailed  += failed;
    totalSkipped += named.length - written - failed;
  }

  console.log(`\n[promoteOsmPois] DONE — written:${totalWritten} failed:${totalFailed} skipped:${totalSkipped}`);
  process.exit(0);
}

run().catch(err => {
  console.error('[promoteOsmPois] Fatal:', err.message);
  process.exit(1);
});
