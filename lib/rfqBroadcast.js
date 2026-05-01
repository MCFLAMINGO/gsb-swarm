'use strict';
/**
 * rfqBroadcast.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Full RFQ broadcast loop for LocalIntel.
 *
 * Flow:
 *   1. createJob()      — insert rfq_jobs row, return { jobId, code }
 *   2. broadcastJob()   — find providers in category+ZIP, SMS + email each
 *   3. recordResponse() — called by SMS/email/voice webhooks when provider replies
 *   4. checkCallback()  — called after each response; fires outbound call if
 *                         ≥3 responses OR job is ≥30 min old with ≥1 response
 *
 * Tables auto-created on first use (Postgres is king).
 *
 * Job code format: 6 uppercase alphanumeric chars (e.g. "X4R9QW")
 * Broadcast SMS:  "New job from Erik (HOA): Streetlight repair in 32082.
 *                  Reply YES-X4R9QW to bid. LocalIntel"
 * Reply-to email: jobs+X4R9QW@thelocalintel.com  ← Resend inbound parse
 */

const db       = require('./db');
const crypto   = require('crypto');

// ── Table migrations ──────────────────────────────────────────────────────────
let migrated = false;
async function migrate() {
  if (migrated) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS rfq_jobs (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code            TEXT NOT NULL UNIQUE,           -- 6-char human code
      caller_phone    TEXT NOT NULL,
      caller_name     TEXT,
      caller_email    TEXT,                           -- confirmed after call
      category        TEXT NOT NULL,
      zip             TEXT,
      description     TEXT,
      status          TEXT NOT NULL DEFAULT 'open',   -- open|matched|confirmed|closed|expired
      broadcast_count INT  NOT NULL DEFAULT 0,
      response_count  INT  NOT NULL DEFAULT 0,
      selected_biz_id TEXT,                           -- business_id of confirmed provider
      callback_fired  BOOLEAN NOT NULL DEFAULT FALSE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at      TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS rfq_broadcasts (
      id           BIGSERIAL PRIMARY KEY,
      job_id       UUID NOT NULL REFERENCES rfq_jobs(id) ON DELETE CASCADE,
      business_id  TEXT NOT NULL,
      business_name TEXT,
      phone        TEXT,
      email        TEXT,
      sms_sent     BOOLEAN NOT NULL DEFAULT FALSE,
      email_sent   BOOLEAN NOT NULL DEFAULT FALSE,
      sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS rfq_responses (
      id            BIGSERIAL PRIMARY KEY,
      job_id        UUID NOT NULL REFERENCES rfq_jobs(id) ON DELETE CASCADE,
      business_id   TEXT,
      business_name TEXT,
      business_phone TEXT,
      business_email TEXT,
      channel       TEXT NOT NULL,  -- 'sms' | 'email' | 'voice'
      raw_text      TEXT,
      responded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      selected      BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS rfq_jobs_code_idx ON rfq_jobs(code)`);
  await db.query(`CREATE INDEX IF NOT EXISTS rfq_jobs_status_idx ON rfq_jobs(status)`);
  await db.query(`CREATE INDEX IF NOT EXISTS rfq_responses_job_idx ON rfq_responses(job_id)`);
  migrated = true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function genCode() {
  // 6 uppercase alphanumeric, unambiguous chars (no 0/O/I/1)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const bytes = crypto.randomBytes(6);
  for (const b of bytes) code += chars[b % chars.length];
  return code;
}

async function sendSms(to, body) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) {
    console.warn('[rfqBroadcast] SMS skipped — TWILIO env vars not set');
    return false;
  }
  const params = new URLSearchParams({ To: to, From: from, Body: body });
  try {
    const res = await fetch(
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
    if (!res.ok) {
      const err = await res.text();
      console.error('[rfqBroadcast] SMS error to', to, ':', err);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[rfqBroadcast] SMS fetch error:', e.message);
    return false;
  }
}

async function sendEmail(to, subject, html, replyTo) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[rfqBroadcast] Email skipped — RESEND_API_KEY not set');
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from:     'LocalIntel Jobs <jobs@thelocalintel.com>',
        to:       [to],
        reply_to: replyTo || 'jobs@thelocalintel.com',
        subject,
        html,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('[rfqBroadcast] Email error to', to, ':', err);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[rfqBroadcast] Email fetch error:', e.message);
    return false;
  }
}

// ── createJob ─────────────────────────────────────────────────────────────────
/**
 * Create an RFQ job in Postgres.
 * @returns { jobId, code }
 */
async function createJob({ callerPhone, callerName, category, zip, description }) {
  await migrate();
  let code, attempts = 0;
  while (attempts < 5) {
    code = genCode();
    const existing = await db.query(`SELECT id FROM rfq_jobs WHERE code = $1`, [code]);
    if (!existing.length) break;
    attempts++;
  }
  const rows = await db.query(
    `INSERT INTO rfq_jobs (code, caller_phone, caller_name, category, zip, description)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, code`,
    [code, callerPhone, callerName || null, category, zip || null, description || null]
  );
  const job = rows[0];
  console.log(`[rfqBroadcast] Job created: ${job.code} — ${category} in ${zip || 'unknown'} for ${callerPhone}`);
  return { jobId: job.id, code: job.code };
}

// ── broadcastJob ──────────────────────────────────────────────────────────────
/**
 * Find all providers in category+ZIP and blast SMS + email.
 * Returns count of providers notified.
 */
async function broadcastJob({ jobId, code, callerName, category, zip, description }) {
  await migrate();

  // Find providers: category match in ZIP (or broader NE FL if no ZIP match)
  const catLike = `%${category}%`;
  let providers = [];

  if (zip) {
    providers = await db.query(
      `SELECT business_id, name, phone, notification_email AS email
       FROM businesses
       WHERE status != 'inactive'
         AND (category ILIKE $1 OR category_group ILIKE $1)
         AND zip = $2
         AND (phone IS NOT NULL OR notification_email IS NOT NULL)
       ORDER BY (claimed_at IS NOT NULL) DESC, confidence_score DESC
       LIMIT 20`,
      [catLike, zip]
    );
  }

  // Fallback to broader area if no ZIP match
  if (!providers.length) {
    providers = await db.query(
      `SELECT business_id, name, phone, notification_email AS email
       FROM businesses
       WHERE status != 'inactive'
         AND (category ILIKE $1 OR category_group ILIKE $1)
         AND (phone IS NOT NULL OR notification_email IS NOT NULL)
       ORDER BY (claimed_at IS NOT NULL) DESC, confidence_score DESC
       LIMIT 10`,
      [catLike]
    );
  }

  if (!providers.length) {
    console.log(`[rfqBroadcast] No providers found for ${category} in ${zip || 'any'}`);
    await db.query(`UPDATE rfq_jobs SET status = 'no_providers' WHERE id = $1`, [jobId]);
    return 0;
  }

  const nameStr   = callerName ? ` from ${callerName}` : '';
  const zipStr    = zip ? ` in ${zip}` : '';
  const catLabel  = category.replace(/_/g, ' ');
  const replyTo   = `jobs+${code}@thelocalintel.com`;
  const siteUrl   = `https://www.thelocalintel.com`;

  let broadcastCount = 0;

  for (const p of providers) {
    let smsSent   = false;
    let emailSent = false;

    // SMS
    if (p.phone) {
      const smsBody =
        `LocalIntel Job Request${nameStr}: ${catLabel}${zipStr}.\n` +
        `"${(description || '').slice(0, 80)}"\n` +
        `Reply YES-${code} to bid. More at ${siteUrl}`;
      smsSent = await sendSms(p.phone, smsBody);
    }

    // Email
    if (p.email) {
      const subject = `New Job: ${catLabel}${zipStr} — Job ${code}`;
      const html = `
        <h2 style="font-family:sans-serif">New LocalIntel Job Request</h2>
        <table style="font-family:sans-serif;font-size:14px;border-collapse:collapse">
          <tr><td style="padding:6px 12px;font-weight:600">Job Code</td><td style="padding:6px 12px">${code}</td></tr>
          <tr><td style="padding:6px 12px;font-weight:600">Service</td><td style="padding:6px 12px">${catLabel}</td></tr>
          ${zip ? `<tr><td style="padding:6px 12px;font-weight:600">ZIP</td><td style="padding:6px 12px">${zip}</td></tr>` : ''}
          ${callerName ? `<tr><td style="padding:6px 12px;font-weight:600">Requester</td><td style="padding:6px 12px">${callerName}</td></tr>` : ''}
          <tr><td style="padding:6px 12px;font-weight:600">Description</td><td style="padding:6px 12px">${description || 'See details above'}</td></tr>
        </table>
        <p style="font-family:sans-serif;margin-top:20px">
          <strong>To bid on this job:</strong> Reply to this email with your availability and rate,
          or text <strong>YES-${code}</strong> to <strong>(904) 506-7476</strong>.
        </p>
        <p style="font-family:sans-serif;font-size:12px;color:#888">
          LocalIntel — Northeast Florida's local commerce network.<br>
          You are receiving this because your business is listed for ${catLabel} services.
          <a href="${siteUrl}/unsubscribe?phone=${encodeURIComponent(p.phone || '')}">Unsubscribe</a>
        </p>
      `;
      emailSent = await sendEmail(p.email, subject, html, replyTo);
    }

    if (smsSent || emailSent) {
      await db.query(
        `INSERT INTO rfq_broadcasts (job_id, business_id, business_name, phone, email, sms_sent, email_sent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [jobId, p.business_id, p.name, p.phone || null, p.email || null, smsSent, emailSent]
      );
      broadcastCount++;
    }

    console.log(`[rfqBroadcast] Notified ${p.name} — SMS:${smsSent} Email:${emailSent}`);
  }

  // Update job with broadcast count
  await db.query(
    `UPDATE rfq_jobs SET broadcast_count = $1 WHERE id = $2`,
    [broadcastCount, jobId]
  );

  console.log(`[rfqBroadcast] Job ${code} broadcast to ${broadcastCount} providers`);
  return broadcastCount;
}

// ── recordResponse ────────────────────────────────────────────────────────────
/**
 * Called when a provider responds (SMS/email/voice).
 * Looks up the job by code, inserts response, increments counter.
 * Returns { job, response, shouldCallback }
 */
async function recordResponse({ code, providerPhone, providerEmail, channel, rawText }) {
  await migrate();

  // Look up job
  const jobs = await db.query(
    `SELECT * FROM rfq_jobs WHERE code = $1 AND status IN ('open','matched')`,
    [code.toUpperCase()]
  );
  if (!jobs.length) {
    console.warn(`[rfqBroadcast] recordResponse: job code ${code} not found or closed`);
    return { ok: false, reason: 'job_not_found' };
  }
  const job = jobs[0];

  // Find matching broadcast record to get business details
  let bizId = null, bizName = null, bizEmail = null;
  if (providerPhone) {
    const bc = await db.query(
      `SELECT business_id, business_name, email FROM rfq_broadcasts
       WHERE job_id = $1 AND phone = $2 LIMIT 1`,
      [job.id, providerPhone]
    );
    if (bc.length) { bizId = bc[0].business_id; bizName = bc[0].business_name; bizEmail = bc[0].email; }
  }
  if (!bizId && providerEmail) {
    const bc = await db.query(
      `SELECT business_id, business_name, phone FROM rfq_broadcasts
       WHERE job_id = $1 AND email = $2 LIMIT 1`,
      [job.id, providerEmail]
    );
    if (bc.length) { bizId = bc[0].business_id; bizName = bc[0].business_name; }
  }

  // Check for duplicate response from same business
  if (bizId) {
    const existing = await db.query(
      `SELECT id FROM rfq_responses WHERE job_id = $1 AND business_id = $2`,
      [job.id, bizId]
    );
    if (existing.length) {
      console.log(`[rfqBroadcast] Duplicate response from ${bizName || bizId} on job ${code}`);
      return { ok: true, duplicate: true, job };
    }
  }

  // Insert response
  await db.query(
    `INSERT INTO rfq_responses (job_id, business_id, business_name, business_phone, business_email, channel, raw_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [job.id, bizId || null, bizName || null, providerPhone || null, providerEmail || null, channel, rawText || null]
  );

  // Increment response count + update status
  const updated = await db.query(
    `UPDATE rfq_jobs
     SET response_count = response_count + 1,
         status = CASE WHEN status = 'open' THEN 'matched' ELSE status END
     WHERE id = $1
     RETURNING response_count, callback_fired, created_at`,
    [job.id]
  );
  const { response_count, callback_fired, created_at } = updated[0];

  // Callback trigger: ≥3 responses OR job ≥30 min old with ≥1 response
  const ageMin = (Date.now() - new Date(created_at).getTime()) / 60000;
  const shouldCallback = !callback_fired && (response_count >= 3 || ageMin >= 30);

  console.log(`[rfqBroadcast] Response recorded for job ${code} — count: ${response_count}, shouldCallback: ${shouldCallback}`);

  return {
    ok: true,
    job: { ...job, response_count },
    bizName,
    shouldCallback,
  };
}

// ── confirmSelection ──────────────────────────────────────────────────────────
/**
 * Called when caller picks a provider (by number 1/2/3, phone, or name).
 * Marks response as selected, closes job, notifies both parties.
 */
async function confirmSelection({ jobId, responseIndex, callerPhone }) {
  await migrate();

  // Get job
  const jobs = await db.query(`SELECT * FROM rfq_jobs WHERE id = $1`, [jobId]);
  if (!jobs.length) return { ok: false, reason: 'job_not_found' };
  const job = jobs[0];

  // Get responses ordered by responded_at
  const responses = await db.query(
    `SELECT * FROM rfq_responses WHERE job_id = $1 ORDER BY responded_at ASC`,
    [jobId]
  );
  if (!responses.length) return { ok: false, reason: 'no_responses' };

  const idx = Math.max(0, (responseIndex || 1) - 1);
  const chosen = responses[Math.min(idx, responses.length - 1)];

  // Mark selected
  await db.query(
    `UPDATE rfq_responses SET selected = TRUE WHERE id = $1`,
    [chosen.id]
  );
  await db.query(
    `UPDATE rfq_jobs SET status = 'confirmed', selected_biz_id = $1 WHERE id = $2`,
    [chosen.business_id || null, jobId]
  );

  // Notify chosen provider
  const callerStr = job.caller_name ? `${job.caller_name} (${job.caller_phone})` : job.caller_phone;
  const catLabel  = (job.category || '').replace(/_/g, ' ');
  const zipStr    = job.zip ? ` in ${job.zip}` : '';

  if (chosen.business_phone) {
    await sendSms(
      chosen.business_phone,
      `LocalIntel Job CONFIRMED — ${catLabel}${zipStr}.\n` +
      `Customer: ${callerStr}.\n` +
      `"${(job.description || '').slice(0, 100)}"\n` +
      `Please contact the customer directly to schedule. Job ID: ${job.code}`
    );
  }
  if (chosen.business_email) {
    const subject = `Job Confirmed — ${catLabel}${zipStr} (${job.code})`;
    const html = `
      <h2 style="font-family:sans-serif">You've been selected for a job!</h2>
      <p style="font-family:sans-serif">
        <strong>${callerStr}</strong> has confirmed you for <strong>${catLabel}${zipStr}</strong>.
      </p>
      <p style="font-family:sans-serif">
        <strong>Details:</strong> ${job.description || 'Contact the customer for details.'}<br>
        <strong>Customer phone:</strong> ${job.caller_phone}<br>
        ${job.caller_email ? `<strong>Customer email:</strong> ${job.caller_email}<br>` : ''}
        <strong>Job ID:</strong> ${job.code}
      </p>
      <p style="font-family:sans-serif">Please reach out to schedule at your earliest convenience.</p>
    `;
    await sendEmail(chosen.business_email, subject, html);
  }

  // Notify caller
  const bizLabel = chosen.business_name || chosen.business_phone || 'the provider';
  await sendSms(
    job.caller_phone,
    `LocalIntel: ${bizLabel} has been confirmed for your ${catLabel} job${zipStr}. ` +
    `They'll reach out to schedule. Job ID: ${job.code}`
  );

  // Alert erik
  const ownerPhone = process.env.OWNER_ALERT_PHONE || '+19045867887';
  await sendSms(
    ownerPhone,
    `[LocalIntel CONFIRMED] ${catLabel}${zipStr} — ${callerStr} → ${bizLabel} — Job ${job.code}`
  ).catch(() => {});

  console.log(`[rfqBroadcast] Job ${job.code} confirmed — ${bizLabel}`);
  return { ok: true, job, chosen };
}

// ── markCallbackFired ─────────────────────────────────────────────────────────
async function markCallbackFired(jobId) {
  await migrate();
  await db.query(`UPDATE rfq_jobs SET callback_fired = TRUE WHERE id = $1`, [jobId]);
}

// ── getJobByCode ──────────────────────────────────────────────────────────────
async function getJobByCode(code) {
  await migrate();
  const rows = await db.query(`SELECT * FROM rfq_jobs WHERE code = $1`, [code.toUpperCase()]);
  return rows[0] || null;
}

// ── getResponses ──────────────────────────────────────────────────────────────
async function getResponses(jobId) {
  await migrate();
  return db.query(
    `SELECT * FROM rfq_responses WHERE job_id = $1 ORDER BY responded_at ASC`,
    [jobId]
  );
}

// ── expireOldJobs — called by background worker ───────────────────────────────
async function expireOldJobs() {
  await migrate();
  const expired = await db.query(
    `UPDATE rfq_jobs SET status = 'expired'
     WHERE status IN ('open','matched') AND expires_at < NOW()
     RETURNING id, code, caller_phone, category`
  );
  for (const j of expired) {
    console.log(`[rfqBroadcast] Job ${j.code} expired — ${j.category}`);
  }
  return expired.length;
}

module.exports = {
  createJob,
  broadcastJob,
  recordResponse,
  confirmSelection,
  markCallbackFired,
  getJobByCode,
  getResponses,
  expireOldJobs,
  sendSms,
  sendEmail,
};
