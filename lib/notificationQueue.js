/**
 * lib/notificationQueue.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Enqueue and deliver intelligence notifications to claimed businesses.
 * No third-party providers. Channels: sms, email, push, web.
 *
 * SMS  → email-to-SMS carrier gateways (free, no API key)
 * Email → Node.js nodemailer via SMTP (Railway env: SMTP_HOST etc.)
 * Push  → Web Push API (VAPID keys in Railway env)
 * Web   → stored in notification_queue, polled by dashboard
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';
const db = require('./db');

// ─── ENQUEUE ─────────────────────────────────────────────────────────────────
/**
 * enqueue(business_id, subject, payload, channels)
 * Creates one notification_queue row per channel the business subscribed to.
 * Called by oracle query handler and pipeline events.
 */
async function enqueue(business_id, subject, payload, channels = ['web']) {
  if (!business_id) return;
  const rows = [];
  for (const channel of channels) {
    const [row] = await db.query(
      `INSERT INTO notification_queue (business_id, channel, subject, payload)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [business_id, channel, subject, JSON.stringify(payload)]
    );
    if (row) rows.push(row.id);
  }
  return rows;
}

/**
 * enqueueForZipCategory(zip, category_group, subject, payload)
 * Enqueues for ALL claimed businesses in a ZIP+category.
 * Called when an oracle query touches a ZIP a business has claimed.
 */
async function enqueueForZipCategory(zip, category_group, subject, payload) {
  // Find all claimed businesses in this ZIP + category group
  const claimed = await db.query(
    `SELECT business_id, notify_sms, notify_email, notify_push, notify_web
     FROM businesses
     WHERE zip = $1
       AND category_group = $2
       AND claimed_at IS NOT NULL
       AND status = 'active'`,
    [zip, category_group]
  );
  if (claimed.length === 0) return 0;

  let queued = 0;
  for (const biz of claimed) {
    const channels = [];
    if (biz.notify_sms)   channels.push('sms');
    if (biz.notify_email) channels.push('email');
    if (biz.notify_push)  channels.push('push');
    if (biz.notify_web)   channels.push('web');
    if (channels.length === 0) channels.push('web'); // always at least web
    await enqueue(biz.business_id, subject, payload, channels);
    queued++;
  }
  return queued;
}

// ─── DELIVER: SMS via carrier email gateway ──────────────────────────────────
async function deliverSms(notification) {
  const nodemailer = require('nodemailer');
  const biz = await db.query(
    `SELECT notification_phone, name FROM businesses WHERE business_id = $1`,
    [notification.business_id]
  );
  if (!biz[0]?.notification_phone) throw new Error('no phone on file');

  const phone   = biz[0].notification_phone.replace(/\D/g, '');
  const carrier = notification.payload?.carrier || 'verizon'; // default; business sets this at claim time
  const gateway = await db.query(
    `SELECT gateway FROM carrier_sms_gateways WHERE carrier = $1`,
    [carrier]
  );
  if (!gateway[0]) throw new Error(`unknown carrier: ${carrier}`);

  const to = `${phone}@${gateway[0].gateway}`;
  const text = `LocalIntel: ${notification.subject}\n${notification.payload?.body || ''}`.slice(0, 160);

  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  await transporter.sendMail({
    from:    process.env.SMTP_FROM || 'noreply@thelocalintel.com',
    to,
    subject: '',
    text,
  });
}

// ─── DELIVER: Email ──────────────────────────────────────────────────────────
async function deliverEmail(notification) {
  const nodemailer = require('nodemailer');
  const biz = await db.query(
    `SELECT notification_email, name FROM businesses WHERE business_id = $1`,
    [notification.business_id]
  );
  if (!biz[0]?.notification_email) throw new Error('no email on file');

  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const p = notification.payload || {};
  await transporter.sendMail({
    from:    `LocalIntel <${process.env.SMTP_FROM || 'intel@thelocalintel.com'}>`,
    to:      biz[0].notification_email,
    subject: notification.subject || 'LocalIntel Update',
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
        <div style="font-size:18px;font-weight:700;color:#111827;margin-bottom:8px">
          ${notification.subject}
        </div>
        <div style="color:#374151;line-height:1.6">${p.body || ''}</div>
        ${p.cta_url ? `
          <a href="${p.cta_url}" style="display:inline-block;margin-top:20px;padding:10px 20px;
             background:#16A34A;color:white;border-radius:8px;font-weight:600;text-decoration:none">
            ${p.cta_label || 'View Details'}
          </a>` : ''}
        <div style="margin-top:32px;font-size:12px;color:#9CA3AF">
          LocalIntel · <a href="https://thelocalintel.com/unsubscribe?id=${notification.business_id}" style="color:#9CA3AF">unsubscribe</a>
        </div>
      </div>`,
  });
}

// ─── DELIVER: Web Push ───────────────────────────────────────────────────────
async function deliverPush(notification) {
  // Requires: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL in Railway env
  // Push subscription stored in businesses.push_subscription (add when needed)
  // For now store as web and upgrade when VAPID keys are configured
  if (!process.env.VAPID_PRIVATE_KEY) {
    throw new Error('VAPID keys not configured — falling back to web');
  }
  const webpush = require('web-push');
  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL || 'intel@thelocalintel.com'}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  const biz = await db.query(
    `SELECT push_subscription FROM businesses WHERE business_id = $1`,
    [notification.business_id]
  );
  if (!biz[0]?.push_subscription) throw new Error('no push subscription');
  await webpush.sendNotification(
    JSON.parse(biz[0].push_subscription),
    JSON.stringify({ title: notification.subject, body: notification.payload?.body })
  );
}

// ─── DELIVER: Web (in-app polling) ───────────────────────────────────────────
// Web notifications are already stored in notification_queue.
// The dashboard polls GET /claim/notifications?business_id=...
// Nothing to "deliver" — just mark as sent (it sits in queue for dashboard).
async function deliverWeb(notification) {
  // No-op — already in DB, dashboard reads it via API
  return true;
}

// ─── WORKER: process pending queue ───────────────────────────────────────────
const DELIVER_FN = { sms: deliverSms, email: deliverEmail, push: deliverPush, web: deliverWeb };
const MAX_ATTEMPTS = 3;

async function processQueue(limit = 50) {
  const pending = await db.query(
    `SELECT * FROM notification_queue
     WHERE status = 'pending'
       AND attempts < $1
     ORDER BY created_at ASC
     LIMIT $2
     FOR UPDATE SKIP LOCKED`,
    [MAX_ATTEMPTS, limit]
  );
  if (pending.length === 0) return { processed: 0, sent: 0, failed: 0 };

  let sent = 0, failed = 0;
  for (const notif of pending) {
    // Mark in-flight
    await db.query(
      `UPDATE notification_queue SET attempts = attempts + 1, last_attempt_at = NOW() WHERE id = $1`,
      [notif.id]
    );
    try {
      const fn = DELIVER_FN[notif.channel];
      if (!fn) throw new Error(`unknown channel: ${notif.channel}`);
      await fn(notif);
      await db.query(
        `UPDATE notification_queue SET status = 'sent', sent_at = NOW() WHERE id = $1`,
        [notif.id]
      );
      sent++;
    } catch (err) {
      const isFinal = notif.attempts + 1 >= MAX_ATTEMPTS;
      await db.query(
        `UPDATE notification_queue SET status = $1, error_msg = $2 WHERE id = $3`,
        [isFinal ? 'failed' : 'pending', err.message, notif.id]
      );
      failed++;
    }
  }

  console.log(`[notify] processed ${pending.length} | sent ${sent} | failed ${failed}`);
  return { processed: pending.length, sent, failed };
}

module.exports = { enqueue, enqueueForZipCategory, processQueue };
