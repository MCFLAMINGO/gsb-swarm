'use strict';
/**
 * workers/railReportWorker.js — Daily morning rail routing + revenue report
 * ─────────────────────────────────────────────────────────────────────────
 * Fires every morning at 8:00 AM Eastern (12:00 UTC).
 * Pulls last 24h of fee_events + rail_stats, emails a summary via Resend
 * to OWNER_EMAIL (Railway env var).
 *
 * Report covers:
 *   - Total fees collected by rail (surge_split / tempo_pathusd / deferred_rfq)
 *   - Rail distribution (what % of jobs went to each rail)
 *   - Acquisition targets (no_wallet businesses that got RFQ'd)
 *   - Top 5 active businesses by fee volume
 *   - Notification queue drain status
 */

const db = require('../lib/db');

const REPORT_HOUR_UTC = 12; // 8am Eastern = 12:00 UTC
const REPORT_MIN_UTC  = 0;

// ── Build report data ─────────────────────────────────────────────────────────
async function buildReport() {
  const [
    feeRows,
    railRows,
    topBiz,
    noWalletCount,
    notifRows,
    feeTotal,
  ] = await Promise.all([

    // Fee summary by status
    db.query(`
      SELECT status, COUNT(*) AS cnt, COALESCE(SUM(amount_usd), 0) AS total_usd
        FROM fee_events
       WHERE created_at >= NOW() - INTERVAL '24 hours'
       GROUP BY status
       ORDER BY total_usd DESC
    `).catch(() => []),

    // Rail distribution
    db.query(`
      SELECT
        meta->>'rail'     AS rail,
        meta->>'fee_rail' AS fee_rail,
        COUNT(*)          AS cnt,
        COALESCE(SUM(amount_usd), 0) AS total_usd
        FROM fee_events
       WHERE created_at >= NOW() - INTERVAL '24 hours'
         AND meta->>'rail' IS NOT NULL
       GROUP BY meta->>'rail', meta->>'fee_rail'
       ORDER BY total_usd DESC
    `).catch(() => []),

    // Top 5 businesses by fees yesterday
    db.query(`
      SELECT fe.business_id, b.name, COUNT(*) AS events,
             COALESCE(SUM(fe.amount_usd), 0) AS total_usd,
             MAX(fe.meta->>'rail') AS last_rail
        FROM fee_events fe
        LEFT JOIN businesses b ON b.business_id = fe.business_id::uuid
       WHERE fe.created_at >= NOW() - INTERVAL '24 hours'
         AND fe.status = 'charged'
       GROUP BY fe.business_id, b.name
       ORDER BY total_usd DESC
       LIMIT 5
    `).catch(() => []),

    // Acquisition targets (businesses that got rfq'd but have no wallet)
    db.query(`
      SELECT COUNT(DISTINCT business_id) AS cnt
        FROM fee_events
       WHERE created_at >= NOW() - INTERVAL '24 hours'
         AND status = 'no_wallet'
    `).catch(() => [{ cnt: 0 }]),

    // Notification queue status
    db.query(`
      SELECT channel, status, COUNT(*) AS cnt
        FROM notification_queue
       WHERE created_at >= NOW() - INTERVAL '24 hours'
       GROUP BY channel, status
       ORDER BY channel, status
    `).catch(() => []),

    // Total fees charged in last 24h
    db.query(`
      SELECT COALESCE(SUM(amount_usd), 0) AS total
        FROM fee_events
       WHERE created_at >= NOW() - INTERVAL '24 hours'
         AND status = 'charged'
    `).catch(() => [{ total: 0 }]),
  ]);

  const totalCharged = parseFloat(feeTotal[0]?.total || 0).toFixed(4);
  const acqTargets   = parseInt(noWalletCount[0]?.cnt || 0, 10);

  return { feeRows, railRows, topBiz, acqTargets, notifRows, totalCharged };
}

// ── Format email HTML ─────────────────────────────────────────────────────────
function formatEmail(report) {
  const { feeRows, railRows, topBiz, acqTargets, notifRows, totalCharged } = report;
  const now = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });

  const railTable = railRows.length
    ? railRows.map(r =>
        `<tr>
          <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;">${r.rail || 'unknown'}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;">${r.fee_rail || '—'}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;text-align:right;">${r.cnt}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600;">$${parseFloat(r.total_usd).toFixed(4)}</td>
        </tr>`
      ).join('')
    : '<tr><td colspan="4" style="padding:12px;color:#888;">No rail data yet — fees accumulating</td></tr>';

  const topBizTable = topBiz.length
    ? topBiz.map((b, i) =>
        `<tr>
          <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;">${i + 1}. ${b.name || b.business_id}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;text-align:right;">${b.events}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600;">$${parseFloat(b.total_usd).toFixed(4)}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;">${b.last_rail || '—'}</td>
        </tr>`
      ).join('')
    : '<tr><td colspan="4" style="padding:12px;color:#888;">No charged fees yet — routing live</td></tr>';

  const feeStatusTable = feeRows.length
    ? feeRows.map(r =>
        `<tr>
          <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;">${r.status}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;text-align:right;">${r.cnt}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;text-align:right;">$${parseFloat(r.total_usd).toFixed(4)}</td>
        </tr>`
      ).join('')
    : '<tr><td colspan="3" style="padding:12px;color:#888;">No fee events in last 24h</td></tr>';

  const notifSummary = notifRows.length
    ? notifRows.map(r => `${r.channel}/${r.status}: ${r.cnt}`).join(' · ')
    : 'No notifications in last 24h';

  return `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:600px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

  <!-- Header -->
  <div style="background:#16A34A;padding:24px 32px;">
    <h1 style="margin:0;color:#fff;font-size:20px;font-weight:700;">LocalIntel Daily Rail Report</h1>
    <p style="margin:4px 0 0;color:#dcfce7;font-size:14px;">${now}</p>
  </div>

  <!-- Hero stat -->
  <div style="padding:24px 32px;background:#f0fdf4;border-bottom:1px solid #dcfce7;">
    <p style="margin:0;font-size:13px;color:#166534;text-transform:uppercase;letter-spacing:.05em;">Total Fees Collected (24h)</p>
    <p style="margin:4px 0 0;font-size:36px;font-weight:800;color:#15803d;">$${totalCharged}</p>
    <p style="margin:6px 0 0;font-size:13px;color:#4b7a5e;">${acqTargets} acquisition targets (no_wallet RFQs) · ${notifSummary}</p>
  </div>

  <!-- Rail distribution -->
  <div style="padding:24px 32px;">
    <h2 style="margin:0 0 12px;font-size:15px;font-weight:700;color:#111;">Rail Distribution</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:#f9fafb;">
          <th style="padding:8px 12px;text-align:left;color:#6b7280;font-weight:600;">Rail</th>
          <th style="padding:8px 12px;text-align:left;color:#6b7280;font-weight:600;">Fee Rail</th>
          <th style="padding:8px 12px;text-align:right;color:#6b7280;font-weight:600;">Jobs</th>
          <th style="padding:8px 12px;text-align:right;color:#6b7280;font-weight:600;">Revenue</th>
        </tr>
      </thead>
      <tbody>${railTable}</tbody>
    </table>
  </div>

  <!-- Top businesses -->
  <div style="padding:0 32px 24px;">
    <h2 style="margin:0 0 12px;font-size:15px;font-weight:700;color:#111;">Top Businesses by Fee Volume</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:#f9fafb;">
          <th style="padding:8px 12px;text-align:left;color:#6b7280;font-weight:600;">Business</th>
          <th style="padding:8px 12px;text-align:right;color:#6b7280;font-weight:600;">Events</th>
          <th style="padding:8px 12px;text-align:right;color:#6b7280;font-weight:600;">Fees</th>
          <th style="padding:8px 12px;text-align:left;color:#6b7280;font-weight:600;">Rail</th>
        </tr>
      </thead>
      <tbody>${topBizTable}</tbody>
    </table>
  </div>

  <!-- Fee status breakdown -->
  <div style="padding:0 32px 24px;">
    <h2 style="margin:0 0 12px;font-size:15px;font-weight:700;color:#111;">Fee Status Breakdown</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:#f9fafb;">
          <th style="padding:8px 12px;text-align:left;color:#6b7280;font-weight:600;">Status</th>
          <th style="padding:8px 12px;text-align:right;color:#6b7280;font-weight:600;">Count</th>
          <th style="padding:8px 12px;text-align:right;color:#6b7280;font-weight:600;">Amount</th>
        </tr>
      </thead>
      <tbody>${feeStatusTable}</tbody>
    </table>
  </div>

  <!-- Footer -->
  <div style="padding:16px 32px;background:#f9fafb;border-top:1px solid #e5e7eb;">
    <p style="margin:0;font-size:12px;color:#9ca3af;">
      LocalIntel · gsb-swarm-production.up.railway.app ·
      <a href="https://gsb-swarm-production.up.railway.app/api/local-intel/rail-stats?hours=24" style="color:#16A34A;">Live rail stats</a> ·
      <a href="https://gsb-swarm-production.up.railway.app/api/local-intel/fee-events?hours=24" style="color:#16A34A;">Fee events</a>
    </p>
  </div>

</div>
</body>
</html>`;
}

// ── Send report ───────────────────────────────────────────────────────────────
async function sendReport() {
  const ownerEmail = process.env.OWNER_EMAIL;
  if (!ownerEmail) {
    console.warn('[railReport] OWNER_EMAIL not set — skipping email send, logging report only');
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.warn('[railReport] RESEND_API_KEY not set — cannot send report');
    return;
  }

  try {
    const report = await buildReport();
    const html   = formatEmail(report);

    const { Resend } = require('resend');
    const resend     = new Resend(resendKey);

    const day        = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
    const subject    = `LocalIntel Rail Report — ${day} · $${report.totalCharged} collected`;

    const recipients = [ownerEmail].filter(Boolean);
    if (!recipients.length) {
      console.log('[railReport] no recipients — logging only');
      console.log(`[railReport] $${report.totalCharged} collected | ${report.acqTargets} acq targets | rails: ${JSON.stringify(report.railRows.map(r => `${r.rail}:${r.cnt}`))}`);
      return;
    }

    const result = await resend.emails.send({
      from:    'LocalIntel <notifications@thelocalintel.com>',
      to:      recipients,
      subject,
      html,
    });

    console.log(`[railReport] sent to ${recipients.join(', ')} — id: ${result.id || result.data?.id || 'ok'} | $${report.totalCharged} collected`);
  } catch (e) {
    console.error('[railReport] send error:', e.message);
  }
}

// ── Scheduler — 8am Eastern = 12:00 UTC daily ────────────────────────────────
function scheduleDailyReport() {
  function msUntilNext8amEastern() {
    const now   = new Date();
    // Convert to Eastern time offset (UTC-4 EDT / UTC-5 EST)
    // Use a fixed UTC-4 (EDT) — close enough for daily scheduling
    const ET_OFFSET_MS = 4 * 60 * 60 * 1000;
    const nowET = new Date(now.getTime() - ET_OFFSET_MS);
    const nextET = new Date(Date.UTC(
      nowET.getUTCFullYear(),
      nowET.getUTCMonth(),
      nowET.getUTCDate(),
      8, 0, 0, 0  // 8am ET
    ));
    // If already past 8am ET today, schedule for tomorrow
    if (nextET.getTime() - ET_OFFSET_MS <= now.getTime()) {
      nextET.setUTCDate(nextET.getUTCDate() + 1);
    }
    return (nextET.getTime() - ET_OFFSET_MS) - now.getTime();
  }

  const ms   = msUntilNext8amEastern();
  const hrs  = (ms / 3600000).toFixed(1);
  console.log(`[railReport] Daily report scheduled — next run in ${hrs}h`);

  // Cap at 24h to avoid 32-bit overflow, re-arm after each fire
  const MAX_TIMEOUT = 24 * 60 * 60 * 1000;
  const safeMs = Math.min(ms, MAX_TIMEOUT);

  setTimeout(async () => {
    if (ms > MAX_TIMEOUT) {
      // Fired early due to cap — re-arm without sending
      scheduleDailyReport();
      return;
    }
    await sendReport().catch(e => console.warn('[railReport] run error:', e.message));
    scheduleDailyReport(); // re-arm for next day
  }, safeMs);
}

module.exports = { sendReport, scheduleDailyReport, buildReport };

// Run directly for testing
if (require.main === module) {
  sendReport()
    .then(() => process.exit(0))
    .catch(e => { console.error(e.message); process.exit(1); });
}
