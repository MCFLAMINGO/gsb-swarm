'use strict';
/**
 * posRouter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Universal POS dispatch layer. Every business in Postgres has a pos_type.
 * This module routes fetchMenu() and placeOrder() to the correct handler
 * based on that pos_type — callers never need to know which POS is behind it.
 *
 * Supported pos_types:
 *   surge    → surgeAgent.js   (live)
 *   toast    → toastAgent.js   (stub — ready for key)
 *   square   → squareAgent.js  (stub — ready for key)
 *   clover   → cloverAgent.js  (stub — ready for key)
 *   none/null→ rfq fallback    (dispatch job to business via SMS/email)
 *
 * Every handler must implement the same contract:
 *   fetchMenu(businessId)                      → { items: [{ sku, name, priceUsd, available }] }
 *   createOrder(businessId, items, opts)       → { receiptId, payUrl, total, items }
 *   sendPaymentSms(toPhone, payUrl, summary)   → { sent, sms_sid }
 *
 * Usage:
 *   const pos = require('./posRouter');
 *   const menu  = await pos.fetchMenu(businessId);
 *   const order = await pos.placeOrder({ businessId, orderText, customerPhone });
 */

const db             = require('./db');
const { decryptPosConfig } = require('./posDecrypt');

// ── Handler registry ──────────────────────────────────────────────────────────
// Lazy-loaded so unused handlers don't import at startup
const HANDLERS = {
  surge:  () => require('./surgeAgent'),
  toast:  () => require('./toastAgent'),
  square: () => require('./squareAgent'),
  clover: () => require('./cloverAgent'),
  other:  () => require('./surgeAgent'), // 'other' with system_name=Surge → surgeAgent
};

// ── Resolve pos_type for a business ─────────────────────────────────────────
async function getPosType(businessId) {
  const rows = await db.query(
    `SELECT pos_type, pos_config FROM businesses WHERE business_id = $1 LIMIT 1`,
    [businessId]
  );
  if (!rows.length) throw new Error(`business ${businessId} not found`);
  const { pos_type, pos_config } = rows[0];

  // 'other' with system_name=Surge is treated as surge
  if (pos_type === 'other' && pos_config) {
    try {
      const creds = decryptPosConfig(pos_config);
      if (creds.system_name?.toLowerCase().includes('surge') ||
          creds.apim_key || creds.subscription_key) {
        return 'surge';
      }
    } catch (_) {}
  }

  return pos_type || null;
}

// ── Get handler for a pos_type ────────────────────────────────────────────────
function getHandler(posType) {
  const loader = HANDLERS[posType];
  if (!loader) return null;
  try {
    return loader();
  } catch (e) {
    console.warn(`[posRouter] handler load failed for ${posType}: ${e.message}`);
    return null;
  }
}

// ── fetchMenu ─────────────────────────────────────────────────────────────────
/**
 * Fetch the live menu/service catalog for a business.
 * Returns normalized array: [{ sku, name, priceUsd, available, description }]
 *
 * Falls back to empty array if business has no POS integration.
 */
async function fetchMenu(businessId) {
  const posType = await getPosType(businessId);
  const handler = posType ? getHandler(posType) : null;

  if (!handler || typeof handler.fetchMenu !== 'function') {
    console.log(`[posRouter] no POS handler for ${businessId} (type=${posType}) — returning empty menu`);
    return { items: [], pos_type: posType || 'none', integrated: false };
  }

  try {
    const raw = await handler.fetchMenu(businessId);
    const items = normalizeMenu(raw, posType);
    return { items, pos_type: posType, integrated: true };
  } catch (e) {
    console.error(`[posRouter] fetchMenu error (${posType}):`, e.message);
    return { items: [], pos_type: posType, integrated: false, error: e.message };
  }
}

// ── Normalize menu across POS formats ────────────────────────────────────────
/**
 * Each POS returns slightly different shapes. Normalize to a common format.
 * { sku, name, priceUsd, available, category, description, imageUrl }
 */
function normalizeMenu(raw, posType) {
  const items = raw?.items || raw || [];
  if (!Array.isArray(items)) return [];

  return items.map(item => {
    switch (posType) {
      case 'surge':
        return {
          sku:         item.sku        || item.id || String(Math.random()),
          name:        item.name       || item.title || 'Item',
          priceUsd:    item.priceUsd   || item.price || item.amount || 0,
          available:   item.available  !== false,
          category:    item.category   || item.type || 'general',
          description: item.description || '',
          imageUrl:    item.imageUrl   || item.image || null,
        };
      case 'toast':
        return {
          sku:         item.guid       || item.id,
          name:        item.name,
          priceUsd:    (item.price || 0) / 100, // Toast prices in cents
          available:   item.availability?.available !== false,
          category:    item.type       || 'general',
          description: item.description || '',
          imageUrl:    null,
        };
      case 'square':
        return {
          sku:         item.id,
          name:        item.item_data?.name || item.name,
          priceUsd:    (item.item_data?.variations?.[0]?.item_variation_data?.price_money?.amount || 0) / 100,
          available:   true,
          category:    item.item_data?.category_id || 'general',
          description: item.item_data?.description || '',
          imageUrl:    null,
        };
      default:
        return {
          sku:         item.sku || item.id || String(Math.random()),
          name:        item.name || item.title || 'Item',
          priceUsd:    item.priceUsd || item.price || 0,
          available:   item.available !== false,
          category:    item.category || 'general',
          description: item.description || '',
          imageUrl:    item.imageUrl || null,
        };
    }
  }).filter(i => i.name && i.available);
}

// ── matchItems ────────────────────────────────────────────────────────────────
/**
 * Match spoken/typed order text against normalized menu items.
 * Returns { matched: [{sku,name,priceUsd,qty}], unmatched: [string] }
 *
 * Matching strategy (no LLM — deterministic):
 * 1. Split order on "and"/"plus"/"," into segments — each segment is one item request
 * 2. For each segment: score ALL menu items by name similarity, pick the best
 * 3. Similarity = word overlap score (shared meaningful words / total words)
 * 4. Minimum similarity threshold to avoid false matches
 */
function matchItems(items, orderText) {
  const normalize = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

  // Stop words to ignore in scoring
  const STOP = new Set(['i','a','an','the','and','or','please','want','get','like','can','me',
    'some','with','of','in','on','at','for','my','your','us','we','just','one']);

  // Split order into segments on "and", ",", "plus", "also"
  const rawSegments = orderText
    .split(/\band\b|\bplus\b|\balso\b|,/i)
    .map(s => s.trim())
    .filter(s => s.length > 1);

  const matched = [];
  const usedSkus = new Set();
  const unmatched = [];

  for (const seg of rawSegments) {
    const segNorm = normalize(seg);
    const qty = extractQty(segNorm);
    // Remove qty words from segment before scoring
    const cleanSeg = segNorm
      .replace(/^(one|two|three|four|five|six|\d+)\s+/, '')
      .replace(/^(a|an)\s+/, '')
      .trim();

    const segTokens = cleanSeg.split(/\s+/).filter(t => t.length >= 3 && !STOP.has(t));
    if (!segTokens.length) continue;

    // Score every menu item against this segment
    let bestScore = 0;
    let bestItem  = null;

    for (const item of items) {
      if (usedSkus.has(item.sku)) continue;
      const itemNorm   = normalize(item.name);
      const itemTokens = itemNorm.split(/\s+/).filter(t => t.length >= 3 && !STOP.has(t));
      if (!itemTokens.length) continue;

      // Score = shared tokens / union of tokens (Jaccard-style)
      // Bonus: if item name is a substring of segment or vice versa
      const segSet  = new Set(segTokens);
      const itemSet = new Set(itemTokens);
      const shared  = [...segSet].filter(t => {
        // exact token match OR one is prefix of the other (min 4 chars)
        return itemSet.has(t) || [...itemSet].some(it =>
          (t.length >= 4 && it.startsWith(t)) ||
          (it.length >= 4 && t.startsWith(it))
        );
      }).length;

      if (shared === 0) continue;
      const union = new Set([...segSet, ...itemSet]).size;
      let score   = shared / union;

      // Boost: full phrase containment
      if (itemNorm.includes(cleanSeg) || cleanSeg.includes(itemNorm)) score += 0.3;
      // Boost: all segment tokens found in item name
      if (segTokens.every(t => itemNorm.includes(t))) score += 0.2;

      if (score > bestScore) {
        bestScore = score;
        bestItem  = item;
      }
    }

    // Minimum threshold: at least 1 meaningful shared word with some score
    if (bestItem && bestScore >= 0.15) {
      matched.push({ ...bestItem, qty });
      usedSkus.add(bestItem.sku);
    } else {
      unmatched.push(seg);
    }
  }

  return { matched, unmatched };
}

// ── Extract quantity from order segment ───────────────────────────────────────
function extractQty(segText) {
  const numWords = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8 };
  const tokens = segText.trim().split(/\s+/);
  const first = tokens[0];
  if (numWords[first]) return numWords[first];
  const num = parseInt(first, 10);
  if (!isNaN(num) && num > 0 && num <= 20) return num;
  return 1;
}

// ── placeOrder ────────────────────────────────────────────────────────────────
/**
 * Full order flow: match items → create order → send SMS payment link.
 *
 * @param {object} opts
 *   businessId    — UUID from businesses table
 *   orderText     — raw spoken/typed order ("spicy chicken sandwich and a rice bowl")
 *   customerPhone — caller's phone number for SMS payment link
 *   jurisdictionCode — defaults to 'US-FL'
 *
 * @returns {object}
 *   ok            — boolean
 *   receiptId     — POS receipt/order ID
 *   payUrl        — payment link to send to customer
 *   matched       — items successfully matched
 *   unmatched     — words that didn't match any item
 *   summary       — human-readable order summary
 *   total         — order total in USD
 *   sms           — SMS send result
 *   menuSample    — first 5 items (returned when no match, for voice readback)
 *   reason        — error reason if ok=false
 */
async function placeOrder({ businessId, orderText, customerPhone, jurisdictionCode = 'US-FL' }) {
  // 1. Fetch menu
  const { items, pos_type, integrated, error: menuError } = await fetchMenu(businessId);

  if (!integrated) {
    // No POS — fall back to RFQ dispatch
    console.log(`[posRouter] no POS for ${businessId} — falling back to RFQ`);
    return {
      ok: false,
      reason: 'no_pos_integration',
      fallback: 'rfq',
      message: `This business hasn't connected their ordering system yet. We'll send them your request.`,
    };
  }

  if (!items.length) {
    return {
      ok: false,
      reason: 'empty_menu',
      message: `No items available right now. Please try again later.`,
      menuError,
    };
  }

  // 2. Match items
  const { matched, unmatched } = matchItems(items, orderText);

  if (!matched.length) {
    const menuSample = items.slice(0, 5).map(i =>
      `${i.name}${i.priceUsd ? ' — $' + i.priceUsd.toFixed(2) : ''}`
    );
    return {
      ok: false,
      reason: 'no_menu_match',
      message: `Couldn't match "${orderText}" to any item.`,
      menuSample,
      unmatched,
    };
  }

  // 3. Get handler and create order
  const handler = getHandler(pos_type);
  if (!handler || typeof handler.createOrder !== 'function') {
    return { ok: false, reason: 'handler_missing', message: `POS handler for ${pos_type} not available.` };
  }

  let order;
  try {
    const orderItems = matched.map(m => ({ sku: m.sku, qty: m.qty }));
    order = await handler.createOrder(businessId, orderItems, { jurisdictionCode });
  } catch (e) {
    console.error(`[posRouter] createOrder error (${pos_type}):`, e.message);
    return { ok: false, reason: 'order_failed', message: e.message };
  }

  const receiptId = order.receiptId || order.id || order.orderId;
  const payUrl    = typeof handler.getPaymentUrl === 'function'
    ? handler.getPaymentUrl(receiptId)
    : order.payUrl || null;
  const total     = order.total || order.totalUsd || matched.reduce((s, m) => s + (m.priceUsd * m.qty), 0);
  const summary   = matched.map(m => `${m.name} x${m.qty}${m.priceUsd ? ' — $' + (m.priceUsd * m.qty).toFixed(2) : ''}`).join('\n');

  // 4. Send SMS payment link
  let smsResult = { sent: false, reason: 'no_phone' };
  if (customerPhone && payUrl && typeof handler.sendPaymentSms === 'function') {
    try {
      smsResult = await handler.sendPaymentSms(
        customerPhone,
        payUrl,
        `${summary}\nTotal: $${Number(total).toFixed(2)}`
      );
    } catch (e) {
      console.error('[posRouter] SMS error:', e.message);
      smsResult = { sent: false, reason: e.message };
    }
  }

  // 5. Log to Postgres for audit + self-improvement
  try {
    await db.query(
      `INSERT INTO voice_leads (phone, name, raw_text, intent, rfq_id)
       VALUES ($1, $2, $3, 'order', NULL)
       ON CONFLICT DO NOTHING`,
      [customerPhone || 'unknown', null, `ORDER:${businessId}:${orderText}`]
    ).catch(() => {}); // table may not have rfq_id as nullable yet — ignore
  } catch (_) {}

  return {
    ok: true,
    receiptId,
    payUrl,
    pos_type,
    matched,
    unmatched,
    summary,
    total: Number(total).toFixed(2),
    sms: smsResult,
  };
}

// ── speakMenu ─────────────────────────────────────────────────────────────────
/**
 * Return a voice-friendly string listing the first N menu items.
 * Used when caller asks "what do you have?" or no match is found.
 */
async function speakMenu(businessId, limit = 5) {
  const { items, integrated } = await fetchMenu(businessId);
  if (!integrated || !items.length) return "This business hasn't connected their menu yet.";
  const listed = items.slice(0, limit).map(i =>
    `${i.name}${i.priceUsd ? ' for $' + i.priceUsd.toFixed(2) : ''}`
  ).join(', ');
  return `Here's what's available: ${listed}. What would you like?`;
}

module.exports = { fetchMenu, placeOrder, matchItems, normalizeMenu, speakMenu, getPosType };
