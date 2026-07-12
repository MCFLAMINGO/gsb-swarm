'use strict';
/**
 * lib/intentUnified.js — Single intent API for all channels.
 *
 * RESULT we care about: same utterance → same resolvesVia (HOW) on
 * web search, SMS, voice, and agents. New code MUST call normalizeQueryIntent.
 *
 * Composes (does not delete) legacy modules:
 *   intentRegistry — taskClass + resolvesVia (search|rfq|reservation|surge|status)
 *   intentMap      — category / tags / deflect / open-now
 *   taskIntent     — errand / pickup / delivery-style tasks → RFQ
 *
 * Priority (highest first):
 *   1. deflect
 *   2. discovery phrasing ("where can I…") → search (never surge)
 *   3. named food/order ("get X at Brand") → surge/order
 *   4. registry RFQ trades (plumber, landscaper, …) — keep trade category
 *   5. taskIntent errands → RFQ
 *   6. registry / intentMap search
 *
 * Zero LLM. Deterministic.
 */

const registry = require('./intentRegistry');
const intentMap = require('./intentMap');

let detectTaskIntent = null;
try {
  ({ detectTaskIntent } = require('./taskIntent'));
} catch (_) {
  detectTaskIntent = null;
}

const DISCOVERY_RE = /\b(where (can|do|should|to)|who (can|does|is)|find me (a|an)|looking for|how do i (find|get)|recommend)\b/i;
const NAMED_ORDER_RE = /\b((get|order|can i (get|order)|i want|i'd like).{0,80}\bat\s+[a-z0-9][\w'&. -]{1,40}|chicken|broccoli|pizza|burger|taco|sushi|menu)\b/i;
const FOOD_ORDER_RE = /\b(chicken|broccoli|pizza|burger|taco|sushi|salad|sandwich|coffee|wine|beer|menu|takeout|to[- ]go)\b/i;

/**
 * @param {string} query
 * @param {{ channel?: string }} [opts]
 */
function normalizeQueryIntent(query, opts = {}) {
  const q = (query || '').toString().trim();
  const sources = [];

  const reg = registry.resolveIntent(q);
  sources.push('intentRegistry');

  const map = intentMap.resolveIntent(q);
  sources.push('intentMap');

  let openIntent = null;
  try {
    openIntent = intentMap.detectOpenIntent ? intentMap.detectOpenIntent(q) : null;
  } catch (_) { /* optional */ }

  let task = null;
  if (detectTaskIntent && q) {
    try {
      task = detectTaskIntent(q);
      if (task && task.isTask) sources.push('taskIntent');
    } catch (_) { /* optional */ }
  }

  if (map && map.deflect) {
    return pack({
      q, opts, sources, openIntent,
      resolvesVia: 'search',
      taskClass: 'DEFLECT',
      category: null,
      group: null,
      tags: [],
      cuisine: null,
      deflect: true,
      isTask: false,
      taskType: null,
      confidence: map.confidence || 'high',
    });
  }

  let resolvesVia = reg.resolvesVia || 'search';
  let taskClass = reg.taskClass || 'DISCOVER';
  let category = reg.category || (map && !map.deflect ? map.cat : null) || null;
  let group = reg.group || null;
  let tags = Array.isArray(reg.tags) ? reg.tags.slice()
    : (map && Array.isArray(map.tags) ? map.tags.slice() : []);
  let cuisine = reg.cuisine || null;
  let isTask = false;
  let taskType = null;
  let confidence = 'registry';

  const isDiscovery = DISCOVERY_RE.test(q);
  const looksLikeNamedOrder = NAMED_ORDER_RE.test(q) || (FOOD_ORDER_RE.test(q) && /\bat\s+/i.test(q));

  // 2) Discovery questions → search (fixes "where can I get dentures" matching ORDER via "can i get")
  if (isDiscovery) {
    resolvesVia = 'search';
    taskClass = taskClass === 'ORDER' || taskClass === 'STATUS' ? 'DISCOVER' : taskClass;
    if (!category && map && map.cat) category = map.cat;
    confidence = 'discovery';
  }
  // 3) Named food/order at a place → surge (don't let taskIntent steal "get me X at McFlamingo")
  else if (
    looksLikeNamedOrder
    || ((reg.resolvesVia === 'surge' || reg.taskClass === 'ORDER') && FOOD_ORDER_RE.test(q))
  ) {
    resolvesVia = 'surge';
    taskClass = 'ORDER';
    confidence = 'named_order';
  }
  // 4) Registry trades stay RFQ with trade category
  else if (reg.resolvesVia === 'rfq' && reg.category) {
    resolvesVia = 'rfq';
    taskClass = 'RFQ';
    category = reg.category;
    confidence = 'registry_rfq';
    // taskIntent may still mark isTask for follow-up UX, but must not wipe category
    if (task && task.isTask) {
      isTask = true;
      taskType = task.taskType || task.type || 'errand';
    }
  }
  // 5) Generic task/errand language → RFQ
  else if (task && task.isTask) {
    isTask = true;
    taskType = task.taskType || task.type || 'errand';
    resolvesVia = 'rfq';
    taskClass = 'RFQ';
    if (task.cat || task.category) category = task.cat || task.category;
    confidence = 'task';
  }
  // 6) Fill category from map when registry only set group
  else if (map && map.cat) {
    if (!category) category = map.cat;
    if (map.confidence) confidence = map.confidence;
  }

  return pack({
    q, opts, sources, openIntent,
    resolvesVia, taskClass, category, group, tags, cuisine,
    deflect: false, isTask, taskType, confidence,
  });
}

function pack({
  q, opts, sources, openIntent,
  resolvesVia, taskClass, category, group, tags, cuisine,
  deflect, isTask, taskType, confidence,
}) {
  return {
    query: q,
    resolvesVia,
    taskClass,
    category,
    group,
    tags: tags || [],
    cuisine,
    openIntent,
    deflect: !!deflect,
    isTask: !!isTask,
    taskType,
    confidence,
    sources,
    channel: opts.channel || null,
  };
}

function howLabel(intent) {
  switch (intent && intent.resolvesVia) {
    case 'rfq': return 'rfq_bid';
    case 'surge': return 'place_order';
    case 'reservation': return 'reservation';
    case 'status': return 'track_status';
    default: return 'discover';
  }
}

module.exports = {
  normalizeQueryIntent,
  howLabel,
};
