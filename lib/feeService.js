'use strict';
/**
 * lib/feeService.js — LocalIntel Fee Collection Service
 *
 * Fee events are ALWAYS logged regardless of rate — they are acquisition signals.
 *
 * Fee model (two-part on confirmed RFQ booking):
 *   $0.25 flat per confirmed booking  (RFQ_FLAT_FEE, default: 0.25)
 *   +1.5% of quote_usd when present   (RFQ_VALUE_PCT, default: 0.015)
 *   Example: $200 job → $0.25 + $3.00 = $3.25
 *   No quote_usd → $0.25 only
 *
 * Event types:
 *   rfq_match      — business confirmed on an RFQ job (rfqBroadcast confirmSelection)
 *   rfq_book       — business booked via rfqService (proposal flow)
 *   order_complete — food/service order completed via Basalt/Surge
 *
 * Fee status:
 *   free           — computed fee is $0.00
 *   logged_intent  — fee computed + logged, charge deferred until ROUTING_ENABLED=true
 *   charged        — successfully debited via pathUSD/Tempo
 *   failed         — charge attempted, wallet present, failed
 *   no_wallet      — business has no wallet — acquisition signal
 *   routing_off    — ROUTING_ENABLED=false, charge skipped (legacy alias for logged_intent)
 *
 * Env vars:
 *   RFQ_FLAT_FEE        — flat USD fee per confirmed booking (default: 0.25)
 *   RFQ_VALUE_PCT       — fractional % of quote_usd (default: 0.015 = 1.5%)
 *   ROUTING_ENABLED     — if 'true', attempt live pathUSD debit; otherwise log intent only
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

/** Flat fee per confirmed booking (default $0.25) */
function getRfqFlatFee() {
  const v = parseFloat(process.env.RFQ_FLAT_FEE || '0.25');
  return isNaN(v) ? 0.25 : v;
}

/** Fractional multiplier for job value fee (default 0.015 = 1.5%) */
function getRfqValuePct() {
  const v = parseFloat(process.env.RFQ_VALUE_PCT || '0.015');
  return isNaN(v) ? 0.015 : v;
}

/**
 * Compute total fee for a confirmed RFQ booking.
 * @param {number|null} quote_usd — job value from rfq_responses (optional)
 * @returns {{ flat: number, value_fee: number, total: number }}
 */
function computeRfqFee(quote_usd) {
  const flat      = getRfqFlatFee();
  const pct       = getRfqValuePct();
  const value_fee = quote_usd && quote_usd > 0 ? parseFloat((quote_usd * pct).toFixed(4)) : 0;
  const total     = parseFloat((flat + value_fee).toFixed(4));
  return { flat, value_fee, total };
}

/** @deprecated use getRfqFlatFee() — kept for any callers referencing old name */
function getRfqMatchFee() { return getRfqFlatFee(); }

/** Order fee pct — for Surge/Basalt confirmed orders (future) */
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
async function logFee({ event_type, business_id, rfq_id, amount_usd, quote_usd, meta = {} }) {
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

  // If amount_usd not explicitly passed, compute from fee model
  let rate = amount_usd;
  let flat = 0, value_fee = 0;
  if (rate === undefined || rate === null) {
    const computed = computeRfqFee(quote_usd || null);
    rate      = computed.total;
    flat      = computed.flat;
    value_fee = computed.value_fee;
  }
  rate = rate || 0;

  const routing = isRoutingEnabled();

  // Determine status before attempting charge
  let status;
  let charged = false;

  if (!wallet) {
    status = 'no_wallet'; // acquisition signal — business should be targeted for onboarding
  } else if (rate <= 0) {
    status = 'free';
  } else if (!routing) {
    status = 'logged_intent'; // fee computed, charge deferred until ROUTING_ENABLED=true
  } else {
    // Routing on + rate > 0 + wallet present → attempt charge
    attemptCharge._lastTxHash = null;
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
        JSON.stringify({
          ...meta,
          routing_enabled: routing,
          flat_fee:   flat,
          value_fee:  value_fee,
          quote_usd:  quote_usd || null,
          tx_hash:    attemptCharge._lastTxHash || null,
        }),
      ]
    );
    event_id = row?.id;
  } catch (e) {
    console.error('[feeService] fee_events insert error:', e.message);
  }

  console.log(`[feeService] ${event_type} business=${business_id || 'unknown'} amount=$${rate} status=${status} wallet=${wallet ? wallet.slice(0,10) + '...' : 'none'}`);

  return { event_id, status, amount_usd: rate, charged };
}

// ── attemptCharge — pathUSD debit via Tempo sponsor-tx (live when ROUTING_ENABLED=true) ──
//
// Uses the same executor co-sign pattern as localIntelMCP.js paid-tier payments.
// Executor (TEMPO_EXECUTOR_PK) pays gas on behalf of the business wallet.
// Business wallet must hold pathUSD — no pre-approval needed (executor co-signs).
//
// SPONSOR_URL: THROW's /api/sponsor-tx endpoint (proven in production for MCP payments)
// TREASURY:    0x774f484192Cf3F4fB9716Af2e15f44371fD32FEA (LocalIntel treasury on Tempo)
//
const SPONSOR_URL   = 'https://www.throw5onit.com/api/sponsor-tx';
const TREASURY_ADDR = process.env.TEMPO_TREASURY || '0x774f484192Cf3F4fB9716Af2e15f44371fD32FEA';

async function attemptCharge({ business_id, wallet, amount_usd, event_type, rfq_id }) {
  const execPKRaw = (process.env.TEMPO_EXECUTOR_PK || '').replace(/\s/g, '');
  if (!execPKRaw) {
    console.error('[feeService] TEMPO_EXECUTOR_PK not set — cannot charge');
    return 'failed';
  }
  if (!wallet) {
    console.warn(`[feeService] no wallet for business=${business_id} — cannot charge`);
    return 'no_wallet';
  }
  if (!(amount_usd > 0)) {
    console.warn(`[feeService] amount_usd=${amount_usd} is not > 0 — skipping charge`);
    return 'free';
  }

  try {
    const body = {
      fromPK:    execPKRaw,    // executor co-signs as feePayer
      from:      wallet,       // pathUSD pulled from business wallet
      to:        TREASURY_ADDR,
      tokenAddr: 'auto',       // pathUSD on Tempo mainnet
      amount:    amount_usd,
    };

    const res  = await fetch(SPONSOR_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));

    if (data.hash) {
      console.log(`[feeService] charged — event=${event_type} biz=${business_id} $${amount_usd} pathUSD | tx: ${data.hash}`);
      // Attach hash to meta via module-level lastTxHash so logFee() can store it
      attemptCharge._lastTxHash = data.hash;
      return 'charged';
    }

    // sponsor-tx returned an error body
    const reason = data.error || JSON.stringify(data);
    console.warn(`[feeService] charge failed — event=${event_type} biz=${business_id} reason: ${reason}`);
    attemptCharge._lastTxHash = null;
    return 'failed';

  } catch (e) {
    console.error(`[feeService] charge error — event=${event_type} biz=${business_id}:`, e.message);
    attemptCharge._lastTxHash = null;
    return 'failed';
  }
}

// ── getRates — return current env-var rates (for dashboard) ──────────────────
function getRates() {
  const flat = getRfqFlatFee();
  const pct  = getRfqValuePct();
  return {
    rfq_flat_fee:    flat,
    rfq_value_pct:   pct,
    rfq_match_fee:   flat,   // dashboard compat alias — same as rfq_flat_fee
    order_fee_pct:   getOrderFeePct(),
    routing_enabled: isRoutingEnabled(),
    rfq_fee_model:   `$${flat.toFixed(2)} flat + ${(pct * 100).toFixed(1)}% of job value`,
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
  computeRfqFee,
  getRfqFlatFee,
  getRfqValuePct,
  getRfqMatchFee,   // deprecated alias
  getOrderFeePct,
  isRoutingEnabled,
};
