'use strict';
/**
 * squareAgent.js
 * LocalIntel ↔ Square POS integration
 *
 * STUB — ready for credentials.
 * Each business stores their own Square credentials in businesses.pos_config:
 *   { access_token, location_id }
 *
 * Square Catalog API: https://developer.squareup.com/reference/square/catalog-api
 * Square Orders API:  https://developer.squareup.com/reference/square/orders-api
 *
 * To activate: business pastes Square access token + location ID in thelocalintel.com/claim
 * pos_type is set to 'square', credentials encrypted in pos_config.
 */

const db = require('./db');
const { decryptPosConfig } = require('./posDecrypt');

const SQUARE_BASE = 'https://connect.squareup.com'; // prod; use squareupsandbox.com for dev

async function getSquareCreds(businessId) {
  const rows = await db.query(
    `SELECT pos_config FROM businesses WHERE business_id = $1 LIMIT 1`,
    [businessId]
  );
  if (!rows.length || !rows[0].pos_config) throw new Error('no Square config');
  const creds = decryptPosConfig(rows[0].pos_config);
  if (!creds.access_token || !creds.location_id) throw new Error('incomplete Square credentials');
  return creds;
}

async function fetchMenu(businessId) {
  const creds = await getSquareCreds(businessId);

  const res = await fetch(`${SQUARE_BASE}/v2/catalog/list?types=ITEM`, {
    headers: {
      'Authorization': `Bearer ${creds.access_token}`,
      'Content-Type':  'application/json',
      'Square-Version': '2024-01-17',
    },
  });
  if (!res.ok) throw new Error(`Square catalog fetch failed: ${res.status}`);
  const data = await res.json();
  return { items: data.objects || [] };
}

async function createOrder(businessId, items, opts = {}) {
  const creds = await getSquareCreds(businessId);

  const lineItems = items.map(i => ({
    quantity:       String(i.qty || 1),
    catalog_object_id: i.sku,
  }));

  const idempotencyKey = `li-${businessId}-${Date.now()}`;

  const res = await fetch(`${SQUARE_BASE}/v2/orders`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${creds.access_token}`,
      'Content-Type':  'application/json',
      'Square-Version': '2024-01-17',
    },
    body: JSON.stringify({
      idempotency_key: idempotencyKey,
      order: {
        location_id: creds.location_id,
        line_items:  lineItems,
        source: { name: 'LocalIntel' },
      },
    }),
  });
  if (!res.ok) throw new Error(`Square order failed: ${res.status}`);
  const data = await res.json();
  const order = data.order;
  const total = (order?.total_money?.amount || 0) / 100;

  // Square Checkout link (requires Checkout API — optional)
  const payUrl = creds.checkout_page_url || null;

  return {
    receiptId: order?.id,
    orderId:   order?.id,
    total,
    items,
    payUrl,
    raw: order,
  };
}

function getPaymentUrl(receiptId) {
  // Square Pay links require a separate Checkout API call per business setup
  // Returned in createOrder if creds.checkout_page_url is set
  return null;
}

async function sendPaymentSms(toPhone, payUrl, summary) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_FROM_NUMBER || '+19045067476';
  if (!sid || !token) return { sent: false, reason: 'twilio_not_configured' };

  const body = payUrl
    ? `Your LocalIntel order:\n${summary}\n\nPay here: ${payUrl}`
    : `Your LocalIntel order has been placed:\n${summary}`;

  const params = new URLSearchParams({ To: toPhone, From: from, Body: body });
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    }
  );
  const result = await res.json();
  if (result.error_code) return { sent: false, reason: result.message };
  return { sent: true, sms_sid: result.sid };
}

module.exports = { fetchMenu, createOrder, getPaymentUrl, sendPaymentSms };
