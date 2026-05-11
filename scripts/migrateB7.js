'use strict';
require('dotenv').config();
const db = require('../lib/db');

async function main() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS business_slang (
      id           SERIAL      PRIMARY KEY,
      term         TEXT        NOT NULL,
      term_lower   TEXT        GENERATED ALWAYS AS (lower(trim(term))) STORED,
      business_id  UUID        NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
      submitted_by TEXT        NOT NULL,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      votes        INT         NOT NULL DEFAULT 1,
      verified     BOOL        NOT NULL DEFAULT FALSE,
      is_negative  BOOL        NOT NULL DEFAULT FALSE,
      credited_to  TEXT,
      UNIQUE (term_lower, business_id)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_slang_term_lower ON business_slang (term_lower)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_slang_business_id ON business_slang (business_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_slang_votes ON business_slang (votes DESC) WHERE is_negative = FALSE AND votes >= 3`);
  console.log('B7 migration complete: business_slang table ready');
  process.exit(0);
}

main().catch(err => { console.error(err.message); process.exit(1); });
