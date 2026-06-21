'use strict';
/**
 * workers/categoryRepairWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Two-pass category repair. Idempotent — safe to re-run.
 *
 * PASS 1 — Deterministic (name-pattern rules, zero LLM cost)
 *   Runs the 400+ rules from reclassify_categories.js against ALL 614k active
 *   rows — including the 521k that were never stamped after April.
 *   Also applies tier-upgrade rules (Ponte Vedra Inn → upscale_hotel, etc.)
 *   and fixes known cross-category mismatches (Country Club Real Estate →
 *   real_estate). Batches of 2,000. ~5 min total.
 *
 * PASS 2 — LLM batch (Haiku, batches of 80 names)
 *   Targets rows STILL in 'business'/'LocalBusiness'/'uncategorized' AFTER
 *   Pass 1. Every row is a real registered Florida business — the name alone
 *   has enough signal (Tihanys Bakery, Motion Physical Therapy, etc.).
 *   No suppression. No filtering by phone/address — Sunbiz registrations
 *   frequently omit contact info at import time; the name is the truth.
 *   Target ZIPs processed first. Self-throttles 50ms/batch.
 *
 * WORKER CONTRACT:
 *   START → read Postgres → WORK only what needs fixing → write per-unit → END
 *   Never calls process.exit(1). Warns only on non-fatal errors. Redeploy-safe.
 *
 * ENV:
 *   LOCAL_INTEL_DB_URL   — required
 *   ANTHROPIC_API_KEY    — required for Pass 2 (pass skipped if absent)
 *   REPAIR_PASS          — '1'|'2'|'all' (default: 'all')
 *   REPAIR_ZIP_ONLY      — comma-separated ZIPs, limits Pass 2 scope
 *   REPAIR_DRY_RUN       — 'true' = log only, no DB writes
 *
 * Run:
 *   node workers/categoryRepairWorker.js
 *   REPAIR_PASS=1 node workers/categoryRepairWorker.js
 *   REPAIR_ZIP_ONLY=32082,32081 REPAIR_PASS=2 node workers/categoryRepairWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

const db = require('../lib/db');

// Pull the compiled RULES array from the existing deterministic script
let RULES = [];
try {
  ({ RULES } = require('../scripts/reclassify_categories'));
} catch (e) {
  console.warn('[categoryRepairWorker] Could not load RULES from reclassify_categories:', e.message);
}

const DRY_RUN  = process.env.REPAIR_DRY_RUN === 'true';
const RUN_PASS = process.env.REPAIR_PASS || 'all';
const ZIP_ONLY = process.env.REPAIR_ZIP_ONLY
  ? process.env.REPAIR_ZIP_ONLY.split(',').map(z => z.trim())
  : null;

const TARGET_ZIPS = ['32082','32081','32250','32266','32233','32259','32034','32092','32084'];

// ── Tier-upgrade + cross-category fixes ──────────────────────────────────────
// Applied BEFORE general rules. More specific — won't be caught by broad patterns.
const TIER_UPGRADES = [
  // AAA 5-Diamond properties in 32082 — tagged 'hotel' at import, should be upscale_hotel
  { re: /ponte\s*vedra\s*inn\s*(?:&|and)\s*club|lodge\s*(?:&|and)\s*club.*ponte\s*vedra/i,
    category: 'upscale_hotel',  group: 'hospitality' },
  { re: /sawgrass\s*marriott/i, category: 'upscale_hotel',  group: 'hospitality' },
  { re: /ritz.?carlton|four\s*seasons|waldorf\s*astoria|mandarin\s*oriental/i,
    category: 'upscale_hotel',  group: 'hospitality' },
  // Spa outlets of hotels — not hotels
  { re: /spa\s+at\s+(?:the\s+)?(?:ponte\s*vedra|inn|lodge|resort)/i,
    category: 'spa',            group: 'beauty' },
  // Golf courses
  { re: /\btpc\b.*sawgrass|sawgrass\s*country\s*club/i,
    category: 'golf_course',    group: 'entertainment' },
  // Known cross-category mismatch: real estate business tagged fine_dining
  { re: /country\s*club\s*real\s*estate|country\s*club.*realt/i,
    category: 'real_estate',    group: 'real_estate' },
  // Holiday Isle Yacht Club — not fine_dining
  { re: /yacht\s*club(?!\s*(?:grill|restaurant|bar|kitchen|cafe|bistro))/i,
    category: 'marina',         group: 'entertainment' },
];

// ── Valid categories for LLM response validation ──────────────────────────────
const VALID_CATS = new Set([
  'restaurant','fast_food','casual_dining','fine_dining','cafe','coffee_chain','bakery',
  'pizza','bar','pub','sports_bar','brewery','bar_dining','seafood','mexican','bbq',
  'steakhouse','sandwich','fast_casual_mexican','deli','ice_cream','dessert','asian',
  'italian','cuban','health_food','food',
  'hotel','upscale_hotel','budget_hotel','vacation_rental','event_venue',
  'grocery','convenience','gas_station','supermarket','discount_store',
  'plumber','electrician','hvac','roofing','landscaping','painting','flooring','fencing',
  'pest_control','pool_service','screen_enclosure','concrete','masonry','drywall',
  'handyman','general_contractor','solar','irrigation','gutters','insulation','septic',
  'window_door','pressure_washing','home_inspection','interior_design','surveying',
  'home_theater','moving','cleaning','property_services',
  'real_estate','real_estate_agency','home_builder','apartment_complex','mortgage',
  'bank_branch','credit_union','insurance','financial_advisor','accounting',
  'law_firm','legal',
  'clinic','dentist','dental','urgent_care','pharmacy','veterinary','physical_therapy',
  'chiropractic','optometry','healthcare','home_health','aesthetics','pediatrics','lab',
  'gym','gym_chain','yoga_studio','pilates','crossfit','fitness','martial_arts',
  'dance_studio','swim_school',
  'hair_salon','barbershop','nail_salon','massage_spa','tanning','tattoo',
  'beauty_supply','hair_chain','beauty','beauty_salon','spa',
  'auto_repair','auto_dealer','auto_body','auto_glass','car_wash','towing','rv_marine',
  'school','childcare','tutoring','college',
  'church','nonprofit','library','post_office','fire_station','police_station',
  'community_center','park',
  'pet_store','pet_grooming','pet_boarding','dog_training','veterinary',
  'retail','clothing','hardware_store','electronics_store','furniture',
  'sporting_goods','nursery','thrift_store','liquor_store','pawn',
  'photography','printing','marketing_agency','it_services','staffing','security',
  'funeral_home','transport','florist','jewelry','art_gallery',
  'title_company','architecture','golf_course','marina','entertainment',
  'storage','shipping','catering','cleaning',
  'holding_company',   // LLM uses this for shell corps — we mark status=suppressed
]);

// ── Group lookup ──────────────────────────────────────────────────────────────
function deriveGroup(cat) {
  const map = {
    food:         ['restaurant','fast_food','casual_dining','fine_dining','cafe','coffee_chain','bakery','pizza','bar','pub','sports_bar','brewery','bar_dining','seafood','mexican','bbq','steakhouse','sandwich','fast_casual_mexican','deli','ice_cream','dessert','asian','italian','cuban','health_food','food','catering'],
    hospitality:  ['hotel','upscale_hotel','budget_hotel','vacation_rental','event_venue'],
    grocery:      ['grocery','convenience','supermarket','discount_store'],
    construction: ['plumber','electrician','hvac','roofing','landscaping','painting','flooring','fencing','pest_control','pool_service','screen_enclosure','concrete','masonry','drywall','handyman','general_contractor','solar','irrigation','gutters','insulation','septic','window_door','pressure_washing','home_inspection','interior_design','surveying','home_theater','moving','cleaning','property_services'],
    real_estate:  ['real_estate','real_estate_agency','home_builder','apartment_complex','mortgage','title_company','architecture'],
    banking:      ['bank_branch','credit_union','insurance','financial_advisor','accounting'],
    legal:        ['law_firm','legal'],
    health:       ['clinic','dentist','dental','urgent_care','pharmacy','veterinary','physical_therapy','chiropractic','optometry','healthcare','home_health','aesthetics','pediatrics','lab'],
    fitness:      ['gym','gym_chain','yoga_studio','pilates','crossfit','fitness','martial_arts','dance_studio','swim_school'],
    beauty:       ['hair_salon','barbershop','nail_salon','massage_spa','tanning','tattoo','beauty_supply','hair_chain','beauty','beauty_salon','spa'],
    auto:         ['auto_repair','auto_dealer','auto_body','auto_glass','car_wash','towing','rv_marine','gas_station'],
    civic:        ['school','childcare','tutoring','college','church','nonprofit','library','post_office','fire_station','police_station','community_center','park'],
    pets:         ['pet_store','pet_grooming','pet_boarding','dog_training'],
    retail:       ['retail','clothing','hardware_store','electronics_store','furniture','sporting_goods','nursery','thrift_store','liquor_store','pawn','florist','jewelry','art_gallery'],
    services:     ['photography','printing','staffing','security','funeral_home','transport','storage','shipping','it_services','marketing_agency'],
    entertainment:['golf_course','marina','entertainment'],
    fuel:         ['gas_station'],
  };
  for (const [group, cats] of Object.entries(map)) {
    if (cats.includes(cat)) return group;
  }
  return 'services';
}

// ── PASS 1: deterministic ─────────────────────────────────────────────────────
async function pass1() {
  console.log('\n[Pass 1] Deterministic reclassification — all 614k active rows...');
  if (!RULES.length) {
    console.warn('[Pass 1] No rules loaded — skipping');
    return { scanned: 0, updated: 0 };
  }

  const BATCH = 2000;
  let offset = 0, totalScanned = 0, totalUpdated = 0;

  while (true) {
    const rows = await db.query(
      `SELECT business_id, name, category, category_group
       FROM businesses
       WHERE status = 'active'
       ORDER BY business_id
       LIMIT $1 OFFSET $2`,
      [BATCH, offset]
    );
    if (!rows.length) break;
    totalScanned += rows.length;

    const updates = [];

    for (const biz of rows) {
      const name = (biz.name || '').trim();

      // Tier upgrades first (specific overrides)
      let matched = false;
      for (const tu of TIER_UPGRADES) {
        if (tu.re.test(name)) {
          if (biz.category !== tu.category || biz.category_group !== tu.group) {
            updates.push({ id: biz.business_id, cat: tu.category, grp: tu.group });
          }
          matched = true;
          break;
        }
      }
      if (matched) continue;

      // General rules
      for (const rule of RULES) {
        if (rule.p.test(name)) {
          if (biz.category !== rule.category || biz.category_group !== rule.group) {
            updates.push({ id: biz.business_id, cat: rule.category, grp: rule.group });
          }
          break;
        }
      }
    }

    if (updates.length && !DRY_RUN) {
      const ids  = updates.map(u => u.id);
      const cats = updates.map(u => u.cat);
      const grps = updates.map(u => u.grp);
      await db.query(
        `UPDATE businesses
         SET category = vals.cat,
             category_group = vals.grp,
             classification_attempted_at = NOW()
         FROM (SELECT unnest($1::uuid[]) as id,
                      unnest($2::text[]) as cat,
                      unnest($3::text[]) as grp) vals
         WHERE businesses.business_id = vals.id`,
        [ids, cats, grps]
      );
    }

    totalUpdated += updates.length;
    process.stdout.write(`\r[Pass 1] scanned: ${totalScanned.toLocaleString()} | updated: ${totalUpdated.toLocaleString()}`);
    offset += BATCH;
  }

  // Stamp all unstamped rows so the pipeline knows they've been attempted
  if (!DRY_RUN) {
    await db.query(
      `UPDATE businesses SET classification_attempted_at = NOW()
       WHERE status = 'active' AND classification_attempted_at IS NULL`
    );
  }

  console.log(`\n[Pass 1] Done — scanned: ${totalScanned.toLocaleString()} | updated: ${totalUpdated.toLocaleString()}`);
  return { scanned: totalScanned, updated: totalUpdated };
}

// ── PASS 2: LLM batch ─────────────────────────────────────────────────────────
async function pass2() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[Pass 2] ANTHROPIC_API_KEY not set — skipping');
    return { skipped: true };
  }

  console.log('\n[Pass 2] LLM reclassification — remaining uncategorized rows...');

  // Build ZIP filter
  const zipFilter = ZIP_ONLY
    ? `AND zip = ANY(ARRAY[${ZIP_ONLY.map(z => `'${z}'`).join(',')}]::text[])`
    : '';

  // Target ZIPs first, then rest — so the most valuable rows get classified first
  // even if we hit a rate limit or stop early
  const orderBy = `ORDER BY (zip = ANY(ARRAY[${TARGET_ZIPS.map(z => `'${z}'`).join(',')}]::text[])) DESC, business_id`;

  const rows = await db.query(
    `SELECT business_id, name, zip, address
     FROM businesses
     WHERE status = 'active'
       AND category IN ('business', 'LocalBusiness', 'uncategorized')
       ${zipFilter}
     ${orderBy}
     LIMIT 100000`
  );

  if (!rows.length) {
    console.log('[Pass 2] Nothing left to classify — all done.');
    return { classified: 0 };
  }

  console.log(`[Pass 2] ${rows.length.toLocaleString()} rows to classify`);

  const BATCH_SIZE = 80;
  let classified = 0, suppressed = 0, failed = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    // Build numbered name list — include address hint when available
    const nameList = batch.map((r, idx) => {
      const hint = r.address ? ` (${r.address.slice(0, 45)})` : '';
      return `${idx + 1}. ${r.name}${hint}`;
    }).join('\n');

    const prompt =
`You are classifying Florida registered businesses for a local business directory.
Assign exactly one category per business from this list:
${[...VALID_CATS].filter(c => c !== 'holding_company').sort().join(', ')}

Special rule: if the name is clearly a real-estate holding entity (e.g. "123 Main St LLC", "Lemon Lake Mgmt Inc", numbered address LLCs) with no consumer-facing service, reply "holding_company".

Return ONLY a JSON array of ${batch.length} category strings — one per line item, in order.
No explanation. No markdown. Just the array.

${nameList}`;

    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!resp.ok) {
        const err = await resp.text();
        console.warn(`\n[Pass 2] API error batch ${i / BATCH_SIZE}: ${resp.status} — ${err.slice(0, 100)}`);
        failed += batch.length;
        await sleep(3000);
        continue;
      }

      const data = await resp.json();
      const raw  = (data.content?.[0]?.text || '').trim()
        .replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

      let categories;
      try {
        categories = JSON.parse(raw);
        if (!Array.isArray(categories) || categories.length !== batch.length) {
          throw new Error(`array length mismatch: got ${Array.isArray(categories) ? categories.length : typeof categories}`);
        }
      } catch (parseErr) {
        console.warn(`\n[Pass 2] Parse error batch ${i / BATCH_SIZE}: ${parseErr.message}`);
        failed += batch.length;
        continue;
      }

      // Write back per-unit (worker contract)
      for (let j = 0; j < batch.length; j++) {
        const biz = batch[j];
        let   cat = (categories[j] || '').trim().toLowerCase().replace(/\s+/g, '_');

        if (cat === 'holding_company') {
          // Real-estate shell or unintelligible entity — suppress from search
          if (!DRY_RUN) {
            await db.query(
              `UPDATE businesses
               SET status = 'suppressed',
                   classification_attempted_at = NOW()
               WHERE business_id = $1`,
              [biz.business_id]
            );
          }
          suppressed++;
          continue;
        }

        // Normalise and validate
        if (!VALID_CATS.has(cat)) {
          // Try prefix match
          const nearest = [...VALID_CATS].find(v => v !== 'holding_company' && (v.startsWith(cat) || cat.startsWith(v)));
          if (nearest) {
            cat = nearest;
          } else {
            console.warn(`\n[Pass 2] Unknown cat "${cat}" for "${biz.name}" — marking uncategorized`);
            failed++;
            continue;
          }
        }

        const group = deriveGroup(cat);
        if (!DRY_RUN) {
          await db.query(
            `UPDATE businesses
             SET category = $1,
                 category_group = $2,
                 classification_attempted_at = NOW(),
                 confidence_score = 0.75
             WHERE business_id = $3`,
            [cat, group, biz.business_id]
          );
        }
        classified++;
      }

      const batchNum  = Math.ceil(i / BATCH_SIZE) + 1;
      const batchTotal = Math.ceil(rows.length / BATCH_SIZE);
      process.stdout.write(
        `\r[Pass 2] classified: ${classified.toLocaleString()} | suppressed: ${suppressed} | failed: ${failed} | batch ${batchNum}/${batchTotal}`
      );

      await sleep(50); // throttle

    } catch (e) {
      console.warn(`\n[Pass 2] Batch ${i / BATCH_SIZE} exception: ${e.message}`);
      failed += batch.length;
      await sleep(1000);
    }
  }

  console.log(`\n[Pass 2] Done — classified: ${classified.toLocaleString()} | suppressed: ${suppressed} | failed: ${failed}`);
  return { classified, suppressed, failed };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Admin endpoint trigger (used by pipeline_runner) ─────────────────────────
async function run() {
  if (!process.env.LOCAL_INTEL_DB_URL) {
    console.error('[categoryRepairWorker] LOCAL_INTEL_DB_URL not set');
    return;
  }

  const t0 = Date.now();
  console.log(`[categoryRepairWorker] start — pass: ${RUN_PASS} | dry_run: ${DRY_RUN} | zips: ${ZIP_ONLY || 'all'}`);

  const results = {};

  if (RUN_PASS === 'all' || RUN_PASS === '1') {
    results.pass1 = await pass1().catch(e => { console.error('[Pass 1]', e.message); return { error: e.message }; });
  }
  if (RUN_PASS === 'all' || RUN_PASS === '2') {
    results.pass2 = await pass2().catch(e => { console.error('[Pass 2]', e.message); return { error: e.message }; });
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`\n[categoryRepairWorker] complete in ${elapsed}s`);
  console.log(JSON.stringify(results, null, 2));

  // Log run
  try {
    await db.query(
      `INSERT INTO pipeline_runs
         (pipeline, started_at, finished_at, total_scanned, matched, unmatched, notes)
       VALUES ($1, $2, NOW(), $3, $4, 0, $5)`,
      [
        'categoryRepairWorker',
        new Date(t0),
        (results.pass1?.scanned || 0),
        (results.pass1?.updated || 0) + (results.pass2?.classified || 0),
        JSON.stringify({ dry_run: DRY_RUN, pass: RUN_PASS, elapsed_s: elapsed, ...results }),
      ]
    );
  } catch (e) {
    console.warn('[categoryRepairWorker] pipeline_runs log failed (non-fatal):', e.message);
  }
}

// Run directly or export for pipeline_runner
if (require.main === module) {
  run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(0); });
}

module.exports = { run };
