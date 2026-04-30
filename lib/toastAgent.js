'use strict';
/**
 * toastAgent.js
 * LocalIntel ↔ Toast POS integration
 *
 * STUB — ready for credentials.
 * Each business stores their own Toast API credentials in businesses.pos_config:
 *   { client_id, client_secret, restaurant_guid }
 *
 * Toast OAuth2 docs: https://doc.toasttab.com/openapi/authentication/
 * Toast Orders API: https://doc.toasttab.com/openapi/orders/
 *
 * To activate: business pastes Toast API credentials in thelocalintel.com/claim
 * pos_type is set to 'toast', credentials encrypted in pos_config.
 */

const db = require('./db');
const { decryptPosConfig } = require('./posDecrypt');

const TOAST_BASE = 'https://ws-sandbox.toasttab.com'; // use ws-api.toasttab.com for prod

async function getToastCreds(businessId) {
  const rows = await db.query(
    `SELECT pos_config FROM businesses WHERE business_id = $1 LIMIT 1`,
    [businessId]
  );
  if (!rows.length || !rows[0].pos_config) throw new Error('no Toast config');
  const creds = decryptPosConfig(rows[0].pos_config);
  // Expected: { client_id, client_secret, restaurant_guid }
  if (!creds.client_id || !creds.client_secret) throw new Error('incomplete Toast credentials');
  return creds;
}

async function getAccessToken(creds) {
  const res = await fetch(`${TOAST_BASE}/authentication/v1/authentication/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId:     creds.client_id,
      clientSecret: creds.client_secret,
      userAccessType: 'TOAST_MACHINE_CLIENT',
    }),
  });
  if (!res.ok) throw new Error(`Toast auth failed: ${res.status}`);
  const data = await res.json();
  return data.token?.accessToken;
}

async function fetchMenu(businessId) {
  const creds = await getToastCreds(businessId);
  const token = await getAccessToken(creds);

  const res = await fetch(
    `${TOAST_BASE}/menus/v2/menus`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Toast-Restaurant-External-ID': creds.restaurant_guid,
      },
    }
  );
  if (!res.ok) throw new Error(`Toast menu fetch failed: ${res.status}`);
  const data = await res.json();

  // Flatten Toast menu groups → items
  const items = [];
  for (const menu of (data || [])) {
    for (const group of (menu.menuGroups || [])) {
      for (const item of (group.menuItems || [])) {
        items.push(item);
      }
    }
  }
  return { items };
}

async function createOrder(businessId, items, opts = {}) {
  const creds = await getToastCreds(businessId);
  const token = await getAccessToken(creds);

  const selections = items.map(i => ({
    itemGroup: { guid: i.sku },
    item:      { guid: i.sku },
    quantity:  i.qty || 1,
  }));

  const res = await fetch(`${TOAST_BASE}/orders/v2/orders`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Toast-Restaurant-External-ID': creds.restaurant_guid,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      order: {
        selections,
        source: 'API',
      },
    }),
  });
  if (!res.ok) throw new Error(`Toast order failed: ${res.status}`);
  const order = await res.json();
  return {
    receiptId: order.guid || order.externalId,
    orderId:   order.guid,
    total:     (order.totalAmount || 0) / 100,
    items,
    payUrl:    null, // Toast handles payment in-store; no hosted pay URL
    raw:       order,
  };
}

function getPaymentUrl(receiptId) {
  // Toast does not have a hosted payment URL — payment is in-store or via Toast's own app
  return null;
}

async function sendPaymentSms(toPhone, payUrl, summary) {
  // Re-use Twilio from surgeAgent pattern
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_FROM_NUMBER || '+19045067476';
  if (!sid || !token) return { sent: false, reason: 'twilio_not_configured' };

  const body = `Your LocalIntel order has been placed:\n${summary}\n\nPick up at the restaurant.`;
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
