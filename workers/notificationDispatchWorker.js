// notificationDispatchWorker.js
// Drains the notification_queue table — sends email via Resend.
//
// FREE TIER MODEL:
//   - Resend free plan = 3,000 emails/month total across the platform.
//   - Each business gets FREE_EMAIL_MONTHLY_CAP emails/month at no charge.
//   - Beyond that cap the business must have a wallet (claimed + wallet IS NOT NULL)
//     to continue receiving notifications. If no wallet, queue entry is marked
//     'blocked_no_wallet' and the business sees a dashboard prompt to add one.
//   - SMS: always wallet-gated (Twilio costs money on every send).
//   - When a paid email is sent, a usage_ledger row is written so the business
//     can see their consumption and we can eventually charge from their wallet.
//
// RUNS: called from index.js on a setInterval every 30s (non-blocking).
// IDEMPOTENT: only processes 'pending' rows, marks each sent/failed before moving on.
// SAFE TO REDEPLOY: in-flight sends just retry on next cycle (attempts counter guards loops).

'use strict';

const db = require('../lib/db');

const FREE_EMAIL_MONTHLY_CAP = 50; // emails/month free per business
const MAX_ATTEMPTS = 3;            // give up after 3 failures
const BATCH_SIZE   = 20;           // process up to 20 per cycle

let _resend = null;
function getResend() {
  if (!_resend) {
    if (!process.env.RESEND_API_KEY) return null;
    const { Resend } = require('resend');
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}

// How many emails this business has received this calendar month
async function monthlyEmailCount(businessId) {
  const rows = await db.query(`
    SELECT COUNT(*) AS n FROM notification_queue
    WHERE business_id = $1
      AND channel = 'email'
      AND status = 'sent'
      AND sent_at >= date_trunc('month', NOW())
  `, [businessId]);
  return parseInt(rows[0]?.n || '0', 10);
}

// Write a usage_ledger row so the business can see billable notification usage
async function recordUsage(businessId, channel, subjectSnippet) {
  try {
    await db.query(`
      INSERT INTO usage_ledger
        (id, agent_token, tool_name, zip, cost_path_usd, called_at, query_type, credits_charged, ts)
      VALUES
        (gen_random_uuid(), $1, 'notification_dispatch', NULL, 0.001, NOW(), $2, 0.001, NOW())
    `, [businessId, `${channel}:${subjectSnippet.slice(0, 60)}`]);
  } catch (_) { /* non-fatal */ }
}

async function sendEmail(entry, biz) {
  const resend = getResend();
  if (!resend) {
    console.warn('[notifyDispatch] RESEND_API_KEY not set — skipping email');
    return { ok: false, error: 'RESEND_API_KEY not configured' };
  }

  const payload = typeof entry.payload === 'string' ? JSON.parse(entry.payload) : entry.payload;

  // Determine recipient:
  // - If payload.to is set (customer notification from intake respond), use that
  // - Otherwise use business notification_email
  const to = payload.to || biz.notification_email;
  if (!to) return { ok: false, error: 'no recipient email' };

  const html = payload.html || `<pre>${JSON.stringify(payload, null, 2)}</pre>`;

  try {
    const result = await resend.emails.send({
      from: 'LocalIntel <notifications@thelocalintel.com>',
      to,
      subject: entry.subject || 'LocalIntel notification',
      html,
    });
    return { ok: true, messageId: result?.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function dispatch() {
  // Grab a batch of pending entries
  const rows = await db.query(`
    SELECT q.id, q.business_id, q.channel, q.subject, q.payload, q.attempts,
           b.notification_email, b.notification_phone, b.wallet,
           b.notify_email, b.notify_sms, b.name AS biz_name
    FROM notification_queue q
    JOIN businesses b ON b.business_id = q.business_id
    WHERE q.status = 'pending'
      AND q.attempts < $1
    ORDER BY q.created_at
    LIMIT $2
  `, [MAX_ATTEMPTS, BATCH_SIZE]);

  if (!rows.length) return;

  console.log(`[notifyDispatch] Processing ${rows.length} pending notification(s)`);

  for (const entry of rows) {
    // Mark in-flight immediately to prevent double-send on concurrent cycles
    await db.query(
      `UPDATE notification_queue SET attempts = attempts + 1, last_attempt_at = NOW() WHERE id = $1`,
      [entry.id]
    );

    try {
      if (entry.channel === 'email') {
        // Free tier check — count this month's emails for this business
        const monthCount = await monthlyEmailCount(entry.business_id);
        const overFree   = monthCount >= FREE_EMAIL_MONTHLY_CAP;

        if (overFree && !entry.wallet) {
          // No wallet + over free cap — block and prompt business to add wallet
          await db.query(
            `UPDATE notification_queue SET status = 'blocked_no_wallet', error_msg = $1 WHERE id = $2`,
            [`Over ${FREE_EMAIL_MONTHLY_CAP} free emails/month — add a wallet to continue`, entry.id]
          );
          console.log(`[notifyDispatch] ${entry.biz_name} over free cap (${monthCount}) — no wallet, blocked`);
          continue;
        }

        const result = await sendEmail(entry, entry);
        if (result.ok) {
          await db.query(
            `UPDATE notification_queue SET status = 'sent', sent_at = NOW() WHERE id = $1`,
            [entry.id]
          );
          // Log billable usage if over free tier
          if (overFree) await recordUsage(entry.business_id, 'email', entry.subject || '');
          console.log(`[notifyDispatch] ✓ email sent to ${entry.biz_name} (${entry.id})`);
        } else {
          const finalFail = entry.attempts + 1 >= MAX_ATTEMPTS;
          await db.query(
            `UPDATE notification_queue SET status = $1, error_msg = $2 WHERE id = $3`,
            [finalFail ? 'failed' : 'pending', result.error, entry.id]
          );
          console.warn(`[notifyDispatch] ✗ email failed for ${entry.biz_name}: ${result.error}`);
        }

      } else if (entry.channel === 'sms') {
        // SMS is always wallet-gated — Twilio costs money
        if (!entry.wallet) {
          await db.query(
            `UPDATE notification_queue SET status = 'blocked_no_wallet', error_msg = 'SMS requires a wallet — add one in your LocalIntel dashboard' WHERE id = $1`,
            [entry.id]
          );
          console.log(`[notifyDispatch] ${entry.biz_name} SMS blocked — no wallet`);
          continue;
        }
        // SMS send via Twilio would go here — skipped until Twilio credentials wired per-business
        await db.query(
          `UPDATE notification_queue SET status = 'pending_twilio', error_msg = 'Twilio per-business credentials not yet wired' WHERE id = $1`,
          [entry.id]
        );

      } else if (entry.channel === 'push') {
        // Push not yet implemented — mark and move on
        await db.query(
          `UPDATE notification_queue SET status = 'failed', error_msg = 'push not implemented' WHERE id = $1`,
          [entry.id]
        );
      } else {
        await db.query(
          `UPDATE notification_queue SET status = 'failed', error_msg = $1 WHERE id = $2`,
          [`unknown channel: ${entry.channel}`, entry.id]
        );
      }

    } catch (err) {
      console.error(`[notifyDispatch] Unexpected error on entry ${entry.id}:`, err.message);
      const finalFail = entry.attempts + 1 >= MAX_ATTEMPTS;
      await db.query(
        `UPDATE notification_queue SET status = $1, error_msg = $2 WHERE id = $3`,
        [finalFail ? 'failed' : 'pending', err.message.slice(0, 200), entry.id]
      ).catch(() => {});
    }
  }
}

// Boot: start dispatch loop every 30s
function start() {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[notifyDispatch] RESEND_API_KEY not set — email dispatch disabled until key is added to Railway env');
  }
  // Run once immediately, then every 30s
  dispatch().catch(e => console.error('[notifyDispatch] dispatch error:', e.message));
  setInterval(() => {
    dispatch().catch(e => console.error('[notifyDispatch] dispatch error:', e.message));
  }, 30_000);
  console.log('[notifyDispatch] Notification dispatcher started (30s interval)');
}

module.exports = { start, dispatch };
