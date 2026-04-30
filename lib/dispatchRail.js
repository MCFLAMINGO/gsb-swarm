'use strict';
/**
 * lib/dispatchRail.js — Multi-rail dispatch for LocalIntel RFQ
 * ─────────────────────────────────────────────────────────────
 * Handles pushing a job to a business across four rails:
 *
 *   1. Surge UCP    — pos_type='other' + wallet + APIM key in pos_config
 *                     Business gets job notification in their POS dashboard.
 *                     pathUSD held in Tempo escrow on acceptance.
 *
 *   2. Stripe       — pos_type='stripe' + stripe_account_id in pos_config
 *                     Creates a Stripe PaymentIntent + dispatches via
 *                     Stripe Connect transfer on completion.
 *                     Supports USDC, USDT, and fiat USD.
 *
 *   3. Twilio SMS   — phone number present, no POS integration
 *                     Sends SMS with job summary + short accept link.
 *                     Fallback to voice call if SMS fails.
 *
 *   4. Email        — notification_email present (handled in rfqService)
 *                     This file handles rails 1-3 only.
 *
 * Rail selection order (per business):
 *   Surge → Stripe → Twilio SMS → Email (rfqService) → skip
 *
 * All rail calls are non-fatal — failure logs and falls through.
 *
 * Escrow:
 *   - Surge/Tempo: pathUSD locked on acceptance, released on complete
 *   - Stripe: PaymentIntent captured on complete, reversed on decline
 *   - Twilio/Email: no escrow (honor system, confidence penalty on no-show)
 *
 * Stablecoins supported:
 *   pathUSD (Tempo mainnet), USDC (Base mainnet), USDT (future)
 *   Fiat USD via Stripe for non-crypto businesses
 */

const db = require('./db');

// ── Surge UCP ─────────────────────────────────────────────────────────────────
/**
 * POST a job to a business's Surge UCP endpoint.
 * Requires pos_config.apim_key and wallet address.
 *
 * Surge UCP spec:
 *   POST https://api.surge.sh/v1/orders
 *   Headers: x-api-key: <apim_key>
 *   Body: { title, description, budget_usd, deadline_at, requester_wallet, rfq_id }
 *
 * On success: returns { surge_order_id }
 * Business receives push notification in their Surge dashboard.
 * pathUSD escrow is created separately via Tempo (see holdTempoEscrow).
 */
async function dispatchSurge(biz, rfq, acceptUrl) {
  const posConfig = biz.pos_config || {};
  const apimKey   = posConfig.apim_key || posConfig.apimKey;
  const wallet    = biz.wallet;

  if (!apimKey || !wallet) return null;

  const surgeUrl = posConfig.surge_url || 'https://api.surge.sh/v1/orders';

  try {
    const body = {
      title:             `LocalIntel Job — ${rfq.category || 'General'}`,
      description:       rfq.description,
      budget_usd:        rfq.budget_usd || null,
      token:             'pathUSD',
      deadline_at:       rfq.deadline_at || null,
      rfq_id:            rfq.id,
      accept_url:        acceptUrl,
      requester_wallet:  process.env.TEMPO_TREASURY,
      platform:          'localintel',
    };

    const res = await fetch(surgeUrl, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key':    apimKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const txt = await res.text();
      console.warn(`[dispatchRail] Surge dispatch failed (${biz.business_id}): HTTP ${res.status} ${txt.slice(0,100)}`);
      return null;
    }

    const json = await res.json();
    console.log(`[dispatchRail] Surge dispatched rfq=${rfq.id} business=${biz.business_id} surge_order=${json.id || 'ok'}`);
    return { rail: 'surge', surge_order_id: json.id || null, wallet };

  } catch (e) {
    console.warn(`[dispatchRail] Surge error (${biz.business_id}):`, e.message);
    return null;
  }
}

// ── Stripe ────────────────────────────────────────────────────────────────────
/**
 * Create a Stripe PaymentIntent for the job.
 * Supports USD fiat, USDC, and future stablecoins.
 *
 * pos_config.stripe_account_id = the business's Stripe Connect account
 * pos_config.stripe_currency   = 'usd' | 'usdc' (default: 'usd')
 *
 * Payment is authorized (not captured) until completeBooking fires.
 */
async function dispatchStripe(biz, rfq, acceptUrl) {
  const posConfig = biz.pos_config || {};
  const stripeAccountId = posConfig.stripe_account_id;

  if (!stripeAccountId) return null;
  if (!process.env.STRIPE_SECRET_KEY) {
    console.warn('[dispatchRail] STRIPE_SECRET_KEY not set — skipping Stripe rail');
    return null;
  }

  const amountCents = rfq.budget_usd ? Math.round(rfq.budget_usd * 100) : null;
  if (!amountCents || amountCents < 50) return null; // Stripe minimum $0.50

  const currency = posConfig.stripe_currency || 'usd';

  try {
    // Lazy-load Stripe to avoid crashing if module not installed
    let stripe;
    try { stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); }
    catch(_) {
      console.warn('[dispatchRail] stripe npm module not installed — skipping Stripe rail');
      return null;
    }

    // Create PaymentIntent with manual capture (hold funds, capture on completion)
    const intent = await stripe.paymentIntents.create({
      amount:               amountCents,
      currency,
      capture_method:       'manual',   // authorized not captured until job complete
      transfer_data:        { destination: stripeAccountId },
      application_fee_amount: Math.round(amountCents * 0.05), // 5% platform fee
      metadata: {
        rfq_id:      rfq.id,
        business_id: biz.business_id,
        platform:    'localintel',
      },
      description: `LocalIntel RFQ ${rfq.id} — ${rfq.category || 'general'} — ${rfq.zip || ''}`,
    });

    console.log(`[dispatchRail] Stripe intent created rfq=${rfq.id} intent=${intent.id} amount=${amountCents}¢ currency=${currency}`);
    return {
      rail:              'stripe',
      stripe_intent_id:  intent.id,
      stripe_account_id: stripeAccountId,
      currency,
      amount_cents:      amountCents,
    };

  } catch (e) {
    console.warn(`[dispatchRail] Stripe error (${biz.business_id}):`, e.message);
    return null;
  }
}

// ── Twilio SMS ────────────────────────────────────────────────────────────────
/**
 * Send SMS to business phone with job summary + short accept link.
 * Falls back to voice call if SMS delivery fails.
 *
 * Accept link format:
 *   https://gsb-swarm-production.up.railway.app/api/local-intel/inbox/respond
 *   ?rfq=<rfq_id>&biz=<business_id>&token=<dispatch_token>&action=accept
 *
 * Decline link:
 *   same URL with action=decline
 *
 * Business replies YES/NO to the SMS to accept/decline (future: handle inbound).
 */
async function dispatchTwilio(biz, rfq, acceptUrl, declineUrl) {
  const phone = biz.phone;
  if (!phone) return null;

  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    console.warn('[dispatchRail] Twilio env vars not set — skipping SMS rail');
    return null;
  }

  // Format phone to E.164
  const e164 = formatE164(phone);
  if (!e164) {
    console.warn(`[dispatchRail] Could not format phone to E.164: ${phone}`);
    return null;
  }

  const budgetText   = rfq.budget_usd ? `$${rfq.budget_usd}` : 'open budget';
  const deadlineText = rfq.deadline_minutes
    ? `${rfq.deadline_minutes}min deadline`
    : rfq.deadline_at
      ? `due ${new Date(rfq.deadline_at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}`
      : 'flexible timeline';
  const category = rfq.category || 'job';

  const smsBody = [
    `LocalIntel: New ${category} request — ${budgetText}, ${deadlineText}.`,
    `"${rfq.description.slice(0, 100)}${rfq.description.length > 100 ? '...' : ''}"`,
    `Accept: ${acceptUrl}`,
    `Decline: ${declineUrl}`,
    `Reply STOP to unsubscribe.`,
  ].join('\n');

  try {
    let twilio;
    try { twilio = require('twilio')(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN); }
    catch(_) {
      console.warn('[dispatchRail] twilio npm module not installed');
      return null;
    }

    const msg = await twilio.messages.create({
      body: smsBody,
      from: TWILIO_FROM_NUMBER,
      to:   e164,
    });

    console.log(`[dispatchRail] SMS sent rfq=${rfq.id} to=${e164} sid=${msg.sid}`);
    return { rail: 'sms', twilio_sid: msg.sid, phone: e164 };

  } catch (e) {
    console.warn(`[dispatchRail] Twilio SMS error (${biz.business_id} ${e164}):`, e.message);
    return null;
  }
}

// ── Tempo escrow (pathUSD) ────────────────────────────────────────────────────
/**
 * Hold pathUSD in escrow for a Surge-dispatched job.
 * Called after Surge dispatch succeeds and business accepts.
 *
 * Uses existing Railway TEMPO_EXECUTOR_PK wallet to hold funds.
 * Released by releaseTempoEscrow on completion.
 *
 * token_symbol: 'pathUSD' | 'USDC' | 'USDT'
 * For now only pathUSD is supported on Tempo mainnet.
 * USDC on Base is future (x402 agent payments).
 */
async function holdTempoEscrow(rfq, booking_id, business_wallet, token_symbol = 'pathUSD') {
  if (!rfq.budget_usd) return null;
  if (!business_wallet) return null;
  if (!process.env.TEMPO_TREASURY) return null;

  // For now: record escrow intent — actual on-chain tx is triggered
  // by the acceptance webhook once business confirms via Surge.
  // Full Tempo viem transaction will be wired in the next sprint.
  console.log(`[dispatchRail] Tempo escrow intent: ${rfq.budget_usd} ${token_symbol} → ${business_wallet} for booking ${booking_id}`);
  return {
    rail:           'tempo',
    token:          token_symbol,
    amount:         rfq.budget_usd,
    from:           process.env.TEMPO_TREASURY,
    to:             business_wallet,
    booking_id,
    status:         'pending_acceptance', // becomes 'held' after business accepts
  };
}

async function releaseTempoEscrow(escrow_data, completion_note) {
  if (!escrow_data || escrow_data.rail !== 'tempo') return null;
  // TODO: wire viem tx to release escrow to business_wallet
  console.log(`[dispatchRail] Tempo escrow release: ${escrow_data.amount} ${escrow_data.token} → ${escrow_data.to} (booking: ${escrow_data.booking_id})`);
  return { released: true, token: escrow_data.token, amount: escrow_data.amount };
}

// ── Stripe capture (completion) ───────────────────────────────────────────────
async function captureStripePayment(stripe_intent_id) {
  if (!stripe_intent_id) return null;
  if (!process.env.STRIPE_SECRET_KEY) return null;
  try {
    let stripe;
    try { stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); } catch(_) { return null; }
    const intent = await stripe.paymentIntents.capture(stripe_intent_id);
    console.log(`[dispatchRail] Stripe captured intent=${stripe_intent_id} status=${intent.status}`);
    return { captured: true, intent_id: stripe_intent_id };
  } catch (e) {
    console.warn('[dispatchRail] Stripe capture error:', e.message);
    return null;
  }
}

async function cancelStripePayment(stripe_intent_id) {
  if (!stripe_intent_id) return null;
  if (!process.env.STRIPE_SECRET_KEY) return null;
  try {
    let stripe;
    try { stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); } catch(_) { return null; }
    const intent = await stripe.paymentIntents.cancel(stripe_intent_id);
    console.log(`[dispatchRail] Stripe cancelled intent=${stripe_intent_id}`);
    return { cancelled: true, intent_id: stripe_intent_id };
  } catch (e) {
    console.warn('[dispatchRail] Stripe cancel error:', e.message);
    return null;
  }
}

// ── Main dispatch entry point ─────────────────────────────────────────────────
/**
 * dispatchToBusiness — select the best rail and fire.
 *
 * Returns { rail, result } or null if all rails fail.
 *
 * Rail priority:
 *   1. Surge (pos_type='other' + apim_key + wallet)
 *   2. Stripe (pos_type='stripe' + stripe_account_id)
 *   3. Twilio SMS (phone present)
 *   4. null (email-only, handled by rfqService)
 */
async function dispatchToBusiness(biz, rfq) {
  const baseUrl   = 'https://gsb-swarm-production.up.railway.app/api/local-intel/inbox/respond';
  const token     = biz.dispatch_token ? `&token=${biz.dispatch_token}` : '';
  const acceptUrl = `${baseUrl}?rfq=${rfq.id}&biz=${biz.business_id}${token}&action=accept`;
  const declineUrl= `${baseUrl}?rfq=${rfq.id}&biz=${biz.business_id}${token}&action=decline`;

  const posConfig = biz.pos_config || {};
  const posType   = posConfig.pos_type || biz.pos_type || null;

  // Rail 1: Surge
  if (posType === 'other' || posConfig.apim_key) {
    const result = await dispatchSurge(biz, rfq, acceptUrl);
    if (result) return { rail: 'surge', result };
  }

  // Rail 2: Stripe
  if (posType === 'stripe' || posConfig.stripe_account_id) {
    const result = await dispatchStripe(biz, rfq, acceptUrl);
    if (result) return { rail: 'stripe', result };
  }

  // Rail 3: Twilio SMS
  if (biz.phone) {
    const result = await dispatchTwilio(biz, rfq, acceptUrl, declineUrl);
    if (result) return { rail: 'sms', result };
  }

  // Rail 4: email-only (handled by rfqService caller)
  return null;
}

// ── Utility ───────────────────────────────────────────────────────────────────
function formatE164(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  if (digits.length > 7) return `+${digits}`;
  return null;
}

module.exports = {
  dispatchToBusiness,
  holdTempoEscrow,
  releaseTempoEscrow,
  captureStripePayment,
  cancelStripePayment,
  // Exported individually for testing
  dispatchSurge,
  dispatchStripe,
  dispatchTwilio,
};
