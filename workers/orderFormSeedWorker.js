// orderFormSeedWorker.js
// One-time (and safe-to-rerun) worker:
//   1. Adds order_form JSONB column to businesses if it doesn't exist
//   2. For every business with no order_form, seeds from category template
//   3. Per-unit write pattern: fetch one batch → write → next batch
//
// Safe to redeploy — skips businesses that already have order_form set.
// Run on boot (called from index.js after migrations) OR as standalone:
//   node workers/orderFormSeedWorker.js

'use strict';

const db = require('../lib/db');
const { getTemplateForCategory } = require('../lib/orderFormTemplates');

const BATCH = 500; // rows per round

async function ensureColumn() {
  // Check information_schema FIRST — never issue ALTER TABLE if column exists.
  // ALTER TABLE takes AccessExclusiveLock and will block every query on businesses
  // for its entire duration. On a 615k-row table under live load this is catastrophic.
  const exists = await db.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'businesses' AND column_name = 'order_form'
  `);
  if (exists.length) {
    console.log('[orderFormSeed] order_form column already exists — skipping ALTER TABLE.');
    return;
  }
  console.log('[orderFormSeed] Adding order_form column to businesses...');
  await db.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS order_form JSONB`);
  // Index creation is non-blocking (CREATE INDEX IF NOT EXISTS never locks writes)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_businesses_order_form ON businesses USING gin (order_form) WHERE order_form IS NOT NULL`);
  console.log('[orderFormSeed] Column + index added.');
}

async function seedBatch(offset) {
  const rows = await db.query(`
    SELECT business_id, category FROM businesses
    WHERE order_form IS NULL
    ORDER BY business_id
    LIMIT $1 OFFSET $2
  `, [BATCH, offset]);
  return rows;
}

async function run() {
  const start = Date.now();
  console.log('[orderFormSeed] Starting...');

  await ensureColumn();

  let seeded = 0;
  let offset = 0;

  while (true) {
    const rows = await seedBatch(offset);
    if (!rows.length) break;

    for (const row of rows) {
      const form = getTemplateForCategory(row.category);
      await db.query(
        `UPDATE businesses SET order_form = $1, updated_at = NOW() WHERE business_id = $2`,
        [JSON.stringify(form), row.business_id]
      );
      seeded++;
    }

    console.log(`[orderFormSeed] Seeded ${seeded} businesses...`);
    offset += BATCH;

    // If we got fewer than BATCH, we're done
    if (rows.length < BATCH) break;
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[orderFormSeed] Done — ${seeded} businesses seeded in ${elapsed}s`);
}

// Run standalone or export for index.js
if (require.main === module) {
  run().catch(e => { console.error('[orderFormSeed] FATAL:', e.message); process.exit(1); });
} else {
  module.exports = { run };
}
