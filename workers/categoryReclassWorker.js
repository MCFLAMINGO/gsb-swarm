'use strict';
/**
 * categoryReclassWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * One-time backfill: reclassifies businesses with category='LocalBusiness' or
 * NULL by running the expanded inferCategoryFromName logic from
 * yellowPagesScraper. Skips re-runs within 24h unless FULL_REFRESH=true.
 *
 * Contract:
 *   START → check worker_events; skip if last run < 24h ago (FULL_REFRESH=true overrides)
 *   WORK  → keyset-page businesses where category IS NULL or 'LocalBusiness'
 *           in batches of 200, infer category from name, UPDATE if hit
 *   END   → write worker_events { event_type: 'run_complete', meta: {...} }
 */

const db = require('../lib/db');

const BATCH_SIZE    = 200;
const MIN_RUN_GAP_H = 24;
const FULL_REFRESH  = process.env.FULL_REFRESH === 'true';
const STAGGER_MS    = 90 * 1000;

// Copied from workers/yellowPagesScraper.js (not exported there).
// Keep in sync if the source function is updated.
function inferCategoryFromName(name) {
  const n = (name || '').toLowerCase();
  if (/dental|dentist|dds|dmg|smile|orthodont|endodont|periodon|oral surgeon/.test(n)) return 'dentist';
  if (/pharmacy|drug store|rx |apothecary/.test(n))                                  return 'chemist';
  if (/pizza|sushi|grill|restaurant|bistro|diner|kitchen|steakhouse|seafood|barbecue|bbq|taco|burger|eatery|tavern|grille|cantina|trattoria|chophouse/.test(n)) return 'restaurant';
  if (/\bbar\b|pub |brewery|taproom|cocktail|lounge/.test(n))                       return 'bar';
  if (/\bcoffee\b|espresso|roastery/.test(n))                                       return 'cafe';
  if (/hotel|inn |\bresort\b|\blodge\b|marriott|hilton|hyatt|westin|sheraton/.test(n)) return 'hotel';
  if (/fitness|crossfit|yoga|pilates|hiit|boot.?camp|orangetheory|anytime fitness|planet fitness/.test(n)) return 'fitness_centre';
  if (/massage|medspa|med spa|aesthetics|wellness center/.test(n))                  return 'beauty';
  if (/hair salon|hair studio|barber|nail |lash |blow dry/.test(n))                 return 'hairdresser';
  if (/realt|real estate|properties|homes |remax|keller williams|coldwell|century 21|compass realty|exp realty|berkshire/.test(n)) return 'estate_agent';
  if (/mortgage|wealth management|financial advisor|investment advisor|insurance|allstate|state farm|nationwide|farmers ins/.test(n)) return 'finance';
  if (/\bbank\b|credit union|fcu|federal savings|suntrust|truist|regions|ameris|hancock/.test(n)) return 'bank';
  if (/attorney|law firm|\blegal\b|litigation|\bllp\b|\bpa\b| esq/.test(n))       return 'legal';
  if (/urgent care|walk.?in|\bclinic\b|physician|\bmd\b|\bdo\b|medical group|health center|cardio|ortho|derma|pediatric|ob.gyn/.test(n)) return 'clinic';
  if (/veterinar|animal hospital|\bvet\b|pet clinic/.test(n))                       return 'veterinary';
  if (/child care|childcare|daycare|day care|preschool|montessori|learning center/.test(n)) return 'childcare';
  if (/landscap|lawn care|lawn service|tree service|irrigation/.test(n))            return 'landscaping';
  if (/plumb/.test(n))                                                               return 'plumber';
  if (/electri/.test(n))                                                             return 'electrician';
  if (/contractor|construction|builder|renovate|remodel/.test(n))                   return 'contractor';
  if (/auto repair|tire |car wash|mechanic|oil change|transmiss/.test(n))           return 'car_repair';
  if (/self.?storage|storage unit/.test(n))                                         return 'storage';
  if (/dry.?clean|laundry/.test(n))                                                 return 'dry_cleaning';
  if (/\bchurch\b|lutheran|baptist|presbyterian|methodist|catholic|episcopal|worship/.test(n)) return 'place_of_worship';
  if (/liquor|spirits|wine shop|bottle shop|abc store|total wine|abc fine/.test(n)) return 'liquor_store';
  if (/hardware|home depot|lowe'?s|ace hardware|true value|menards/.test(n))         return 'hardware';
  if (/pet supply|petco|petsmart|pet store|animal feed/.test(n))                     return 'pet';
  if (/\bvet\b|animal hosp|pet clinic|animal clinic/.test(n))                        return 'veterinary';
  if (/\blaundry\b|laundromat|dry.?clean|wash.?fold/.test(n))                        return 'laundry';
  if (/florist|flower shop|flowers/.test(n))                                          return 'florist';
  if (/\batm\b|cash machine/.test(n))                                                return 'bank';
  if (/gym|fitness center|crossfit|planet fitness|anytime fitness|orangetheory/.test(n)) return 'fitness';
  if (/auto parts|napa auto|o'reilly|advance auto|autozone/.test(n))                return 'automotive';
  if (/car wash|auto wash|express wash/.test(n))                                     return 'car_wash';
  if (/locksmith|lock.?key|lock service/.test(n))                                    return 'locksmith';
  if (/childcare|day care|daycare|preschool|montessori/.test(n))                    return 'childcare';
  if (/grocery|supermarket|whole foods|publix|winn.?dixie|aldi|kroger|safeway/.test(n)) return 'grocery';
  if (/convenience|7-eleven|seven.?eleven|circle k|wawa|gate gas|kangaroo/.test(n)) return 'convenience';
  if (/bakery|bake shop|pastry|patisserie/.test(n))                                  return 'bakery';
  if (/deli|delicatessen/.test(n))                                                   return 'deli';
  return null;
}

async function shouldSkip() {
  if (FULL_REFRESH) return false;
  try {
    const rows = await db.query(
      `SELECT created_at FROM worker_events
       WHERE worker_name = 'categoryReclassWorker' AND event_type = 'run_complete'
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

let _hasCategorySource = null;
async function hasCategorySourceColumn() {
  if (_hasCategorySource !== null) return _hasCategorySource;
  try {
    const rows = await db.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'businesses' AND column_name = 'category_source' LIMIT 1`
    );
    _hasCategorySource = rows.length > 0;
  } catch (_) {
    _hasCategorySource = false;
  }
  return _hasCategorySource;
}

async function runCategoryReclass() {
  console.log(`[categoryReclass] Starting backfill (FULL_REFRESH=${FULL_REFRESH})...`);
  const t0 = Date.now();

  if (await shouldSkip()) {
    console.log('[categoryReclass] Skipping — ran within last 24h (set FULL_REFRESH=true to force)');
    return { skipped_run: true };
  }

  const hasSource = await hasCategorySourceColumn();
  let lastId = '00000000-0000-0000-0000-000000000000';
  let total = 0, updated = 0, skipped = 0;

  while (true) {
    const rows = await db.query(
      `SELECT business_id, name, category, description, services_text, tags, cuisine
         FROM businesses
        WHERE business_id > $1
          AND (category = 'LocalBusiness' OR category IS NULL)
        ORDER BY business_id
        LIMIT $2`,
      [lastId, BATCH_SIZE]
    );
    if (!rows.length) break;

    for (const biz of rows) {
      lastId = biz.business_id;
      total++;

      const inferred = inferCategoryFromName(biz.name);
      if (!inferred) {
        skipped++;
        continue;
      }

      try {
        if (hasSource) {
          await db.query(
            `UPDATE businesses
                SET category = $1, category_source = 'inferred_backfill'
              WHERE business_id = $2`,
            [inferred, biz.business_id]
          );
        } else {
          await db.query(
            `UPDATE businesses SET category = $1 WHERE business_id = $2`,
            [inferred, biz.business_id]
          );
        }
        updated++;
      } catch (e) {
        skipped++;
        if (skipped <= 5) {
          console.warn(`[categoryReclass] biz ${biz.business_id} update failed: ${e.message}`);
        }
        continue;
      }

      try {
        await db.query(
          `UPDATE businesses
              SET search_vector = businesses_search_vector_build($1, $2, $3, $4, $5, $6)
            WHERE business_id   = $7`,
          [
            biz.name || '',
            inferred,
            biz.description || '',
            biz.services_text || '',
            Array.isArray(biz.tags) ? biz.tags : [],
            biz.cuisine || null,
            biz.business_id,
          ]
        );
      } catch (_) {
        // search_vector function may not exist — non-fatal
      }
    }

    console.log(`[categoryReclass] processed ${total}, updated ${updated}`);

    if (rows.length < BATCH_SIZE) break;
  }

  const elapsed = Date.now() - t0;
  console.log(
    `[categoryReclass] Done — total=${total} updated=${updated} skipped=${skipped} elapsed=${elapsed}ms`
  );

  try {
    await db.query(
      `INSERT INTO worker_events (worker_name, event_type, meta, created_at)
       VALUES ($1, $2, $3, NOW())`,
      ['categoryReclassWorker', 'run_complete', JSON.stringify({
        total, updated, skipped, elapsed_ms: elapsed, full_refresh: FULL_REFRESH,
      })]
    );
  } catch (e) {
    console.warn('[categoryReclass] worker_events log failed:', e.message);
  }

  return { total, updated, skipped, elapsed };
}

if (require.main === module) {
  (async function main() {
    console.log('[categoryReclass] Worker started');
    await new Promise(r => setTimeout(r, STAGGER_MS));
    try {
      await runCategoryReclass();
    } catch (e) {
      console.error('[categoryReclass] Run failed:', e.message);
      try {
        await db.query(
          `INSERT INTO worker_events (worker_name, event_type, meta, created_at)
           VALUES ($1, $2, $3, NOW())`,
          ['categoryReclassWorker', 'fail', JSON.stringify({ error: e.message })]
        );
      } catch (_) {}
    }
    console.log('[categoryReclass] Run-once complete — staying alive idle');
    setInterval(() => {}, 1 << 30);
  })();
}

module.exports = { runCategoryReclass, inferCategoryFromName };
