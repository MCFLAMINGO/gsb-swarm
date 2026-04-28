'use strict';
/**
 * lib/rfqService.js — RFQ / Local Dispatch Service
 *
 * Core service for the LocalIntel RFQ system. Handles posting jobs,
 * collecting quotes, booking, and completion.
 *
 * Two job modes:
 *   delivery  — first-to-accept wins (Uber model), proximity-gated
 *   proposal  — collect quotes, pick winner (Thumbtack model)
 *
 * Three autonomy levels:
 *   full    — agent picks + books automatically
 *   approve — agent ranks, pauses, sends top pick to human for confirmation
 *   human   — agent surfaces all quotes raw, human picks
 *
 * Notifications: Resend email + Web Push (web-push)
 * Proximity: delivery jobs matched by distance from pickup_address lat/lon
 * Payment: v2 (schema supports it, no logic yet)
 */

const db = require('./db');
const { Resend } = require('resend');
let webpush;
try { webpush = require('web-push'); } catch(e) { webpush = null; }

// Lazy-init web-push VAPID details once
let vapidInitialised = false;
function getWebPush() {
  if (!webpush) return null;
  if (!vapidInitialised && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
      process.env.VAPID_EMAIL || 'mailto:erik@mcflamingo.com',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    vapidInitialised = true;
  }
  return vapidInitialised ? webpush : null;
}

// ── Proximity radius from deadline ───────────────────────────────────────────
// Assumes ~15mph average speed in local traffic
function deadlineToRadiusMiles(deadline_minutes) {
  if (!deadline_minutes) return null; // no deadline = ZIP-based, no proximity gate
  if (deadline_minutes <= 15) return 4;
  if (deadline_minutes <= 30) return 8;
  if (deadline_minutes <= 60) return 15;
  return 25;
}

// Build geo URL for maps deep link from address + lat/lon
function buildMapUrl(address, lat, lon) {
  if (!address) return null;
  const enc = encodeURIComponent(address);
  if (lat && lon) return `https://maps.google.com/?q=${lat},${lon}`;
  return `https://maps.google.com/?q=${enc}`;
}

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

  // Ensure has_hours column exists (added for signal strength UI)
  await pool.query(`
    ALTER TABLE businesses
      ADD COLUMN IF NOT EXISTS has_hours BOOLEAN DEFAULT FALSE
  `);

  // Ensure sunbiz_id column exists — stores verified FL Sunbiz document number
  await pool.query(`
    ALTER TABLE businesses
      ADD COLUMN IF NOT EXISTS sunbiz_id TEXT
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

  const limit = job_type === 'delivery' ? 20 : 10;

  // ── Proximity matching for delivery jobs ─────────────────────────────────────
  // For delivery: geocode pickup_address if possible, then filter by radius.
  // Falls back to ZIP-based if no lat/lon available.
  let pickupLat = null, pickupLon = null;
  if (job_type === 'delivery' && pickup_address) {
    // Try to find lat/lon from a business in our DB at that address (best effort)
    const { rows: addrMatch } = await pool.query(
      `SELECT lat, lon FROM businesses WHERE address ILIKE $1 AND lat IS NOT NULL LIMIT 1`,
      [`%${pickup_address.split(',')[0]}%`]
    );
    if (addrMatch[0]) { pickupLat = addrMatch[0].lat; pickupLon = addrMatch[0].lon; }
  }

  const radiusMiles = job_type === 'delivery' ? deadlineToRadiusMiles(deadline_minutes) : null;

  async function queryMatchedBusinesses(radius) {
    if (radius && pickupLat && pickupLon) {
      // Haversine proximity — verified first, then unverified
      const { rows } = await pool.query(
        `SELECT business_id, name, notification_email, dispatch_token, lat, lon,
                (claimed_at IS NOT NULL) AS verified,
                sunbiz_id, sunbiz_doc_number,
                ( 3959 * acos( LEAST(1, cos(radians($1)) * cos(radians(lat))
                  * cos(radians(lon) - radians($2))
                  + sin(radians($1)) * sin(radians(lat)) ) ) ) AS distance_miles
           FROM businesses
          WHERE status != 'inactive'
            AND lat IS NOT NULL AND lon IS NOT NULL
            ${category ? "AND category ILIKE '" + category.replace(/'/g,"''") + "'" : ''}
          HAVING ( 3959 * acos( LEAST(1, cos(radians($1)) * cos(radians(lat))
                  * cos(radians(lon) - radians($2))
                  + sin(radians($1)) * sin(radians(lat)) ) ) ) <= $3
          ORDER BY (claimed_at IS NOT NULL) DESC, distance_miles ASC
          LIMIT $4`,
        [pickupLat, pickupLon, radius, limit]
      );
      return rows;
    }

    // ZIP / category fallback — verified first, then unverified
    const params = [];
    const conditions = ["status != 'inactive'"];
    if (zip)      { params.push(zip);             conditions.push(`zip = $${params.length}`); }
    if (category) { params.push(`%${category}%`); conditions.push(`category ILIKE $${params.length}`); }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT business_id, name, notification_email, dispatch_token, lat, lon,
              (claimed_at IS NOT NULL) AS verified, NULL::numeric AS distance_miles,
              sunbiz_id, sunbiz_doc_number
         FROM businesses
        WHERE ${conditions.join(' AND ')}
        ORDER BY (claimed_at IS NOT NULL) DESC, claimed_at DESC NULLS LAST
        LIMIT $${params.length}`,
      params
    );
    return rows;
  }

  let matched = await queryMatchedBusinesses(radiusMiles);

  // Auto-expand if no matches and we used proximity
  if (matched.length === 0 && radiusMiles && pickupLat && pickupLon) {
    console.log(`[rfqService] no drivers in ${radiusMiles}mi radius — expanding to ${Math.round(radiusMiles * 1.5)}mi`);
    matched = await queryMatchedBusinesses(Math.round(radiusMiles * 1.5));
  }

  const matched_count = matched.length;
  const map_url = buildMapUrl(pickup_address, pickupLat, pickupLon);

  // ── Notify matched businesses ───────────────────────────────────────────────────
  let notified_count = 0;
  const deadlineText = deadline_minutes ? `${deadline_minutes} minutes` : (deadline_iso || 'flexible');
  const budgetText   = budget_usd ? `$${budget_usd}` : 'open';
  const inboxUrl     = `https://www.thelocalintel.com/inbox`;

  const wp = getWebPush();

  const notifyPromises = matched.map(async (biz) => {
    const rfqUrl    = `${inboxUrl}?rfq=${rfq_id}${biz.dispatch_token ? '&token=' + biz.dispatch_token : ''}`;
    const acceptUrl = `https://gsb-swarm-production.up.railway.app/api/local-intel/inbox/respond`;
    const distText  = biz.distance_miles ? ` — ${Number(biz.distance_miles).toFixed(1)} miles away` : '';

    // ─ Email ─────────────────────────────────────────────────────────────────
    if (biz.notification_email && process.env.RESEND_API_KEY) {
      try {
        const resend = getResend();
        const mapLine = map_url ? `\nMap: ${map_url}` : '';
        await resend.emails.send({
          from: 'dispatch@thelocalintel.com',
          to:   biz.notification_email,
          subject: `New ${job_type} request${distText} — ${category || 'general'}`,
          text: [
            'You have a new job request on LocalIntel.',
            '',
            `Category:    ${category || 'general'}`,
            `Description: ${description}`,
            `Budget:      ${budgetText}`,
            `Deadline:    ${deadlineText}`,
            pickup_address  ? `Pickup:      ${pickup_address}`  : '',
            dropoff_address ? `Drop-off:    ${dropoff_address}` : '',
            distText        ? `Distance:    ${distText.replace(' — ', '')}` : '',
            mapLine,
            '',
            `Respond here: ${rfqUrl}`,
            '',
            '— LocalIntel Dispatch',
          ].filter(l => l !== '').join('\n'),
        });
        notified_count++;
      } catch (e) {
        console.error(`[rfqService] email error ${biz.business_id}:`, e.message);
      }
    }

    // ─ Web Push ──────────────────────────────────────────────────────────
    if (wp) {
      try {
        const { rows: subs } = await pool.query(
          `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE business_id = $1`,
          [biz.business_id]
        );
        if (subs.length > 0) {
          const pushPayload = JSON.stringify({
            title:    job_type === 'delivery'
                        ? `🚚 Delivery job${distText}`
                        : `💼 New ${category || 'job'} request`,
            body:     job_type === 'delivery'
                        ? `${description.slice(0, 80)} | $${budget_usd || '?'} | ${deadlineText}`
                        : `${description.slice(0, 100)}`,
            rfq_id,
            job_type,
            map_url:    map_url || null,
            accept_url: acceptUrl,
            inbox_url:  rfqUrl,
          });
          await Promise.all(subs.map(sub =>
            wp.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              pushPayload
            ).catch(e => {
              // 410 = subscription expired, clean it up
              if (e.statusCode === 410) {
                pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [sub.endpoint]).catch(() => {});
              }
            })
          ));
          notified_count++;
        }
      } catch (e) {
        console.error(`[rfqService] push error ${biz.business_id}:`, e.message);
      }
    }
  });

  await Promise.all(notifyPromises);

  const verified_count   = matched.filter(b => b.verified).length;
  const unverified_count = matched_count - verified_count;
  const warning = matched_count === 0 ? 'No businesses matched — RFQ is open but no notifications sent' : null;

  // ── RFQ gap signal — log to rfq_gaps for self-improvement ───────────────────
  if (matched_count < limit) {
    pool.query(`
      CREATE TABLE IF NOT EXISTS rfq_gaps (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        category     TEXT,
        zip          TEXT,
        job_type     TEXT,
        requested    INT,
        matched      INT,
        verified     INT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).then(() => pool.query(
      `INSERT INTO rfq_gaps (category, zip, job_type, requested, matched, verified)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [category || null, zip || null, job_type, limit, matched_count, verified_count]
    )).catch(e => console.warn('[rfqService] gap log error:', e.message));

    // Kick enrichment worker for this category+zip if gap is significant
    if (matched_count < Math.floor(limit / 2)) {
      setImmediate(() => {
        try {
          const { triggerEnrichment } = require('./enrichmentTrigger');
          triggerEnrichment({ category, zip, reason: 'rfq_gap', requested: limit, matched: matched_count });
        } catch(e) { /* enrichmentTrigger is best-effort */ }
      });
    }
  }

  console.log(`[rfqService] createRfq rfq_id=${rfq_id} matched=${matched_count} (${verified_count} verified, ${unverified_count} unverified) notified=${notified_count} autonomy=${autonomy} job_type=${job_type}${warning ? ' WARN:'+warning : ''}`);

  return {
    rfq_id, matched_count, notified_count,
    verified_count, unverified_count,
    map_url: map_url || null,
    ...(warning ? { warning } : {}),
  };
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
    `SELECT * FROM rfq_requests WHERE id = $1::uuid`,
    [rfq_id]
  );

  if (!rfq) return { error: 'RFQ not found', rfq_id };

  const { rows: responses } = await pool.query(
    `SELECT r.*,
            (b.claimed_at IS NOT NULL)                    AS verified,
            COALESCE(b.sunbiz_id, b.sunbiz_doc_number)   AS sunbiz_id,
            (b.sunbiz_id IS NOT NULL
             OR b.sunbiz_doc_number IS NOT NULL)          AS sunbiz_verified
       FROM rfq_responses r
       LEFT JOIN businesses b ON b.business_id = r.business_id
      WHERE r.rfq_id = $1::uuid
      ORDER BY r.created_at ASC`,  /* first come first served */
    [rfq_id]
  );

  const { rows: [booking] } = await pool.query(
    `SELECT * FROM rfq_bookings WHERE rfq_id = $1::uuid LIMIT 1`,
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
    `SELECT * FROM rfq_responses WHERE id = $1::uuid AND rfq_id = $2::uuid`,
    [response_id, rfq_id]
  );

  if (!response) throw new Error(`Response ${response_id} not found for RFQ ${rfq_id}`);

  // Check for existing booking
  const { rows: [existing] } = await pool.query(
    `SELECT id FROM rfq_bookings WHERE rfq_id = $1::uuid LIMIT 1`,
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

  // Mark ONLY the booked response as accepted — others stay pending (ranked queue)
  // They become fallback options if client declines. Declined on completeBooking.
  await pool.query(
    `UPDATE rfq_responses SET status = 'accepted' WHERE id = $1::uuid`,
    [response_id]
  );

  // Mark RFQ as booked
  await pool.query(
    `UPDATE rfq_requests SET status = 'booked' WHERE id = $1::uuid`,
    [rfq_id]
  );

  console.log(`[rfqService] bookRfq rfq_id=${rfq_id} booking_id=${booking.id} business_id=${response.business_id}`);

  // Return next_in_queue so agent knows fallback options
  const { rows: queue } = await pool.query(
    `SELECT id, business_id, business_name, quote_usd, eta_minutes, created_at
       FROM rfq_responses
      WHERE rfq_id = $1::uuid AND status = 'pending'
      ORDER BY created_at ASC`,
    [rfq_id]
  );

  return { booking_id: booking.id, next_in_queue: queue };
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
    `SELECT * FROM rfq_bookings WHERE id = $1::uuid`,
    [booking_id]
  );

  if (!booking) throw new Error(`Booking ${booking_id} not found`);

  await pool.query(
    `UPDATE rfq_bookings
        SET status = 'complete', completed_at = NOW(),
            booker_note = COALESCE($2, booker_note)
      WHERE id = $1::uuid`,
    [booking_id, completion_note || null]
  );

  // Mark RFQ as complete
  await pool.query(
    `UPDATE rfq_requests SET status = 'complete' WHERE id = $1::uuid`,
    [booking.rfq_id]
  );

  // Now decline all remaining pending responses — job is filled
  await pool.query(
    `UPDATE rfq_responses SET status = 'declined'
      WHERE rfq_id = $1::uuid AND status = 'pending'`,
    [booking.rfq_id]
  );

  console.log(`[rfqService] completeBooking booking_id=${booking_id}`);
  return { ok: true };
}

// ── declineResponse — decline a specific response, return next in queue ───────
async function declineResponse(rfq_id, response_id, reason) {
  await migrate();
  const pool = db.getPool();

  // Mark this response declined
  await pool.query(
    `UPDATE rfq_responses SET status = 'declined' WHERE id = $1::uuid AND rfq_id = $2::uuid`,
    [response_id, rfq_id]
  );

  // If there was a booking for this response, cancel it and reopen RFQ
  const { rows: [booking] } = await pool.query(
    `SELECT id FROM rfq_bookings WHERE rfq_id = $1::uuid AND response_id = $2::uuid LIMIT 1`,
    [rfq_id, response_id]
  );
  if (booking) {
    await pool.query(`DELETE FROM rfq_bookings WHERE id = $1::uuid`, [booking.id]);
    await pool.query(`UPDATE rfq_requests SET status = 'open' WHERE id = $1::uuid`, [rfq_id]);
  }

  // Return next pending response (ranked by created_at = first come first served)
  const { rows: queue } = await pool.query(
    `SELECT id, business_id, business_name, quote_usd, eta_minutes, created_at
       FROM rfq_responses
      WHERE rfq_id = $1::uuid AND status = 'pending'
      ORDER BY created_at ASC`,
    [rfq_id]
  );

  const next = queue[0] || null;
  console.log(`[rfqService] declineResponse rfq_id=${rfq_id} response_id=${response_id} next=${next?.business_name || 'none'}`);
  return { declined: response_id, next_response: next, remaining_queue: queue.length, reason: reason || null };
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
    `SELECT * FROM rfq_requests WHERE id = $1::uuid`,
    [rfq_id]
  );

  if (!rfq) throw new Error(`RFQ ${rfq_id} not found`);
  if (rfq.status !== 'open') throw new Error(`RFQ ${rfq_id} is not open (status: ${rfq.status})`);

  // Load business name + sunbiz identifiers
  const { rows: [biz] } = await pool.query(
    `SELECT name, sunbiz_id, sunbiz_doc_number FROM businesses WHERE business_id = $1`,
    [business_id]
  );
  const business_name = biz ? biz.name : null;
  const sunbiz_id     = biz ? (biz.sunbiz_id || biz.sunbiz_doc_number || null) : null;

  // Insert response
  const { rows: [response] } = await pool.query(
    `INSERT INTO rfq_responses
       (rfq_id, business_id, business_name, quote_usd, message, eta_minutes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [rfq_id, business_id, business_name, quote_usd || null, message || null, eta_minutes || null]
  );
  // Attach sunbiz to response object for caller convenience
  response.sunbiz_id       = sunbiz_id;
  response.sunbiz_verified = !!sunbiz_id;

  const response_id = response.id;

  console.log(`[rfqService] submitResponse rfq_id=${rfq_id} response_id=${response_id} business_id=${business_id}`);

  // ── Auto-book: delivery + full autonomy ──────────────────────────────────
  if (rfq.job_type === 'delivery' && rfq.autonomy === 'full') {
    const { rows: [existingBooking] } = await pool.query(
      `SELECT id FROM rfq_bookings WHERE rfq_id = $1::uuid LIMIT 1`,
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
  declineResponse,
  completeBooking,
  submitResponse,
  getOpenRfqs,
};

