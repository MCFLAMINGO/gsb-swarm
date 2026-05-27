'use strict';
require('dotenv').config();
const db = require('../lib/db');

// Retry wrapper — pre-deploy runs while old container is still draining connections.
// Retry up to 10 times with 3s backoff before giving up.
async function withRetry(fn, label, retries = 10, delayMs = 3000) {
  for (let i = 1; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      console.warn(`[migrate] ${label} attempt ${i}/${retries} failed: ${e.message}`);
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

async function main() {
  await withRetry(() => db.query(`
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
  `), 'create sms_query_log');
  await withRetry(() => db.query(`
    CREATE INDEX IF NOT EXISTS idx_sms_log_created
      ON sms_query_log(created_at DESC)
  `), 'create idx_sms_log_created');
  await withRetry(() => db.query(`
    CREATE INDEX IF NOT EXISTS idx_sms_log_caller
      ON sms_query_log(caller_id)
  `), 'create idx_sms_log_caller');
  console.log('B16 migration complete — sms_query_log table ready');
  process.exit(0);
}

main().catch(err => { console.error(err.message); process.exit(1); });
