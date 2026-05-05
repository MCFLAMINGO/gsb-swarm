'use strict';
/**
 * lib/feeService.js — LocalIntel Fee Collection Service
 *
 * All fees are $0.00 by default (env vars control rates).
 * Fee events are ALWAYS logged regardless of rate — they are acquisition signals.
 *
 * Event types:
 *   rfq_match      — business confirmed on an RFQ job (rfqBroadcast confirmSelection)
 *   rfq_book       — business booked via rfqService (proposal flow)
 *   order_complete — food/service order completed via Basalt/Surge
 *
 * Fee status:
 *   free           — rate is $0.00, no charge attempted
 *   charged        — successfully debited via x402/pathUSD
 *   failed         — charge attempted, wallet present, failed
 *   no_wallet      — business has no wallet — acquisition signal
 *   routing_off    — ROUTING_ENABLED=false, charge skipped
 *
 * Env vars (all default to 0/disabled for customer-base phase):
 *   RFQ_MATCH_FEE       — flat USD fee per confirmed RFQ match (default: 0.00)
 *   ORDER_FEE_PCT       — % of order value on confirmed payment (default: 0.00)
 *   ROUTING_ENABLED     — if 'true', actually charge; otherwise log only (default: false)
 */

const db = require('./db');

// ── Table auto-create ─────────────────────────────────────────────────────────
let migrated = false;

async function migrate() {
  if (migrated) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS fee_events (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type   TEXT NOT NULL,          -- rfq_match | rfq_book | order_complete
      business_id  TEXT,
      rfq_id       TEXT,                   -- RFQ or job reference
      amount_usd   NUMERIC(10,4) NOT NULL DEFAULT 0,
      status       TEXT NOT NULL,          -- free | charged | failed | no_wallet | routing_off
      wallet       TEXT,                   -- business wallet at time of event
      meta         JSONB DEFAULT '{}'::jsonb,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS fee_events_event_type_idx ON fee_events(event_type)`);
  await db.query(`CREATE INDEX IF NOT EXISTS fee_events_business_id_idx ON fee_events(business_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS fee_events_created_at_idx ON fee_events(created_at DESC)`);
  migrated = true;
}

// ── Rate readers (live from env vars) ─────────────────────────────────────────
function getRfqMatchFee() {
  const v = parseFloat(process.env.RFQ_MATCH_FEE || '0.00');
  return isNaN(v) ? 0 : v;
}

function getOrderFeePct() {
  const v = parseFloat(process.env.ORDER_FEE_PCT || '0.00');
  return isNaN(v) ? 0 : v;
}

function isRoutingEnabled() {
  return (process.env.ROUTING_ENABLED || 'false').toLowerCase() === 'true';
}

// ── logFee — always logs, charges only when routing enabled and rate > 0 ──────
/**
 * Log a fee event. Charges only when:
 *   - ROUTING_ENABLED=true
 *   - rate > 0
 *   - business has a wallet
 *
 * @param {Object} opts
 * @param {string} opts.event_type  — rfq_match | rfq_book | order_complete
 * @param {string} opts.business_id
 * @param {string} [opts.rfq_id]    — RFQ/job UUID
 * @param {number} opts.amount_usd  — computed fee amount
 * @param {Object} [opts.meta]      — extra context (category, zip, etc.)
 * @returns {Promise<Object>}       — { event_id, status, amount_usd, charged }
 */
async function logFee({ event_type, business_id, rfq_id, amount_usd, meta = {} }) {
  await migrate();

  // Look up business wallet
  let wallet = null;
  if (business_id) {
    const [biz] = await db.query(
      `SELECT wallet FROM businesses WHERE business_id = $1 LIMIT 1`,
      [business_id]
    );
    wallet = biz?.wallet || null;
  }

  const routing = isRoutingEnabled();
  const rate    = amount_usd || 0;

  // Determine status before attempting charge
  let status;
  let charged = false;

  if (!wallet) {
    status = 'no_wallet'; // acquisition signal — business should be targeted for onboarding
  } else if (!routing) {
    status = 'routing_off';
  } else if (rate <= 0) {
    status = 'free';
  } else {
    // Routing on + rate > 0 + wallet present → attempt charge
    status = await attemptCharge({ business_id, wallet, amount_usd: rate, event_type, rfq_id });
    charged = status === 'charged';
  }

  // Insert fee event — never fails silently
  let event_id = null;
  try {
    const [row] = await db.query(
      `INSERT INTO fee_events (event_type, business_id, rfq_id, amount_usd, status, wallet, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING id`,
      [
        event_type,
        business_id || null,
        rfq_id || null,
        rate,
        status,
        wallet,
        JSON.stringify({ ...meta, routing_enabled: routing }),
      ]
    );
    event_id = row?.id;
  } catch (e) {
    console.error('[feeService] fee_events insert error:', e.message);
  }

  console.log(`[feeService] ${event_type} business=${business_id || 'unknown'} amount=$${rate} status=${status} wallet=${wallet ? wallet.slice(0,10) + '...' : 'none'}`);

  return { event_id, status, amount_usd: rate, charged };
}

// ── attemptCharge — x402/pathUSD debit (live only when ROUTING_ENABLED=true) ──
async function attemptCharge({ business_id, wallet, amount_usd, event_type, rfq_id }) {
  // Placeholder: actual Tempo/pathUSD debit logic goes here when fees go live.
  // Using viem to call the pathUSD contract via Tempo mainnet.
  // For now: log and return 'failed' to be safe — no real charge until wired.
  console.warn(
    `[feeService] attemptCharge called but not yet wired — event=${event_type} biz=${business_id} $${amount_usd}. ` +
    `Set ROUTING_ENABLED=false until Tempo debit is implemented.`
  );
  return 'failed';
}

// ── getRates — return current env-var rates (for dashboard) ──────────────────
function getRates() {
  return {
    rfq_match_fee:   getRfqMatchFee(),
    order_fee_pct:   getOrderFeePct(),
    routing_enabled: isRoutingEnabled(),
  };
}

// ── getRecentEvents — last N fee events (for dashboard) ──────────────────────
async function getRecentEvents({ hours = 24, limit = 100 } = {}) {
  await migrate();
  return db.query(
    `SELECT fe.*, b.name AS business_name
       FROM fee_events fe
       LEFT JOIN businesses b ON b.business_id = fe.business_id
      WHERE fe.created_at >= NOW() - ($1 || ' hours')::INTERVAL
      ORDER BY fe.created_at DESC
      LIMIT $2`,
    [String(hours), limit]
  );
}

// ── getSummary — aggregate stats for dashboard ────────────────────────────────
async function getSummary({ hours = 24 } = {}) {
  await migrate();
  const rows = await db.query(
    `SELECT event_type, status, COUNT(*) AS cnt, COALESCE(SUM(amount_usd), 0) AS total_usd
       FROM fee_events
      WHERE created_at >= NOW() - ($1 || ' hours')::INTERVAL
      GROUP BY event_type, status`,
    [String(hours)]
  );

  const no_wallet_count = rows
    .filter(r => r.status === 'no_wallet')
    .reduce((s, r) => s + parseInt(r.cnt, 10), 0);

  return {
    hours,
    events: rows,
    no_wallet_count,   // acquisition signal — businesses without wallets
    rates: getRates(),
  };
}

module.exports = {
  logFee,
  getRates,
  getRecentEvents,
  getSummary,
  getRfqMatchFee,
  getOrderFeePct,
  isRoutingEnabled,
};
