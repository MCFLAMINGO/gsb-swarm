'use strict';
/**
 * lib/settlementService.js — Last-mile merchant settlement
 *
 * Closes the RFQ loop: book → hold → complete → pay local business.
 *
 * Flow:
 *   holdOnBook()       — record escrow intent on rfq_bookings.escrow_data
 *   settleOnComplete() — pay merchant wallet (Tempo pathUSD when live),
 *                        always write settlement_events for the forecast loop
 *
 * Env:
 *   SETTLEMENT_ENABLED=true  — attempt live treasury→merchant pathUSD transfer
 *   TEMPO_EXECUTOR_PK        — co-signer (same as feeService)
 *   TEMPO_TREASURY           — source wallet for settlement payouts
 *
 * Statuses on settlement_events:
 *   held | settled | settled_intent | failed | no_wallet | no_amount | already_settled
 *
 * Mirror of feeService (platform fee ← merchant) but money flows TO the merchant.
 */

const db = require('./db');

const SPONSOR_URL   = 'https://www.throw5onit.com/api/sponsor-tx';
const TREASURY_ADDR = process.env.TEMPO_TREASURY || '0x774f484192Cf3F4fB9716Af2e15f44371fD32FEA';

let migrated = false;

async function migrate() {
  if (migrated) return;

  await db.query(`
    CREATE TABLE IF NOT EXISTS settlement_events (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id      TEXT,
      rfq_id          TEXT,
      business_id     TEXT,
      zip             TEXT,
      category        TEXT,
      amount_usd      NUMERIC(12,4) NOT NULL DEFAULT 0,
      token           TEXT NOT NULL DEFAULT 'pathUSD',
      status          TEXT NOT NULL,
      wallet          TEXT,
      tx_hash         TEXT,
      rail            TEXT DEFAULT 'tempo',
      meta            JSONB DEFAULT '{}'::jsonb,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS settlement_events_booking_idx ON settlement_events(booking_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS settlement_events_zip_idx ON settlement_events(zip)`);
  await db.query(`CREATE INDEX IF NOT EXISTS settlement_events_created_idx ON settlement_events(created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS settlement_events_status_idx ON settlement_events(status)`);

  // Ensure merchant wallet + booking settlement columns exist (idempotent)
  await db.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS wallet TEXT`);
  await db.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`);
  await db.query(`
    ALTER TABLE rfq_bookings
      ADD COLUMN IF NOT EXISTS payment_rail     TEXT,
      ADD COLUMN IF NOT EXISTS payment_token    TEXT DEFAULT 'pathUSD',
      ADD COLUMN IF NOT EXISTS payment_amount   NUMERIC(10,2),
      ADD COLUMN IF NOT EXISTS escrow_data      JSONB,
      ADD COLUMN IF NOT EXISTS stripe_intent_id TEXT,
      ADD COLUMN IF NOT EXISTS settled_at       TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS settled_tx       TEXT
  `).catch(() => {});

  migrated = true;
}

function isSettlementEnabled() {
  return (process.env.SETTLEMENT_ENABLED || 'false').toLowerCase() === 'true';
}

async function logEvent(row) {
  await migrate();
  const [inserted] = await db.query(
    `INSERT INTO settlement_events
       (booking_id, rfq_id, business_id, zip, category, amount_usd, token, status, wallet, tx_hash, rail, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
     RETURNING id, status, amount_usd, tx_hash`,
    [
      row.booking_id || null,
      row.rfq_id || null,
      row.business_id || null,
      row.zip || null,
      row.category || null,
      row.amount_usd || 0,
      row.token || 'pathUSD',
      row.status,
      row.wallet || null,
      row.tx_hash || null,
      row.rail || 'tempo',
      JSON.stringify(row.meta || {}),
    ]
  );
  return inserted;
}

/**
 * Attempt treasury → merchant pathUSD transfer via THROW sponsor-tx.
 * Same co-sign pattern as feeService, opposite direction.
 */
async function attemptPayout({ wallet, amount_usd, booking_id }) {
  const execPKRaw = (process.env.TEMPO_EXECUTOR_PK || '').replace(/\s/g, '');
  if (!execPKRaw) {
    console.error('[settlementService] TEMPO_EXECUTOR_PK not set — cannot payout');
    return { status: 'failed', tx_hash: null, reason: 'no_executor_pk' };
  }
  if (!wallet) {
    return { status: 'no_wallet', tx_hash: null, reason: 'no_wallet' };
  }
  if (!(amount_usd > 0)) {
    return { status: 'no_amount', tx_hash: null, reason: 'no_amount' };
  }

  try {
    const body = {
      fromPK:    execPKRaw,
      from:      TREASURY_ADDR, // pathUSD pulled from treasury
      to:        wallet,       // paid to local merchant
      tokenAddr: 'auto',
      amount:    amount_usd,
    };
    const res  = await fetch(SPONSOR_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (data.hash) {
      console.log(`[settlementService] paid merchant $${amount_usd} → ${wallet.slice(0, 10)}… tx=${data.hash} booking=${booking_id}`);
      return { status: 'settled', tx_hash: data.hash, reason: null };
    }
    const reason = data.error || JSON.stringify(data);
    console.warn(`[settlementService] payout failed booking=${booking_id}: ${reason}`);
    return { status: 'failed', tx_hash: null, reason };
  } catch (e) {
    console.error(`[settlementService] payout error booking=${booking_id}:`, e.message);
    return { status: 'failed', tx_hash: null, reason: e.message };
  }
}

/**
 * On book: create escrow hold record on the booking so complete can settle.
 * Does not move funds yet (authorization / intent). Stripe intents stay on their rail.
 */
async function holdOnBook({
  booking_id,
  rfq_id,
  business_id,
  quote_usd,
  budget_usd,
  zip,
  category,
  stripe_intent_id = null,
}) {
  await migrate();

  const amount = Number(quote_usd || budget_usd || 0) || 0;
  const [biz] = business_id
    ? await db.query(`SELECT wallet FROM businesses WHERE business_id::text = $1 LIMIT 1`, [String(business_id)])
    : [null];
  const wallet = biz?.wallet || null;

  if (stripe_intent_id) {
    await db.query(
      `UPDATE rfq_bookings
          SET payment_rail = 'stripe',
              payment_amount = $2,
              stripe_intent_id = $3,
              escrow_data = $4::jsonb
        WHERE id::text = $1`,
      [
        String(booking_id),
        amount || null,
        stripe_intent_id,
        JSON.stringify({
          rail: 'stripe',
          stripe_intent_id,
          amount,
          status: 'authorized',
          booking_id,
          business_id,
        }),
      ]
    );
    const ev = await logEvent({
      booking_id, rfq_id, business_id, zip, category,
      amount_usd: amount, status: 'held', wallet, rail: 'stripe',
      meta: { phase: 'hold', stripe_intent_id },
    });
    return { ok: true, status: 'held', rail: 'stripe', event_id: ev?.id, amount_usd: amount, wallet };
  }

  const escrow = {
    rail:       'tempo',
    token:      'pathUSD',
    amount,
    from:       TREASURY_ADDR,
    to:         wallet,
    booking_id,
    business_id,
    status:     wallet && amount > 0 ? 'held' : (wallet ? 'held_no_amount' : 'held_no_wallet'),
    held_at:    new Date().toISOString(),
  };

  await db.query(
    `UPDATE rfq_bookings
        SET payment_rail = 'tempo',
            payment_token = 'pathUSD',
            payment_amount = $2,
            escrow_data = $3::jsonb
      WHERE id::text = $1`,
    [String(booking_id), amount || null, JSON.stringify(escrow)]
  );

  const ev = await logEvent({
    booking_id, rfq_id, business_id, zip, category,
    amount_usd: amount,
    status: 'held',
    wallet,
    rail: 'tempo',
    meta: { phase: 'hold', escrow_status: escrow.status },
  });

  console.log(`[settlementService] holdOnBook booking=${booking_id} amount=$${amount} wallet=${wallet ? wallet.slice(0, 10) + '…' : 'none'}`);
  return { ok: true, status: 'held', rail: 'tempo', event_id: ev?.id, amount_usd: amount, wallet, escrow };
}

/**
 * On complete: settle to merchant wallet and record outcome for forecasts.
 */
async function settleOnComplete({ booking_id, completion_note = null }) {
  await migrate();

  const [booking] = await db.query(
    `SELECT * FROM rfq_bookings WHERE id::text = $1 LIMIT 1`,
    [String(booking_id)]
  );
  if (!booking) throw new Error(`Booking ${booking_id} not found`);

  if (booking.settled_at) {
    return {
      ok: true,
      status: 'already_settled',
      settled_at: booking.settled_at,
      settled_tx: booking.settled_tx || null,
      amount_usd: booking.payment_amount != null ? Number(booking.payment_amount) : null,
    };
  }

  const [rfq] = await db.query(
    `SELECT id, zip, category, budget_usd FROM rfq_requests WHERE id::text = $1 LIMIT 1`,
    [String(booking.rfq_id)]
  ).catch(() => [null]);

  const [biz] = await db.query(
    `SELECT wallet, name FROM businesses WHERE business_id::text = $1 LIMIT 1`,
    [String(booking.business_id)]
  ).catch(() => [null]);

  const wallet = biz?.wallet || booking.escrow_data?.to || null;
  const amount = Number(
    booking.payment_amount
    || booking.escrow_data?.amount
    || rfq?.budget_usd
    || 0
  ) || 0;

  const zip = rfq?.zip || null;
  const category = rfq?.category || null;
  const live = isSettlementEnabled();

  // Stripe capture path
  if (booking.stripe_intent_id || booking.escrow_data?.rail === 'stripe') {
    let captured = null;
    try {
      const { captureStripePayment } = require('./dispatchRail');
      captured = await captureStripePayment(booking.stripe_intent_id || booking.escrow_data?.stripe_intent_id);
    } catch (e) {
      console.warn('[settlementService] stripe capture error:', e.message);
    }
    const status = captured?.captured ? 'settled' : (live ? 'failed' : 'settled_intent');
    await db.query(
      `UPDATE rfq_bookings
          SET settled_at = NOW(),
              settled_tx = COALESCE($2, settled_tx),
              escrow_data = COALESCE(escrow_data, '{}'::jsonb) || $3::jsonb
        WHERE id::text = $1`,
      [
        String(booking_id),
        booking.stripe_intent_id || null,
        JSON.stringify({ status, released_at: new Date().toISOString(), completion_note }),
      ]
    );
    const ev = await logEvent({
      booking_id, rfq_id: booking.rfq_id, business_id: booking.business_id,
      zip, category, amount_usd: amount, status, wallet,
      rail: 'stripe', tx_hash: booking.stripe_intent_id || null,
      meta: { phase: 'complete', captured: !!captured?.captured, live, note: completion_note },
    });
    return { ok: true, status, amount_usd: amount, wallet, event_id: ev?.id, rail: 'stripe', live };
  }

  // Tempo / pathUSD path
  let status;
  let tx_hash = null;
  let reason = null;

  if (!wallet) {
    status = 'no_wallet';
  } else if (!(amount > 0)) {
    status = 'no_amount';
  } else if (!live) {
    status = 'settled_intent'; // money intent recorded; flip SETTLEMENT_ENABLED to pay on-chain
  } else {
    const payout = await attemptPayout({ wallet, amount_usd: amount, booking_id });
    status  = payout.status;
    tx_hash = payout.tx_hash;
    reason  = payout.reason;
  }

  // Mark booking settled for any terminal-ish outcome that represents "loop closed"
  // (including settled_intent / no_wallet) so forecast workers see completions.
  const markSettled = ['settled', 'settled_intent', 'no_wallet', 'no_amount'].includes(status);
  if (markSettled) {
    await db.query(
      `UPDATE rfq_bookings
          SET settled_at = NOW(),
              settled_tx = COALESCE($2, settled_tx),
              escrow_data = COALESCE(escrow_data, '{}'::jsonb) || $3::jsonb
        WHERE id::text = $1`,
      [
        String(booking_id),
        tx_hash,
        JSON.stringify({
          status,
          released_at: new Date().toISOString(),
          completion_note,
          live,
        }),
      ]
    );
  }

  const ev = await logEvent({
    booking_id,
    rfq_id: booking.rfq_id,
    business_id: booking.business_id,
    zip,
    category,
    amount_usd: amount,
    status,
    wallet,
    tx_hash,
    rail: 'tempo',
    meta: {
      phase: 'complete',
      live,
      reason,
      note: completion_note,
      business_name: biz?.name || booking.business_name || null,
    },
  });

  console.log(`[settlementService] settleOnComplete booking=${booking_id} status=${status} amount=$${amount} live=${live}`);
  return {
    ok: true,
    status,
    amount_usd: amount,
    wallet,
    tx_hash,
    event_id: ev?.id,
    rail: 'tempo',
    live,
    reason,
  };
}

module.exports = {
  migrate,
  holdOnBook,
  settleOnComplete,
  isSettlementEnabled,
  attemptPayout,
  logEvent,
};
