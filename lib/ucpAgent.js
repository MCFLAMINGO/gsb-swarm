'use strict';
/**
 * ucpAgent.js
 * ─────────────────────────────────────────────────────────────────────────────
 * LocalIntel ↔ Universal Commerce Protocol (UCP) handler.
 *
 * Any business that advertises a UCP endpoint in pos_config.ucp_endpoint
 * uses this handler — regardless of their underlying POS (Surge, Toast, Square,
 * or any future UCP-compliant merchant). This is the preferred path.
 *
 * UCP spec: https://ucp.dev / https://github.com/Universal-Commerce-Protocol/ucp
 * Version:  2026-04-08
 *
 * Capabilities implemented:
 *   dev.ucp.shopping.checkout   — checkout-sessions create/update/complete
 *   dev.ucp.shopping.catalog    — product discovery (GET /catalog/search)
 *   dev.ucp.shopping.ap2_mandate— Tempo escrow as cryptographic mandate (stub→live)
 *
 * Checkout-session state machine:
 *   created → active → completed | expired | cancelled
 *
 * pos_config fields used:
 *   ucp_endpoint   — base URL e.g. https://surge.basalthq.com
 *   ucp_api_key    — Ocp-Apim-Subscription-Key or Bearer token
 *   ucp_wallet     — merchant wallet address (optional, for public reads)
 *   ucp_version    — protocol version (default: 2026-04-08)
 *   ap2_mandate_key— private key for signing AP2 mandates (Tempo path)
 */

const db                 = require('./db');
const { decryptPosConfig } = require('./posDecrypt');

const UCP_VERSION = '2026-04-08';

// ── Get UCP credentials for a business ───────────────────────────────────────
async function getUcpCreds(businessId) {
  const rows = await db.query(
    `SELECT pos_config, wallet FROM businesses WHERE business_id = $1 LIMIT 1`,
    [businessId]
  );
  if (!rows.length) throw new Error(`business ${businessId} not found`);
  const { pos_config, wallet } = rows[0];
  if (!pos_config) throw new Error(`no pos_config for business ${businessId}`);

  const creds = decryptPosConfig(pos_config);

  // Resolve endpoint — explicit ucp_endpoint wins, fallback to known Surge base
  const endpoint = creds.ucp_endpoint || 'https://surge.basalthq.com';

  // Resolve auth header — support APIM key (Surge) or Bearer token (generic UCP)
  const apiKey = creds.ucp_api_key || creds.apim_key || creds.api_key || creds.subscription_key;

  return {
    endpoint,
    apiKey,
    wallet:     wallet || creds.ucp_wallet || null,
    version:    creds.ucp_version || UCP_VERSION,
    ap2Key:     creds.ap2_mandate_key || null,
  };
}

// ── Build auth headers ────────────────────────────────────────────────────────
function authHeaders(creds) {
  const h = { 'Content-Type': 'application/json', 'UCP-Version': creds.version };
  if (creds.apiKey) {
    // Surge uses Ocp-Apim-Subscription-Key; generic UCP uses Bearer
    h['Ocp-Apim-Subscription-Key'] = creds.apiKey;
  }
  if (creds.wallet) {
    h['X-Wallet'] = creds.wallet;
  }
  // Advertise LocalIntel as UCP platform agent
  h['UCP-Agent'] = 'profile="https://www.thelocalintel.com/.well-known/ucp-agent"';
  return h;
}

// ── fetchMenu via UCP Catalog ─────────────────────────────────────────────────
/**
 * Fetches live inventory/catalog from the UCP endpoint.
 * Falls back to /api/inventory (Surge-specific) if catalog search not available.
 *
 * Returns { items: [{ sku, name, priceUsd, available, category, description }] }
 */
async function fetchMenu(businessId) {
  const creds = await getUcpCreds(businessId);

  // Try UCP catalog search first (standard path)
  try {
    const res = await fetch(`${creds.endpoint}/api/ucp/catalog/search`, {
      method:  'POST',
      headers: authHeaders(creds),
      body:    JSON.stringify({ query: '', limit: 200 }),
    });
    if (res.ok) {
      const data = await res.json();
      const items = (data.items || data.products || data.results || []);
      if (items.length) {
        console.log(`[ucpAgent] catalog/search returned ${items.length} items for ${businessId}`);
        return { items: items.map(normalizeItem) };
      }
    }
  } catch (_) {}

  // Fall back to /api/inventory (Surge-compatible)
  const res = await fetch(`${creds.endpoint}/api/inventory`, {
    headers: authHeaders(creds),
  });
  if (!res.ok) throw new Error(`UCP fetchMenu failed: ${res.status}`);
  const data = await res.json();
  const raw = data.items || data || [];
  console.log(`[ucpAgent] /api/inventory returned ${raw.length} items for ${businessId}`);
  return { items: raw.map(normalizeItem) };
}

// ── Normalize a catalog item to posRouter contract ────────────────────────────
function normalizeItem(item) {
  // Base price — Surge stores $0 on the parent item when price lives in modifiers
  let priceUsd = item.priceUsd || item.price || item.amount || 0;

  // Surge modifier pattern: attributes.modifierGroups[].modifiers[].priceAdjustment
  // When base price is 0, sum the default modifier prices as the effective price.
  // If no default is marked, use the first required modifier's first option.
  const modGroups = item.attributes?.modifierGroups || item.modifierGroups || [];
  if (priceUsd === 0 && modGroups.length > 0) {
    let modTotal = 0;
    for (const group of modGroups) {
      const mods = group.modifiers || [];
      // Prefer modifiers flagged default; fall back to first in a required group
      const defaults = mods.filter(m => m.default && m.available !== false);
      const candidates = defaults.length > 0
        ? defaults
        : (group.required ? mods.filter(m => m.available !== false).slice(0, 1) : []);
      for (const m of candidates) {
        modTotal += (m.priceAdjustment || m.price || 0);
      }
    }
    if (modTotal > 0) priceUsd = modTotal;
  }

  // Flatten modifiers as variant options for voice readback
  const variants = modGroups.flatMap(g =>
    (g.modifiers || []).map(m => ({
      name:            m.name,
      priceAdjustment: m.priceAdjustment || 0,
      modifierId:      m.id,
      groupId:         g.id,
      groupName:       g.name,
      required:        g.required || false,
      default:         m.default  || false,
    }))
  );

  return {
    sku:         item.sku        || item.id   || String(Math.random()),
    name:        item.name       || item.title || 'Item',
    priceUsd,
    available:   item.available  !== false && item.stockQty !== 0,
    category:    item.category   || item.type  || 'general',
    description: item.description || '',
    imageUrl:    item.imageUrl   || item.image  || null,
    variants:    variants.length ? variants : undefined,
  };
}

// ── createOrder via UCP checkout-sessions ─────────────────────────────────────
/**
 * Full UCP checkout-sessions flow:
 *   1. POST /api/ucp/checkout-sessions   — create session with line items
 *   2. (optional) PATCH /:id             — update if needed
 *   3. POST /:id/complete                — submit payment instrument
 *
 * For agent-autonomous orders (no human in loop), we use the AP2 mandate path.
 * For voice/SMS orders, we create the session and return the continue_url or
 * portal URL for the customer to complete payment.
 *
 * @param {string} businessId
 * @param {Array}  items  — [{ sku, qty }]
 * @param {object} opts   — { jurisdictionCode, customerPhone, agentMode }
 */
async function createOrder(businessId, items, opts = {}) {
  const creds = await getUcpCreds(businessId);
  const { jurisdictionCode = 'US-FL', agentMode = false } = opts;

  // ── Step 1: Create checkout session ──────────────────────────────────────
  // UCP line item format: { id: "inventory:<SKU>", qty: N }
  const lineItems = items.map(i => ({
    id:  i.sku.startsWith('inventory:') ? i.sku : `inventory:${i.sku}`,
    qty: i.qty || 1,
  }));

  const sessionBody = {
    items: lineItems,
    jurisdiction: jurisdictionCode,
    signals: {
      'dev.ucp.buyer_ip':    '0.0.0.0', // voice caller — no IP
      'dev.ucp.user_agent':  'LocalIntel-VoiceAgent/1.0',
      'dev.ucp.channel':     agentMode ? 'agent' : 'voice',
    },
  };

  // If agent mode + AP2 key available, attach mandate
  if (agentMode && creds.ap2Key) {
    sessionBody.ap2 = buildAp2Mandate(creds.ap2Key, lineItems, jurisdictionCode);
  }

  const createRes = await fetch(`${creds.endpoint}/api/ucp/checkout-sessions`, {
    method:  'POST',
    headers: authHeaders(creds),
    body:    JSON.stringify(sessionBody),
  });

  if (!createRes.ok) {
    const body = await createRes.text();
    // 402 = payment required — L402/x402 flow
    if (createRes.status === 402) {
      return handle402(createRes, body, businessId, lineItems, creds);
    }
    throw new Error(`UCP checkout-session create failed: ${createRes.status} ${body.slice(0, 200)}`);
  }

  const session = await createRes.json();
  const sessionId = session.id || session.session_id;
  console.log(`[ucpAgent] checkout-session created: ${sessionId} for ${businessId}`);

  // ── Step 2: For agent-autonomous payment (no human), complete immediately ──
  if (agentMode && session.state !== 'completed') {
    return completeSession(sessionId, creds, session);
  }

  // ── Step 3: For voice/human orders, return portal URL for SMS payment link ─
  const payUrl = session.continue_url
    || session.portal_url
    || getPaymentUrl(sessionId, creds.endpoint);

  return {
    receiptId:  sessionId,
    orderId:    sessionId,
    sessionId,
    state:      session.state || 'created',
    total:      session.total?.amount || session.totalUsd || session.total || 0,
    currency:   session.total?.currency || 'USD',
    items:      session.items || lineItems,
    payUrl,
    raw:        session,
  };
}

// ── completeSession — submit payment instrument ───────────────────────────────
async function completeSession(sessionId, creds, sessionData = {}) {
  // For agent-autonomous Tempo payments, use AP2 mandate as payment credential
  // For now: return the session with payUrl for human to complete
  // TODO: wire real Tempo viem TX here — see holdTempoEscrow in dispatchRail.js
  const completeBody = {
    signals: {
      'dev.ucp.buyer_ip':   '0.0.0.0',
      'dev.ucp.user_agent': 'LocalIntel-VoiceAgent/1.0',
    },
  };

  if (creds.ap2Key) {
    // AP2 mandate path — cryptographic proof of agent authorization
    // Shape: { payment: { instruments: [{ handler_id, credential: { type: 'ap2_mandate', token } }] } }
    completeBody.payment = {
      instruments: [{
        handler_id: 'localintel_tempo_ap2',
        type:       'ap2_mandate',
        credential: {
          type:  'ap2_mandate',
          token: buildAp2Token(creds.ap2Key, sessionId),
        },
      }],
    };
    completeBody.ap2 = { checkout_mandate: buildAp2Token(creds.ap2Key, sessionId) };
  }

  try {
    const res = await fetch(
      `${creds.endpoint}/api/ucp/checkout-sessions/${sessionId}/complete`,
      {
        method:  'POST',
        headers: authHeaders(creds),
        body:    JSON.stringify(completeBody),
      }
    );
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[ucpAgent] session complete failed: ${res.status} — falling back to payUrl`);
      return {
        receiptId: sessionId,
        state:     'pending_payment',
        payUrl:    getPaymentUrl(sessionId, creds.endpoint),
        raw:       body,
      };
    }
    const result = await res.json();
    return {
      receiptId: sessionId,
      orderId:   result.order_id || sessionId,
      state:     result.state || 'completed',
      total:     result.total?.amount || result.totalUsd || 0,
      payUrl:    null, // completed — no payment URL needed
      raw:       result,
    };
  } catch (e) {
    console.error('[ucpAgent] completeSession error:', e.message);
    return {
      receiptId: sessionId,
      state:     'pending_payment',
      payUrl:    getPaymentUrl(sessionId, creds.endpoint),
    };
  }
}

// ── Handle 402 Payment Required (L402 / x402) ────────────────────────────────
async function handle402(res, body, businessId, lineItems, creds) {
  // L402: WWW-Authenticate header contains payment details
  const wwwAuth = res.headers.get('WWW-Authenticate') || '';
  const macaroon = wwwAuth.match(/macaroon="([^"]+)"/)?.[1];
  const invoice   = wwwAuth.match(/invoice="([^"]+)"/)?.[1];

  console.log(`[ucpAgent] 402 received for ${businessId} — L402 flow`);
  console.log(`[ucpAgent] macaroon: ${macaroon ? 'present' : 'absent'}, invoice: ${invoice ? 'present' : 'absent'}`);

  // TODO: pay invoice via Tempo/Lightning, then retry with L402-Payment header
  // For now: return the portal URL so human can complete
  return {
    receiptId:  null,
    state:      'payment_required',
    payUrl:     getPaymentUrl(null, creds.endpoint),
    l402:       { macaroon, invoice },
    message:    'Payment required — L402 flow. Sending SMS with payment link.',
  };
}

// ── AP2 Mandate builder (stub → Tempo viem TX) ───────────────────────────────
/**
 * Builds an AP2 mandate for autonomous agent payments.
 * Currently a signed JWT stub — will be replaced with Tempo on-chain mandate
 * when holdTempoEscrow() is live in dispatchRail.js.
 *
 * AP2 mandate proves: agent is authorized by user to make this purchase.
 * Tempo escrow proves: funds are locked until business delivers.
 * Together = trustless autonomous commerce.
 */
function buildAp2Mandate(ap2Key, lineItems, jurisdiction) {
  // Stub: returns a minimal mandate structure
  // Production: sign with ap2Key using crypto.createSign('RS256') or viem signTypedData
  const mandate = {
    version:      UCP_VERSION,
    issued_at:    new Date().toISOString(),
    platform:     'localintel',
    platform_url: 'https://www.thelocalintel.com',
    items:        lineItems,
    jurisdiction,
    // TODO: replace with real signature
    // sig: crypto.createSign('RSA-SHA256').update(JSON.stringify(payload)).sign(ap2Key, 'base64')
  };
  return Buffer.from(JSON.stringify(mandate)).toString('base64');
}

function buildAp2Token(ap2Key, sessionId) {
  const token = {
    version:    UCP_VERSION,
    session_id: sessionId,
    platform:   'localintel',
    issued_at:  new Date().toISOString(),
    // TODO: real signature
  };
  return Buffer.from(JSON.stringify(token)).toString('base64');
}

// ── getPaymentUrl ─────────────────────────────────────────────────────────────
function getPaymentUrl(sessionId, endpoint) {
  const base = endpoint || 'https://surge.basalthq.com';
  if (!sessionId) return `${base}/portal`;
  return `${base}/portal/${sessionId}`;
}

// ── getSessionStatus ──────────────────────────────────────────────────────────
async function getSessionStatus(businessId, sessionId) {
  const creds = await getUcpCreds(businessId);
  const res = await fetch(
    `${creds.endpoint}/api/ucp/checkout-sessions/${sessionId}`,
    { headers: authHeaders(creds) }
  );
  if (!res.ok) throw new Error(`UCP session status failed: ${res.status}`);
  return res.json();
}

// ── sendPaymentSms — reuse Twilio pattern ─────────────────────────────────────
async function sendPaymentSms(toPhone, payUrl, summary) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_FROM_NUMBER || '+19045067476';
  if (!sid || !token) return { sent: false, reason: 'twilio_not_configured' };

  const body = payUrl
    ? `Your LocalIntel order:\n${summary}\n\nComplete payment here:\n${payUrl}\n\nReply CANCEL to cancel.`
    : `Your LocalIntel order has been placed:\n${summary}`;

  const params = new URLSearchParams({ To: toPhone, From: from, Body: body });
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method:  'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    }
  );
  const result = await res.json();
  if (result.error_code) return { sent: false, reason: result.message };
  return { sent: true, sms_sid: result.sid };
}

module.exports = {
  fetchMenu,
  createOrder,
  getPaymentUrl: (receiptId) => getPaymentUrl(receiptId, 'https://surge.basalthq.com'),
  getSessionStatus,
  sendPaymentSms,
  normalizeItem,
  // Exported for testing
  buildAp2Mandate,
};
