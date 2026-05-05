/**
 * descriptionCleanerWorker.js
 * ───────────────────────────
 * Replaces Yellow Pages boilerplate descriptions with honest deterministic templates.
 *
 * Boilerplate pattern: "[Name] is a local business serving the XXXXX area."
 * Replacement template: "[Name] is [a/an category label] in [City], FL [ZIP]."
 *
 * Worker contract:
 *   START  → read Postgres for boilerplate records
 *   WORK   → generate clean description from name + category + city + zip
 *   END    → upsert description to Postgres
 *   SAFE   → ONLY touches records matching the boilerplate pattern
 *            Real descriptions are never overwritten
 *
 * Run: node workers/descriptionCleanerWorker.js
 * Full refresh: FULL_REFRESH=true node workers/descriptionCleanerWorker.js
 */

'use strict';

const db = require('../lib/db');
const { CATEGORY_LABELS } = require('./reclassifyWorker');

// Boilerplate patterns to replace
const BOILERPLATE_PATTERNS = [
  /^.+is a local business serving the \d{5} area\.?$/i,
  /^.+is a local restaurant serving the \d{5} area\.?$/i,
  /^.+is a local (restaurant|business|shop|store|clinic|office|salon|gym|bar|cafe|hotel|pharmacy|contractor|company|firm|practice|center|studio) serving the .+ area\.?$/i,
  /^.+provides? .+ services? in the \d{5} area\.?$/i,
  /^.+is a (quick-service|local) restaurant in the \d{5} area\.?$/i,
  /^.+is a (cafe|pharmacy|bar|gym|hotel|salon|spa) serving (coffee and light fare|the \d{5} area)\.?$/i,
];

function isBoilerplate(description) {
  if (!description) return false;
  return BOILERPLATE_PATTERNS.some(re => re.test(description.trim()));
}

function buildDescription(name, category, city, zip) {
  const label = CATEGORY_LABELS[category] || CATEGORY_LABELS['LocalBusiness'];
  const location = city ? `${city}, FL ${zip}` : `FL ${zip}`;
  return `${name} is ${label} in ${location}.`;
}

// Runner
if (require.main === module) {
  (async () => {
    const FULL_REFRESH = process.env.FULL_REFRESH === 'true';
    console.log(`[desc-cleaner] Starting — FULL_REFRESH=${FULL_REFRESH}`);

    // Load all businesses — we filter in JS so we can use regex
    const businesses = await db.query(`
      SELECT business_id, name, category, city, zip, description
      FROM businesses
      WHERE status != 'inactive'
        AND description IS NOT NULL
        AND description != ''
    `);

    console.log(`[desc-cleaner] Loaded ${businesses.length} records`);

    const toUpdate = businesses.filter(b => isBoilerplate(b.description));
    console.log(`[desc-cleaner] ${toUpdate.length} boilerplate descriptions to clean`);

    let count = 0;
    for (let i = 0; i < toUpdate.length; i += 100) {
      const chunk = toUpdate.slice(i, i + 100);
      await Promise.all(chunk.map(b => {
        const clean = buildDescription(b.name, b.category, b.city, b.zip);
        return db.query(
          `UPDATE businesses SET description = $1, updated_at = NOW() WHERE business_id = $2`,
          [clean, b.business_id]
        );
      }));
      count += chunk.length;
      process.stdout.write(`\r[desc-cleaner] ${count}/${toUpdate.length} cleaned…`);
    }

    console.log(`\n[desc-cleaner] Done — ${count} descriptions replaced`);
    process.exit(0);
  })().catch(e => { console.error('[desc-cleaner] FATAL:', e.message); process.exit(1); });
}
