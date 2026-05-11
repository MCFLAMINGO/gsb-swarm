'use strict';

/**
 * lib/taskIntent.js — Plain-language task/errand detection.
 *
 * Used by BOTH:
 *   - localIntelAgent.js  (POST /api/local-intel — web search bar, SMS)
 *   - voiceIntake.js      (Twilio voice transcription)
 *
 * Detects when the user is asking for a task to be DONE for them
 * (pickup, dropoff, errand, send someone) rather than searching for
 * a business. When detected we collect one follow-up (which venue?)
 * and then route to handleRFQ with the right category.
 *
 * Zero LLM. Fully deterministic regex. Module-level Map for follow-up
 * state with 10-minute TTL. Keyed by sessionId (phone for SMS/voice,
 * IP/customerId for web).
 */

// ── Follow-up state (module-level, 10-min TTL) ─────────────────────────────
const FOLLOWUP_TTL_MS = 10 * 60 * 1000;
const _followups = new Map(); // sessionId → { taskType, cat, followUpKey, zip, ts }

function _now() { return Date.now(); }

function _prune() {
  const cutoff = _now() - FOLLOWUP_TTL_MS;
  for (const [k, v] of _followups.entries()) {
    if (!v || !v.ts || v.ts < cutoff) _followups.delete(k);
  }
}

function getTaskFollowUp(sessionId) {
  if (!sessionId) return null;
  _prune();
  const key = `task:${sessionId}`;
  const v = _followups.get(key);
  if (!v) return null;
  if (_now() - v.ts > FOLLOWUP_TTL_MS) {
    _followups.delete(key);
    return null;
  }
  return v;
}

function setTaskFollowUp(sessionId, state) {
  if (!sessionId || !state) return;
  _prune();
  const key = `task:${sessionId}`;
  _followups.set(key, { ...state, ts: _now() });
}

function clearTaskFollowUp(sessionId) {
  if (!sessionId) return;
  _followups.delete(`task:${sessionId}`);
}

// ── Task action patterns (do this FOR me) ───────────────────────────────────
// Order matters slightly: more specific → less specific.
const PICKUP_RE =
  /\b(pick(?:\s|-)?up|pickup|grab|get|fetch|collect|retrieve)\b[\s\S]{0,40}\b(my|the|some|our)\b/i;
// "X picked up" / "[noun phrase] picked up" — the noun does not need a possessive.
// e.g. "get me dry cleaning picked up", "have the laundry picked up".
const PICKUP_INV_RE =
  /\b(picked\s?up|pickup|grabbed|fetched|collected)\b/i;
const DROPOFF_RE =
  /\b(drop(?:\s|-)?off|dropoff|drop)\b[\s\S]{0,40}\b(my|the|some|our|at|off)\b/i;
const DROPOFF_INV_RE =
  /\b(dropped\s?off|dropoff|drop\s?off)\b/i;
const SEND_SOMEONE_RE =
  /\b(send|have|get)\s+(someone|somebody|a\s+(?:runner|driver|courier))\b/i;
const NEED_PICKED_UP_RE =
  /\bi\s+(?:need|want)\b[\s\S]{0,40}\b(picked\s?up|dropped\s?off|delivered)\b/i;
const GET_ME_X_PICKED_UP_RE =
  /\b(get|have)\s+(me|us)?\s*[\s\S]{0,60}\b(picked\s?up|dropped\s?off|delivered)\b/i;
const CAN_YOU_TASK_RE =
  /\bcan\s+you\s+(?:get|pick\s?up|grab|fetch|bring|drop\s?off|deliver|run)\b[\s\S]{0,60}\b(my|the|some|our|to|a)\b/i;
const RUN_ERRAND_RE =
  /\b(run\s+(?:an?\s+)?errand|do\s+(?:an?\s+)?errand)\b/i;

// ── Category vocab (what is being picked up / dropped off) ─────────────────
const CAT_PATTERNS = [
  // dry_cleaning
  {
    re: /\b(dry\s?cleaning|dry\s?cleaner|laundry|clothes|shirts|suit|tailor)\b/i,
    cat: 'dry_cleaning',
    followUp: 'Which dry cleaner do you use? (reply with name or NONE)',
    followUpKey: 'venue_name',
  },
  // pharmacy
  {
    re: /\b(prescription|prescriptions|meds|medication|medicine|pharmacy|rx|refill)\b/i,
    cat: 'pharmacy',
    followUp: 'Which pharmacy do you use? (reply with name or NONE)',
    followUpKey: 'venue_name',
  },
  // grocery
  {
    re: /\b(groceries|grocery|milk|eggs|bread|produce|supermarket|ingredients?|food\s+(?:from\s+the\s+)?store)\b/i,
    cat: 'grocery',
    followUp: 'Which store do you want me to contact? (reply with name or NONE)',
    followUpKey: 'venue_name',
  },
  // restaurant
  {
    re: /\b(food|order|meal|takeout|take\s?out|dinner|lunch|breakfast|restaurant|pizza|burger|sushi|tacos?|wings?)\b/i,
    cat: 'restaurant',
    followUp: 'Which restaurant? (reply with name or NONE)',
    followUpKey: 'venue_name',
  },
  // errands — packages / mail
  {
    re: /\b(package|packages|parcel|mail|letter|envelope|fedex|ups\s+(?:box|store|package)|usps|post\s+office|shipment)\b/i,
    cat: 'errands',
    followUp: 'Where does it need to go? (reply with address or business name)',
    followUpKey: 'destination',
  },
];

// Hard deflect — if message clearly says "where can I find a dry cleaner",
// that's discovery, NOT a task. Don't fire taskIntent on those.
const DISCOVERY_HINT_RE =
  /\b(where\s+(?:is|can\s+i|are)|find\s+me\s+a|search\s+for|look\s+up|recommend|suggest|hours\s+of|phone\s+number\s+for|address\s+(?:of|for))\b/i;

/**
 * detectTaskIntent(text)
 *
 * @param {string} text
 * @returns {{
 *   isTask: boolean,
 *   taskType: 'pickup'|'dropoff'|'errand'|'send_someone'|null,
 *   cat: string|null,
 *   followUp: string|null,
 *   followUpKey: string|null,
 * }}
 */
function detectTaskIntent(text) {
  const empty = { isTask: false, taskType: null, cat: null, followUp: null, followUpKey: null };
  if (!text || typeof text !== 'string') return empty;
  const raw = text.trim();
  if (!raw) return empty;

  // Discovery phrasing wins — don't treat as task.
  if (DISCOVERY_HINT_RE.test(raw)) return empty;

  // Detect task action type
  let taskType = null;
  if (SEND_SOMEONE_RE.test(raw))           taskType = 'send_someone';
  else if (GET_ME_X_PICKED_UP_RE.test(raw)) {
    taskType = /dropped\s?off/i.test(raw) ? 'dropoff' : 'pickup';
  }
  else if (NEED_PICKED_UP_RE.test(raw)) {
    taskType = /dropped\s?off/i.test(raw) ? 'dropoff' : 'pickup';
  }
  else if (DROPOFF_INV_RE.test(raw))       taskType = 'dropoff';
  else if (DROPOFF_RE.test(raw))           taskType = 'dropoff';
  else if (PICKUP_INV_RE.test(raw))        taskType = 'pickup';
  else if (CAN_YOU_TASK_RE.test(raw))      taskType = 'pickup';
  else if (PICKUP_RE.test(raw))            taskType = 'pickup';
  else if (RUN_ERRAND_RE.test(raw))        taskType = 'errand';

  if (!taskType) return empty;

  // Match the noun (what is being picked up / dropped off) to a category
  for (const p of CAT_PATTERNS) {
    if (p.re.test(raw)) {
      return {
        isTask: true,
        taskType,
        cat: p.cat,
        followUp: p.followUp,
        followUpKey: p.followUpKey,
      };
    }
  }

  // Generic errand — we caught the verb but not the thing. Ask what + where.
  return {
    isTask: true,
    taskType: taskType === 'send_someone' ? 'send_someone' : 'errand',
    cat: 'errands',
    followUp: 'What do you need picked up or dropped off, and where? (reply with details or CANCEL)',
    followUpKey: 'errand_details',
  };
}

module.exports = {
  detectTaskIntent,
  getTaskFollowUp,
  setTaskFollowUp,
  clearTaskFollowUp,
};
