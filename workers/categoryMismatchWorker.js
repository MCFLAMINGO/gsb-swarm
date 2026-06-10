'use strict';
/**
 * workers/categoryMismatchWorker.js
 *
 * Scans businesses for obvious name-vs-category mismatches introduced by
 * bad source data (Yellow Pages, OSM, etc. sometimes assign wrong categories).
 *
 * WORKER CONTRACT:
 *   START → read Postgres for what's done (skip) → WORK only new → END → upsert to Postgres → REDEPLOY SAFE
 *
 * Runs as a scheduled worker (daily). Safe to re-run — already-reviewed
 * records are skipped via the category_reviews table.
 *
 * Actions:
 *   - AUTO-FIX: High-confidence mismatches (name keyword clearly identifies category)
 *               → UPDATE businesses SET category=... directly + log to category_reviews
 *   - FLAG:     Low-confidence mismatches → insert into category_reviews for human review
 *
 * No process.exit(1). Warns only on errors.
 */

const db = require('../lib/db');

// ── Mismatch rules ────────────────────────────────────────────────────────────
// Each rule: { namePattern, wrongCats, correctCat, correctGroup, confidence }
//   namePattern : regex matched against business name (case-insensitive)
//   wrongCats   : array of category strings that are clearly wrong for this name
//   correctCat  : what it should be
//   correctGroup: category_group it should be
//   confidence  : 'high' (auto-fix) | 'low' (flag for review)

const MISMATCH_RULES = [
  // ── Trades misclassified as beauty / food / other ─────────────────────────
  {
    namePattern: /\b(plumb|plumbing)\b/i,
    wrongCats:   ['spa_massage','massage','beauty','beauty_salon','hairdresser','barbershop',
                  'nail_salon','restaurant','fast_food','cafe','bar','gym','retail'],
    correctCat:  'plumber', correctGroup: 'services', confidence: 'high',
  },
  {
    // Require more than just 'electric' alone — must look like a trade company
    // Excludes: Electric Tan, Electric Slide, Electric Avenue, etc.
    namePattern: /\b(electrician|electrical (service|contractor|repair|install)|electric (corp|co\.|inc|llc|service|contractor|repair|solutions|group))\b/i,
    wrongCats:   ['spa_massage','beauty','beauty_salon','hairdresser','barbershop',
                  'nail_salon','restaurant','fast_food','bar','gym'],
    correctCat:  'electrician', correctGroup: 'services', confidence: 'high',
  },
  {
    namePattern: /\b(hvac|air condition|heating.*cooling|cooling.*heating|mechanical service)\b/i,
    wrongCats:   ['spa_massage','beauty','beauty_salon','hairdresser','restaurant','bar'],
    correctCat:  'hvac', correctGroup: 'services', confidence: 'high',
  },
  {
    namePattern: /\b(roofing|roof repair|roof install)\b/i,
    wrongCats:   ['spa_massage','beauty','beauty_salon','hairdresser','restaurant','bar','gym'],
    correctCat:  'roofing', correctGroup: 'construction', confidence: 'high',
  },
  {
    namePattern: /\b(landscap|lawn (care|service|maintenance)|yard service|tree service|sod)\b/i,
    wrongCats:   ['spa_massage','beauty','beauty_salon','hairdresser','nail_salon','restaurant',
                  'fast_food','bar','gym','insurance'],
    correctCat:  'landscaping', correctGroup: 'services', confidence: 'high',
  },
  {
    namePattern: /\b(pest control|exterminator|termite)\b/i,
    wrongCats:   ['spa_massage','beauty','beauty_salon','hairdresser','restaurant','bar'],
    correctCat:  'pest_control', correctGroup: 'services', confidence: 'high',
  },
  {
    namePattern: /\b(painting|painters?|paint contractor)\b/i,
    wrongCats:   ['spa_massage','beauty','beauty_salon','hairdresser','restaurant','bar','gym'],
    correctCat:  'painting', correctGroup: 'services', confidence: 'high',
  },
  {
    namePattern: /\b(flooring|hardwood floor|tile install|carpet install)\b/i,
    wrongCats:   ['spa_massage','beauty','beauty_salon','hairdresser','restaurant','bar'],
    correctCat:  'flooring', correctGroup: 'construction', confidence: 'high',
  },
  {
    namePattern: /\b(moving|movers?|relocation service)\b/i,
    wrongCats:   ['spa_massage','beauty','beauty_salon','hairdresser','restaurant','bar'],
    correctCat:  'moving', correctGroup: 'services', confidence: 'high',
  },
  // ── Finance / legal / professional misclassified as beauty / food ─────────
  {
    namePattern: /\b(insurance|insur\.|ins\.|coverage|underwriting)\b/i,
    wrongCats:   ['spa_massage','massage','beauty','beauty_salon','hairdresser','barbershop',
                  'nail_salon','restaurant','fast_food','cafe','bar','gym','landscaping',
                  'plumber','electrician'],
    correctCat:  'insurance', correctGroup: 'finance', confidence: 'high',
  },
  {
    namePattern: /\b(aerospace|aviation|aircraft|airlines?|aerosp\.)\b/i,
    wrongCats:   ['spa_massage','massage','beauty','beauty_salon','hairdresser','barbershop',
                  'nail_salon','restaurant','fast_food','bar','gym'],
    correctCat:  'insurance', correctGroup: 'finance', confidence: 'low', // could be manufacturing too
  },
  {
    namePattern: /\b(attorney|law (firm|office|group)|lawyers?|legal (group|services|counsel))\b/i,
    wrongCats:   ['spa_massage','beauty','beauty_salon','hairdresser','restaurant','fast_food',
                  'bar','gym','landscaping'],
    correctCat:  'law_firm', correctGroup: 'legal', confidence: 'high',
  },
  {
    namePattern: /\b(CPA|accounti|bookkeeping|tax (service|prep|advisor))\b/i,
    wrongCats:   ['spa_massage','beauty','beauty_salon','hairdresser','restaurant','bar','gym'],
    correctCat:  'accounting', correctGroup: 'finance', confidence: 'high',
  },
  {
    namePattern: /\b(mortgage|home (loan|lending)|lending|financial (services|group|advisor))\b/i,
    wrongCats:   ['spa_massage','beauty','beauty_salon','hairdresser','restaurant','bar','gym'],
    correctCat:  'financial_advisor', correctGroup: 'finance', confidence: 'high',
  },
  // ── Medical / dental misclassified as beauty / food ───────────────────────
  {
    namePattern: /\b(dental|dentist|orthodont|endodont|periodon)\b/i,
    wrongCats:   ['spa_massage','beauty','beauty_salon','hairdresser','restaurant','fast_food',
                  'bar','retail','clothes','gym'],
    correctCat:  'dentist', correctGroup: 'health', confidence: 'high',
  },
  {
    namePattern: /\b(medical|clinic|pediatric|chiropractic|orthoped|physical therapy|urgent care)\b/i,
    wrongCats:   ['spa_massage','beauty','beauty_salon','hairdresser','restaurant','fast_food',
                  'bar','retail','clothes'],
    correctCat:  'clinic', correctGroup: 'health', confidence: 'high',
  },
  {
    namePattern: /\b(optometry|optometrist|eye (care|center|clinic)|vision (center|clinic))\b/i,
    wrongCats:   ['spa_massage','beauty','beauty_salon','hairdresser','restaurant','bar'],
    correctCat:  'optician', correctGroup: 'health', confidence: 'high',
  },
  {
    namePattern: /\b(veterinar|animal (clinic|hospital|care)|pet (clinic|hospital))\b/i,
    wrongCats:   ['spa_massage','beauty','beauty_salon','restaurant','bar','gym'],
    correctCat:  'veterinary', correctGroup: 'pets', confidence: 'high',
  },
  // ── Automotive misclassified as beauty / food ─────────────────────────────
  {
    namePattern: /\b(auto (repair|body|service|shop)|car (repair|service|wash)|collision center)\b/i,
    wrongCats:   ['spa_massage','beauty','beauty_salon','hairdresser','restaurant','bar','gym'],
    correctCat:  'auto_repair', correctGroup: 'automotive', confidence: 'high',
  },
  {
    namePattern: /\b(car (dealer|dealership|sales)|motors?|automotive (group|sales))\b/i,
    wrongCats:   ['spa_massage','beauty','beauty_salon','hairdresser','restaurant','bar','gym'],
    correctCat:  'auto_dealer', correctGroup: 'automotive', confidence: 'high',
  },
  // ── Real estate misclassified ─────────────────────────────────────────────
  {
    namePattern: /\b(realt(y|or)|real estate (group|services|agent)|properties (llc|inc|group))\b/i,
    wrongCats:   ['spa_massage','beauty','beauty_salon','hairdresser','restaurant','bar','gym',
                  'insurance'],
    correctCat:  'real_estate', correctGroup: 'real_estate', confidence: 'high',
  },
];

// ── Ensure category_reviews table exists ─────────────────────────────────────
async function ensureTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS category_reviews (
      id              SERIAL PRIMARY KEY,
      business_id     UUID NOT NULL,
      name            TEXT,
      old_category    TEXT,
      new_category    TEXT,
      action          TEXT NOT NULL,  -- 'auto_fixed' | 'flagged'
      confidence      TEXT,
      reviewed_at     TIMESTAMPTZ DEFAULT NOW(),
      reviewed_by     TEXT DEFAULT 'categoryMismatchWorker'
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_cat_reviews_biz ON category_reviews(business_id)
  `);
}

// ── Main scan ─────────────────────────────────────────────────────────────────
async function runMismatchScan({ limit = 50000, zipPrefix = null } = {}) {
  await ensureTable();

  // Skip businesses already reviewed
  const alreadyReviewed = await db.query(
    `SELECT DISTINCT business_id FROM category_reviews`
  );
  const skipSet = new Set(alreadyReviewed.map(r => r.business_id));
  console.log(`[mismatch] ${skipSet.size} already reviewed, skipping`);

  // Fetch businesses (per-unit read pattern — fetch in pages)
  const zipClause = zipPrefix ? `AND zip ILIKE $2` : '';
  const params    = zipPrefix ? [limit, `${zipPrefix}%`] : [limit];
  const businesses = await db.query(
    `SELECT business_id, name, category, category_group
     FROM businesses
     WHERE status != 'inactive'
     ${zipClause}
     ORDER BY business_id
     LIMIT $1`,
    params
  );

  let autoFixed = 0;
  let flagged   = 0;
  let skipped   = 0;

  for (const biz of businesses) {
    if (skipSet.has(biz.business_id)) { skipped++; continue; }
    if (!biz.name || !biz.category)   continue;

    for (const rule of MISMATCH_RULES) {
      if (!rule.namePattern.test(biz.name))        continue;
      if (!rule.wrongCats.includes(biz.category))  continue;

      // Match found
      if (rule.confidence === 'high') {
        // Auto-fix
        await db.query(
          `UPDATE businesses SET category = $1, category_group = $2 WHERE business_id = $3`,
          [rule.correctCat, rule.correctGroup, biz.business_id]
        );
        await db.query(
          `INSERT INTO category_reviews
             (business_id, name, old_category, new_category, action, confidence)
           VALUES ($1, $2, $3, $4, 'auto_fixed', 'high')`,
          [biz.business_id, biz.name, biz.category, rule.correctCat]
        );
        console.log(`[mismatch] AUTO-FIXED: "${biz.name}" ${biz.category} → ${rule.correctCat}`);
        autoFixed++;
      } else {
        // Flag for review
        await db.query(
          `INSERT INTO category_reviews
             (business_id, name, old_category, new_category, action, confidence)
           VALUES ($1, $2, $3, $4, 'flagged', 'low')
           ON CONFLICT DO NOTHING`,
          [biz.business_id, biz.name, biz.category, rule.correctCat]
        );
        console.log(`[mismatch] FLAGGED:    "${biz.name}" ${biz.category} → ${rule.correctCat}?`);
        flagged++;
      }
      break; // one fix per business
    }
  }

  console.log(`[mismatch] Done. auto_fixed=${autoFixed} flagged=${flagged} skipped=${skipped} total_scanned=${businesses.length}`);
  return { autoFixed, flagged, skipped, scanned: businesses.length };
}

module.exports = { runMismatchScan };

// ── Run directly ──────────────────────────────────────────────────────────────
if (require.main === module) {
  runMismatchScan({ limit: 100000 })
    .then(r => {
      console.log('[mismatch] Result:', r);
      process.exit(0);
    })
    .catch(e => {
      console.error('[mismatch] Error:', e.message);
      // No process.exit(1) — warn only
      process.exit(0);
    });
}
