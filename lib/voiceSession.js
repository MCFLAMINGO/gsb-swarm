'use strict';
/**
 * voiceSession.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Postgres-backed voice call session state.
 * Keyed on Twilio CallSid — same SID for every speech turn in a call.
 *
 * Stages:
 *   greeting         — initial call, no context yet
 *   menu_presented   — matched a business, read menu, waiting for item selection
 *   order_building   — cart has items, still gathering ("anything else?")
 *   order_confirmed  — order placed, call ending
 */

const db = require('./db');

// Auto-create table on first use
let migrated = false;
async function migrate() {
  if (migrated) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS voice_sessions (
      call_sid      TEXT PRIMARY KEY,
      caller_phone  TEXT,
      stage         TEXT NOT NULL DEFAULT 'greeting',
      business_id   TEXT,
      business_name TEXT,
      zip           TEXT,
      category      TEXT,
      cart          JSONB NOT NULL DEFAULT '[]',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  migrated = true;
}

async function get(callSid) {
  await migrate();
  const rows = await db.query(
    `SELECT * FROM voice_sessions WHERE call_sid = $1`,
    [callSid]
  );
  return rows[0] || null;
}

async function save(callSid, patch) {
  await migrate();
  const existing = await get(callSid);
  if (!existing) {
    // INSERT
    const s = {
      call_sid:      callSid,
      caller_phone:  patch.caller_phone  || 'unknown',
      stage:         patch.stage         || 'greeting',
      business_id:   patch.business_id   || null,
      business_name: patch.business_name || null,
      zip:           patch.zip           || null,
      category:      patch.category      || null,
      cart:          JSON.stringify(patch.cart || []),
    };
    await db.query(
      `INSERT INTO voice_sessions
         (call_sid, caller_phone, stage, business_id, business_name, zip, category, cart)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [s.call_sid, s.caller_phone, s.stage, s.business_id,
       s.business_name, s.zip, s.category, s.cart]
    );
  } else {
    // UPDATE only provided fields
    const fields = [];
    const vals   = [];
    let i = 1;
    const allowed = ['stage','business_id','business_name','zip','category','cart','caller_phone'];
    for (const key of allowed) {
      if (patch[key] !== undefined) {
        fields.push(`${key} = $${i++}`);
        vals.push(key === 'cart' ? JSON.stringify(patch[key]) : patch[key]);
      }
    }
    if (!fields.length) return;
    fields.push(`updated_at = NOW()`);
    vals.push(callSid);
    await db.query(
      `UPDATE voice_sessions SET ${fields.join(', ')} WHERE call_sid = $${i}`,
      vals
    );
  }
  return get(callSid);
}

async function addToCart(callSid, item) {
  const session = await get(callSid);
  if (!session) return null;
  const cart = Array.isArray(session.cart) ? session.cart : [];
  // If item already in cart, increment qty
  const existing = cart.find(c => c.sku === item.sku);
  if (existing) {
    existing.qty = (existing.qty || 1) + (item.qty || 1);
  } else {
    cart.push({ sku: item.sku, name: item.name, qty: item.qty || 1, priceUsd: item.priceUsd });
  }
  return save(callSid, { cart });
}

async function clearSession(callSid) {
  await migrate();
  await db.query(`DELETE FROM voice_sessions WHERE call_sid = $1`, [callSid]);
}

// Cart total helper
function cartTotal(cart) {
  return cart.reduce((sum, item) => sum + (item.priceUsd || 0) * (item.qty || 1), 0);
}

// Human-readable cart summary for voice readback
function cartSummary(cart) {
  if (!cart.length) return 'nothing yet';
  return cart.map(i => `${i.qty > 1 ? i.qty + ' ' : ''}${i.name}`).join(', ');
}

module.exports = { get, save, addToCart, clearSession, cartTotal, cartSummary };
