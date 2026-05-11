'use strict';
require('dotenv').config();
const db = require('../lib/db');

async function main() {
  // business_aliases table — owner-set aliases for claimed businesses
  await db.query(`
    CREATE TABLE IF NOT EXISTS business_aliases (
      id           SERIAL      PRIMARY KEY,
      business_id  UUID        NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
      alias        TEXT        NOT NULL,
      alias_lower  TEXT        GENERATED ALWAYS AS (lower(alias)) STORED,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (business_id, alias_lower)
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_business_aliases_lower
      ON business_aliases (alias_lower)
  `);
  // Seed McFlamingo aliases (it's claimed)
  await db.query(`
    INSERT INTO business_aliases (business_id, alias)
    SELECT business_id, unnest(ARRAY['MCFL','mc flamingo','the flamingo','flamingo restaurant'])
    FROM businesses WHERE name ILIKE '%mcflamingo%' LIMIT 1
    ON CONFLICT DO NOTHING
  `);
  console.log('B5 migration complete: business_aliases table ready');
  process.exit(0);
}

main().catch(err => { console.error(err.message); process.exit(1); });
