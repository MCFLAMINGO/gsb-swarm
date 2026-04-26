'use strict';
/**
 * lib/workerHeartbeat.js
 * Shared heartbeat utility for LocalIntel workers.
 * Stores last_run in Postgres worker_heartbeat table.
 * Workers call isFresh() on startup to skip redundant runs.
 */

const ENSURE_SQL = `
  CREATE TABLE IF NOT EXISTS worker_heartbeat (
    worker_name TEXT PRIMARY KEY,
    last_run    TIMESTAMPTZ
  )
`;

async function getDb() {
  if (!process.env.LOCAL_INTEL_DB_URL) return null;
  try { return require('./db'); } catch (_) { return null; }
}

/**
 * Returns true if this worker ran within the last `freshMs` milliseconds.
 * Creates the table if it doesn't exist.
 */
async function isFresh(workerName, freshMs) {
  try {
    const db = await getDb();
    if (!db) return false;
    await db.query(ENSURE_SQL);
    const row = await db.queryOne(
      `SELECT last_run FROM worker_heartbeat WHERE worker_name = $1`,
      [workerName]
    );
    if (!row || !row.last_run) return false;
    return (Date.now() - new Date(row.last_run).getTime()) < freshMs;
  } catch (_) {
    return false;
  }
}

/**
 * Record that this worker just completed a run.
 */
async function ping(workerName) {
  try {
    const db = await getDb();
    if (!db) return;
    await db.query(ENSURE_SQL);
    await db.query(
      `INSERT INTO worker_heartbeat (worker_name, last_run) VALUES ($1, NOW())
       ON CONFLICT (worker_name) DO UPDATE SET last_run = NOW()`,
      [workerName]
    );
  } catch (_) {}
}

module.exports = { isFresh, ping };
