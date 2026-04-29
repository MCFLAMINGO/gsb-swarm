/**
 * surgeAgent.js
 * LocalIntel ↔ Surge/Basalt integration
 *
 * Handles:
 *   - fetchMenu(businessId)        — GET /api/inventory
 *   - createOrder(businessId, items) — POST /api/orders
 *   - getPaymentUrl(receiptId)     — /pay/{receiptId}
 *   - sendPaymentSms(to, payUrl, orderSummary) — Twilio SMS
 *
 * Credentials: decrypted from businesses.pos_config (pos_type='other', system_name='Surge')
 */

'use strict';

const db             = require('./db');
const { decryptPosConfig } = require('./posDecrypt');

const SURGE_BASE = 'https://surge.basalthq.com';

// ── Get decrypted Surge API key for a business ────────────────────────────────
async function getSurgeKey(businessId) {
  const [biz] = await db.query(
    `SELECT pos_config FROM businesses WHERE business_id = $1 LIMIT 1`,
    [businessId]
  );
  if (!biz?.pos_config) throw new Error('no POS config for business');

  const creds = decryptPosConfig(biz.pos_config);

  // Support both 'other' (system_name=Surge) and future dedicated 'surge' type
  const key = creds.api_key || creds.apim_key || creds.subscription_key;
  if (!key) throw new Error('no Surge API key found in POS config');
  return key;
}

// ── Fetch live menu from Surge inventory ─────────────────────────────────────
// Public read: pass merchant wallet address via x-wallet header (no APIM key needed)
// Authenticated read: use APIM key from pos_config
async function fetchMenu(businessId) {
  // Try to get wallet address from agent_registry for public read
  let walletAddr = null;
  try {
    const [reg] = await db.query(
      `SELECT deposit_address FROM agent_registry WHERE business_id = $1 LIMIT 1`,
      [businessId]
    );
    walletAddr = reg?.deposit_address || null;
  } catch (_) {}

  // Build headers — prefer public wallet read, fall back to APIM key
  let headers = { 'Content-Type': 'application/json' };
  if (walletAddr) {
    headers['x-wallet'] = walletAddr;
  } else {
    const apiKey = await getSurgeKey(businessId);
    headers['Ocp-Apim-Subscription-Key'] = apiKey;
  }

  const res = await fetch(`${SURGE_BASE}/api/inventory`, { headers });

  if (!res.ok) {
    // Fallback: if public wallet read failed, try APIM key
    if (walletAddr) {
      console.warn('[surgeAgent] public wallet read failed, trying APIM key');
      const apiKey = await getSurgeKey(businessId);
      const res2 = await fetch(`${SURGE_BASE}/api/inventory`, {
        headers: {
          'Ocp-Apim-Subscription-Key': apiKey,
          'Content-Type': 'application/json',
        },
      });
      if (!res2.ok) {
        const body = await res2.text();
        throw new Error(`Surge inventory fetch failed: ${res2.status} ${body.slice(0, 200)}`);
      }
      const data2 = await res2.json();
      console.log(`[surgeAgent] fetched ${(data2.items || data2).length || '?'} items for ${businessId}`);
      return data2;
    }
    const body = await res.text();
    throw new Error(`Surge inventory fetch failed: ${res.status} ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  console.log(`[surgeAgent] fetched ${(data.items || data).length || '?'} items for business ${businessId}`);
  return data;
}

// ── Match customer intent to menu item ───────────────────────────────────────
function matchMenuItem(menuData, query) {
  const items = menuData.items || menuData || [];
  if (!Array.isArray(items)) return null;

  const q = query.toLowerCase();
  // Exact name match first
  let match = items.find(i => i.name?.toLowerCase() === q);
  // Partial match fallback
  if (!match) match = items.find(i => i.name?.toLowerCase().includes(q) || q.includes(i.name?.toLowerCase()));
  return match || null;
}

// ── Create order on Surge ─────────────────────────────────────────────────────
async function createOrder(businessId, items, jurisdictionCode = 'US-FL') {
  // items: [{ sku: 'ITEM-001', qty: 1 }, ...]
  const apiKey = await getSurgeKey(businessId);

  const res = await fetch(`${SURGE_BASE}/api/orders`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ items, jurisdictionCode }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Surge order failed: ${res.status} ${body.slice(0, 200)}`);
  }

  const order = await res.json();
  console.log(`[surgeAgent] order created — receiptId: ${order.receiptId || order.id}`);
  return order;
}

// ── Get payment URL ───────────────────────────────────────────────────────────
function getPaymentUrl(receiptId) {
  return `${SURGE_BASE}/portal/${receiptId}`;
}

// ── Send payment link via Twilio SMS ─────────────────────────────────────────
async function sendPaymentSms(toPhone, payUrl, orderSummary) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_FROM_NUMBER || '+19045067476';

  if (!sid || !token) {
    console.warn('[surgeAgent] Twilio creds missing — SMS not sent');
    return { sent: false, reason: 'twilio_not_configured' };
  }

  const body = `Your LocalIntel order:\n${orderSummary}\n\nPay here:\n${payUrl}\n\nReply CANCEL to cancel.`;

  const params = new URLSearchParams({
    To:   toPhone,
    From: from,
    Body: body,
  });

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    }
  );

  const result = await res.json();
  if (result.error_code) {
    console.error('[surgeAgent] SMS error:', result.message);
    return { sent: false, reason: result.message };
  }
  console.log(`[surgeAgent] SMS sent to ${toPhone} — sid: ${result.sid}`);
  return { sent: true, sms_sid: result.sid };
}

// ── Full order flow: match → create order → send SMS ─────────────────────────
async function placeOrderFromVoice({ businessId, customerPhone, orderText, jurisdictionCode }) {
  // 1. Fetch menu
  const menu = await fetchMenu(businessId);
  const items = menu.items || menu || [];

  // 2. Match items from order text
  const words    = orderText.toLowerCase().split(/\s+/);
  const matched  = [];
  const unmatched = [];

  // Try full phrase first, then individual words
  const match = matchMenuItem(menu, orderText);
  if (match) {
    matched.push({ sku: match.sku, qty: 1, name: match.name, price: match.priceUsd });
  } else {
    // Try word by word
    for (const word of words) {
      if (word.length < 3) continue;
      const m = matchMenuItem(menu, word);
      if (m && !matched.find(x => x.sku === m.sku)) {
        matched.push({ sku: m.sku, qty: 1, name: m.name, price: m.priceUsd });
      } else if (!m) {
        unmatched.push(word);
      }
    }
  }

  if (!matched.length) {
    return {
      ok: false,
      reason: 'no_menu_match',
      message: `We couldn't match "${orderText}" to any item on the menu. Please call back and try item names like "${items.slice(0,3).map(i=>i.name).join('", "')}"`,
      menu_items: items.slice(0, 10),
    };
  }

  // 3. Create order
  const orderItems = matched.map(m => ({ sku: m.sku, qty: m.qty }));
  const order      = await createOrder(businessId, orderItems, jurisdictionCode);
  const receiptId  = order.receiptId || order.id;
  const payUrl     = getPaymentUrl(receiptId);

  // 4. Build summary
  const summary = matched.map(m => `${m.name} x${m.qty}${m.price ? ` — $${m.price}` : ''}`).join('\n');
  const total   = order.total || order.totalUsd || matched.reduce((s, m) => s + (m.price || 0), 0);

  // 5. Send SMS if phone provided
  let smsResult = { sent: false };
  if (customerPhone) {
    smsResult = await sendPaymentSms(customerPhone, payUrl, `${summary}\nTotal: $${total}`);
  }

  return {
    ok: true,
    receiptId,
    payUrl,
    matched,
    unmatched,
    summary,
    total,
    sms: smsResult,
  };
}

// ── Poll receipt status ───────────────────────────────────────────────────────
async function getReceiptStatus(businessId, receiptId) {
  const apiKey = await getSurgeKey(businessId);
  const res    = await fetch(`${SURGE_BASE}/api/receipts/status?receiptId=${receiptId}`, {
    headers: { 'Ocp-Apim-Subscription-Key': apiKey },
  });
  if (!res.ok) throw new Error(`Surge status check failed: ${res.status}`);
  return res.json();
}

// ── Verify Surge webhook signature (HMAC-SHA256 with APIM key) ────────────────
function verifyWebhookSignature(rawBody, signature, apimKey) {
  const crypto   = require('crypto');
  const expected = crypto.createHmac('sha256', apimKey).update(rawBody).digest('hex');
  return expected === signature;
}

module.exports = {
  fetchMenu,
  matchMenuItem,
  createOrder,
  getPaymentUrl,
  getReceiptStatus,
  verifyWebhookSignature,
  sendPaymentSms,
  placeOrderFromVoice,
};
