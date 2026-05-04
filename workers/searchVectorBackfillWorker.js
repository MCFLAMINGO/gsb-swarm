'use strict';
/**
 * searchVectorBackfillWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 1 LocalIntel query foundation — populates `cuisine` (extracted from
 * OSM tags) and `search_vector` (weighted tsvector) for every business row.
 *
 * Contract:
 *   START → check worker_events; skip if last run < 12h ago (FULL_REFRESH=true overrides)
 *   WORK  → stream all businesses in batches of 200, derive cuisine from tags,
 *           call businesses_search_vector_build() and UPDATE the row
 *   END   → write worker_events { event_type: 'run_complete', meta: {...} }
 *   LOOP  → stays alive idle after one pass; supervisor restarts will self-skip
 */

const db = require('../lib/db');

const BATCH_SIZE     = 200;
const MIN_RUN_GAP_H  = 12;
const FULL_REFRESH   = process.env.FULL_REFRESH === 'true';
const STAGGER_MS     = 60 * 1000;

const KNOWN_CUISINES = new Set([
  'chinese','italian','mexican','american','sushi','thai','indian','japanese',
  'greek','french','vietnamese','korean','mediterranean','seafood','barbecue',
  'pizza','burger','sandwich','vegetarian','vegan',
]);

function extractCuisine(tags) {
  if (!Array.isArray(tags) || !tags.length) return null;
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().toLowerCase();
    // Match "cuisine=xxx" tag form
    if (t.startsWith('cuisine=')) {
      const val = t.slice('cuisine='.length).split(';')[0].trim();
      if (KNOWN_CUISINES.has(val)) return val;
    }
  }
  // Fallback — any bare known-cuisine tag
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().toLowerCase();
    if (KNOWN_CUISINES.has(t)) return t;
  }
  return null;
}

async function shouldSkip() {
  if (FULL_REFRESH) return false;
  try {
    const rows = await db.query(
      `SELECT created_at FROM worker_events
       WHERE worker_name = 'searchVectorBackfillWorker' AND event_type = 'run_complete'
       ORDER BY created_at DESC LIMIT 1`
    );
    if (!rows.length) return false;
    const lastRun = new Date(rows[0].created_at);
    const hoursSince = (Date.now() - lastRun.getTime()) / 3600000;
    return hoursSince < MIN_RUN_GAP_H;
  } catch (_) {
    return false;
  }
}

async function runBackfill() {
  console.log(`[search-vector-backfill] Starting backfill (FULL_REFRESH=${FULL_REFRESH})...`);
  const t0 = Date.now();

  // Fetch IDs only first — keeps memory bounded; iterate in keyset pages
  let lastId = '00000000-0000-0000-0000-000000000000';
  let processed = 0, updated = 0, failed = 0, withCuisine = 0;

  while (true) {
    const rows = await db.query(
      `SELECT business_id, name, category, description,
              services_text, tags, cuisine, search_vector
         FROM businesses
        WHERE business_id > $1
          ${FULL_REFRESH ? '' : 'AND search_vector IS NULL'}
        ORDER BY business_id
        LIMIT $2`,
      [lastId, BATCH_SIZE]
    );
    if (!rows.length) break;

    for (const biz of rows) {
      lastId = biz.business_id;
      processed++;

      const cuisine = extractCuisine(biz.tags) || biz.cuisine || null;
      if (cuisine) withCuisine++;

      try {
        await db.query(
          `UPDATE businesses
              SET cuisine       = $1,
                  search_vector = businesses_search_vector_build($2, $3, $4, $5, $6, $1)
            WHERE business_id   = $7`,
          [
            cuisine,
            biz.name || '',
            biz.category || '',
            biz.description || '',
            biz.services_text || '',
            Array.isArray(biz.tags) ? biz.tags : [],
            biz.business_id,
          ]
        );
        updated++;
      } catch (e) {
        failed++;
        if (failed <= 5) {
          console.warn(`[search-vector-backfill] biz ${biz.business_id} failed: ${e.message}`);
        }
      }
    }

    if (processed % BATCH_SIZE === 0) {
      console.log(`[search-vector-backfill] progress — processed=${processed} updated=${updated} cuisine=${withCuisine} failed=${failed}`);
    }

    if (rows.length < BATCH_SIZE) break;
  }

  const elapsed = Date.now() - t0;
  console.log(
    `[search-vector-backfill] Done — processed=${processed} updated=${updated} ` +
    `cuisine=${withCuisine} failed=${failed} elapsed=${elapsed}ms`
  );

  try {
    await db.query(
      `INSERT INTO worker_events (worker_name, event_type, meta, created_at)
       VALUES ($1, $2, $3, NOW())`,
      ['searchVectorBackfillWorker', 'run_complete', JSON.stringify({
        processed, updated, with_cuisine: withCuisine, failed,
        elapsed_ms: elapsed, full_refresh: FULL_REFRESH,
      })]
    );
  } catch (e) {
    console.warn('[search-vector-backfill] worker_events log failed:', e.message);
  }

  return { processed, updated, withCuisine, failed, elapsed };
}

(async function main() {
  console.log('[search-vector-backfill] Worker started');

  await new Promise(r => setTimeout(r, STAGGER_MS));

  if (await shouldSkip()) {
    console.log('[search-vector-backfill] Skipping — ran within last 12h (set FULL_REFRESH=true to force)');
  } else {
    try {
      await runBackfill();
    } catch (e) {
      console.error('[search-vector-backfill] Run failed:', e.message);
      try {
        await db.query(
          `INSERT INTO worker_events (worker_name, event_type, meta, created_at)
           VALUES ($1, $2, $3, NOW())`,
          ['searchVectorBackfillWorker', 'fail', JSON.stringify({ error: e.message })]
        );
      } catch (_) {}
    }
  }

  console.log('[search-vector-backfill] Run-once complete — staying alive idle');
  setInterval(() => {}, 1 << 30);
})();

module.exports = { runBackfill, extractCuisine };
