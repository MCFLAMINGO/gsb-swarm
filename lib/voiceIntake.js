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
  // Food & delivery — all map to 'restaurant' so Postgres category match works
  'catering':     'catering',    'cater':        'catering',
  'food truck':   'catering',
  'deliver':      'restaurant',  'delivery':     'restaurant',
  'bring me':     'restaurant',  'bring to':     'restaurant',
  'drop off':     'restaurant',  'drop it':      'restaurant',
  'pick up':      'restaurant',  'pickup':       'restaurant',
  'order food':   'restaurant',  'food deliver': 'restaurant',
  'restaurant':   'restaurant',  'takeout':      'restaurant',
  'take out':     'restaurant',  'food from':    'restaurant',
  'mcflaming':    'restaurant',  'flamingo':     'restaurant',
  'order':        'restaurant',  'food':         'restaurant',
  'eat':          'restaurant',  'hungry':       'restaurant',
  'lunch':        'restaurant',  'dinner':       'restaurant',
  'breakfast':    'restaurant',  'meal':         'restaurant',
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
async function handleIncoming({ stage, speechResult, callerPhone, callSid }) {
  const voiceSession = require('./voiceSession');

  // ── Stage 1: Greeting — just gather their speech ──────────────────────────
  if (stage === 'greeting' || !speechResult) {
    // Clear any stale session from a previous call on this SID
    if (callSid) await voiceSession.clearSession(callSid).catch(() => {});
    const xml = twiml(
      'Welcome to LocalIntel. Tell me your name, where you are, and what you need — ' +
      'or tell me about your business to get found by AI.',
      { action: '/api/voice/process' }
    );
    return { contentType: 'text/xml', body: xml };
  }

  // ── Resume existing session if one exists for this CallSid ───────────────
  if (callSid) {
    const session = await voiceSession.get(callSid).catch(() => null);

    if (session && session.stage === 'menu_presented' && session.business_id) {
      // Caller just heard the menu — they're now naming an item
      return handleMenuResponse({ session, speechResult, callerPhone, callSid, voiceSession });
    }

    if (session && session.stage === 'order_building' && session.business_id) {
      // Cart has items — check if adding more or done
      return handleOrderBuilding({ session, speechResult, callerPhone, callSid, voiceSession });
    }
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
          `SELECT business_id, name, pos_config->>'pos_type' AS pos_type
           FROM businesses
           WHERE zip = $1
             AND pos_config IS NOT NULL
             AND pos_config->>'pos_type' IS NOT NULL
             AND pos_config->>'pos_type' != ''
             AND status != 'inactive'
             AND (category ILIKE $2 OR category_group ILIKE $2 OR name ILIKE $3)
           LIMIT 1`,
          [resolvedZip, `%${resolvedCategory}%`, `%${text.slice(0, 30)}%`]
        );
        if (candidates.length > 0) {
          const biz = candidates[0];
          console.log(`[voiceIntake] POS order path → ${biz.name} (${biz.pos_type})`);

          // Fetch menu first so we can present it and lock the session
          const { fetchMenu } = posRouter;
          const { items: menuItems } = fetchMenu
            ? await fetchMenu(biz.business_id).catch(() => ({ items: [] }))
            : { items: [] };

          if (menuItems && menuItems.length > 0) {
            // Try to match the item they named right away
            const { matchItems } = posRouter;
            const { matched } = matchItems ? matchItems(menuItems, text) : { matched: [] };

            if (matched.length > 0) {
              // Direct hit — store session as order_building, add to cart
              if (callSid) {
                await voiceSession.save(callSid, {
                  caller_phone:  callerPhone,
                  stage:         'order_building',
                  business_id:   biz.business_id,
                  business_name: biz.name,
                  zip:           resolvedZip,
                  category:      resolvedCategory,
                  cart:          matched.map(m => ({ sku: m.sku, name: m.name, qty: m.qty || 1, priceUsd: m.priceUsd })),
                }).catch(() => {});
              }
              const itemList = matched.map(m => m.name).join(' and ');
              const cartTot  = voiceSession.cartTotal(matched.map(m => ({ ...m, qty: m.qty || 1 })));
              const xml = twiml(
                `Got it${name ? ', ' + name : ''}! I have ${itemList} — $${cartTot.toFixed(2)}. ` +
                `Would you like anything else, or should I place the order?`,
                { action: '/api/voice/process' }
              );
              return { contentType: 'text/xml', body: xml };
            } else {
              // No item match — present menu and lock session
              if (callSid) {
                await voiceSession.save(callSid, {
                  caller_phone:  callerPhone,
                  stage:         'menu_presented',
                  business_id:   biz.business_id,
                  business_name: biz.name,
                  zip:           resolvedZip,
                  category:      resolvedCategory,
                  cart:          [],
                }).catch(() => {});
              }
              const menuStr = menuItems.slice(0, 6).map(i =>
                `${i.name}${i.priceUsd ? ' — $' + i.priceUsd.toFixed(2) : ''}`
              ).join(', ');
              const xml = twiml(
                `${biz.name} has: ${menuStr}. What would you like?`,
                { action: '/api/voice/process' }
              );
              return { contentType: 'text/xml', body: xml };
            }
          }

          // No menu items — fall through to original placeOrder path
          const result = await posRouter.placeOrder({
            businessId:    biz.business_id,
            orderText:     text,
            customerPhone: callerPhone,
          });
          if (result.ok) {
            if (callSid) await voiceSession.clearSession(callSid).catch(() => {});
            const itemList = result.matched.map(m => `${m.name}`).join(' and ');
            const xml = twiml(
              `Got it${name ? ', ' + name : ''}! ` +
              `I've placed your order for ${itemList} — total $${result.total}. ` +
              `${result.sms?.sent ? 'A payment link has been sent to your phone. ' : ''}` +
              `${biz.name} will have it ready for you. Goodbye!`
            );
            return { contentType: 'text/xml', body: xml };
          } else if (result.reason === 'no_menu_match' && result.menuSample) {
            const menuStr = result.menuSample.join(', ');
            const xml = twiml(
              `${biz.name} has: ${menuStr}. What would you like?`,
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

      // Be honest about uncertainty — but still fire an SMS and alert erik
      await sendSms(
        callerPhone,
        `LocalIntel: We received your request${resolvedZip ? ' in ' + resolvedZip : ''} ` +
        `but need more detail to match you with the right provider. ` +
        `Reply with your service need and ZIP, or visit thelocalintel.com`
      ).catch(() => {});
      await sendSms(
        process.env.OWNER_ALERT_PHONE || '+19045867887',
        `[LocalIntel ALERT] Unmatched voice request from ${callerPhone}: "${(text || '').slice(0, 120)}" ZIP: ${resolvedZip || 'unknown'}`
      ).catch(() => {});
      responseText =
        `Thanks${name ? ', ' + name : ''}. I heard you but wasn't sure exactly which service you need. ` +
        `I've sent you a text so you can reply with more detail, and we'll get you matched. Goodbye!`;
    } else if (matchPreview) {
      // We found real businesses — tell the caller who and how many
      const countPhrase = matchPreview.count === 1
        ? `1 ${categoryLabel} provider`
        : `${matchPreview.count} ${categoryLabel} providers`;
      responseText =
        `Got it${name ? ', ' + name : ''}! ` +
        `I found ${countPhrase} in ${resolvedZip || 'your area'}. ` +
        `${timing ? 'For ' + timing + '. ' : ''}` +
        `${matchPreview.topName} is your top match and has been notified. ` +
        `You'll receive a text confirmation right now, and the provider will reach out shortly. Goodbye!`;
    } else {
      // No businesses found in DB for this category — be honest
      responseText =
        `Got it${name ? ', ' + name : ''}! ` +
        `I don't have a verified ${categoryLabel} provider in ${resolvedZip || 'your area'} yet. ` +
        `${timing ? 'Timing noted: ' + timing + '. ' : ''}` +
        `I've logged your request and you'll get a text from us shortly. Goodbye!`;
      // Alert erik on no-match so the gap is visible
      await sendSms(
        process.env.OWNER_ALERT_PHONE || '+19045867887',
        `[LocalIntel GAP] No ${resolvedCategory} in ZIP ${resolvedZip || 'unknown'} — caller ${callerPhone}${timing ? ', timing: ' + timing : ''}`
      ).catch(() => {});
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

// ── DONE intent detection ────────────────────────────────────────────────────
const DONE_RE = /^(no+pe?|that'?s? it|place|done|go ahead|nothing|just that|place it|confirm|check ?out|finish|that'?s all|all done|yes place|yeah place)/i;

/**
 * handleMenuResponse
 * Caller just heard the menu and is naming an item.
 * session.stage === 'menu_presented', session.business_id is locked.
 */
async function handleMenuResponse({ session, speechResult, callerPhone, callSid, voiceSession }) {
  try {
    const posRouter = require('./posRouter');
    const { items } = await posRouter.fetchMenu(session.business_id).catch(() => ({ items: [] }));

    if (!items || !items.length) {
      // Can't get menu — fall back to RFQ gracefully
      await voiceSession.clearSession(callSid).catch(() => {});
      const xml = twiml(
        `Sorry, I couldn't load the menu for ${session.business_name} right now. Please try again.`
      );
      return { contentType: 'text/xml', body: xml };
    }

    const { matched } = posRouter.matchItems(items, speechResult);

    if (matched.length > 0) {
      // Add to cart, advance to order_building
      for (const m of matched) {
        await voiceSession.addToCart(callSid, { sku: m.sku, name: m.name, qty: m.qty || 1, priceUsd: m.priceUsd });
      }
      await voiceSession.save(callSid, { stage: 'order_building' });
      const updatedSession = await voiceSession.get(callSid);
      const cart    = updatedSession.cart || [];
      const total   = voiceSession.cartTotal(cart);
      const summary = voiceSession.cartSummary(cart);
      const addedNames = matched.map(m => m.name).join(' and ');
      const xml = twiml(
        `Got it — ${addedNames}, $${(matched.reduce((s, m) => s + (m.priceUsd || 0) * (m.qty || 1), 0)).toFixed(2)}. ` +
        `Your cart: ${summary} — $${total.toFixed(2)}. ` +
        `Anything else, or shall I place the order?`,
        { action: '/api/voice/process' }
      );
      return { contentType: 'text/xml', body: xml };
    } else {
      // No match — re-read a truncated menu
      const menuStr = items.slice(0, 6).map(i =>
        `${i.name}${i.priceUsd ? ' — $' + i.priceUsd.toFixed(2) : ''}`
      ).join(', ');
      const xml = twiml(
        `I didn't catch that. ${session.business_name} has: ${menuStr}. What would you like?`,
        { action: '/api/voice/process' }
      );
      return { contentType: 'text/xml', body: xml };
    }
  } catch (e) {
    console.error('[voiceIntake] handleMenuResponse error:', e.message);
    const xml = twiml(`Something went wrong. Please call back and try again.`);
    return { contentType: 'text/xml', body: xml };
  }
}

/**
 * handleOrderBuilding
 * Cart has items, caller is in the "anything else?" loop.
 * session.stage === 'order_building'.
 */
async function handleOrderBuilding({ session, speechResult, callerPhone, callSid, voiceSession }) {
  try {
    const posRouter = require('./posRouter');
    const cart      = Array.isArray(session.cart) ? session.cart : [];

    // ── Check for DONE intent first ───────────────────────────────────────────
    if (DONE_RE.test(speechResult.trim())) {
      // Fire order with existing cart directly — no re-match needed
      const db      = require('./db');
      const posRow  = await db.query(
        `SELECT pos_config->>'pos_type' AS pos_type, pos_config FROM businesses WHERE business_id = $1`,
        [session.business_id]
      );
      const posType = posRow[0] && posRow[0].pos_type;

      let orderResult = null;
      if (posType) {
        try {
          // Reconstruct orderText from cart names — matchItems will re-confirm exact hits
          const cartText = cart.map(c => Array(c.qty || 1).fill(c.name).join(' and ')).join(' and ');
          orderResult = await posRouter.placeOrder({
            businessId:    session.business_id,
            orderText:     cartText,
            customerPhone: callerPhone,
          });
        } catch (e) {
          console.error('[voiceIntake] handleOrderBuilding placeOrder error:', e.message);
        }
      }

      await voiceSession.clearSession(callSid).catch(() => {});

      let finalText;
      if (orderResult && orderResult.ok) {
        finalText =
          `Perfect! Your order from ${session.business_name}: ` +
          `${voiceSession.cartSummary(cart)} — total $${orderResult.total}. ` +
          `${orderResult.sms && orderResult.sms.sent ? 'A payment link has been sent to your phone. ' : ''}` +
          `They'll have it ready for you. Goodbye!`;
      } else {
        // POS failed or unavailable — SMS a summary so the order isn't lost
        const totalFallback = voiceSession.cartTotal(cart);
        await sendSms(
          callerPhone,
          `LocalIntel: Order request from ${session.business_name} — ` +
          `${voiceSession.cartSummary(cart)}, ~$${totalFallback.toFixed(2)}. ` +
          `We'll confirm with the restaurant. Reply CANCEL to cancel.`
        ).catch(() => {});
        await sendSms(
          process.env.OWNER_ALERT_PHONE || '+19045867887',
          `[LocalIntel ORDER] ${callerPhone} → ${session.business_name}: ` +
          `${voiceSession.cartSummary(cart)} $${totalFallback.toFixed(2)}` +
          (orderResult ? ` | reason: ${orderResult.reason}` : ' | no pos result')
        ).catch(() => {});
        finalText =
          `Got it! I've noted your order for ${voiceSession.cartSummary(cart)} from ${session.business_name}. ` +
          `We've sent you a text to confirm. Goodbye!`;
      }

      const xml = twiml(finalText);
      return { contentType: 'text/xml', body: xml };
    }

    // ── Not done — try to match more items ───────────────────────────────────
    const { items } = await posRouter.fetchMenu(session.business_id).catch(() => ({ items: [] }));
    const { matched } = items.length ? posRouter.matchItems(items, speechResult) : { matched: [] };

    if (matched.length > 0) {
      for (const m of matched) {
        await voiceSession.addToCart(callSid, { sku: m.sku, name: m.name, qty: m.qty || 1, priceUsd: m.priceUsd });
      }
      const updatedSession = await voiceSession.get(callSid);
      const updatedCart  = updatedSession.cart || [];
      const total        = voiceSession.cartTotal(updatedCart);
      const summary      = voiceSession.cartSummary(updatedCart);
      const addedNames   = matched.map(m => m.name).join(' and ');
      const xml = twiml(
        `Added ${addedNames}. Your cart: ${summary} — $${total.toFixed(2)}. Anything else?`,
        { action: '/api/voice/process' }
      );
      return { contentType: 'text/xml', body: xml };
    } else {
      // Didn't understand — remind them of cart and ask again
      const total   = voiceSession.cartTotal(cart);
      const summary = voiceSession.cartSummary(cart);
      const xml = twiml(
        `I didn't catch that. Your cart has ${summary} — $${total.toFixed(2)}. ` +
        `Want to add anything, or place the order?`,
        { action: '/api/voice/process' }
      );
      return { contentType: 'text/xml', body: xml };
    }
  } catch (e) {
    console.error('[voiceIntake] handleOrderBuilding error:', e.message);
    const xml = twiml(`Something went wrong. Please call back and try again.`);
    return { contentType: 'text/xml', body: xml };
  }
}

module.exports = { handleIncoming, handleMenuResponse, handleOrderBuilding, parseIntent, extractCategory, extractZip, extractName };
