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

const SMS_DAILY_LIMIT        = 0;    // SMS off — email only (free Resend)
const EMAIL_DAILY_LIMIT      = 500;  // Resend free tier: 3,000/month
const OUTREACH_COOLDOWN_DAYS = 30;
const INBOX_BASE_URL         = process.env.INBOX_BASE_URL || 'https://www.thelocalintel.com/inbox.html';
const CLAIM_BASE_URL         = process.env.CLAIM_BASE_URL || 'https://www.thelocalintel.com/claim';

// ── Safety guard ────────────────────────────────────────────────────────────
// Set CLAIM_OUTREACH_LIVE=true in Railway env to actually send.
// Until then, all sends are simulated — no Twilio or Resend calls made.
const LIVE_MODE = process.env.CLAIM_OUTREACH_LIVE === 'true';

// ── Twilio (copied pattern from localIntelAgent.js sendRfqSms) ──────────────
async function sendOutreachSms(toE164Phone, body) {
  if (!LIVE_MODE) {
    console.log(`[claim-outreach] DRY RUN SMS → ${toE164Phone}: ${body.slice(0, 60)}...`);
    return { sent: true, sid: 'dry_run' };
  }
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
  if (!LIVE_MODE) {
    console.log(`[claim-outreach] DRY RUN EMAIL → ${toEmail}: ${subject.slice(0, 60)}...`);
    return { sent: true, id: 'dry_run' };
  }
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
  return `${shortName}, we're building the alternative to Google for local business in Florida. Claim your free LocalIntel profile, list what you do, and connect with customers in your area. Reply CLAIM. thelocalintel.com`;
}

function buildEmailHtml(biz) {
  const ctaUrl   = `${CLAIM_BASE_URL}?biz=${biz.business_id}`;
  const ctaLabel = 'Claim your free profile →';
  const catLabel = biz.category ? biz.category.replace(/_/g, ' ') : 'local services';
  const zipStr   = biz.zip ? ` in ${biz.zip}` : '';
  return `
<div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#111">
  <p style="font-size:16px">Hi <strong>${escapeHtml(biz.name)}</strong>,</p>
  <p>Your business is already listed on <strong>LocalIntel</strong> — Florida's local commerce network built for the AI agent economy.</p>
  <p>Customers and AI agents are searching for <strong>${escapeHtml(catLabel)}${zipStr}</strong> right now.
  When someone requests your service, LocalIntel routes it directly to your inbox —
  no middleman, no commission on search. You and the customer connect directly.</p>
  <p style="margin:24px 0">
    <a href="${ctaUrl}" style="background:#16A34A;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block">${ctaLabel}</a>
  </p>
  <p style="font-size:13px;color:#555">LocalIntel is free for businesses. Join the AI agent economy — let customers and their agents find you.</p>
  <p style="font-size:12px;color:#999;margin-top:32px">
    — The LocalIntel Team &nbsp;|&nbsp; <a href="https://www.thelocalintel.com" style="color:#999">thelocalintel.com</a><br/>
    You're listed for ${escapeHtml(catLabel)} services${zipStr}.<br/>
    <a href="https://www.thelocalintel.com/unsubscribe?biz=${biz.business_id}" style="color:#999">Unsubscribe</a>
  </p>
</div>`;
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

// Ensure claim_outreach table exists
async function ensureTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS claim_outreach (
      id           BIGSERIAL PRIMARY KEY,
      business_id  TEXT NOT NULL,
      channel      TEXT NOT NULL,
      sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      message_sid  TEXT,
      email_id     TEXT,
      error        TEXT
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS claim_outreach_biz_idx ON claim_outreach(business_id, sent_at DESC)`);
}


async function run() {
  console.log('[claim-outreach] START');
  if (!LIVE_MODE) {
    console.log('[claim-outreach] ⚠️  DRY RUN MODE — set CLAIM_OUTREACH_LIVE=true in Railway env to send real messages');
  }

  await ensureTable();

  const limit = process.env.TEST_EMAIL ? 1
    : Math.min(parseInt(process.env.OUTREACH_BATCH_LIMIT || String(EMAIL_DAILY_LIMIT), 10), EMAIL_DAILY_LIMIT);

  const rows = await db.query(
    `SELECT DISTINCT ON (b.contact_email) b.business_id, b.name, b.phone, b.contact_email, b.zip, b.category, b.city
       FROM businesses b
      WHERE b.claimed_at IS NULL
        AND b.status != 'inactive'
        AND b.contact_email IS NOT NULL
        -- Filter obvious bad emails from scraper
        AND b.contact_email NOT LIKE '%@domain.%'
        AND b.contact_email NOT LIKE '%.png'
        AND b.contact_email NOT LIKE '%.jpg'
        AND b.contact_email NOT LIKE '%.gif'
        AND b.contact_email NOT LIKE '%.svg'
        AND b.contact_email NOT LIKE '%craigslist.org'
        AND b.contact_email NOT LIKE '%@2x.%'
        -- Filter URL-encoded artifacts (e.g. %20info@...)
        AND b.contact_email NOT LIKE E'\\%%'
        -- Filter emails shorter than 6 chars total
        AND LENGTH(b.contact_email) >= 6
        -- Filter phone numbers used as email local part (digits/hyphens/parens/plus only before @)
        AND b.contact_email !~ '^[0-9+()-]+@'
        -- Filter local part that is all digits (e.g. 32967@aol.com, 1@1.com)
        AND split_part(b.contact_email, '@', 1) !~ '^[0-9]+$'
        -- Filter toll-free / vanity numbers embedded in local part (e.g. 1-866-520-ugly...)
        AND split_part(b.contact_email, '@', 1) !~ '^1[.-]?8(00|33|44|55|66|77|88)'
        -- Must match basic valid email shape
        AND b.contact_email ~ '^[^@]+@[^@]+[.][^@]{2,}$'
        AND NOT EXISTS (
          SELECT 1 FROM claim_outreach co
           WHERE co.business_id = b.business_id
             AND co.channel = 'email'
             AND co.error IS NULL
             AND co.sent_at > NOW() - INTERVAL '${OUTREACH_COOLDOWN_DAYS} days'
        )
      ORDER BY
        b.contact_email,
        confidence_score DESC NULLS LAST,
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
      const html    = buildEmailHtml(biz);
      // TEST_EMAIL override — sends to a single address instead of the business
      const sendTo  = process.env.TEST_EMAIL || biz.contact_email;
      const result  = await sendOutreachEmail(sendTo, subject, html);
      if (result.sent) {
        emailsSent++;
        console.log(`[claim-outreach] email sent → ${sendTo} (biz: ${biz.name})`);
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
