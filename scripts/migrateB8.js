'use strict';
require('dotenv').config();
const db = require('../lib/db');

async function main() {
  await db.query(`
    ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS is_showcase BOOL NOT NULL DEFAULT FALSE
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_businesses_showcase
      ON businesses (is_showcase) WHERE is_showcase = TRUE
  `);
  const result = await db.query(`
    UPDATE businesses SET is_showcase = TRUE
    WHERE name ILIKE '%mcflamingo%'
    RETURNING name, business_id, zip
  `);
  if (result.length) {
    console.log(`Marked as showcase: ${result.map(r => r.name).join(', ')}`);
  } else {
    console.warn('McFlamingo not found — check businesses table');
  }
  console.log('B8 migration complete');
  process.exit(0);
}

main().catch(err => { console.error(err.message); process.exit(1); });
