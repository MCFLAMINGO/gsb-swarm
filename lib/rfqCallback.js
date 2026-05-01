'use strict';
/**
 * rfqCallback.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Outbound Twilio call to the caller when providers have responded.
 *
 * Flow:
 *   1. fireCallback()    — Twilio REST API places call to caller_phone
 *                          TwiML URL: /api/rfq/callback-twiml?jobId=...
 *   2. callbackTwiml()   — returns TwiML that reads provider list and gathers
 *                          the caller's choice ("say 1, 2, or 3")
 *   3. callbackProcess() — called by Twilio after caller speaks their choice
 *                          → confirmSelection() → done
 *
 * Voice: Polly.Joanna-Neural (same as voiceIntake)
 * All state in Postgres — no in-memory session needed (job ID in TwiML URL)
 */

const { confirmSelection, markCallbackFired, getJobByCode, getResponses, sendSms } = require('./rfqBroadcast');

const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : 'https://gsb-swarm-production.up.railway.app';

function escXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function twimlSay(text, gather = null) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n';
  if (gather) {
    xml += `  <Gather input="speech" action="${escXml(gather.action)}" method="POST" speechTimeout="4" language="en-US">\n`;
    xml += `    <Say voice="Polly.Joanna-Neural">${escXml(text)}</Say>\n`;
    xml += `  </Gather>\n`;
    xml += `  <Say voice="Polly.Joanna-Neural">We didn't catch your selection. Please call back at (904) 506-7476.</Say>\n`;
  } else {
    xml += `  <Say voice="Polly.Joanna-Neural">${escXml(text)}</Say>\n`;
  }
  xml += '</Response>';
  return xml;
}

// ── fireCallback ──────────────────────────────────────────────────────────────
/**
 * Place an outbound call to the caller via Twilio REST API.
 * The call will GET /api/rfq/callback-twiml?jobId=... for its TwiML.
 */
async function fireCallback(job) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_FROM_NUMBER;

  if (!sid || !token || !from) {
    console.warn('[rfqCallback] Twilio env vars not set — cannot fire callback');
    return false;
  }

  const twimlUrl = `${BASE_URL}/api/rfq/callback-twiml?jobId=${encodeURIComponent(job.id)}`;

  const params = new URLSearchParams({
    To:  job.caller_phone,
    From: from,
    Url: twimlUrl,
    Method: 'GET',
    StatusCallback: `${BASE_URL}/api/rfq/callback-status`,
    StatusCallbackMethod: 'POST',
    Timeout: '30',
  });

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`,
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
      console.error('[rfqCallback] Twilio outbound call error:', err);
      return false;
    }
    const data = await res.json();
    console.log(`[rfqCallback] Outbound call placed to ${job.caller_phone} — SID: ${data.sid}`);
    await markCallbackFired(job.id);
    return true;
  } catch (e) {
    console.error('[rfqCallback] fireCallback error:', e.message);
    return false;
  }
}

// ── callbackTwiml ─────────────────────────────────────────────────────────────
/**
 * GET /api/rfq/callback-twiml?jobId=...
 * Returns TwiML that introduces the job results and asks caller to pick.
 */
async function callbackTwiml(jobId) {
  const job       = await getJobByCode(jobId).catch(() => null)
    || await (async () => {
      const db = require('./db');
      const rows = await db.query(`SELECT * FROM rfq_jobs WHERE id = $1`, [jobId]);
      return rows[0] || null;
    })();

  if (!job) {
    return twimlSay('Sorry, we could not find your job request. Please call back at (904) 506-7476.');
  }

  const responses = await getResponses(job.id);
  if (!responses.length) {
    return twimlSay(
      `Hi${job.caller_name ? ', ' + job.caller_name : ''}! ` +
      `We haven't received any bids yet for your ${(job.category || '').replace(/_/g,' ')} request. ` +
      `We'll call you back when providers respond. Goodbye!`
    );
  }

  const nameGreet = job.caller_name ? `, ${job.caller_name}` : '';
  const catLabel  = (job.category || '').replace(/_/g, ' ');
  const zipStr    = job.zip ? ` in ${job.zip}` : '';

  let intro = `Hi${nameGreet}! LocalIntel calling about your ${catLabel} request${zipStr}. `;
  intro += `${responses.length} provider${responses.length > 1 ? 's have' : ' has'} responded. `;

  // Read list
  const listItems = responses.slice(0, 5).map((r, i) => {
    const bizName  = r.business_name || 'a local provider';
    const channel  = r.channel === 'email' ? 'by email' : r.channel === 'voice' ? 'by phone' : 'by text';
    return `${i + 1}. ${bizName}, responded ${channel}.`;
  }).join(' ');

  const ask = responses.length === 1
    ? `Say "yes" or "confirm" to go with ${responses[0].business_name || 'this provider'}, or "no" to wait for more responses.`
    : `Say the number — 1 through ${Math.min(responses.length, 5)} — to confirm that provider, or say "not yet" to wait.`;

  const fullText = `${intro} Here are your options. ${listItems} ${ask}`;

  const actionUrl = `${BASE_URL}/api/rfq/callback-process?jobId=${encodeURIComponent(job.id)}`;
  return twimlSay(fullText, { action: actionUrl });
}

// ── callbackProcess ───────────────────────────────────────────────────────────
/**
 * POST /api/rfq/callback-process?jobId=...
 * Processes the caller's spoken selection.
 */
async function callbackProcess(jobId, speechResult) {
  const speech = (speechResult || '').toLowerCase().trim();

  // Look up job
  const db  = require('./db');
  const rows = await db.query(`SELECT * FROM rfq_jobs WHERE id = $1`, [jobId]);
  if (!rows.length) {
    return twimlSay('Sorry, we could not find your job. Please call (904) 506-7476.');
  }
  const job = rows[0];

  // Detect "not yet" / "later" / "no"
  if (/not yet|later|no|wait|hold|skip|unsure|don't|dont/i.test(speech)) {
    await sendSms(
      job.caller_phone,
      `LocalIntel: No problem — your job ${job.code} is still open. ` +
      `We'll call back when more responses come in, or visit thelocalintel.com/jobs/${job.code}`
    ).catch(() => {});
    return twimlSay(
      'No problem! Your request stays open and we\'ll call you when more providers respond. Goodbye!'
    );
  }

  // Detect "yes" / "confirm" (single provider)
  const responses = await getResponses(job.id);
  let chosenIndex = 1; // default to first

  // Parse spoken number: "one", "two", "three", "1", "2", "3"
  const numWords = { one:1, two:2, three:3, four:4, five:5, first:1, second:2, third:3 };
  const numMatch = speech.match(/\b([1-5]|one|two|three|four|five|first|second|third)\b/);
  if (numMatch) {
    chosenIndex = parseInt(numMatch[1]) || numWords[numMatch[1]] || 1;
  }

  if (!responses.length) {
    return twimlSay('No responses on file yet. We\'ll call you back. Goodbye!');
  }

  const result = await confirmSelection({
    jobId: job.id,
    responseIndex: chosenIndex,
    callerPhone: job.caller_phone,
  });

  if (!result.ok) {
    return twimlSay('Sorry, something went wrong. Please call (904) 506-7476 and we\'ll sort it out. Goodbye!');
  }

  const bizName = result.chosen.business_name || 'the provider';
  return twimlSay(
    `Perfect${job.caller_name ? ', ' + job.caller_name : ''}! ` +
    `${bizName} has been confirmed for your ${(job.category || '').replace(/_/g,' ')} job. ` +
    `They'll reach out to schedule. Your job ID is ${job.code}. Goodbye!`
  );
}

module.exports = { fireCallback, callbackTwiml, callbackProcess };
