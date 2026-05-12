'use strict';
require('dotenv').config();
const db = require('../lib/db');

async function main() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS sms_query_log (
      id               SERIAL PRIMARY KEY,
      message_sid      TEXT,
      caller_id        TEXT,
      query            TEXT NOT NULL,
      zip              TEXT,
      intent           TEXT,
      resolved_via     TEXT,
      response_preview TEXT,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_sms_log_created
      ON sms_query_log(created_at DESC)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_sms_log_caller
      ON sms_query_log(caller_id)
  `);
  console.log('B16 migration complete — sms_query_log table ready');
  process.exit(0);
}

main().catch(err => { console.error(err.message); process.exit(1); });
