'use strict';
/**
 * lib/workerHeartbeat.js
 * Shared heartbeat utility for LocalIntel workers.
 *
 * Schema:
 *   worker_name       TEXT PRIMARY KEY
 *   last_run          TIMESTAMPTZ        — when the worker last completed a run
 *   rows_written      INT                — how many rows were upserted last run
 *   last_error        TEXT               — last error message (NULL = clean run)
 *   consecutive_fails INT DEFAULT 0      — circuit breaker counter
 *   skip_until        TIMESTAMPTZ        — circuit breaker: skip external API until this time
 *
 * Rule: heartbeat ≠ success.
 *   ping(name, rowsWritten)  — records completion + row count
 *   pingError(name, msg)     — records a failed run, increments consecutive_fails
 *   isFresh(name, freshMs)   — returns true if last_run is within freshMs
 *   isCircuitOpen(name)      — returns true if skip_until is in the future
 *   tripCircuit(name, ms)    — set skip_until = NOW() + ms, called after N fails
 *   resetCircuit(name)       — clear consecutive_fails + skip_until after success
 */

const ENSURE_SQL = `
  CREATE TABLE IF NOT EXISTS worker_heartbeat (
    worker_name       TEXT PRIMARY KEY,
    last_run          TIMESTAMPTZ,
    rows_written      INT     DEFAULT 0,
    last_error        TEXT,
    consecutive_fails INT     DEFAULT 0,
    skip_until        TIMESTAMPTZ
  )
`;

// Add new columns to existing tables on older deploys (safe to run repeatedly)
const MIGRATE_SQL = `
  ALTER TABLE worker_heartbeat ADD COLUMN IF NOT EXISTS rows_written      INT DEFAULT 0;
  ALTER TABLE worker_heartbeat ADD COLUMN IF NOT EXISTS last_error        TEXT;
  ALTER TABLE worker_heartbeat ADD COLUMN IF NOT EXISTS consecutive_fails INT DEFAULT 0;
  ALTER TABLE worker_heartbeat ADD COLUMN IF NOT EXISTS skip_until        TIMESTAMPTZ;
`;

async function getDb() {
  if (!process.env.LOCAL_INTEL_DB_URL) return null;
  try { return require('./db'); } catch (_) { return null; }
}

async function ensureTable(db) {
  await db.query(ENSURE_SQL);
  await db.query(MIGRATE_SQL);
}

/**
 * Returns true if this worker ran within the last `freshMs` milliseconds.
 */
async function isFresh(workerName, freshMs) {
  try {
    const db = await getDb();
    if (!db) return false;
    await ensureTable(db);
    const row = await db.queryOne(
      `SELECT last_run FROM worker_heartbeat WHERE worker_name = $1`,
      [workerName]
    );
    if (!row || !row.last_run) return false;
    return (Date.now() - new Date(row.last_run).getTime()) < freshMs;
  } catch (_) {
    // DB unreachable on boot — assume fresh so worker sleeps and doesn't drain pool
    return true;
  }
}

/**
 * Record a successful run with row count.
 * Clears last_error and resets consecutive_fails.
 */
async function ping(workerName, rowsWritten = 0) {
  try {
    const db = await getDb();
    if (!db) return;
    await ensureTable(db);
    await db.query(
      `INSERT INTO worker_heartbeat (worker_name, last_run, rows_written, last_error, consecutive_fails, skip_until)
       VALUES ($1, NOW(), $2, NULL, 0, NULL)
       ON CONFLICT (worker_name) DO UPDATE SET
         last_run          = NOW(),
         rows_written      = $2,
         last_error        = NULL,
         consecutive_fails = 0,
         skip_until        = NULL`,
      [workerName, rowsWritten]
    );
  } catch (_) {}
}

/**
 * Record a failed run. Increments consecutive_fails.
 * Call tripCircuit() separately if you want to open the circuit after N failures.
 */
async function pingError(workerName, errorMsg) {
  try {
    const db = await getDb();
    if (!db) return;
    await ensureTable(db);
    await db.query(
      `INSERT INTO worker_heartbeat (worker_name, last_run, rows_written, last_error, consecutive_fails)
       VALUES ($1, NOW(), 0, $2, 1)
       ON CONFLICT (worker_name) DO UPDATE SET
         last_run          = NOW(),
         rows_written      = 0,
         last_error        = $2,
         consecutive_fails = COALESCE(worker_heartbeat.consecutive_fails, 0) + 1`,
      [workerName, String(errorMsg).slice(0, 500)]
    );
  } catch (_) {}
}

/**
 * Returns true if the circuit is open (skip_until is in the future).
 * Workers should check this before hitting an external API.
 */
async function isCircuitOpen(workerName) {
  try {
    const db = await getDb();
    if (!db) return false;
    await ensureTable(db);
    const row = await db.queryOne(
      `SELECT skip_until, consecutive_fails FROM worker_heartbeat WHERE worker_name = $1`,
      [workerName]
    );
    if (!row || !row.skip_until) return false;
    return new Date(row.skip_until).getTime() > Date.now();
  } catch (_) {
    return false;
  }
}

/**
 * Trip the circuit — skip this worker's external calls for `skipMs` milliseconds.
 * Default: 6 hours.
 */
async function tripCircuit(workerName, skipMs = 6 * 3600 * 1000) {
  try {
    const db = await getDb();
    if (!db) return;
    await ensureTable(db);
    await db.query(
      `INSERT INTO worker_heartbeat (worker_name, skip_until)
       VALUES ($1, NOW() + ($2 || ' milliseconds')::interval)
       ON CONFLICT (worker_name) DO UPDATE SET
         skip_until = NOW() + ($2 || ' milliseconds')::interval`,
      [workerName, skipMs]
    );
    console.warn(`[workerHeartbeat] Circuit OPEN for ${workerName} — skipping for ${Math.round(skipMs/3600000)}h`);
  } catch (_) {}
}

/**
 * Reset circuit after a successful run.
 */
async function resetCircuit(workerName) {
  try {
    const db = await getDb();
    if (!db) return;
    await db.query(
      `UPDATE worker_heartbeat SET consecutive_fails = 0, skip_until = NULL, last_error = NULL
       WHERE worker_name = $1`,
      [workerName]
    );
  } catch (_) {}
}

/**
 * Get current status for a worker — used by admin endpoints.
 */
async function getStatus(workerName) {
  try {
    const db = await getDb();
    if (!db) return null;
    await ensureTable(db);
    return await db.queryOne(
      `SELECT worker_name, last_run, rows_written, last_error, consecutive_fails, skip_until
       FROM worker_heartbeat WHERE worker_name = $1`,
      [workerName]
    );
  } catch (_) { return null; }
}

module.exports = { isFresh, ping, pingError, isCircuitOpen, tripCircuit, resetCircuit, getStatus };
