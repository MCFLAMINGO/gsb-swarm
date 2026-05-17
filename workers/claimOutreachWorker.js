/**
 * claimOutreachWorker.js  (B66)
 * ─────────────────────────────────────────────────────────────────────────────
 * Reaches out to unclaimed businesses via SMS (phone) and email (contact_email)
 * to invite them to claim their LocalIntel profile.
 *
 * Rules:
 * - Only contacts businesses NOT already in claim_outreach within 30 days
 * - SMS batch:   max 200/day (A2P compliance — stay well under 10DLC limits)
 * - Email batch: max 200/day (conservative — adjust when Resend plan confirmed)
 * - Prioritizes businesses with BOTH phone AND contact_email
 * - Never contacts businesses with merchant_email set (already claimed via portal)
 * - Manual-trigger only — NOT auto-launched by dashboard-server.js boot loop.
 *
 * Run: node workers/claimOutreachWorker.js
 */
'use strict';

const db = require('../lib/db');

const SMS_DAILY_LIMIT        = 200;
const EMAIL_DAILY_LIMIT      = 200;
const OUTREACH_COOLDOWN_DAYS = 30;
const CLAIM_BASE_URL         = process.env.CLAIM_BASE_URL || 'https://thelocalintel.com/claim';

// ── Twilio (copied pattern from localIntelAgent.js sendRfqSms) ──────────────
async function sendOutreachSms(toE164Phone, body) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    return { sent: false, reason: 'twilio_not_configured' };
  }
  let twilio;
  try { twilio = require('twilio')(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN); }
  catch (e) {
    return { sent: false, reason: 'twilio_module_missing', error: e.message };
  }
  try {
    const msg = await twilio.messages.create({ body, from: TWILIO_FROM_NUMBER, to: toE164Phone });
    return { sent: true, sid: msg.sid };
  } catch (e) {
    return { sent: false, reason: 'twilio_send_failed', error: e.message };
  }
}

// Same normalization as localIntelAgent.toE164 — keep in sync.
function toE164(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits.length >= 11 ? digits : null;
  const ten = digits.replace(/\D/g, '');
  if (ten.length === 10) return `+1${ten}`;
  if (ten.length === 11 && ten.startsWith('1')) return `+${ten}`;
  return null;
}

// ── Resend (email) ──────────────────────────────────────────────────────────
async function sendOutreachEmail(toEmail, subject, html) {
  const { RESEND_API_KEY } = process.env;
  if (!RESEND_API_KEY) {
    return { sent: false, reason: 'resend_not_configured' };
  }
  let Resend;
  try { ({ Resend } = require('resend')); }
  catch (e) {
    return { sent: false, reason: 'resend_module_missing', error: e.message };
  }
  try {
    const resend = new Resend(RESEND_API_KEY);
    const result = await resend.emails.send({
      from: 'LocalIntel <intel@thelocalintel.com>',
      to: toEmail,
      subject,
      html,
    });
    const emailId = result?.data?.id || result?.id || null;
    if (result?.error) {
      return { sent: false, reason: 'resend_send_failed', error: result.error.message || String(result.error) };
    }
    return { sent: true, id: emailId };
  } catch (e) {
    return { sent: false, reason: 'resend_send_failed', error: e.message };
  }
}

// ── Message builders ───────────────────────────────────────────────────────
function truncateName(name, max = 40) {
  if (!name) return 'Your business';
  if (name.length <= max) return name;
  return name.slice(0, max - 1).trim() + '…';
}

function buildSmsBody(biz) {
  const shortName = truncateName(biz.name, 40);
  // Keep under 160 chars
  return `LocalIntel: ${shortName} is listed on thelocalintel.com. Claim your free profile to receive job requests & get paid. Reply CLAIM to start.`;
}

function buildEmailHtml(biz) {
  const url = `${CLAIM_BASE_URL}?biz=${biz.business_id}`;
  return `<p>Hi ${escapeHtml(biz.name)},</p>
<p>Your business is listed on <strong>LocalIntel</strong>, Florida's local business intelligence platform. Customers and AI agents are searching for businesses like yours right now.</p>
<p>Claim your free profile to:</p>
<ul>
  <li>Receive job requests and RFQs directly</li>
  <li>Get paid via LocalIntel when jobs complete</li>
  <li>Show up first in local searches</li>
</ul>
<p><a href="${url}">Claim your profile →</a></p>
<p style="color:#666;font-size:12px;">— The LocalIntel Team<br/>thelocalintel.com</p>`;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function recordOutreach({ business_id, channel, message_sid = null, email_id = null, error = null }) {
  try {
    await db.query(
      `INSERT INTO claim_outreach (business_id, channel, sent_at, message_sid, email_id, error)
       VALUES ($1, $2, NOW(), $3, $4, $5)`,
      [business_id, channel, message_sid, email_id, error]
    );
  } catch (e) {
    console.error('[claim-outreach] failed to record outreach:', e.message);
  }
}

async function run() {
  console.log('[claim-outreach] START');
  const limit = SMS_DAILY_LIMIT + EMAIL_DAILY_LIMIT;

  const rows = await db.query(
    `SELECT b.business_id, b.name, b.phone, b.contact_email, b.zip, b.category, b.city
       FROM businesses b
      WHERE b.claimed = false
        AND b.status = 'active'
        AND b.merchant_email IS NULL
        AND (b.phone IS NOT NULL OR b.contact_email IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM claim_outreach co
           WHERE co.business_id = b.business_id
             AND co.sent_at > NOW() - INTERVAL '${OUTREACH_COOLDOWN_DAYS} days'
        )
      ORDER BY
        (CASE WHEN b.phone IS NOT NULL AND b.contact_email IS NOT NULL THEN 0 ELSE 1 END),
        b.name
      LIMIT $1`,
    [limit]
  );

  console.log(`[claim-outreach] candidates: ${rows.length}`);

  let smsSent = 0, emailsSent = 0, errors = 0;

  for (const biz of rows) {
    // ── SMS ──
    if (smsSent < SMS_DAILY_LIMIT && biz.phone) {
      const e164 = toE164(biz.phone);
      if (e164) {
        const body = buildSmsBody(biz);
        const result = await sendOutreachSms(e164, body);
        if (result.sent) {
          smsSent++;
          await recordOutreach({
            business_id: biz.business_id,
            channel: 'sms',
            message_sid: result.sid,
          });
        } else {
          errors++;
          await recordOutreach({
            business_id: biz.business_id,
            channel: 'sms',
            error: result.reason + (result.error ? `: ${result.error}` : ''),
          });
        }
      }
    }

    // ── Email ──
    if (emailsSent < EMAIL_DAILY_LIMIT && biz.contact_email) {
      const subject = `${truncateName(biz.name, 60)} — your free LocalIntel profile is ready`;
      const html = buildEmailHtml(biz);
      const result = await sendOutreachEmail(biz.contact_email, subject, html);
      if (result.sent) {
        emailsSent++;
        await recordOutreach({
          business_id: biz.business_id,
          channel: 'email',
          email_id: result.id,
        });
      } else {
        errors++;
        await recordOutreach({
          business_id: biz.business_id,
          channel: 'email',
          error: result.reason + (result.error ? `: ${result.error}` : ''),
        });
      }
    }

    if (smsSent >= SMS_DAILY_LIMIT && emailsSent >= EMAIL_DAILY_LIMIT) break;
  }

  console.log(`[claim-outreach] END — ${smsSent} SMS sent, ${emailsSent} emails sent, ${errors} errors`);
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[claim-outreach] FATAL:', e.message);
      process.exit(1);
    });
}

module.exports = { run };
