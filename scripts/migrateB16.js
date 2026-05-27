'use strict';
require('dotenv').config();
// Pre-deploy: use a dedicated single-connection pool, not the shared lib/db pool.
// The old container's 24+ workers hold most of the 25-connection Railway cap during
// overlap — one connection is all we need and all we can reliably get.
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.LOCAL_INTEL_DB_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 5000,
});
const db = { query: (sql, params) => pool.query(sql, params) };

// Retry wrapper — pre-deploy runs while old container is still draining connections.
// 30 retries × 5s = 150s window for old container connections to fully drain.
async function withRetry(fn, label, retries = 30, delayMs = 5000) {
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
  await pool.end();
  process.exit(0);
}

main().catch(async err => { console.error(err.message); await pool.end(); process.exit(1); });
