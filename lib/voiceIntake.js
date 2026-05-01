'use strict';

/**
 * voiceIntake.js
 * Natural language voice intake for LocalIntel via Twilio.
 *
 * Flow:
 *   1. Twilio calls POST /api/voice/incoming with caller phone + transcribed speech
 *   2. parseIntent() splits: homeowner (needs work) vs business (wants listing)
 *   3. Homeowner → extract who/where/what/when → post RFQ → SMS confirmation
 *   4. Business  → capture phone+name → SMS link to thelocalintel.com/claim
 *
 * No LLM. Deterministic vocabulary scoring — same pattern as MCP routing.
 */

const SITE_URL = 'https://www.thelocalintel.com';

// ── Intent scoring ─────────────────────────────────────────────────────────────

// Words that signal "I have a business / I want to be listed"
const BUSINESS_VOCAB = [
  'my business', 'our business', 'i own', 'we own', 'i run', 'we run',
  'list my', 'list our', 'get listed', 'discoverable', 'add my', 'add our',
  'my company', 'our company', 'i provide', 'we provide', 'my service',
  'my shop', 'my store', 'my restaurant', 'my lawn', 'we do', 'i do',
  'find me customers', 'get customers', 'more customers', 'get found',
];

// Service category keywords → maps to category for RFQ
const SERVICE_MAP = {
  // Landscaping
  'lawn':         'landscaping', 'mow':          'landscaping',
  'mowing':       'landscaping', 'landscap':     'landscaping',
  'grass':        'landscaping', 'yard':         'landscaping',
  'tree':         'landscaping', 'hedge':        'landscaping',
  'trim':         'landscaping', 'bush':         'landscaping',
  'mulch':        'landscaping', 'plant':        'landscaping',
  'irrigation':   'landscaping', 'sprinkler':    'landscaping',
  // Cleaning
  'clean':        'cleaning',    'maid':         'cleaning',
  'housekeep':    'cleaning',    'janitorial':   'cleaning',
  'pressure wash':'cleaning',    'window clean': 'cleaning',
  // Plumbing
  'plumb':        'plumbing',    'pipe':         'plumbing',
  'leak':         'plumbing',    'drain':        'plumbing',
  'water heater': 'plumbing',    'toilet':       'plumbing',
  'faucet':       'plumbing',
  // Electrical
  'electric':     'electrical',  'wiring':       'electrical',
  'outlet':       'electrical',  'breaker':      'electrical',
  'panel':        'electrical',  'light':        'electrical',
  // HVAC
  'hvac':         'hvac',        'ac ':          'hvac',
  'air condition':'hvac',        'heat':         'hvac',
  'furnace':      'hvac',        'duct':         'hvac',
  'cool':         'hvac',
  // Roofing
  'roof':         'roofing',     'shingle':      'roofing',
  'gutter':       'roofing',     'leak':         'roofing',
  // Painting
  'paint':        'painting',    'stain':        'painting',
  'drywall':      'painting',
  // Moving
  'mov':          'moving',      'haul':         'moving',
  'junk':         'moving',      'removal':      'moving',
  // Handyman
  'handyman':     'handyman',    'fix':          'handyman',
  'repair':       'handyman',    'install':      'handyman',
  'assemble':     'handyman',
  // Pest
  'pest':         'pest_control','bug':          'pest_control',
  'termite':      'pest_control','exterminate':  'pest_control',
  'mosquito':     'pest_control',
  // Carpentry / flooring
  'floor':        'flooring',    'tile':         'flooring',
  'carpet':       'flooring',    'hardwood':     'flooring',
  'fence':        'carpentry',   'deck':         'carpentry',
  'cabinet':      'carpentry',
  // Pool
  'pool':         'pool_service','spa ':         'pool_service',
  // Concrete / pressure
  'concrete':     'concrete',    'driveway':     'concrete',
  'pressure':     'pressure_washing',
  // General contractor
  'remodel':      'contractor',  'renovate':     'contractor',
  'addition':     'contractor',  'construction': 'contractor',
  // Childcare / pet
  'babysit':      'childcare',   'daycare':      'childcare',
  'pet sit':      'pet_services','dog walk':     'pet_services',
  'grooming':     'pet_services',
  // Food & delivery
  'catering':     'catering',    'cater':        'catering',
  'food truck':   'catering',
  'deliver':      'delivery',    'delivery':     'delivery',
  'bring me':     'delivery',    'bring to':     'delivery',
  'drop off':     'delivery',    'drop it':      'delivery',
  'pick up':      'delivery',    'pickup':       'delivery',
  'order food':   'delivery',    'food deliver': 'delivery',
  'restaurant':   'delivery',    'takeout':      'delivery',
  'take out':     'delivery',    'food from':    'delivery',
  'mcflaming':    'delivery',    'flamingo':     'delivery',
  // Errands / personal
  'errand':       'errands',     'grocery':      'errands',
  'groceries':    'errands',     'pharmacy':     'errands',
  'prescription': 'errands',
  // Tutoring / lessons
  'tutor':        'tutoring',    'lesson':       'tutoring',
  'teach':        'tutoring',    'coach':        'tutoring',
  // Photography
  'photo':        'photography', 'photograph':   'photography',
  'headshot':     'photography', 'wedding photo':'photography',
  // Auto
  'car wash':     'auto',        'oil change':   'auto',
  'tire':         'auto',        'mechanic':     'auto',
  'auto repair':  'auto',        'tow':          'auto',
  // IT / tech
  'computer':     'it_support',  'laptop':       'it_support',
  'wifi':         'it_support',  'network':      'it_support',
  'tech support': 'it_support',
};

// Florida ZIP codes (5-digit starting with 32 or 33 or 34)
const ZIP_RE = /\b(3[234]\d{3})\b/;

// Common city → ZIP mapping for NE Florida
const CITY_ZIP = {
  'ponte vedra':      '32082',
  'ponte vedra beach':'32082',
  'nocatee':          '32081',
  'st johns':         '32259',
  'saint johns':      '32259',
  'fleming island':   '32003',
  'orange park':      '32073',
  'jacksonville':     '32202',
  'jax':              '32202',
  'st augustine':     '32084',
  'saint augustine':  '32084',
  'fernandina':       '32034',
  'fernandina beach': '32034',
  'yulee':            '32097',
  'green cove springs':'32043',
  'palatka':          '32177',
  'palm coast':       '32164',
  'flagler beach':    '32136',
  'ormond beach':     '32174',
  'daytona':          '32114',
};

/**
 * Determine if the caller is a business owner wanting to get listed,
 * or a homeowner/consumer needing a service.
 * Returns 'business' | 'homeowner'
 */
function parseIntent(text) {
  const lower = text.toLowerCase();
  const bizScore = BUSINESS_VOCAB.reduce((s, phrase) =>
    lower.includes(phrase) ? s + 1 : s, 0);
  return bizScore >= 1 ? 'business' : 'homeowner';
}

/**
 * Extract service category from transcribed text.
 * Returns best matching category string or null.
 */
function extractCategory(text) {
  const lower = text.toLowerCase();
  let best = null;
  for (const [keyword, category] of Object.entries(SERVICE_MAP)) {
    if (lower.includes(keyword)) {
      best = category;
      break; // first match wins — order matters in SERVICE_MAP
    }
  }
  return best;
}

/**
 * Extract a Florida ZIP code or city name from text.
 */
function extractZip(text) {
  const lower = text.toLowerCase();
  // Direct ZIP
  const zipMatch = lower.match(ZIP_RE);
  if (zipMatch) return zipMatch[1];
  // City name
  for (const [city, zip] of Object.entries(CITY_ZIP)) {
    if (lower.includes(city)) return zip;
  }
  return null;
}

/**
 * Extract a name from "my name is X" or "this is X" or "i'm X"
 */
function extractName(text) {
  const m = text.match(/(?:my name is|this is|i(?:'m| am))\s+([A-Za-z][A-Za-z\s]{1,30}?)(?:\s+(?:and|i|from|in|at)\b|[,.]|$)/i);
  return m ? m[1].trim() : null;
}

/**
 * Extract timing: "today", "tomorrow", "saturday", "asap", etc.
 */
function extractTiming(text) {
  const lower = text.toLowerCase();
  if (lower.includes('today') || lower.includes('asap') || lower.includes('right away') || lower.includes('as soon as')) return 'today';
  if (lower.includes('tomorrow')) return 'tomorrow';
  const days = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  for (const day of days) {
    if (lower.includes(day)) return day;
  }
  return null;
}

/**
 * Build TwiML response string.
 * Twilio requires XML — we return it directly, no SDK needed.
 */
function twiml(say, gather = null, redirect = null) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n';
  if (gather) {
    xml += `  <Gather input="speech" action="${gather.action}" method="POST" speechTimeout="3" language="en-US">\n`;
    xml += `    <Say voice="Polly.Joanna-Neural">${escXml(say)}</Say>\n`;
    xml += `  </Gather>\n`;
    // Fallback if no speech detected
    xml += `  <Say voice="Polly.Joanna-Neural">We didn't catch that. Please call back and try again.</Say>\n`;
  } else {
    xml += `  <Say voice="Polly.Joanna-Neural">${escXml(say)}</Say>\n`;
  }
  if (redirect) {
    xml += `  <Redirect method="POST">${escXml(redirect)}</Redirect>\n`;
  }
  xml += '</Response>';
  return xml;
}

function escXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Send an SMS via Twilio REST API (no SDK required).
 * Uses env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 */
async function sendSms(to, body) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) {
    console.warn('[voiceIntake] SMS skipped — TWILIO env vars not set');
    return;
  }
  const params = new URLSearchParams({ To: to, From: from, Body: body });
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
    console.error('[voiceIntake] SMS error:', err);
  }
}

/**
 * Capture a business lead into Postgres leads table.
 * Non-blocking — fires and forgets, errors logged.
 */
async function captureBusinessLead({ phone, name, rawText }) {
  try {
    const db = require('./db');
    await db.query(`
      CREATE TABLE IF NOT EXISTS voice_leads (
        id         BIGSERIAL PRIMARY KEY,
        phone      TEXT,
        name       TEXT,
        raw_text   TEXT,
        intent     TEXT DEFAULT 'business',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(
      `INSERT INTO voice_leads (phone, name, raw_text, intent) VALUES ($1, $2, $3, 'business')`,
      [phone, name, rawText]
    );
    console.log('[voiceIntake] Lead captured:', phone, name || '(no name)');
  } catch (e) {
    console.error('[voiceIntake] captureBusinessLead error:', e.message);
  }
}

/**
 * Post an RFQ using a system caller key (the TREASURY wallet key).
 * Non-blocking — fires and forgets after confirming via SMS.
 */
async function postVoiceRfq({ category, zip, description, callerPhone, callerName }) {
  try {
    const rfqService = require('./rfqService');
    // Use a dedicated voice-intake caller key stored in Railway env
    // Falls back to treasury address as the caller identifier
    const caller_key = process.env.VOICE_CALLER_KEY || 'voice-intake';
    const rfq = await rfqService.createRfq({
      job_type: 'proposal',
      category,
      zip,
      description,
      deadline_minutes: 1440, // 24 hours
      autonomy: 'human',
      notify_email: null,
      caller_key,
    });
    console.log('[voiceIntake] RFQ posted:', rfq.id, category, zip);

    // SMS confirmation to caller
    const categoryLabel = category.replace(/_/g, ' ');
    await sendSms(
      callerPhone,
      `LocalIntel: We're finding ${categoryLabel} quotes for you in ${zip}. ` +
      `You'll receive responses shortly. Your job ID: ${rfq.id}`
    );

    // Store voice lead with rfq_id
    try {
      const db = require('./db');
      await db.query(`
        CREATE TABLE IF NOT EXISTS voice_leads (
          id         BIGSERIAL PRIMARY KEY,
          phone      TEXT,
          name       TEXT,
          raw_text   TEXT,
          intent     TEXT DEFAULT 'business',
          rfq_id     UUID,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await db.query(
        `INSERT INTO voice_leads (phone, name, raw_text, intent, rfq_id) VALUES ($1, $2, $3, 'homeowner', $4)`,
        [callerPhone, callerName, description, rfq.id]
      );
    } catch (e) {
      console.error('[voiceIntake] lead store error:', e.message);
    }

    return rfq;
  } catch (e) {
    console.error('[voiceIntake] postVoiceRfq error:', e.message);
    // SMS failure notice
    await sendSms(
      callerPhone,
      `LocalIntel: We received your request but had trouble finding providers right now. ` +
      `Please visit ${SITE_URL} or call back.`
    );
    return null;
  }
}

/**
 * Main handler — called by the Express route.
 *
 * Handles two Twilio call stages:
 *   stage=greeting  — initial call, gather speech
 *   stage=process   — SpeechResult is available, process it
 *
 * Returns { contentType, body } to send back to Twilio.
 */
async function handleIncoming({ stage, speechResult, callerPhone }) {
  // ── Stage 1: Greeting — just gather their speech ──────────────────────────
  if (stage === 'greeting' || !speechResult) {
    const xml = twiml(
      'Welcome to LocalIntel. Tell me your name, where you are, and what you need — ' +
      'or tell me about your business to get found by AI.',
      { action: '/api/voice/process' }
    );
    return { contentType: 'text/xml', body: xml };
  }

  // ── Stage 2: Process their speech ─────────────────────────────────────────
  const text = speechResult.trim();
  console.log('[voiceIntake] Caller:', callerPhone, '| Speech:', text);

  const intent = parseIntent(text);

  // ── BUSINESS side ──────────────────────────────────────────────────────────
  if (intent === 'business') {
    const name = extractName(text);
    await captureBusinessLead({ phone: callerPhone, name, rawText: text });
    await sendSms(
      callerPhone,
      `LocalIntel: Thanks${name ? ' ' + name : ''}! Complete your listing at ${SITE_URL}/claim — ` +
      `get your business found by AI agents today.`
    );
    const xml = twiml(
      `Thanks${name ? ', ' + name : ''}! ` +
      `We just sent you a text with a link to complete your listing on LocalIntel. ` +
      `Your business will be discoverable by AI agents once you verify your Sunbiz number. ` +
      `Visit the local intel dot com to get started. Goodbye!`
    );
    return { contentType: 'text/xml', body: xml };
  }

  // ── HOMEOWNER side ─────────────────────────────────────────────────────────
  const category = extractCategory(text);
  const zip      = extractZip(text);
  const name     = extractName(text);
  const timing   = extractTiming(text);

  // Build a human-readable description from what we heard
  const description = [
    name ? `Caller: ${name}.` : null,
    `Request: ${text}`,
    timing ? `Timing: ${timing}.` : null,
  ].filter(Boolean).join(' ');

  // If we have enough to post — category OR zip (not both required)
  if (category || zip) {
    const resolvedZip      = zip || '32082'; // default to Ponte Vedra if no ZIP heard
    const resolvedCategory = category || 'general';
    const categoryLabel    = resolvedCategory.replace(/_/g, ' ');
    const isUncertain      = !category; // no keyword matched — we're guessing

    // ── POS ORDER PATH ─────────────────────────────────────────────────────
    // If the caller names a specific business or category maps to a POS-connected
    // business in this ZIP, route to posRouter for a real order.
    // Otherwise fall through to the RFQ path.
    if (!isUncertain) {
      try {
        const db         = require('./db');
        const posRouter  = require('./posRouter');
        // Find a business in this ZIP with a POS integration that matches category
        const candidates = await db.query(
          `SELECT business_id, name, pos_type
           FROM businesses
           WHERE zip = $1
             AND pos_type IS NOT NULL
             AND pos_type != ''
             AND status != 'inactive'
             AND (category ILIKE $2 OR category_group ILIKE $2 OR name ILIKE $3)
           LIMIT 1`,
          [resolvedZip, `%${resolvedCategory}%`, `%${text.slice(0, 30)}%`]
        );
        if (candidates.length > 0) {
          const biz = candidates[0];
          console.log(`[voiceIntake] POS order path → ${biz.name} (${biz.pos_type})`);
          const result = await posRouter.placeOrder({
            businessId:    biz.business_id,
            orderText:     text,
            customerPhone: callerPhone,
          });
          if (result.ok) {
            const itemList = result.matched.map(m => `${m.name}`).join(' and ');
            const xml = twiml(
              `Got it${name ? ', ' + name : ''}! ` +
              `I've placed your order for ${itemList} — total $${result.total}. ` +
              `${result.sms?.sent ? 'A payment link has been sent to your phone. ' : ''}` +
              `${biz.name} will have it ready for you. Goodbye!`
            );
            return { contentType: 'text/xml', body: xml };
          } else if (result.reason === 'no_menu_match' && result.menuSample) {
            // Tell caller what's available, gather again
            const menuStr = result.menuSample.join(', ');
            const xml = twiml(
              `I couldn't find that item. Here's what's available: ${menuStr}. What would you like?`,
              { action: '/api/voice/process' }
            );
            return { contentType: 'text/xml', body: xml };
          }
          // Other failures fall through to RFQ
          console.log('[voiceIntake] posRouter result not ok:', result.reason, '— falling through to RFQ');
        }
      } catch (e) {
        console.error('[voiceIntake] posRouter error:', e.message, '— falling through to RFQ');
      }
    }

    // ── Pre-check: quick synchronous lookup so we can give the caller real info ──
    let matchPreview = null;
    if (!isUncertain && resolvedZip && resolvedCategory) {
      try {
        const db = require('./db');
        const previewRows = await db.query(
          `SELECT name, phone
           FROM businesses
           WHERE zip = $1
             AND status != 'inactive'
             AND (category ILIKE $2 OR category_group ILIKE $2)
           ORDER BY (claimed_at IS NOT NULL) DESC, confidence_score DESC
           LIMIT 3`,
          [resolvedZip, `%${resolvedCategory}%`]
        );
        if (previewRows.length > 0) {
          matchPreview = {
            count: previewRows.length,
            topName: previewRows[0].name,
            topPhone: previewRows[0].phone || null,
          };
        }
      } catch (e) {
        console.warn('[voiceIntake] pre-check error:', e.message);
      }
    }

    // Post async — don't block the TwiML response
    postVoiceRfq({
      category: resolvedCategory,
      zip: resolvedZip,
      description,
      callerPhone,
      callerName: name,
    }).catch(e => console.error('[voiceIntake] async rfq error:', e.message));

    let responseText;
    if (isUncertain) {
      // Log to rfq_gaps so self-improvement batch can pick this up later
      try {
        const db = require('./db');
        await db.query(`
          ALTER TABLE rfq_gaps ADD COLUMN IF NOT EXISTS raw_text TEXT;
          ALTER TABLE rfq_gaps ADD COLUMN IF NOT EXISTS source TEXT;
        `).catch(() => {});
        await db.query(
          `INSERT INTO rfq_gaps (category, zip, job_type, requested, matched, verified, raw_text, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          ['unknown', resolvedZip, 'voice', 1, 0, 0, text, 'voice_intake']
        );
        console.log('[voiceIntake] gap logged for self-improvement:', text?.slice(0, 60));
      } catch (e) {
        console.warn('[voiceIntake] gap log error:', e.message);
      }

      // Be honest about uncertainty but still tell them what ZIP we're covering
      responseText =
        `Thanks${name ? ', ' + name : ''}. I heard you but want to be upfront — ` +
        `I wasn't sure exactly which service you need. ` +
        `I've logged your request${resolvedZip ? ' in ' + resolvedZip : ''} and our team will follow up with you directly. ` +
        `You can also visit the local intel dot com to browse available services. Goodbye!`;
    } else if (matchPreview) {
      // We found real businesses — tell the caller who and how many
      const countPhrase = matchPreview.count === 1
        ? `1 ${categoryLabel} provider`
        : `${matchPreview.count} ${categoryLabel} providers`;
      responseText =
        `Got it${name ? ', ' + name : ''}! ` +
        `I found ${countPhrase} in ${resolvedZip || 'your area'}. ` +
        `${timing ? 'For ' + timing + '. ' : ''}` +
        `${matchPreview.topName} is your top match and has been sent your request. ` +
        `Expect a call back${matchPreview.topPhone ? ' from ' + matchPreview.topPhone : ''} shortly. Goodbye!`;
    } else {
      // No businesses found in DB for this category — be honest
      responseText =
        `Got it${name ? ', ' + name : ''}! ` +
        `I don't have a verified ${categoryLabel} provider in ${resolvedZip || 'your area'} yet, ` +
        `but I've logged your request and our team will source one for you. ` +
        `${timing ? 'Timing noted: ' + timing + '. ' : ''}` +
        `You'll receive a follow-up shortly. Goodbye!`;
    }

    const xml = twiml(responseText);
    return { contentType: 'text/xml', body: xml };
  }

  // Not enough info — ask again
  const xml = twiml(
    'I didn\'t quite catch that. Tell me your name, where you are, and what service you need — ' +
    'for example: my name is Bob, I live in Ponte Vedra, I need my lawn mowed this Saturday.',
    { action: '/api/voice/process' }
  );
  return { contentType: 'text/xml', body: xml };
}

module.exports = { handleIncoming, parseIntent, extractCategory, extractZip, extractName };
