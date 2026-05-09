'use strict';
/**
 * confirmedJobs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for jobs confirmed for a business.
 * Sources: rfq_win (bookRfq), surge_purchase (/api/surge/webhook), manual.
 *
 * Job shape exposes WHO / WHAT / WHERE / WHEN / HOW fields.
 * Merchant notified via SMS + email on creation.
 * Business replies DONE → markComplete().
 */

const db      = require('./db');
const { Resend } = require('resend');

let migrated = false;

async function migrate() {
  if (migrated) return;
  const pool = db.getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS confirmed_jobs (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id      UUID NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
      source           TEXT NOT NULL CHECK (source IN ('rfq_win','surge_purchase','manual')),
      customer_name    TEXT,
      customer_phone   TEXT,
      customer_email   TEXT,
      service_name     TEXT NOT NULL,
      description      TEXT,
      address          TEXT,
      zip              TEXT,
      map_url          TEXT,
      scheduled_at     TIMESTAMPTZ,
      schedule_text    TEXT,
      is_recurring     BOOLEAN NOT NULL DEFAULT FALSE,
      recurrence_note  TEXT,
      paid_amount      NUMERIC(10,2),
      currency         TEXT NOT NULL DEFAULT 'USD',
      settlement_hash  TEXT,
      payment_method   TEXT CHECK (payment_method IN ('surge','stripe','cash','pathusd','other')),
      status           TEXT NOT NULL DEFAULT 'confirmed'
                       CHECK (status IN ('confirmed','in_progress','complete','cancelled')),
      completed_at     TIMESTAMPTZ,
      done_sms_sent    BOOLEAN NOT NULL DEFAULT FALSE,
      rfq_id           UUID,
      rfq_booking_id   UUID,
      surge_order_id   TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cj_business ON confirmed_jobs(business_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cj_status   ON confirmed_jobs(status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cj_created  ON confirmed_jobs(created_at DESC)`);

  // Update trigger
  await pool.query(`
    CREATE OR REPLACE FUNCTION confirmed_jobs_touch()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
    $$
  `);
  await pool.query(`
    DROP TRIGGER IF EXISTS confirmed_jobs_touch_trg ON confirmed_jobs
  `);
  await pool.query(`
    CREATE TRIGGER confirmed_jobs_touch_trg
      BEFORE UPDATE ON confirmed_jobs
      FOR EACH ROW EXECUTE FUNCTION confirmed_jobs_touch()
  `);

  migrated = true;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function buildMapUrl(address, zip) {
  if (!address) return null;
  const q = encodeURIComponent(`${address}${zip ? ' ' + zip : ''}`);
  return `https://maps.google.com/?q=${q}`;
}

function mapsLink(address, zip) {
  const url = buildMapUrl(address, zip);
  return url ? `\nDirections: ${url}` : '';
}

function buildSmsBody(job, bizName) {
  const lines = [
    `LocalIntel: New confirmed job for ${bizName}!`,
    `─────────────────────`,
    `WHO:  ${job.customer_name || 'Customer'}${job.customer_phone ? ' · ' + job.customer_phone : ''}`,
    `WHAT: ${job.service_name}${job.description ? ' — ' + job.description : ''}`,
    `WHERE: ${job.address || 'TBD'}${job.zip ? ' ' + job.zip : ''}`,
    `WHEN: ${job.schedule_text || 'ASAP'}${job.recurrence_note ? ' (' + job.recurrence_note + ')' : ''}`,
    `HOW:  Paid $${job.paid_amount || '—'} via ${job.payment_method || 'pending'}`,
  ];
  if (job.map_url) lines.push(`Map: ${job.map_url}`);
  lines.push(`Reply DONE when complete.`);
  return lines.join('\n');
}

async function notifyBusiness(job, biz) {
  // SMS — uses raw fetch (same pattern as rfqBroadcast.sendSms, no twilio npm pkg needed)
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_PHONE_NUMBER;
  if (biz.phone && sid && token && from) {
    try {
      const params = new URLSearchParams({ To: biz.phone, From: from, Body: buildSmsBody(job, biz.name) });
      const smsRes = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
          },
          body: params.toString(),
        }
      );
      if (!smsRes.ok) console.error('[confirmedJobs] SMS error:', await smsRes.text());
      else console.log(`[confirmedJobs] SMS sent to ${biz.phone} for job ${job.id}`);
    } catch (e) {
      console.error('[confirmedJobs] SMS error:', e.message);
    }
  }

  // Email
  if (biz.notification_email && process.env.RESEND_API_KEY) {
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const serviceLines = [
        `WHO:   ${job.customer_name || 'Customer'}${job.customer_phone ? '  |  ' + job.customer_phone : ''}`,
        `WHAT:  ${job.service_name}${job.description ? '\n       ' + job.description : ''}`,
        `WHERE: ${job.address || 'TBD'}${job.zip ? ' ' + job.zip : ''}`,
        `WHEN:  ${job.schedule_text || 'ASAP'}${job.recurrence_note ? '  (' + job.recurrence_note + ')' : ''}`,
        `HOW:   $${job.paid_amount || '—'} paid via ${job.payment_method || 'pending'}${job.settlement_hash ? '\n       TX: ' + job.settlement_hash : ''}`,
      ];
      if (job.map_url) serviceLines.push(`MAP:   ${job.map_url}`);

      await resend.emails.send({
        from:    'dispatch@thelocalintel.com',
        to:      biz.notification_email,
        bcc:     'erik@mcflamingo.com',
        subject: `✅ Confirmed Job: ${job.service_name} — ${job.customer_name || 'New Customer'}`,
        text: [
          `You have a confirmed job from LocalIntel.`,
          '',
          ...serviceLines,
          '',
          `─────────────────────────────────────────`,
          `Reply DONE via SMS to mark this complete.`,
          '',
          '— LocalIntel Dispatch',
          'LocalIntel Data Services | Erik Osol',
        ].join('\n'),
      });
      console.log(`[confirmedJobs] email sent to ${biz.notification_email} for job ${job.id}`);
    } catch (e) {
      console.error('[confirmedJobs] email error:', e.message);
    }
  }
}

// ── createConfirmedJob ────────────────────────────────────────────────────────
/**
 * Write a confirmed job + notify the business.
 * @param {object} params
 * @returns {{ job_id: string }}
 */
async function createConfirmedJob(params) {
  await migrate();
  const pool = db.getPool();

  const {
    business_id,
    source,           // 'rfq_win' | 'surge_purchase' | 'manual'
    customer_name,
    customer_phone,
    customer_email,
    service_name,
    description,
    address,
    zip,
    scheduled_at,
    schedule_text,
    is_recurring = false,
    recurrence_note,
    paid_amount,
    currency = 'USD',
    settlement_hash,
    payment_method,
    rfq_id,
    rfq_booking_id,
    surge_order_id,
  } = params;

  if (!business_id) throw new Error('business_id required');
  if (!service_name) throw new Error('service_name required');
  if (!source) throw new Error('source required');

  const map_url = buildMapUrl(address, zip);

  const { rows: [job] } = await pool.query(
    `INSERT INTO confirmed_jobs (
       business_id, source,
       customer_name, customer_phone, customer_email,
       service_name, description,
       address, zip, map_url,
       scheduled_at, schedule_text, is_recurring, recurrence_note,
       paid_amount, currency, settlement_hash, payment_method,
       rfq_id, rfq_booking_id, surge_order_id
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
     ) RETURNING *`,
    [
      business_id, source,
      customer_name || null, customer_phone || null, customer_email || null,
      service_name, description || null,
      address || null, zip || null, map_url,
      scheduled_at || null, schedule_text || null, is_recurring, recurrence_note || null,
      paid_amount || null, currency, settlement_hash || null, payment_method || null,
      rfq_id || null, rfq_booking_id || null, surge_order_id || null,
    ]
  );

  console.log(`[confirmedJobs] created job ${job.id} source=${source} biz=${business_id}`);

  // Notify business (fire-and-forget)
  setImmediate(async () => {
    try {
      const [biz] = await db.query(
        `SELECT name, phone, notification_email FROM businesses WHERE business_id = $1`,
        [business_id]
      );
      if (biz) await notifyBusiness(job, biz);
    } catch (e) {
      console.error('[confirmedJobs] notify error:', e.message);
    }
  });

  return { job_id: job.id };
}

// ── getConfirmedJobs ──────────────────────────────────────────────────────────
/**
 * Fetch confirmed jobs for a business, ordered by created_at DESC.
 */
async function getConfirmedJobs(business_id, { limit = 20, status } = {}) {
  await migrate();
  const pool = db.getPool();

  const conditions = ['business_id = $1'];
  const vals = [business_id];

  if (status) {
    vals.push(status);
    conditions.push(`status = $${vals.length}`);
  }

  const { rows } = await pool.query(
    `SELECT * FROM confirmed_jobs
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${vals.length + 1}`,
    [...vals, limit]
  );
  return rows;
}

// ── markComplete ──────────────────────────────────────────────────────────────
/**
 * Mark a job complete. Called when merchant replies DONE via SMS.
 */
async function markComplete(job_id) {
  await migrate();
  const pool = db.getPool();

  const { rows: [job] } = await pool.query(
    `UPDATE confirmed_jobs
        SET status = 'complete', completed_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [job_id]
  );

  if (!job) throw new Error(`confirmed_job ${job_id} not found`);
  console.log(`[confirmedJobs] marked complete: ${job_id}`);
  return job;
}

// ── findByPhone ───────────────────────────────────────────────────────────────
/**
 * Find the most recent open confirmed job for a business phone number.
 * Used by SMS DONE handler to know which job to mark complete.
 */
async function findOpenJobForBusiness(business_id) {
  await migrate();
  const pool = db.getPool();

  const { rows: [job] } = await pool.query(
    `SELECT * FROM confirmed_jobs
      WHERE business_id = $1
        AND status IN ('confirmed','in_progress')
      ORDER BY created_at DESC
      LIMIT 1`,
    [business_id]
  );
  return job || null;
}

module.exports = { migrate, createConfirmedJob, getConfirmedJobs, markComplete, findOpenJobForBusiness };
