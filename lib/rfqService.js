'use strict';
/**
 * lib/rfqService.js — RFQ / Local Dispatch Service
 *
 * Core service for the LocalIntel RFQ system. Handles posting jobs,
 * collecting quotes, booking, and completion.
 *
 * Two job modes:
 *   delivery  — first-to-accept wins (Uber model)
 *   proposal  — collect quotes, pick winner (Thumbtack model)
 *
 * Three autonomy levels:
 *   full    — agent picks + books automatically
 *   approve — agent ranks, pauses, sends top pick to human for confirmation
 *   human   — agent surfaces all quotes raw, human picks
 *
 * Payment: v2 (schema supports it, no logic yet)
 * Notifications: Resend email
 */

const db = require('./db');
const { Resend } = require('resend');

// ── Migration guard ───────────────────────────────────────────────────────────
let migrated = false;

async function migrate() {
  if (migrated) return;
  const pool = db.getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rfq_requests (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      job_type        TEXT NOT NULL DEFAULT 'proposal',
      category        TEXT,
      zip             TEXT,
      description     TEXT NOT NULL,
      pickup_address  TEXT,
      dropoff_address TEXT,
      budget_usd      NUMERIC(10,2),
      deadline_minutes INT,
      deadline_at     TIMESTAMPTZ,
      autonomy        TEXT NOT NULL DEFAULT 'human',
      notify_email    TEXT,
      caller_key      TEXT,
      status          TEXT NOT NULL DEFAULT 'open',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rfq_responses (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      rfq_id          UUID NOT NULL REFERENCES rfq_requests(id),
      business_id     TEXT NOT NULL,
      business_name   TEXT,
      quote_usd       NUMERIC(10,2),
      message         TEXT,
      eta_minutes     INT,
      status          TEXT NOT NULL DEFAULT 'pending',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rfq_bookings (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      rfq_id          UUID NOT NULL REFERENCES rfq_requests(id),
      response_id     UUID REFERENCES rfq_responses(id),
      business_id     TEXT NOT NULL,
      business_name   TEXT,
      booker_note     TEXT,
      escrow_tx       TEXT,
      fee_usd         NUMERIC(10,2),
      status          TEXT NOT NULL DEFAULT 'confirmed',
      confirmed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at    TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS rfq_requests_zip_cat
      ON rfq_requests(zip, category, status)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS rfq_responses_rfq_id
      ON rfq_responses(rfq_id)
  `);

  // Ensure businesses table has the dispatch-token column used for inbox auth
  await pool.query(`
    ALTER TABLE businesses
      ADD COLUMN IF NOT EXISTS dispatch_token TEXT
  `);

  migrated = true;
}

// ── Resend helper ─────────────────────────────────────────────────────────────
function getResend() {
  return new Resend(process.env.RESEND_API_KEY);
}

// ── createRfq ─────────────────────────────────────────────────────────────────
/**
 * Post a new RFQ. Called by local_intel_rfq MCP tool.
 * Returns { rfq_id, matched_count, notified_count }
 */
async function createRfq({
  job_type = 'proposal',
  category,
  zip,
  description,
  pickup_address,
  dropoff_address,
  budget_usd,
  deadline_minutes,
  deadline_iso,
  autonomy = 'human',
  notify_email,
  caller_key,
}) {
  await migrate();
  const pool = db.getPool();

  if (!description) throw new Error('description is required');

  // Compute deadline_at from deadline_minutes or deadline_iso
  let deadline_at = null;
  if (deadline_minutes) {
    deadline_at = new Date(Date.now() + deadline_minutes * 60 * 1000).toISOString();
  } else if (deadline_iso) {
    deadline_at = deadline_iso;
  }

  // Insert the RFQ
  const { rows: [rfq] } = await pool.query(
    `INSERT INTO rfq_requests
       (job_type, category, zip, description,
        pickup_address, dropoff_address,
        budget_usd, deadline_minutes, deadline_at,
        autonomy, notify_email, caller_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [
      job_type, category || null, zip || null, description,
      pickup_address || null, dropoff_address || null,
      budget_usd || null, deadline_minutes || null, deadline_at,
      autonomy, notify_email || null, caller_key || null,
    ]
  );

  const rfq_id = rfq.id;

  // Find matching businesses
  const limit = job_type === 'delivery' ? 20 : 10;

  let matchQuery;
  let matchParams;

  if (zip && category) {
    matchQuery = `
      SELECT business_id, name, notification_email
        FROM businesses
       WHERE zip = $1
         AND category ILIKE $2
         AND status != 'inactive'
       LIMIT $3
    `;
    matchParams = [zip, `%${category}%`, limit];
  } else if (zip) {
    matchQuery = `
      SELECT business_id, name, notification_email
        FROM businesses
       WHERE zip = $1
         AND status != 'inactive'
       LIMIT $2
    `;
    matchParams = [zip, limit];
  } else if (category) {
    matchQuery = `
      SELECT business_id, name, notification_email
        FROM businesses
       WHERE category ILIKE $1
         AND status != 'inactive'
       LIMIT $2
    `;
    matchParams = [`%${category}%`, limit];
  } else {
    matchQuery = `
      SELECT business_id, name, notification_email
        FROM businesses
       WHERE status != 'inactive'
       LIMIT $1
    `;
    matchParams = [limit];
  }

  const { rows: matched } = await pool.query(matchQuery, matchParams);
  const matched_count = matched.length;

  // Send email notifications to matched businesses
  let notified_count = 0;

  if (matched_count > 0 && process.env.RESEND_API_KEY) {
    const resend = getResend();

    const deadlineText = deadline_minutes
      ? `${deadline_minutes} minutes`
      : (deadline_iso || 'flexible');

    const budgetText = budget_usd ? `$${budget_usd}` : 'open';

    const emailPromises = matched
      .filter(biz => biz.notification_email)
      .map(async (biz) => {
        try {
          await resend.emails.send({
            from: 'dispatch@thelocalintel.com',
            to: biz.notification_email,
            subject: `New ${job_type} request in ${zip || 'your area'} — ${category || 'general'}`,
            text: [
              'You have a new job request on LocalIntel.',
              '',
              `Category: ${category || 'general'}`,
              `Description: ${description}`,
              `Budget: ${budgetText}`,
              `Deadline: ${deadlineText}`,
              '',
              `To respond: https://www.thelocalintel.com/inbox?rfq=${rfq_id}`,
              '(Use your claim token to log in)',
              '',
              '— LocalIntel Dispatch',
            ].join('\n'),
          });
          notified_count++;
        } catch (emailErr) {
          console.error(`[rfqService] email error for ${biz.business_id}:`, emailErr.message);
        }
      });

    await Promise.all(emailPromises);
  }

  console.log(`[rfqService] createRfq rfq_id=${rfq_id} matched=${matched_count} notified=${notified_count} autonomy=${autonomy} job_type=${job_type}`);

  return { rfq_id, matched_count, notified_count };
}

// ── getRfqStatus ──────────────────────────────────────────────────────────────
/**
 * Get the status of an RFQ + all responses + booking if exists.
 * Returns { rfq, responses, booking }
 */
async function getRfqStatus(rfq_id) {
  await migrate();
  const pool = db.getPool();

  const { rows: [rfq] } = await pool.query(
    `SELECT * FROM rfq_requests WHERE id = $1`,
    [rfq_id]
  );

  if (!rfq) return { error: 'RFQ not found', rfq_id };

  const { rows: responses } = await pool.query(
    `SELECT * FROM rfq_responses WHERE rfq_id = $1 ORDER BY quote_usd ASC NULLS LAST, created_at ASC`,
    [rfq_id]
  );

  const { rows: [booking] } = await pool.query(
    `SELECT * FROM rfq_bookings WHERE rfq_id = $1 LIMIT 1`,
    [rfq_id]
  );

  return { rfq, responses, booking: booking || null };
}

// ── bookRfq ───────────────────────────────────────────────────────────────────
/**
 * Book a specific response — confirms the job with that business.
 * Returns { booking_id }
 */
async function bookRfq(rfq_id, response_id, booker_note) {
  await migrate();
  const pool = db.getPool();

  // Load the response
  const { rows: [response] } = await pool.query(
    `SELECT * FROM rfq_responses WHERE id = $1 AND rfq_id = $2`,
    [response_id, rfq_id]
  );

  if (!response) throw new Error(`Response ${response_id} not found for RFQ ${rfq_id}`);

  // Check for existing booking
  const { rows: [existing] } = await pool.query(
    `SELECT id FROM rfq_bookings WHERE rfq_id = $1 LIMIT 1`,
    [rfq_id]
  );

  if (existing) {
    return { booking_id: existing.id, already_booked: true };
  }

  // Create booking
  const { rows: [booking] } = await pool.query(
    `INSERT INTO rfq_bookings
       (rfq_id, response_id, business_id, business_name, booker_note)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [rfq_id, response_id, response.business_id, response.business_name || null, booker_note || null]
  );

  // Mark response as accepted, others as declined
  await pool.query(
    `UPDATE rfq_responses SET status = 'accepted' WHERE id = $1`,
    [response_id]
  );
  await pool.query(
    `UPDATE rfq_responses SET status = 'declined' WHERE rfq_id = $1 AND id != $2`,
    [rfq_id, response_id]
  );

  // Mark RFQ as booked
  await pool.query(
    `UPDATE rfq_requests SET status = 'booked' WHERE id = $1`,
    [rfq_id]
  );

  console.log(`[rfqService] bookRfq rfq_id=${rfq_id} booking_id=${booking.id} business_id=${response.business_id}`);

  return { booking_id: booking.id };
}

// ── completeBooking ───────────────────────────────────────────────────────────
/**
 * Mark a booking as complete. Escrow release is v2.
 * Returns { ok: true }
 */
async function completeBooking(booking_id, completion_note) {
  await migrate();
  const pool = db.getPool();

  const { rows: [booking] } = await pool.query(
    `SELECT * FROM rfq_bookings WHERE id = $1`,
    [booking_id]
  );

  if (!booking) throw new Error(`Booking ${booking_id} not found`);

  await pool.query(
    `UPDATE rfq_bookings
        SET status = 'complete', completed_at = NOW(),
            booker_note = COALESCE($2, booker_note)
      WHERE id = $1`,
    [booking_id, completion_note || null]
  );

  // Mark RFQ as complete
  await pool.query(
    `UPDATE rfq_requests SET status = 'complete' WHERE id = $1`,
    [booking.rfq_id]
  );

  console.log(`[rfqService] completeBooking booking_id=${booking_id}`);

  return { ok: true };
}

// ── submitResponse ────────────────────────────────────────────────────────────
/**
 * Submit a response from a business. Called by the inbox API.
 * Handles auto-book for delivery+full and approve-mode notifications.
 * Returns { response_id }
 */
async function submitResponse(rfq_id, business_id, { quote_usd, message, eta_minutes }) {
  await migrate();
  const pool = db.getPool();

  // Load the RFQ
  const { rows: [rfq] } = await pool.query(
    `SELECT * FROM rfq_requests WHERE id = $1`,
    [rfq_id]
  );

  if (!rfq) throw new Error(`RFQ ${rfq_id} not found`);
  if (rfq.status !== 'open') throw new Error(`RFQ ${rfq_id} is not open (status: ${rfq.status})`);

  // Load business name
  const { rows: [biz] } = await pool.query(
    `SELECT name FROM businesses WHERE business_id = $1`,
    [business_id]
  );
  const business_name = biz ? biz.name : null;

  // Insert response
  const { rows: [response] } = await pool.query(
    `INSERT INTO rfq_responses
       (rfq_id, business_id, business_name, quote_usd, message, eta_minutes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [rfq_id, business_id, business_name, quote_usd || null, message || null, eta_minutes || null]
  );

  const response_id = response.id;

  console.log(`[rfqService] submitResponse rfq_id=${rfq_id} response_id=${response_id} business_id=${business_id}`);

  // ── Auto-book: delivery + full autonomy ──────────────────────────────────
  if (rfq.job_type === 'delivery' && rfq.autonomy === 'full') {
    const { rows: [existingBooking] } = await pool.query(
      `SELECT id FROM rfq_bookings WHERE rfq_id = $1 LIMIT 1`,
      [rfq_id]
    );

    if (!existingBooking) {
      try {
        await bookRfq(rfq_id, response_id, 'auto-booked: delivery + full autonomy');
      } catch (bookErr) {
        console.error(`[rfqService] auto-book failed rfq_id=${rfq_id}:`, bookErr.message);
      }
    }
  }

  // ── Approve mode: notify human with top quote ─────────────────────────────
  if (rfq.autonomy === 'approve' && rfq.notify_email && process.env.RESEND_API_KEY) {
    // Only notify on first response or when a better quote comes in
    // For simplicity: notify on every response (human can ignore extras)
    const resend = getResend();
    const quoteText = quote_usd ? `$${quote_usd}` : 'open quote';
    const etaText   = eta_minutes ? `${eta_minutes}min` : 'ETA not specified';

    try {
      await resend.emails.send({
        from: 'dispatch@thelocalintel.com',
        to: rfq.notify_email,
        subject: `New response on your RFQ — ${business_name || business_id}`,
        text: [
          `Agent recommends: ${business_name || business_id} — ${quoteText}, ETA ${etaText}`,
          '',
          `Confirm: https://www.thelocalintel.com/inbox?rfq=${rfq_id}&action=approve&response=${response_id}`,
          `Decline: https://www.thelocalintel.com/inbox?rfq=${rfq_id}`,
          '',
          '— LocalIntel Dispatch',
        ].join('\n'),
      });
    } catch (emailErr) {
      console.error(`[rfqService] approve-notify email error rfq_id=${rfq_id}:`, emailErr.message);
    }
  }

  return { response_id };
}

// ── getOpenRfqs ───────────────────────────────────────────────────────────────
/**
 * Get open RFQs for a ZIP + category combination (business inbox).
 * Returns array of open rfq_requests.
 */
async function getOpenRfqs(zip, category) {
  await migrate();
  const pool = db.getPool();

  let rows;

  if (zip && category) {
    ({ rows } = await pool.query(
      `SELECT * FROM rfq_requests
        WHERE status = 'open'
          AND zip = $1
          AND category ILIKE $2
        ORDER BY created_at DESC
        LIMIT 50`,
      [zip, `%${category}%`]
    ));
  } else if (zip) {
    ({ rows } = await pool.query(
      `SELECT * FROM rfq_requests
        WHERE status = 'open'
          AND zip = $1
        ORDER BY created_at DESC
        LIMIT 50`,
      [zip]
    ));
  } else if (category) {
    ({ rows } = await pool.query(
      `SELECT * FROM rfq_requests
        WHERE status = 'open'
          AND category ILIKE $1
        ORDER BY created_at DESC
        LIMIT 50`,
      [`%${category}%`]
    ));
  } else {
    ({ rows } = await pool.query(
      `SELECT * FROM rfq_requests
        WHERE status = 'open'
        ORDER BY created_at DESC
        LIMIT 50`
    ));
  }

  return rows;
}

module.exports = {
  migrate,
  createRfq,
  getRfqStatus,
  bookRfq,
  completeBooking,
  submitResponse,
  getOpenRfqs,
};
