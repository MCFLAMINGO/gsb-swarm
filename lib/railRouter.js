'use strict';
/**
 * lib/railRouter.js — LocalIntel Payment & Job Rail Router
 * ─────────────────────────────────────────────────────────
 * OpenRouter-style selector: scores every available rail for a given
 * business + transaction context and returns the best one with a fallback.
 *
 * Rails (in default priority order):
 *   surge      — Surge/Basalt merchant POS, direct order payment on Base USDC
 *                Fee collected via Surge split → BASE_HOT_WALLET (0x1447...)
 *   tempo      — pathUSD on Tempo mainnet for RFQ platform fees
 *                Fee collected via sponsor-tx → TEMPO_HOT_WALLET (0x774f...)
 *   base_usdc  — USDC on Base for agent-to-agent x402 queries
 *                Fee collected → BASE_HOT_WALLET
 *   stripe     — Stripe Connect for card-paying businesses with no crypto
 *                Fee collected via application_fee_amount → Stripe platform account
 *   sms        — Twilio SMS dispatch for phone-only businesses (no wallet)
 *   rfq        — Universal broadcast fallback — no fee collected until confirmed
 *
 * Scoring:
 *   Each rail has a base weight (tunable via env vars).
 *   Per-business signals add/subtract from the base weight.
 *   Health check failures zero out a rail's weight.
 *   Highest score wins. If score === 0, fall through to next rail.
 *
 * Env vars (all optional — defaults shown):
 *   RAIL_WEIGHT_SURGE=10
 *   RAIL_WEIGHT_TEMPO=7
 *   RAIL_WEIGHT_BASE_USDC=5
 *   RAIL_WEIGHT_STRIPE=3
 *   RAIL_WEIGHT_SMS=2
 *   RAIL_WEIGHT_RFQ=1
 *   PLATFORM_SPLIT_ADDRESS=0x1447612B0Dc9221434bA78F63026E356de7F30FA  (Base hot wallet)
 *   TEMPO_TREASURY=0x774f484192Cf3F4fB9716Af2e15f44371fD32FEA           (Tempo hot wallet)
 *
 * Usage:
 *   const { selectRail } = require('./railRouter');
 *   const decision = selectRail(biz, { type: 'order', amount_usd: 45 });
 *   // → { rail: 'surge', score: 13, reason: 'surge_merchant+wallet', fallback: 'tempo',
 *   //     fee_destination: '0x1447...', fee_rail: 'surge_split' }
 */

// ── Health check cache ────────────────────────────────────────────────────────
// Keyed by rail name. Entries expire after HEALTH_TTL_MS.
const HEALTH_TTL_MS = 60_000; // 1 minute
const _healthCache  = {};

async function checkHealth(rail) {
  const now     = Date.now();
  const cached  = _healthCache[rail];
  if (cached && now - cached.ts < HEALTH_TTL_MS) return cached.ok;

  let ok = true; // default assume healthy
  try {
    if (rail === 'surge') {
      const res = await fetch('https://surge.basalthq.com/healthz', {
        signal: AbortSignal.timeout(4000),
      });
      ok = res.ok;
    }
    // Tempo, Stripe, Twilio: assume up unless we add checks
  } catch (_) {
    ok = false;
  }

  _healthCache[rail] = { ok, ts: now };
  return ok;
}

// ── Weight readers ────────────────────────────────────────────────────────────
function weights() {
  return {
    surge:     parseFloat(process.env.RAIL_WEIGHT_SURGE     || '10'),
    tempo:     parseFloat(process.env.RAIL_WEIGHT_TEMPO     || '7'),
    base_usdc: parseFloat(process.env.RAIL_WEIGHT_BASE_USDC || '5'),
    stripe:    parseFloat(process.env.RAIL_WEIGHT_STRIPE    || '3'),
    sms:       parseFloat(process.env.RAIL_WEIGHT_SMS       || '2'),
    rfq:       parseFloat(process.env.RAIL_WEIGHT_RFQ       || '1'),
  };
}

// ── Fee destination per rail ──────────────────────────────────────────────────
const FEE_DESTINATIONS = {
  surge:     () => process.env.PLATFORM_SPLIT_ADDRESS || '0x1447612B0Dc9221434bA78F63026E356de7F30FA',
  tempo:     () => process.env.TEMPO_TREASURY         || '0x774f484192Cf3F4fB9716Af2e15f44371fD32FEA',
  base_usdc: () => process.env.PLATFORM_SPLIT_ADDRESS || '0x1447612B0Dc9221434bA78F63026E356de7F30FA',
  stripe:    () => 'stripe_platform_account',
  sms:       () => null, // no fee until RFQ confirmed
  rfq:       () => null, // no fee until RFQ confirmed
};

const FEE_RAIL_LABEL = {
  surge:     'surge_split',
  tempo:     'tempo_pathusd',
  base_usdc: 'base_usdc_x402',
  stripe:    'stripe_application_fee',
  sms:       'deferred_rfq',
  rfq:       'deferred_rfq',
};

// ── Score a single rail for a business + transaction ─────────────────────────
/**
 * @param {string}  rail       — rail name
 * @param {number}  base       — base weight from env
 * @param {Object}  biz        — business record from Postgres
 * @param {Object}  ctx        — transaction context
 * @param {string}  ctx.type   — 'order' | 'rfq_fee' | 'notification_fee' | 'agent_query'
 * @param {number}  [ctx.amount_usd]
 * @param {boolean} [ctx.payer_has_card]   — payer can use a card (Stripe viable)
 * @param {boolean} [ctx.payer_has_crypto] — payer has a crypto wallet
 * @returns {number} score (0 = not viable)
 */
function scoreRail(rail, base, biz, ctx) {
  const posConfig = biz.pos_config || {};
  let   score     = base;

  switch (rail) {

    case 'surge': {
      // Must have APIM key configured
      if (!posConfig.apim_key && !posConfig.apimKey) return 0;
      // Strong signal: wallet present means they're a proper Surge merchant
      if (biz.wallet) score += 3;
      // Orders are Surge's specialty
      if (ctx.type === 'order') score += 2;
      // Small micropayments better on Tempo (fee overhead)
      if (ctx.amount_usd && ctx.amount_usd < 1) score -= 3;
      break;
    }

    case 'tempo': {
      // Prefer for RFQ platform fees and micropayments
      if (!biz.wallet) score -= 4; // hard to charge without a wallet
      if (ctx.type === 'rfq_fee')          score += 3;
      if (ctx.type === 'notification_fee') score += 2;
      if (ctx.amount_usd && ctx.amount_usd < 5) score += 2; // micropayment sweet spot
      if (ctx.type === 'order')            score -= 2; // orders better on Surge
      break;
    }

    case 'base_usdc': {
      // Agent-to-agent x402 queries on Base
      if (ctx.type !== 'agent_query') score -= 3;
      if (ctx.payer_has_crypto) score += 2;
      if (!biz.wallet) score -= 2;
      break;
    }

    case 'stripe': {
      // Fallback for card-paying businesses
      if (!posConfig.stripe_account_id) return 0;
      if (!process.env.STRIPE_SECRET_KEY) return 0;
      if (ctx.payer_has_card) score += 3;
      if (ctx.type === 'order' && ctx.amount_usd && ctx.amount_usd >= 0.50) score += 1;
      if (ctx.type === 'agent_query') return 0; // agents don't use cards
      break;
    }

    case 'sms': {
      // Phone-only businesses — no wallet, no POS
      if (!biz.phone) return 0;
      if (biz.wallet) score -= 3;        // wallet businesses should use better rails
      if (posConfig.apim_key) return 0;  // has Surge, shouldn't need SMS
      if (ctx.type === 'agent_query') return 0;
      break;
    }

    case 'rfq': {
      // Always viable as last resort — never returns 0
      if (biz.wallet)         score -= 2;
      if (posConfig.apim_key) score -= 2;
      if (biz.phone)          score -= 1;
      break;
    }

    default:
      return 0;
  }

  return Math.max(0, score);
}

// ── Main selector ─────────────────────────────────────────────────────────────
/**
 * Select the best rail for a business + transaction.
 * Runs health checks async — call `await selectRail(...)`.
 *
 * @param {Object} biz  — business row from Postgres
 * @param {Object} ctx  — { type, amount_usd?, payer_has_card?, payer_has_crypto? }
 * @returns {Promise<RailDecision>}
 *
 * @typedef {Object} RailDecision
 * @property {string}      rail             — winning rail
 * @property {number}      score            — winning score
 * @property {string}      reason           — human-readable reason
 * @property {string|null} fallback         — next best rail
 * @property {string|null} fee_destination  — wallet address to receive platform fee
 * @property {string}      fee_rail         — label for fee collection method
 * @property {Object}      scores           — all rail scores (for logging)
 */
async function selectRail(biz, ctx = {}) {
  const w      = weights();
  const rails  = ['surge', 'tempo', 'base_usdc', 'stripe', 'sms', 'rfq'];

  // Score all rails
  const scored = rails.map(rail => ({
    rail,
    score: scoreRail(rail, w[rail], biz, ctx),
  }));

  // Apply health checks (async, cached)
  // Health failure PENALIZES (-5) but does not zero a rail — a misconfigured
  // health check should not silently kill the best configured rail.
  const healthChecks = await Promise.allSettled(
    scored.map(async ({ rail, score }) => {
      if (score === 0) return { rail, score: 0 };
      const healthy = await checkHealth(rail);
      return { rail, score: healthy ? score : Math.max(0, score - 5) };
    })
  );

  const results = healthChecks
    .map(r => r.status === 'fulfilled' ? r.value : { rail: r.reason?.rail || 'unknown', score: 0 })
    .sort((a, b) => b.score - a.score);

  const winner   = results[0];
  const runnerUp = results.find(r => r.rail !== winner.rail && r.score > 0);

  // Build human-readable reason
  const reasons = [];
  const posConfig = biz.pos_config || {};
  if (posConfig.apim_key || posConfig.apimKey) reasons.push('surge_merchant');
  if (biz.wallet)                               reasons.push('wallet');
  if (posConfig.stripe_account_id)              reasons.push('stripe_connect');
  if (biz.phone)                                reasons.push('phone');
  if (ctx.type)                                 reasons.push(`type:${ctx.type}`);
  if (!reasons.length)                          reasons.push('rfq_fallback');

  const allScores = Object.fromEntries(results.map(r => [r.rail, r.score]));

  return {
    rail:            winner.rail,
    score:           winner.score,
    reason:          reasons.join('+'),
    fallback:        runnerUp?.rail || null,
    fee_destination: FEE_DESTINATIONS[winner.rail]?.() || null,
    fee_rail:        FEE_RAIL_LABEL[winner.rail]       || 'unknown',
    scores:          allScores,
  };
}

// ── Surge split enforcement ───────────────────────────────────────────────────
/**
 * Validate that a Surge merchant's pos_config includes the platform split address.
 * Called when a business connects their Surge account.
 * Returns the corrected pos_config with split enforced.
 *
 * @param {Object} pos_config — existing pos_config from businesses table
 * @returns {Object} pos_config with split_address injected
 */
function enforceSurgeSplit(pos_config = {}) {
  const splitAddress = process.env.PLATFORM_SPLIT_ADDRESS
    || '0x1447612B0Dc9221434bA78F63026E356de7F30FA';
  const splitPct = parseFloat(process.env.PLATFORM_SPLIT_PCT || '0.015'); // 1.5% default

  return {
    ...pos_config,
    split_address: splitAddress,
    split_pct:     splitPct,
    split_token:   'USDC',
    split_chain:   'base',
    split_enforced_at: new Date().toISOString(),
  };
}

/**
 * Check if a pos_config has the correct platform split address.
 * Returns true if valid, false if missing or pointing to wrong address.
 */
function hasSurgeSplit(pos_config = {}) {
  const expected = (process.env.PLATFORM_SPLIT_ADDRESS || '0x1447612B0Dc9221434bA78F63026E356de7F30FA').toLowerCase();
  return pos_config.split_address?.toLowerCase() === expected;
}

// ── getRailStats — aggregate rail decisions from fee_events for dashboard ─────
async function getRailStats({ hours = 24 } = {}) {
  const db = require('./db');
  try {
    const rows = await db.query(
      `SELECT
         meta->>'rail'          AS rail,
         meta->>'fee_rail'      AS fee_rail,
         status,
         COUNT(*)               AS cnt,
         COALESCE(SUM(amount_usd), 0) AS total_usd
       FROM fee_events
       WHERE created_at >= NOW() - ($1 || ' hours')::INTERVAL
         AND meta->>'rail' IS NOT NULL
       GROUP BY meta->>'rail', meta->>'fee_rail', status
       ORDER BY total_usd DESC`,
      [String(hours)]
    );
    return rows;
  } catch (_) {
    return [];
  }
}

module.exports = {
  selectRail,
  enforceSurgeSplit,
  hasSurgeSplit,
  getRailStats,
  checkHealth,   // exported for testing
  weights,       // exported for dashboard display
};
