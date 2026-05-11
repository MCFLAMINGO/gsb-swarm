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
 *
 * Design rules:
 *  - More specific patterns before general ones
 *  - First verb in sentence wins for taskType (left-to-right)
 *  - First recognizable noun wins for cat
 *  - Discovery/search phrasing deflects (returns isTask=false)
 *  - FL brand names + slang + abbreviations baked in
 *  - allTasks array enables multi-task sentence handling
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

// ── Hard deflect — discovery phrasing beats everything ─────────────────────
// These phrases indicate the user wants to FIND a business, not get a task done.
const DISCOVERY_HINT_RE =
  /\b(where\s+(?:is|can\s+i|are|do\s+i|should\s+i)|find\s+(?:me\s+)?a|search\s+for|look\s+up|recommend(?:ation)?|suggest|hours\s+of|phone\s+(?:number\s+)?for|address\s+(?:of|for)|best\s+(?:place|spot|restaurant)|near(?:est|by)\s+(?:dry|laun|pharm|groc|resto|rest)|i\s+need\s+a\s+(?:cleaner|dry|laun|pharm|groc|mechanic|plumber|vet|doctor|dentist|lawyer|barber|salon)|pickup\s+truck|pickup\s+basketball|pickup\s+game|pickup\s+(?:locations?|spots?|points?|service|option)|food\s+pickup\s+(?:locations?|options?|near)|order\s+(?:online|ahead)|delivery\s+(?:restaurant|service|option|near)|restaurants?\s+(?:that\s+deliver|near|in|open))\b/i;

// ── Task verb patterns — detect errand action type ─────────────────────────
// Tested via _firstVerbMatch — position in text wins (left-to-right).

// "send/have/get someone/a driver" OR "I need someone to X"
const SEND_SOMEONE_RE =
  /\b(send|have|get)\s+(someone|somebody|a\s+(?:runner|driver|courier|person|guy|gal))\b|\bi\s+need\s+someone\s+to\b/i;

// Passive: "picked up", "dropped off", "delivered"
const PASSIVE_PICKUP_RE   = /\b(picked[\s-]?up)\b/i;
const PASSIVE_DROPOFF_RE  = /\b(dropped[\s-]?off)\b/i;
const PASSIVE_DELIVER_RE  = /\bdelivered\b/i;

// "I need/want X picked up/dropped off"
const NEED_PASSIVE_RE =
  /\bi\s+(?:need|want|gotta\s+have)\b[\s\S]{0,60}\b(picked[\s-]?up|dropped[\s-]?off|delivered)\b/i;

// "get/have me/us X picked up/dropped off"
const GET_ME_PASSIVE_RE =
  /\b(get|have)\s+(?:me|us)\s+[\s\S]{0,60}\b(picked[\s-]?up|dropped[\s-]?off|delivered)\b/i;

// "can you drop off" → dropoff; separate from pickup variant
const CAN_YOU_DROPOFF_RE =
  /\bcan\s+you\s+(?:please\s+)?drop[\s-]?off\b/i;
const CAN_YOU_PICKUP_RE =
  /\bcan\s+you\s+(?:please\s+)?(?:pick[\s-]?up|grab|get|bring|fetch|deliver|run(?:\s+and\s+get)?|swing\s+by(?:\s+and\s+get)?)\b/i;

// "drop X off" / "drop off X" / "drop the X" / "drop off"
// Handles: "drop something off", "drop my car off", "drop the package", "drop off in 32250"
const DROPOFF_VERB_RE =
  /\bdrop(?:\s+[\w]+)?\s+off\b|\bdrop\s+off\b|\bdrop(?:off|\s+(?:it|them|that|this|the|my|our|your)\b)/i;

// "pick up X" — no possessive required; "pick up pizza" valid
const PICKUP_VERB_RE =
  /\b(?:pick[\s-]?up|pickup|grab|fetch|collect|retrieve)\b/i;

// "get me X" / "get my X"
// "get me/my/us/our X"
const GET_ME_RE =
  /\bget\s+(?:me|my|us|our)\s+\w/i;

// "get some/a/an X for me/us" OR "get X for my wife/kids/husband"
// More specific than GET_ME_RE — requires 'for' clause to avoid over-matching
const GET_FOR_RE =
  /\bget\s+(?:some|a|an|the)?\s*\w[\w\s]{0,30}\s+for\s+(?:me|us|my|our|the\s+(?:kids?|family|wife|husband|boss|team|office))\b/i;

// "run to X and get Y" / "swing by" / "stop by and pick up"
const RUN_TO_RE =
  /\b(?:run|swing|stop|head|go)\s+(?:to|by|over\s+to)\b[\s\S]{0,80}\b(?:get|grab|pick\s*up|fetch|pick\s+it\s+up)\b/i;

// "bring me X" — delivery request
const BRING_ME_RE =
  /\bbring\s+(?:me|us|my|our)\s+\w/i;

// "have X cleaned/done"
const HAVE_DONE_RE =
  /\bhave\s+(?:my|the|our|it|them)?\s*\w[\w\s]{0,30}(?:cleaned|washed|pressed|ironed|tailored|altered|repaired|fixed|done)\b/i;

// "get X cleaned/done"
const GET_CLEANED_RE =
  /\bget\s+(?:my|the|our|it|them)?\s*\w[\w\s]{0,30}(?:cleaned|washed|pressed|ironed|tailored|altered|repaired|fixed|done)\b/i;

// "run an errand" / "do an errand" / "make a publix run" / "make a grocery run"
const RUN_ERRAND_RE =
  /\b(?:run|do)\s+(?:an?\s+)?errand\b|\bmake\s+a\s+(?:publix|grocery|store|beer|wine|pharmacy|cvs|walgreens|quick)\s+run\b/i;

// "go get my X" — navigational errand
const GO_GET_RE =
  /\b(?:go|run|head)\s+(?:and\s+)?(?:get|grab|pick\s*up|fetch)\b/i;

// ── Category vocab — what is being picked up / dropped off ─────────────────
// Order matters: first match wins. More specific → less specific.
// FL brand names and slang included for NE FL / JAX / PVB / statewide coverage.
const CAT_PATTERNS = [

  // ── Dry cleaning / laundry / tailoring ───────────────────────────────────
  // Includes: clothes, suits, shirts, tailor, cleaner, laundromat, uniforms, scrubs
  {
    re: /\b(dry[\s-]?cleaning|dry[\s-]?cleaner|laundry|laundromat|wash\s+(?:my\s+)?clothes|clothes|clothing|shirts?|suits?|dress(?:es)?|pants|jeans|slacks|blazer|uniforms?|scrubs?|tailor(?:ed)?|alterations?|cleaner|cleaners|getting\s+cleaned|get\s+(?:it|them|the\s+\w+)\s+cleaned|cleaning\s+done|pressed|ironed|starched)\b/i,
    cat: 'dry_cleaning',
    followUp: 'Which dry cleaner do you use? (reply with name or NONE)',
    followUpKey: 'venue_name',
  },

  // ── Pharmacy / prescriptions ─────────────────────────────────────────────
  // Includes: rx, meds, scripts, pills, CVS, Walgreens, Winn-Dixie/Publix pharmacy
  {
    re: /\b(prescription|prescriptions|meds|medication|medications|medicine|medicines|pharmacy|pharmacies|rx\b|refill|scripts?|pills?|capsules?|tablets?|dose|dosage|cvs|walgreens|rite\s*aid|winn-?dixie\s+pharm|publix\s+pharm)\b/i,
    cat: 'pharmacy',
    followUp: 'Which pharmacy do you use? (reply with name or NONE)',
    followUpKey: 'venue_name',
  },

  // ── Grocery / supermarket ────────────────────────────────────────────────
  // FL brands: Publix, Winn-Dixie, Aldi, Lucky's Market, Fresco y Mas
  {
    re: /\b(groceries|grocery|supermarket|publix|winn[\s-]?dixie|aldi|lucky.?s\s+market|fresco\s+y\s+mas|whole\s+foods|trader\s+joe|kroger|costco|sams?\s+club|bj.?s|food\s+lion|food\s+(?:from\s+the\s+)?store|food\s+items?|grocery\s+run|grocery\s+order|milk|eggs?|bread|produce|ingredients?|household\s+items?|cleaning\s+supplies)\b/i,
    cat: 'grocery',
    followUp: 'Which store do you want me to contact? (reply with name or NONE)',
    followUpKey: 'venue_name',
  },

  // ── Pet food / pet supplies — must precede restaurant to avoid "food" match ─
  {
    re: /\b(dog\s+food|cat\s+food|pet\s+food|pet\s+supplies?|kibble|dog\s+treats?|cat\s+treats?|bird\s+seed|fish\s+food|petco|petsmart|pet\s+store|hamster\s+food|cat\s+litter|litter\s+box)\b/i,
    cat: 'pet_services',
    followUp: 'Which pet store? (reply with name or NONE)',
    followUpKey: 'venue_name',
  },

  // ── Restaurant / food order ──────────────────────────────────────────────
  // FL/NE FL: Cuban, seafood, Latin, Tex-Mex, wings, beach food
  // Chains common in NE FL / Jacksonville / Ponte Vedra / St Johns area
  {
    re: /\b(food|order|meal|takeout|take[\s-]?out|dinner|lunch|breakfast|brunch|restaurant|pizza|burger|burgers?|sushi|tacos?|wings?|fries|bbq|chinese|thai|italian|mexican|cuban|cuban\s+food|latin|seafood|sandwiches?|sub|hoagie|bowl|plate|combo|entree|appetizer|gyro|ramen|poke|ceviche|empanadas?|tamales?|mcdonalds|wendys|burger\s*king|chick[\s-]?fil[\s-]?a|taco\s*bell|chipotle|panera|dominos?|papa\s*john|five\s*guys|popeyes?|raising\s+canes?|shake\s+shack|jersey\s+mike|firehouse|wingstop|hooters|bahama\s+breeze|bonefish|carrabbas|outback|longhorn|first\s+watch|metro\s+diner|beach\s+house|palm\s+valley)\b/i,
    cat: 'restaurant',
    followUp: 'Which restaurant? (reply with name or NONE)',
    followUpKey: 'venue_name',
  },

  // ── Packages / mail / shipping ───────────────────────────────────────────
  {
    re: /\b(packages?|parcels?|mail|letters?|envelope|fedex|ups[\s-](?:box|store|package|drop)?|usps|post\s+office|shipment|shipping\s+label|amazon\s+return|return\s+label|box\s+(?:it\s+up|up)|ups\s+store|the\s+mail)\b/i,
    cat: 'errands',
    followUp: 'Where does it need to go? (reply with address or business name)',
    followUpKey: 'destination',
  },

  // ── Auto / car ───────────────────────────────────────────────────────────
  {
    re: /\b(car|vehicle|truck|van|suv|auto|my\s+ride|the\s+car|the\s+truck|my\s+car|my\s+truck|my\s+vehicle)\b/i,
    cat: 'auto_repair',
    followUp: 'Which shop? (reply with name or NONE)',
    followUpKey: 'venue_name',
  },

  // ── Liquor / alcohol ─────────────────────────────────────────────────────
  // ABC Fine Wine & Spirits is the major FL chain
  {
    re: /\b(beer|wine|liquor|spirits|booze|six[\s-]?pack|case\s+of\s+beer|bottle\s+of\s+wine|bottle\s+of\s+whiskey|total\s+wine|abc\s+fine\s+wine|abc\s+spirits|publix\s+wine|alcohol|vodka|whiskey|bourbon|rum|tequila|hard\s+seltzer|white\s+claw)\b/i,
    cat: 'liquor_store',
    followUp: 'Which store? (reply with name or NONE)',
    followUpKey: 'venue_name',
  },

  // ── Coffee / cafe ────────────────────────────────────────────────────────
  {
    re: /\b(coffee|latte|espresso|cold\s+brew|cappuccino|starbucks|dunkin|dutch\s+bros|cafe|coffee\s+order|my\s+coffee\s+order|iced\s+coffee|frappuccino)\b/i,
    cat: 'cafe',
    followUp: 'Which coffee shop? (reply with name or NONE)',
    followUpKey: 'venue_name',
  },

  // ── Flowers / gifts ──────────────────────────────────────────────────────
  {
    re: /\b(flowers?|bouquet|arrangement|roses?|floral|florist|gift\s+basket|gift\s+card|birthday\s+(?:cake|gift|candles?)|1-800-flowers?|balloons?|party\s+(?:supplies|favors|stuff)|cups\s+and\s+plates|paper\s+plates|plastic\s+cups|decorations?)\b/i,
    cat: 'florist',
    followUp: 'Which florist or gift shop? (reply with name or NONE)',
    followUpKey: 'venue_name',
  },

];

// ── _firstVerbMatch(text) ──────────────────────────────────────────────────
// Returns the taskType of the FIRST task verb found left-to-right in text.
function _firstVerbMatch(text) {
  const checks = [
    { re: SEND_SOMEONE_RE,    type: 'send_someone' },
    { re: PASSIVE_DROPOFF_RE, type: 'dropoff'      },
    { re: PASSIVE_PICKUP_RE,  type: 'pickup'       },
    { re: PASSIVE_DELIVER_RE, type: 'pickup'       },
    { re: NEED_PASSIVE_RE,    type: 'pickup'       },
    { re: GET_ME_PASSIVE_RE,  type: 'pickup'       },
    { re: CAN_YOU_DROPOFF_RE, type: 'dropoff'      },
    { re: CAN_YOU_PICKUP_RE,  type: 'pickup'       },
    { re: DROPOFF_VERB_RE,    type: 'dropoff'      },
    { re: PICKUP_VERB_RE,     type: 'pickup'       },
    { re: GET_ME_RE,          type: 'pickup'       },
    { re: GET_FOR_RE,         type: 'pickup'       },
    { re: RUN_TO_RE,          type: 'errand'       },
    { re: BRING_ME_RE,        type: 'pickup'       },
    { re: HAVE_DONE_RE,       type: 'pickup'       },
    { re: GET_CLEANED_RE,     type: 'pickup'       },
    { re: RUN_ERRAND_RE,      type: 'errand'       },
    { re: GO_GET_RE,          type: 'errand'       },
  ];

  let earliest = null;
  let earliestType = null;

  for (const { re, type } of checks) {
    const m = re.exec(text);
    if (m && (earliest === null || m.index < earliest)) {
      earliest = m.index;
      earliestType = type;
    }
  }

  return earliestType;
}

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
 *   allTasks: Array<{taskType:string, cat:string, followUp:string, followUpKey:string}>
 * }}
 *
 * allTasks — all detected {taskType, cat} pairs ordered by position.
 * First is primary. Enables multi-task sentences like
 * "pick up my dry cleaning and get groceries" to surface both intents.
 */
function detectTaskIntent(text) {
  const empty = {
    isTask: false, taskType: null, cat: null,
    followUp: null, followUpKey: null, allTasks: [],
  };
  if (!text || typeof text !== 'string') return empty;
  const raw = text.trim();
  if (!raw) return empty;

  // Discovery phrasing wins — not a task request.
  if (DISCOVERY_HINT_RE.test(raw)) return empty;

  // Detect first task verb (left-to-right wins)
  const taskType = _firstVerbMatch(raw);
  if (!taskType) return empty;

  // Find ALL cat matches ordered by position (multi-task support)
  const allCatMatches = [];
  for (const p of CAT_PATTERNS) {
    const m = p.re.exec(raw);
    if (m) allCatMatches.push({ index: m.index, p });
  }
  allCatMatches.sort((a, b) => a.index - b.index);

  const allTasks = allCatMatches.map(({ p }) => ({
    taskType,
    cat: p.cat,
    followUp: p.followUp,
    followUpKey: p.followUpKey,
  }));

  // Primary = first cat match
  const primaryCat = allCatMatches.length > 0 ? allCatMatches[0].p : null;

  if (primaryCat) {
    return {
      isTask: true,
      taskType,
      cat: primaryCat.cat,
      followUp: primaryCat.followUp,
      followUpKey: primaryCat.followUpKey,
      allTasks,
    };
  }

  // Task verb detected but no recognizable noun — generic errand.
  // Preserve detected verb type (pickup/dropoff) — don't flatten to 'errand'.
  const resolvedType = taskType === 'send_someone' ? 'send_someone'
    : (taskType === 'dropoff' ? 'dropoff'
    : (taskType === 'pickup'  ? 'pickup'
    : 'errand'));

  return {
    isTask: true,
    taskType: resolvedType,
    cat: 'errands',
    followUp: 'What do you need picked up or dropped off, and where? (reply with details or CANCEL)',
    followUpKey: 'errand_details',
    allTasks: [],
  };
}

module.exports = {
  detectTaskIntent,
  getTaskFollowUp,
  setTaskFollowUp,
  clearTaskFollowUp,
};
