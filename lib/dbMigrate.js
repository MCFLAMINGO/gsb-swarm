'use strict';
/**
 * lib/dbMigrate.js
 * Runs ALL schema/migration SQL files on startup — in order, idempotently.
 * Safe to re-run: all statements use IF NOT EXISTS / ON CONFLICT DO NOTHING.
 *
 * Execution order:
 *   1. db/schema.sql              — base tables (businesses, zip_intelligence, etc.)
 *   2. db/migration_002_sunbelt.sql — state_registry, phase columns, state indexes
 *   3. db/migration_NNN_*.sql     — any future migrations, auto-discovered by name sort
 *
 * Uses a migrations_log table to track which files have been applied.
 * Files already in migrations_log are skipped on subsequent boots.
 */

const fs   = require('fs');
const path = require('path');

const DB_DIR = path.join(__dirname, '../db');

async function runStatements(db, sql, label) {
  // Split on semicolons, preserving DO $$ ... $$ blocks
  const statements = [];
  let current = '';
  let inDollarQuote = false;

  for (const line of sql.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('--')) { current += '\n'; continue; }

    // Track $$ dollar-quoting (used in DO blocks and function bodies)
    const dollarMatches = (line.match(/\$\$/g) || []).length;
    if (dollarMatches % 2 !== 0) inDollarQuote = !inDollarQuote;

    current += line + '\n';

    if (!inDollarQuote && trimmed.endsWith(';')) {
      const s = current.trim().replace(/;$/, '').trim();
      if (s.length > 5) statements.push(s);
      current = '';
    }
  }
  if (current.trim().length > 5) statements.push(current.trim());

  let ok = 0, skipped = 0;
  for (const stmt of statements) {
    try {
      await db.query(stmt);
      ok++;
    } catch (e) {
      if (
        e.message.includes('already exists') ||
        e.message.includes('duplicate') ||
        e.message.includes('does not exist') // DROP IF NOT EXISTS on non-existent col
      ) {
        skipped++;
      } else {
        console.warn(`[db-migrate] [${label}] warn: ${e.message.slice(0, 150)}`);
        skipped++;
      }
    }
  }
  return { ok, skipped };
}

async function ensureMigrationsLog(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS migrations_log (
      id          SERIAL PRIMARY KEY,
      filename    TEXT UNIQUE NOT NULL,
      applied_at  TIMESTAMPTZ DEFAULT NOW(),
      statements_ok     INT DEFAULT 0,
      statements_skipped INT DEFAULT 0
    )
  `);
}

async function getAppliedMigrations(db) {
  try {
    const rows = await db.query('SELECT filename FROM migrations_log ORDER BY id');
    return new Set((rows.rows || []).map(r => r.filename));
  } catch (e) {
    return new Set();
  }
}

async function markApplied(db, filename, ok, skipped) {
  await db.query(
    `INSERT INTO migrations_log (filename, statements_ok, statements_skipped)
     VALUES ($1, $2, $3)
     ON CONFLICT (filename) DO UPDATE SET applied_at = NOW()`,
    [filename, ok, skipped]
  );
}

async function runMigration() {
  if (!process.env.LOCAL_INTEL_DB_URL) {
    console.log('[db-migrate] LOCAL_INTEL_DB_URL not set — skipping');
    return false;
  }

  let db;
  try {
    db = require('./db');
  } catch (e) {
    console.warn('[db-migrate] pg module not available:', e.message);
    return false;
  }

  try {
    await db.query('SELECT 1');
    console.log('[db-migrate] ✓ PostgreSQL connected');
  } catch (e) {
    console.error('[db-migrate] Connection failed:', e.message);
    return false;
  }

  await ensureMigrationsLog(db);
  const applied = await getAppliedMigrations(db);

  // Discover all SQL files in db/ — schema.sql first, then migration_NNN_*.sql in order
  const allFiles = fs.readdirSync(DB_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort((a, b) => {
      // schema.sql always first
      if (a === 'schema.sql') return -1;
      if (b === 'schema.sql') return 1;
      return a.localeCompare(b);
    });

  let totalOk = 0, totalSkipped = 0, ran = 0, skippedFiles = 0;

  for (const filename of allFiles) {
    if (applied.has(filename)) {
      skippedFiles++;
      continue;
    }

    const filepath = path.join(DB_DIR, filename);
    const sql = fs.readFileSync(filepath, 'utf8');
    console.log(`[db-migrate] Applying ${filename}...`);

    const { ok, skipped } = await runStatements(db, sql, filename);
    await markApplied(db, filename, ok, skipped);

    totalOk += ok;
    totalSkipped += skipped;
    ran++;
    console.log(`[db-migrate] ✓ ${filename} — ${ok} applied, ${skipped} skipped`);
  }

  if (ran === 0) {
    console.log(`[db-migrate] All ${skippedFiles} migration(s) already applied — nothing to do`);
  } else {
    console.log(`[db-migrate] ✓ ${ran} file(s) migrated — ${totalOk} statements ok, ${totalSkipped} skipped`);
  }

  // Log table counts
  try {
    const tables = ['businesses', 'source_evidence', 'zip_intelligence', 'sunbiz_raw', 'usage_ledger', 'state_registry'];
    const counts = await Promise.all(tables.map(t =>
      db.query(`SELECT COUNT(*) FROM ${t}`).then(r => `${t}:${r.rows[0].count}`).catch(() => `${t}:?`)
    ));
    console.log(`[db-migrate] Table counts — ${counts.join(' | ')}`);
  } catch (e) { /* non-fatal */ }

  return true;
}

module.exports = { runMigration };
