'use strict';
/**
 * scripts/promoteOsmBatch.js
 *
 * Fast version: processes ZIPs in batches of N, runs upserts in parallel
 * within each ZIP (bounded concurrency), then moves to next ZIP.
 *
 * Usage:
 *   node scripts/promoteOsmBatch.js                  -- all ZIPs
 *   node scripts/promoteOsmBatch.js --zips 32082,32081,32095
 *   node scripts/promoteOsmBatch.js --limit 50        -- first 50 ZIPs only
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Pool } = require('pg');
const db = require('../lib/db');

const CONCURRENCY = 20; // parallel upserts per ZIP

const PG_GROUP_MAP = {
  restaurant:'food', fast_food:'food', cafe:'food', bar:'food', pub:'food', food_court:'food',
  doctor:'health', dentist:'health', clinic:'health', hospital:'health', pharmacy:'health',
  chiropractor:'health', optometrist:'health', veterinary:'health',
  bank:'finance', atm:'finance', insurance:'finance', financial:'finance', mortgage:'finance',
  attorney:'legal', lawyer:'legal',
  gym:'retail', fitness_centre:'retail', salon:'retail', spa:'retail', hairdresser:'retail',
  supermarket:'retail', convenience:'retail', hardware:'retail', electronics:'retail',
  school:'civic', college:'civic', church:'civic', place_of_worship:'civic', library:'civic',
  fire_station:'civic', police:'civic', post_office:'civic',
  hotel:'lodging', motel:'lodging',
};

function pgGroup(cat) {
  if (!cat) return 'services';
  const k = cat.toLowerCase().replace(/[^a-z0-9_]/g,'_');
  return PG_GROUP_MAP[k] || 'services';
}

function resolveCategory(poi) {
  const sub = (poi.subtype || '').toLowerCase();
  const cat = (poi.category || 'other').toLowerCase();
  if (cat === 'amenity' || cat === 'shop' || cat === 'healthcare') return sub || cat;
  if (cat === 'leisure') return sub === 'fitness_centre' ? 'gym' : (sub || 'leisure');
  if (cat === 'tourism') return (sub === 'hotel' || sub === 'motel') ? sub : (sub || 'tourism');
  return sub || cat;
}

async function promoteZip(zip, pois) {
  const named = pois.filter(p => p.name && p.name.trim().length > 1);
  if (!named.length) return { zip, written: 0, failed: 0, total: 0 };

  let written = 0, failed = 0;

  // Process in batches of CONCURRENCY
  for (let i = 0; i < named.length; i += CONCURRENCY) {
    const batch = named.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (poi) => {
      try {
        const category = resolveCategory(poi);
        const addr = poi.addr || {};
        const address = [addr.street, addr.city].filter(Boolean).join(', ') || null;
        await db.upsertBusiness({
          name:             poi.name.trim(),
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
      }
    }));
  }

  return { zip, written, failed, total: named.length };
}

async function run() {
  const pool = new Pool({ connectionString: process.env.LOCAL_INTEL_DB_URL });

  // Parse args
  const zipArg  = process.argv.find(a => a.startsWith('--zips='))?.split('=')[1];
  const limitArg = process.argv.find(a => a.startsWith('--limit='))?.split('=')[1];
  const targetZips = zipArg ? zipArg.split(',').map(z => z.trim()) : null;
  const limit = limitArg ? parseInt(limitArg) : null;

  let query, params;
  if (targetZips) {
    query  = `SELECT zip, osm_json FROM zip_enrichment WHERE zip = ANY($1) AND osm_json IS NOT NULL ORDER BY zip`;
    params = [targetZips];
  } else if (limit) {
    query  = `SELECT zip, osm_json FROM zip_enrichment WHERE osm_json IS NOT NULL ORDER BY jsonb_array_length(osm_json->'osm_pois') DESC LIMIT $1`;
    params = [limit];
  } else {
    query  = `SELECT zip, osm_json FROM zip_enrichment WHERE osm_json IS NOT NULL ORDER BY zip`;
    params = [];
  }

  const { rows } = await pool.query(query, params);
  console.log(`[promoteOsmBatch] ${rows.length} ZIPs to process`);

  let totalWritten = 0, totalFailed = 0, totalZips = 0;
  const start = Date.now();

  for (const row of rows) {
    const pois = row.osm_json?.osm_pois || [];
    if (!pois.length) continue;
    const result = await promoteZip(row.zip, pois);
    totalWritten += result.written;
    totalFailed  += result.failed;
    totalZips++;
    process.stdout.write(`\r[promoteOsmBatch] ${totalZips}/${rows.length} ZIPs | +${totalWritten} written | ${Math.round((Date.now()-start)/1000)}s`);
  }

  console.log(`\n[promoteOsmBatch] DONE — ${totalWritten} written, ${totalFailed} failed across ${totalZips} ZIPs in ${Math.round((Date.now()-start)/1000)}s`);
  await pool.end();
  process.exit(0);
}

run().catch(err => {
  console.error('[promoteOsmBatch] Fatal:', err.message);
  process.exit(1);
});
