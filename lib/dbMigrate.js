'use strict';
/**
 * lib/dbMigrate.js
 * Runs schema migration on startup if LOCAL_INTEL_DB_URL is set.
 * Safe to run multiple times — all statements use IF NOT EXISTS / ON CONFLICT.
 */

const fs   = require('fs');
const path = require('path');

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
    // Test connection first
    await db.query('SELECT 1');
    console.log('[db-migrate] ✓ PostgreSQL connected');
  } catch (e) {
    console.error('[db-migrate] Connection failed:', e.message);
    return false;
  }

  // Run schema SQL — split into individual statements to handle errors gracefully
  const schemaPath = path.join(__dirname, '../db/schema.sql');
  if (!fs.existsSync(schemaPath)) {
    console.warn('[db-migrate] schema.sql not found');
    return false;
  }

  const sql = fs.readFileSync(schemaPath, 'utf8');

  // Split on semicolons, filter blanks, run each statement
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 10 && !s.startsWith('--'));

  let ok = 0, skipped = 0;
  for (const stmt of statements) {
    try {
      await db.query(stmt);
      ok++;
    } catch (e) {
      // "already exists" errors are fine
      if (e.message.includes('already exists') || e.message.includes('duplicate')) {
        skipped++;
      } else {
        console.warn('[db-migrate] Statement warning:', e.message.slice(0, 120));
        skipped++;
      }
    }
  }

  console.log(`[db-migrate] ✓ Schema applied — ${ok} statements, ${skipped} skipped`);

  // Log table counts
  try {
    const tables = ['businesses', 'source_evidence', 'zip_intelligence', 'sunbiz_raw', 'usage_ledger'];
    for (const t of tables) {
      const row = await db.queryOne(`SELECT COUNT(*) FROM ${t}`);
      console.log(`[db-migrate]   ${t}: ${row?.count ?? 0} rows`);
    }
  } catch (e) {
    // Tables might not exist yet on first run
  }

  return true;
}

module.exports = { runMigration };
