'use strict';
require('dotenv').config();
const db = require('../lib/db');

async function main() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS intent_dead_ends (
      id           SERIAL PRIMARY KEY,
      query        TEXT NOT NULL,
      zip          TEXT,
      channel      TEXT,
      fail_reason  TEXT NOT NULL,
      intent_path  TEXT,
      caller_id    TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_dead_ends_created
      ON intent_dead_ends(created_at DESC)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_dead_ends_fail_reason
      ON intent_dead_ends(fail_reason)
  `);
  console.log('B10 migration complete — intent_dead_ends table ready');
  process.exit(0);
}

main().catch(err => { console.error(err.message); process.exit(1); });
