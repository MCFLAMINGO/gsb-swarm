'use strict';
require('dotenv').config();
const db = require('../lib/db');

async function main() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS task_followup_sessions (
      session_id   TEXT        PRIMARY KEY,
      state        JSONB       NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at   TIMESTAMPTZ NOT NULL
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_task_followup_expires
      ON task_followup_sessions (expires_at)
  `);
  console.log('B2 migration complete: task_followup_sessions table ready');
  process.exit(0);
}

main().catch(err => { console.error(err.message); process.exit(1); });
