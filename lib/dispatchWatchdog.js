'use strict';
/**
 * lib/dispatchWatchdog.js — RFQ timeout + auto-retry
 * ─────────────────────────────────────────────────────
 * Runs on a 60-second tick. Checks rfq_requests for jobs that:
 *   1. Are still 'open' (no acceptance) past their deadline
 *   2. Have no responses after a soft timeout (10 min default)
 *
 * On timeout:
 *   - Tries the next closest business in the same ZIP/category
 *   - Logs to rfq_timeouts for self-improvement analysis
 *   - If no more candidates: marks RFQ 'expired', notifies requester
 *
 * Self-improvement feedback:
 *   - Tracks which businesses repeatedly time out → drops their confidence
 *   - Tracks which categories have chronic gaps → feeds enrichment trigger
 *
 * Called from dashboard-server.js on startup (setInterval).
 */

const db = require('./db');
const { dispatchToBusiness } = require('./dispatchRail');

// How long to wait before re-dispatching to the next provider (minutes)
const SOFT_TIMEOUT_MINUTES   = 10;
const HARD_TIMEOUT_MINUTES   = 60;
// How much to penalise a no-show business's confidence score
const NO_SHOW_CONFIDENCE_HIT = -0.05;

let _running = false;

// ── Schema migration (idempotent) ─────────────────────────────────────────────
let _migrated = false;
async function migrateWatchdog() {
  if (_migrated) return;
  const pool = db.getPool();

  // Payment rail columns on rfq_requests
  await pool.query(`
    ALTER TABLE rfq_requests
      ADD COLUMN IF NOT EXISTS payment_rail      TEXT,
      ADD COLUMN IF NOT EXISTS payment_token     TEXT DEFAULT 'pathUSD',
      ADD COLUMN IF NOT EXISTS payment_amount    NUMERIC(10,2),
      ADD COLUMN IF NOT EXISTS dispatch_log      JSONB DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS retry_count       INT  DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_dispatched_at TIMESTAMPTZ
  `);

  // Payment rail columns on rfq_bookings
  await pool.query(`
    ALTER TABLE rfq_bookings
      ADD COLUMN IF NOT EXISTS payment_rail      TEXT,
      ADD COLUMN IF NOT EXISTS payment_token     TEXT DEFAULT 'pathUSD',
      ADD COLUMN IF NOT EXISTS payment_amount    NUMERIC(10,2),
      ADD COLUMN IF NOT EXISTS escrow_data       JSONB,
      ADD COLUMN IF NOT EXISTS stripe_intent_id  TEXT,
      ADD COLUMN IF NOT EXISTS settled_at        TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS settled_tx        TEXT
  `);

  // Timeout log table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rfq_timeouts (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      rfq_id          UUID NOT NULL,
      business_id     TEXT,
      timeout_type    TEXT NOT NULL,   -- 'soft' | 'hard' | 'no_candidates'
      retry_count     INT  DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Push subscriptions table (for web-push notifications)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id     TEXT NOT NULL,
      endpoint        TEXT NOT NULL UNIQUE,
      p256dh          TEXT NOT NULL,
      auth            TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS rfq_timeouts_rfq_id ON rfq_timeouts(rfq_id)
  `);

  _migrated = true;
  console.log('[watchdog] Schema migration complete');
}

// ── Tick ──────────────────────────────────────────────────────────────────────
async function tick() {
  if (_running) return;
  _running = true;

  try {
    const pool = db.getPool();

    // Find open RFQs that have passed soft timeout with zero responses
    const softCutoff = new Date(Date.now() - SOFT_TIMEOUT_MINUTES * 60 * 1000).toISOString();
    const hardCutoff = new Date(Date.now() - HARD_TIMEOUT_MINUTES * 60 * 1000).toISOString();

    const { rows: stale } = await pool.query(`
      SELECT r.*
      FROM rfq_requests r
      LEFT JOIN rfq_responses resp ON resp.rfq_id = r.id AND resp.status != 'declined'
      WHERE r.status = 'open'
        AND r.created_at < $1
      GROUP BY r.id
      HAVING count(resp.id) = 0
      LIMIT 20
    `, [softCutoff]);

    for (const rfq of stale) {
      const isHardTimeout = rfq.created_at < new Date(hardCutoff);
      const retryCount = rfq.retry_count || 0;

      if (isHardTimeout || retryCount >= 5) {
        // Hard timeout — mark expired, log gap
        await pool.query(
          `UPDATE rfq_requests SET status = 'expired' WHERE id = $1`,
          [rfq.id]
        );
        await pool.query(
          `INSERT INTO rfq_timeouts (rfq_id, timeout_type, retry_count)
           VALUES ($1, 'hard', $2)`,
          [rfq.id, retryCount]
        );
        await logGap(rfq, 'hard_timeout');
        console.log(`[watchdog] RFQ ${rfq.id} hard-expired after ${retryCount} retries`);
        continue;
      }

      // Soft timeout — try next candidate
      await softRetry(rfq, pool);
    }

    // Also check: RFQs with deadline_at in the past that are still open
    const { rows: deadlineExpired } = await pool.query(`
      SELECT * FROM rfq_requests
      WHERE status = 'open'
        AND deadline_at IS NOT NULL
        AND deadline_at < NOW()
      LIMIT 10
    `);

    for (const rfq of deadlineExpired) {
      await pool.query(
        `UPDATE rfq_requests SET status = 'expired' WHERE id = $1`,
        [rfq.id]
      );
      await logGap(rfq, 'deadline_passed');
      console.log(`[watchdog] RFQ ${rfq.id} expired — deadline passed`);
    }

  } catch (e) {
    console.error('[watchdog] tick error:', e.message);
  } finally {
    _running = false;
  }
}

// ── Soft retry — find next untried candidate and dispatch ─────────────────────
async function softRetry(rfq, pool) {
  // Get already-tried business IDs from dispatch_log
  const dispatchLog = rfq.dispatch_log || [];
  const triedIds = dispatchLog.map(d => d.business_id).filter(Boolean);

  // Find next closest business in same ZIP + category not yet tried
  const excludeClause = triedIds.length
    ? `AND business_id != ALL(ARRAY[${triedIds.map(id=>`'${id}'`).join(',')}])`
    : '';

  const params = [];
  const conditions = [`status != 'inactive'`];
  if (rfq.zip)      { params.push(rfq.zip);              conditions.push(`zip = $${params.length}`); }
  if (rfq.category) { params.push(`%${rfq.category}%`);  conditions.push(`category ILIKE $${params.length}`); }
  params.push(1); // limit

  const { rows: [nextBiz] } = await pool.query(`
    SELECT business_id, name, phone, wallet, pos_config, dispatch_token,
           notification_email
    FROM businesses
    WHERE ${conditions.join(' AND ')} ${excludeClause}
    ORDER BY (claimed_at IS NOT NULL) DESC, confidence_score DESC
    LIMIT $${params.length}
  `, params);

  if (!nextBiz) {
    // No more candidates
    await pool.query(
      `UPDATE rfq_requests SET status = 'no_candidates' WHERE id = $1`,
      [rfq.id]
    );
    await pool.query(
      `INSERT INTO rfq_timeouts (rfq_id, timeout_type, retry_count)
       VALUES ($1, 'no_candidates', $2)`,
      [rfq.id, rfq.retry_count || 0]
    );
    await logGap(rfq, 'no_candidates');
    console.log(`[watchdog] RFQ ${rfq.id} — no more candidates`);
    return;
  }

  // Dispatch to next candidate
  const dispatchResult = await dispatchToBusiness(nextBiz, rfq);

  // Update dispatch_log and retry_count
  const newLog = [
    ...dispatchLog,
    {
      business_id:   nextBiz.business_id,
      business_name: nextBiz.name,
      rail:          dispatchResult?.rail || 'none',
      dispatched_at: new Date().toISOString(),
      retry:         (rfq.retry_count || 0) + 1,
    },
  ];

  await pool.query(`
    UPDATE rfq_requests
    SET retry_count = retry_count + 1,
        dispatch_log = $2::jsonb,
        last_dispatched_at = NOW()
    WHERE id = $1
  `, [rfq.id, JSON.stringify(newLog)]);

  await pool.query(
    `INSERT INTO rfq_timeouts (rfq_id, business_id, timeout_type, retry_count)
     VALUES ($1, $2, 'soft', $3)`,
    [rfq.id, nextBiz.business_id, rfq.retry_count || 0]
  );

  console.log(`[watchdog] RFQ ${rfq.id} soft-retry → ${nextBiz.name} (${nextBiz.business_id}) via ${dispatchResult?.rail || 'none'}`);
}

// ── Self-improvement: confidence penalty for no-shows ────────────────────────
/**
 * Called when a booking is made but business never starts/completes.
 * Reduces confidence_score so future RFQs rank this business lower.
 */
async function penaliseNoShow(business_id) {
  try {
    const pool = db.getPool();
    await pool.query(`
      UPDATE businesses
      SET confidence_score = GREATEST(0.0, confidence_score + $1)
      WHERE business_id = $2
    `, [NO_SHOW_CONFIDENCE_HIT, business_id]);
    console.log(`[watchdog] No-show penalty applied to ${business_id} (${NO_SHOW_CONFIDENCE_HIT})`);
  } catch (e) {
    console.warn('[watchdog] penaliseNoShow error:', e.message);
  }
}

/**
 * Called when a job completes successfully.
 * Boosts confidence_score to reward reliable businesses.
 */
async function rewardCompletion(business_id) {
  try {
    const pool = db.getPool();
    await pool.query(`
      UPDATE businesses
      SET confidence_score = LEAST(1.0, confidence_score + 0.02),
          last_confirmed    = NOW()
      WHERE business_id = $1
    `, [business_id]);
    console.log(`[watchdog] Completion reward applied to ${business_id} (+0.02 confidence)`);
  } catch (e) {
    console.warn('[watchdog] rewardCompletion error:', e.message);
  }
}

// ── Gap logging (feeds enrichment) ───────────────────────────────────────────
async function logGap(rfq, reason) {
  try {
    const pool = db.getPool();
    await pool.query(`
      INSERT INTO rfq_gaps (category, zip, job_type, requested, matched, verified)
      VALUES ($1, $2, $3, 1, 0, 0)
      ON CONFLICT DO NOTHING
    `, [rfq.category || null, rfq.zip || null, rfq.job_type || 'proposal']);
  } catch (_) {}
}

// ── Start watchdog (called from server startup) ────────────────────────────────
let _interval = null;
async function start() {
  try {
    await migrateWatchdog();
  } catch (e) {
    console.warn('[watchdog] Migration failed (non-fatal):', e.message);
  }
  if (_interval) return;
  _interval = setInterval(tick, 60 * 1000); // check every 60s
  console.log('[watchdog] Started — checking every 60s for stale RFQs');
}

function stop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = { start, stop, tick, penaliseNoShow, rewardCompletion, migrateWatchdog };
