'use strict';
/**
 * scripts/test-last-mile.js
 * Exercises book → settle → forecast without live Tempo keys.
 *
 * SETTLEMENT_ENABLED defaults false → settled_intent (ledger + forecast still advance).
 * Set SETTLEMENT_ENABLED=true + TEMPO_EXECUTOR_PK to attempt real payout.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

process.env.LOCAL_INTEL_DB_URL =
  process.env.LOCAL_INTEL_DB_URL ||
  'postgresql://localintel:localintel@127.0.0.1:5432/localintel';
process.env.SETTLEMENT_ENABLED = process.env.SETTLEMENT_ENABLED || 'false';
process.env.TASK_SIGNAL_FORCE = 'true';

const db = require('../lib/db');
const settlementService = require('../lib/settlementService');
const { run: runTaskSignals, projectScore } = require('../workers/taskSignalWorker');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

async function ensureBiz(zip) {
  await db.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS wallet TEXT`);
  await db.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`);
  // Prefer an existing business in the ZIP
  let [biz] = await db.query(
    `SELECT business_id, name FROM businesses WHERE zip = $1 LIMIT 1`,
    [zip]
  );
  if (!biz) {
    [biz] = await db.query(
      `INSERT INTO businesses (name, zip, category, claimed, wallet, claimed_at)
       VALUES ($1, $2, 'landscaping', true, $3, NOW())
       RETURNING business_id, name`,
      ['LastMile Test Landscaping', zip, '0xTestMerchantWallet00000000000000000001']
    );
  } else {
    await db.query(
      `UPDATE businesses
          SET wallet = COALESCE(NULLIF(wallet, ''), $2),
              claimed_at = COALESCE(claimed_at, NOW()),
              claimed = true
        WHERE business_id = $1`,
      [biz.business_id, '0xTestMerchantWallet00000000000000000001']
    );
  }
  return biz;
}

async function main() {
  console.log('── last-mile test ──');
  assert(db.isReady(), 'LOCAL_INTEL_DB_URL required');

  // Unit: projection helper
  const p = projectScore({ growth: 50, opportunity: 50, maturity: 'Growing', hasMacro: true }, 80, 40, 12);
  assert(p.growth >= 50, 'velocity should lift growth');
  assert(p.opportunity >= 50, 'unmet should lift opportunity');

  await settlementService.migrate();

  // Ensure RFQ tables via rfqService migrate
  const rfqService = require('../lib/rfqService');
  // touch migrate by creating a throwaway path — createRfq does migrate()
  // Use direct migrate through book path instead: call createRfq

  const zip = '32082';
  const biz = await ensureBiz(zip);
  console.log('merchant:', biz.business_id, biz.name);

  // Seed zip_signals row so forecast has a base
  await db.query(`
    INSERT INTO zip_signals (zip, sig_growth_score, sig_opportunity_score, sig_risk_score, sig_market_maturity, last_updated_at)
    VALUES ($1, 55, 60, 30, 'Growing', NOW())
    ON CONFLICT (zip) DO UPDATE SET
      sig_growth_score = COALESCE(zip_signals.sig_growth_score, 55),
      sig_opportunity_score = COALESCE(zip_signals.sig_opportunity_score, 60),
      last_updated_at = NOW()
  `, [zip]).catch(async (e) => {
    // Some schemas use different PK — try upsert via pgStore
    console.warn('zip_signals seed warn:', e.message);
    const pgStore = require('../lib/pgStore');
    await pgStore.upsertZipSignals(zip, {
      sig_growth_score: 55,
      sig_opportunity_score: 60,
      sig_risk_score: 30,
      sig_market_maturity: 'Growing',
    });
  });

  const created = await rfqService.createRfq({
    job_type: 'proposal',
    category: 'landscaping',
    zip,
    description: 'Last-mile test: mow lawn and edge beds at test address',
    budget_usd: 150,
    autonomy: 'human',
    notify_email: null,
  });
  assert(created?.rfq_id, 'createRfq should return rfq_id');
  console.log('rfq:', created.rfq_id, 'matched:', created.matched_count);

  // Ensure a response exists for our merchant (createRfq may not match in sparse DB)
  const pool = db.getPool();
  let { rows: responses } = await pool.query(
    `SELECT id FROM rfq_responses WHERE rfq_id::text = $1 LIMIT 1`,
    [created.rfq_id]
  );
  if (!responses.length) {
    const { rows: [resp] } = await pool.query(
      `INSERT INTO rfq_responses (rfq_id, business_id, business_name, quote_usd, message, eta_minutes, status)
       VALUES ($1::uuid, $2, $3, 150, 'Can do tomorrow morning', 60, 'pending')
       RETURNING id`,
      [created.rfq_id, biz.business_id, biz.name]
    );
    responses = [resp];
  }
  const responseId = responses[0].id;

  const booked = await rfqService.bookRfq(created.rfq_id, responseId, 'last-mile test book');
  assert(booked?.booking_id, 'bookRfq should return booking_id');
  assert(booked.settlement_hold?.status === 'held', `expected hold, got ${JSON.stringify(booked.settlement_hold)}`);
  console.log('booked:', booked.booking_id, 'hold:', booked.settlement_hold?.status);

  const { rows: [bookingRow] } = await pool.query(
    `SELECT escrow_data, payment_amount, payment_rail FROM rfq_bookings WHERE id::text = $1`,
    [booked.booking_id]
  );
  assert(bookingRow?.escrow_data, 'escrow_data should be set on book');
  assert(Number(bookingRow.payment_amount) === 150, 'payment_amount should be 150');

  const completed = await rfqService.completeBooking(booked.booking_id, 'job done — last-mile test');
  assert(completed?.ok, 'completeBooking ok');
  assert(
    ['settled', 'settled_intent', 'no_wallet', 'no_amount'].includes(completed.settlement?.status),
    `unexpected settlement status: ${completed.settlement?.status}`
  );
  console.log('complete settlement:', completed.settlement?.status, completed.settlement?.amount_usd);

  const events = await db.query(
    `SELECT status, amount_usd, zip FROM settlement_events WHERE booking_id = $1 ORDER BY created_at`,
    [String(booked.booking_id)]
  );
  assert(events.length >= 2, 'expected hold + complete settlement_events');
  assert(events.some(e => e.status === 'held'), 'missing held event');
  assert(events.some(e => e.status === completed.settlement.status), 'missing complete event');

  const signalResult = await runTaskSignals();
  assert(signalResult.written > 0, 'taskSignalWorker should write signals');
  console.log('taskSignalWorker:', signalResult);

  const [sig] = await db.query(
    `SELECT sig_task_velocity, sig_unmet_demand_score, sig_settlement_volume_30d, sig_category_momentum
       FROM zip_signals WHERE zip = $1`,
    [zip]
  );
  assert(sig, 'zip_signals row for test ZIP');
  assert(sig.sig_task_velocity != null, 'sig_task_velocity written');
  console.log('signals:', sig);

  const [forecast] = await db.query(
    `SELECT model_version, proj_12mo_growth_score, summary_12mo
       FROM zip_forecast WHERE zip = $1 AND model_version = 'v1-task-loop'
       ORDER BY generated_at DESC LIMIT 1`,
    [zip]
  );
  assert(forecast, 'zip_forecast row written');
  console.log('forecast:', forecast.model_version, 'growth12=', forecast.proj_12mo_growth_score);

  console.log('✅ last-mile test passed');
}

main().catch((e) => {
  console.error('❌ last-mile test failed:', e);
  process.exit(1);
});
