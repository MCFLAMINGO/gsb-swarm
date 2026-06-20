'use strict';
/**
 * workers/surgeAuditWorker.js — Surge split address backfill + ongoing audit
 * ──────────────────────────────────────────────────────────────────────────
 * Worker contract: START → read Postgres for what's done (skip) → WORK only new → END → upsert → REDEPLOY SAFE
 *
 * On boot (and weekly thereafter):
 *   1. Find all businesses with pos_config that have apim_key/apimKey (Surge merchants)
 *      but are MISSING the platform split_address.
 *   2. Inject split_address + split_pct via railRouter.enforceSurgeSplit().
 *   3. Write corrected pos_config back to Postgres.
 *   4. Log audit summary to console + write to surge_audit_log table.
 *
 * This closes the revenue gap for all merchants who connected before
 * the split enforcement was added to POST /inbox/pos (commit 13abb04).
 */

const db         = require('../lib/db');
const railRouter = require('../lib/railRouter');

const AUDIT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // weekly re-audit

async function ensureAuditLog() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS surge_audit_log (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      total_surge  INT NOT NULL DEFAULT 0,
      patched      INT NOT NULL DEFAULT 0,
      already_ok   INT NOT NULL DEFAULT 0,
      errors       INT NOT NULL DEFAULT 0,
      split_address TEXT,
      split_pct    NUMERIC(6,4)
    )
  `);
}

async function runAudit() {
  console.log('[surgeAudit] starting split address audit...');
  await ensureAuditLog();

  const splitAddress = (process.env.PLATFORM_SPLIT_ADDRESS || '0x1447612B0Dc9221434bA78F63026E356de7F30FA').toLowerCase();
  const splitPct     = parseFloat(process.env.PLATFORM_SPLIT_PCT || '0.015');

  // Fetch all businesses with a non-null pos_config
  const rows = await db.query(
    `SELECT business_id, name, pos_config
       FROM businesses
      WHERE pos_config IS NOT NULL
        AND status != 'inactive'`
  );

  let totalSurge  = 0;
  let patched     = 0;
  let alreadyOk   = 0;
  let errors      = 0;

  for (const row of rows) {
    let cfg;
    try {
      cfg = typeof row.pos_config === 'string' ? JSON.parse(row.pos_config) : row.pos_config;
    } catch (_) {
      continue; // malformed json — skip
    }

    // Is this a Surge merchant? Must have apim_key or apimKey
    const isSurge = !!(cfg.apim_key || cfg.apimKey || cfg.pos_type === 'other' || cfg.pos_type === 'surge');
    if (!isSurge) continue;

    totalSurge++;

    // Already has correct split?
    if (railRouter.hasSurgeSplit(cfg)) {
      alreadyOk++;
      continue;
    }

    // Missing or wrong split — patch it
    try {
      const patched_cfg = railRouter.enforceSurgeSplit(cfg);
      await db.query(
        `UPDATE businesses SET pos_config = $1 WHERE business_id = $2`,
        [JSON.stringify(patched_cfg), row.business_id]
      );
      patched++;
      console.log(`[surgeAudit] patched split → ${row.name} (${row.business_id})`);
    } catch (e) {
      errors++;
      console.warn(`[surgeAudit] patch error for ${row.business_id}:`, e.message);
    }
  }

  // Write audit log
  try {
    await db.query(
      `INSERT INTO surge_audit_log (total_surge, patched, already_ok, errors, split_address, split_pct)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [totalSurge, patched, alreadyOk, errors, splitAddress, splitPct]
    );
  } catch (_) {}

  console.log(`[surgeAudit] DONE — surge_merchants=${totalSurge} patched=${patched} already_ok=${alreadyOk} errors=${errors} split=${splitAddress}`);
  return { totalSurge, patched, alreadyOk, errors };
}

function scheduleWeeklyAudit() {
  // Run immediately on boot, then weekly
  runAudit().catch(e => console.warn('[surgeAudit] boot run error (non-fatal):', e.message));

  setInterval(() => {
    runAudit().catch(e => console.warn('[surgeAudit] weekly run error (non-fatal):', e.message));
  }, AUDIT_INTERVAL_MS);
}

module.exports = { runAudit, scheduleWeeklyAudit };

// Run directly if called as script
if (require.main === module) {
  runAudit()
    .then(r => { console.log('[surgeAudit] standalone result:', r); process.exit(0); })
    .catch(e => { console.error('[surgeAudit] fatal:', e.message); process.exit(1); });
}
