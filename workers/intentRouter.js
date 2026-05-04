'use strict';
/**
 * intentRouter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Maps a fuzzy natural-language query to:
 *   { zip, vertical, tool, args, confidence, reasoning }
 *
 * This is what makes "where should I open a clinic in Northeast Florida"
 * resolve to: zip=32082, vertical=healthcare, tool=local_intel_healthcare
 *
 * Resolution order:
 *   1. ZIP detection  — literal 5-digit, or named place → ZIP
 *   2. Vertical detection — keyword signals per industry
 *   3. Tool selection — within a vertical, pick the most targeted tool
 *   4. Multi-ZIP expansion — "Northeast Florida" → top 3 ZIPs ranked by
 *      sector confidence scores from census_layer
 *
 * Exported: route(query) → RouteResult
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR      = path.join(__dirname, '..', 'data');
const CENSUS_DIR    = path.join(DATA_DIR, 'census_layer');
const SPENDING_FILE = path.join(DATA_DIR, 'spendingZones.json');

// ── Re-use detection helpers from inferenceCache ──────────────────────────────
const { detectVertical, detectZip } = require('./inferenceCache');

// ── Region expansions → multiple ZIPs ────────────────────────────────────────
// When user says "Northeast Florida" without a specific ZIP, expand to top ZIPs
const REGION_EXPANSIONS = {
  'northeast florida':  ['32082','32081','32084','32092','32086','32080','32259','32250','32034','32097'],
  'st johns county':    ['32082','32081','32084','32086','32092','32080','32095','32259'],
  'duval county':       ['32250','32266','32258','32233','32256','32257','32224','32225','32246','32216','32217','32207'],
  'jacksonville':       ['32216','32217','32224','32225','32246','32207','32250','32256','32257','32258'],
  'clay county':        ['32003','32073','32068'],
  'nassau county':      ['32034','32097'],
  'ponte vedra':        ['32082','32081'],
  'beaches':            ['32250','32266','32233','32240','32082','32080'],
  'st augustine':       ['32084','32086','32080','32092'],
  'nocatee':            ['32081'],
};

// Default ZIPs when no region or ZIP detected (richest data coverage)
const FALLBACK_ZIPS = ['32082','32081','32084'];

// ── Intent detection — lookup vs market question ────────────────────────────
// "lookup" intent: user wants to FIND specific businesses/providers/people
//   → always resolves to local_intel_search regardless of vertical
// "market" intent: user wants MARKET INTELLIGENCE (gaps, saturation, opportunity)
//   → resolves to vertical tool or oracle
// If neither fires clearly, we fall through to vertical tool selection.

const INTENT_SIGNALS = {
  // Lookup intent — user wants a list of existing businesses / providers
  lookup: [
    /\bfind\b.*\bnear\b/i,
    /\bare there\b/i,
    /\bhow many\b/i,
    /\blist of\b/i,
    /\bwho (is|are|operates|runs|has)\b/i,
    /\bwhat (businesses|providers|offices|clinics|shops|contractors|agents)\b/i,
    /\bshow me\b/i,
    /\bnearby\b/i,
    /\bin (the area|this zip|this area|my area|32\d{3})\b/i,
    /\blocal\b.*\b(list|directory|options)\b/i,
    /\bwhere (can i find|do i find|is there a)\b/i,
    /\boperating in\b/i,
    /\bopen (in|near|around)\b/i,
  ],
  // Market / opportunity intent — user wants gap analysis, saturation, demand
  market: [
    /\bgap\b/i,
    /\bsaturated\b/i,
    /\bsaturation\b/i,
    /\bopportunity\b/i,
    /\bopportunities\b/i,
    /\bdemand\b/i,
    /\bundersupplied\b/i,
    /\boversupplied\b/i,
    /\bwhitespace\b/i,
    /\bunderserved\b/i,
    /\bunmet\b/i,
    /\bpotential\b/i,
    /\bwhere should i open\b/i,
    /\bshould i open\b/i,
    /\bviable\b/i,
    /\bfeasib\b/i,
    /\bmarket.*(signal|momentum|trend)/i,
    /\bpermit.*(velocity|pull|pipeline)/i,
    /\bhousing starts\b/i,
    /\bnew construction\b/i,
    /\bgrowth (corridor|area|pocket)/i,
    /\bexpansion (opportunity|target)/i,
    /\bwhat.*(missing|lacking|needed)/i,
    /\bis.*(there|a).*(need|demand|room)/i,
  ],
};

/**
 * detectIntent(query) → 'lookup' | 'market' | null
 * Lookup always wins over market if both match — the user wants a list, not analysis.
 */
function detectIntent(query) {
  for (const pattern of INTENT_SIGNALS.lookup) {
    if (pattern.test(query)) return 'lookup';
  }
  for (const pattern of INTENT_SIGNALS.market) {
    if (pattern.test(query)) return 'market';
  }
  return null;
}

// ── Tool selection within vertical ───────────────────────────────────────────
// Intent signals → best tool override within a vertical
const TOOL_OVERRIDES = {
  restaurant: [
    { pattern: /gap|missing|undersupplied|whitespace|opportunity|cuisine.type|what.is.missing/i, tool: 'local_intel_restaurant' },
    { pattern: /saturation|density|too.many|oversaturated|crowded/i,                             tool: 'local_intel_oracle' },
    { pattern: /signal|momentum|tide|trend|growing|dying/i,                                      tool: 'local_intel_signal' },
    { pattern: /permit|build|lease|location|corridor|street/i,                                   tool: 'local_intel_bedrock' },
  ],
  healthcare: [
    // Lookup: user wants to find existing providers
    { pattern: /\bfind\b|\bare there\b|\blist\b|\bshow me\b|\bhow many\b|operating in|open (in|near)/i, tool: 'local_intel_search' },
    // Gap / demand analysis — includes specialist gaps, med spa, chiro, etc.
    { pattern: /gap|missing|undersupplied|need|demand|provider.ratio|unmet|specialist.gap|physician.shortage|medical.desert|healthcare.gap/i, tool: 'local_intel_healthcare' },
    // Saturation
    { pattern: /saturat|too.many|oversupplied|crowded|compet/i,                                   tool: 'local_intel_oracle' },
    // Signal / trends
    { pattern: /signal|momentum|trend|growing|declining/i,                                        tool: 'local_intel_signal' },
    // Demographics — senior, age-banded, income cohort, population
    { pattern: /demographic|senior|elder|age|income|population|household/i,                       tool: 'local_intel_zone' },
    // Infrastructure — clinic space, facility build-out, permits
    { pattern: /permit|build|clinic.space|facility|real estate|location|lease/i,                  tool: 'local_intel_bedrock' },
  ],
  retail: [
    { pattern: /gap|missing|undersupplied|need|demand|spending.capture/i,                         tool: 'local_intel_retail' },
    { pattern: /corridor|street|anchor|shopping.center|plaza/i,                                   tool: 'local_intel_corridor' },
    { pattern: /demographic|income|spending|consumer/i,                                           tool: 'local_intel_zone' },
    { pattern: /signal|momentum/i,                                                                 tool: 'local_intel_signal' },
  ],
  construction: [
    // Lookup: find existing contractors / trade businesses
    { pattern: /\bfind\b|\bare there\b|\blist\b|\bshow me\b|\bhow many\b|operating in|open (in|near)/i, tool: 'local_intel_search' },
    // Permit velocity / active pipeline — includes specific trades: roofer, plumber, pool, solar, masonry, pavers
    { pattern: /permit|active|pipeline|project|velocity|pull|housing starts|new construction/i,   tool: 'local_intel_bedrock' },
    // Trade gaps / demand — includes all expanded trades
    { pattern: /gap|demand|opportunity|need|undersupplied|trade.shortage|subcontractor.gap/i,     tool: 'local_intel_construction' },
    // Saturation / competition
    { pattern: /saturat|too.many|oversupplied|crowded|compet/i,                                   tool: 'local_intel_oracle' },
    // Demographics — household growth, population, new development
    { pattern: /demographic|growth|population|household|development.activity|infrastructure/i,    tool: 'local_intel_zone' },
    // Signal / momentum
    { pattern: /signal|momentum|trend/i,                                                          tool: 'local_intel_signal' },
  ],
  realtor: [
    { pattern: /gap|opportunity|undervalued|whitespace/i,                                         tool: 'local_intel_oracle' },
    { pattern: /permit|infrastructure|road|develop/i,                                             tool: 'local_intel_bedrock' },
    { pattern: /income|demographic|household|owner.occ/i,                                         tool: 'local_intel_zone' },
    { pattern: /signal|momentum|score/i,                                                          tool: 'local_intel_signal' },
    { pattern: /corridor|street|A1A/i,                                                            tool: 'local_intel_corridor' },
  ],
};

// Default tool per vertical when no override matches
const VERTICAL_DEFAULT_TOOL = {
  restaurant:   'local_intel_restaurant',
  healthcare:   'local_intel_healthcare',
  retail:       'local_intel_retail',
  construction: 'local_intel_construction',
  realtor:      'local_intel_realtor',
};

// ── Census layer loader ───────────────────────────────────────────────────────
// Used to rank ZIPs by sector relevance when multi-ZIP expansion happens

function loadCensusLayer(zip) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CENSUS_DIR, `${zip}.json`), 'utf8'));
  } catch (_) {
    return null;
  }
}

function loadConfidence() {
  try {
    return JSON.parse(fs.readFileSync(path.join(CENSUS_DIR, '_confidence.json'), 'utf8'));
  } catch (_) {
    return {};
  }
}

// ── ZIP ranking — picks best ZIPs for a vertical from a candidate list ────────
function rankZipsForVertical(zipCandidates, vertical) {
  const conf = loadConfidence();

  return zipCandidates
    .map(zip => {
      const census  = loadCensusLayer(zip);
      const cScore  = conf[zip] || 0;

      // Find sector gap relevance for this vertical
      let gapScore = 0;
      if (census && Array.isArray(census.sector_gaps)) {
        const NAICS_MAP = {
          restaurant:   ['72'],
          healthcare:   ['62'],
          retail:       ['44','45'],
          construction: ['23'],
          realtor:      ['53','52'],
        };
        const targetNaics = NAICS_MAP[vertical] || [];
        const relevant = census.sector_gaps.filter(g =>
          targetNaics.some(n => String(g.naics || '').startsWith(n))
        );
        gapScore = relevant.length > 0
          ? Math.max(...relevant.map(g => g.relevance_score || g.demand_estimate || 0))
          : 0;
      }

      return { zip, score: (cScore * 0.4) + (gapScore * 0.6) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(r => r.zip);
}

// ── Region detector ───────────────────────────────────────────────────────────
function detectRegion(query) {
  const q = query.toLowerCase();
  for (const [region, zips] of Object.entries(REGION_EXPANSIONS)) {
    if (q.includes(region)) return zips;
  }
  return null;
}

// ── Tool picker ───────────────────────────────────────────────────────────────
// Resolution order:
//   1. Intent = lookup → always local_intel_search (find me X, are there X, how many X)
//   2. Intent = market → check TOOL_OVERRIDES for best market tool within vertical
//   3. No intent signal → check TOOL_OVERRIDES by pattern, fall back to vertical default
function pickTool(query, vertical) {
  const intent = detectIntent(query);

  // Lookup intent always wins — user wants a list, not market analysis
  if (intent === 'lookup') return 'local_intel_search';

  // Market intent + no vertical → oracle (general market question)
  if (intent === 'market' && !vertical) return 'local_intel_oracle';

  // Check TOOL_OVERRIDES for this vertical
  const overrides = TOOL_OVERRIDES[vertical] || [];
  for (const o of overrides) {
    if (o.pattern.test(query)) return o.tool;
  }

  return VERTICAL_DEFAULT_TOOL[vertical] || 'local_intel_ask';
}

// ── Confidence scorer for the route itself ────────────────────────────────────
function routeConfidence(hasLiteralZip, hasNamedPlace, hasVertical, zipCount) {
  let score = 0;
  if (hasLiteralZip)  score += 40;
  if (hasNamedPlace)  score += 25;
  if (hasVertical)    score += 25;
  if (zipCount > 0)   score += 10;
  return Math.min(score, 100);
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * route(query) → RouteResult
 *
 * RouteResult: {
 *   zip:        string          — primary ZIP
 *   zips:       string[]        — all candidate ZIPs (for multi-ZIP queries)
 *   vertical:   string|null     — detected vertical
 *   tool:       string          — MCP tool to call
 *   args:       object          — args to pass to the tool
 *   route_confidence: number    — 0-100 how certain we are about this routing
 *   reasoning:  string          — LLM-readable explanation of routing decision
 *   multi_zip:  boolean         — true if query spans a region
 * }
 */
function route(query) {
  if (!query || typeof query !== 'string') {
    return {
      zip: DEFAULT_ZIP, zips: [DEFAULT_ZIP], vertical: null,
      tool: 'local_intel_ask', args: { query, zip: DEFAULT_ZIP },
      route_confidence: 0, reasoning: 'Empty query — fallback to ask tool',
      multi_zip: false,
    };
  }

  // 1. Detect ZIP
  const literalZip  = detectZip(query);
  const regionZips  = !literalZip ? detectRegion(query) : null;
  const vertical    = detectVertical(query);
  // When no vertical detected, do NOT default to 'realtor' — fall through to
  // local_intel_ask (open query) so the best available tool is picked at runtime.
  const tool        = pickTool(query, vertical || null);

  let zips;
  let isMulti = false;
  let reasoning = [];

  if (literalZip) {
    zips = [literalZip];
    reasoning.push(`literal ZIP ${literalZip} detected`);
  } else if (regionZips) {
    isMulti = true;
    // Rank region ZIPs by vertical relevance
    zips = vertical ? rankZipsForVertical(regionZips, vertical) : regionZips.slice(0, 3);
    reasoning.push(`region expansion → ${zips.length} ZIPs ranked by ${vertical || 'general'} relevance`);
  } else {
    zips = FALLBACK_ZIPS;
    reasoning.push('no geo signal — using default coverage ZIPs');
  }

  const intent = detectIntent(query);

  if (vertical) {
    reasoning.push(`vertical: ${vertical}`);
  } else {
    reasoning.push('no vertical detected — routing to ask tool');
  }

  if (intent) reasoning.push(`intent: ${intent}`);
  reasoning.push(`tool: ${tool}`);

  const primaryZip = zips[0];
  const conf = routeConfidence(!!literalZip, !!regionZips, !!vertical, zips.length);

  return {
    zip:              primaryZip,
    zips,
    vertical:         vertical || null,
    tool,
    args:             { query, zip: primaryZip },
    route_confidence: conf,
    reasoning:        reasoning.join(' · '),
    multi_zip:        isMulti,
    intent:           intent || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — Local search engine intent classifier
// Deterministic keyword → category map for the consumer search bar. Zero LLM.
// ─────────────────────────────────────────────────────────────────────────────

const KEYWORD_CATEGORY_MAP = {
  // Drinks & alcohol
  whiskey: ['bar','liquor_store'], bourbon: ['bar','liquor_store'],
  cocktail: ['bar'], cocktails: ['bar'], beer: ['bar','liquor_store'],
  wine: ['bar','liquor_store','restaurant'], spirits: ['bar','liquor_store'],
  liquor: ['liquor_store','bar'], alcohol: ['liquor_store','bar'],
  drinks: ['bar','cafe','restaurant'], nightcap: ['bar'],
  // Coffee
  coffee: ['cafe','coffee_chain'], espresso: ['cafe'], latte: ['cafe'],
  cappuccino: ['cafe'], 'cold brew': ['cafe'],
  // Food — general
  food: ['restaurant','fast_food','cafe'], eat: ['restaurant','fast_food'],
  lunch: ['restaurant','fast_food','cafe'], dinner: ['restaurant'],
  breakfast: ['cafe','restaurant'], brunch: ['cafe','restaurant'],
  snack: ['cafe','convenience','fast_food'],
  // Food — specific
  pizza: ['restaurant','fast_food'], burger: ['restaurant','fast_food'],
  burgers: ['restaurant','fast_food'], tacos: ['restaurant','fast_food'],
  sushi: ['restaurant'], chinese: ['restaurant'], thai: ['restaurant'],
  indian: ['restaurant'], italian: ['restaurant'], mexican: ['restaurant'],
  seafood: ['restaurant'], bbq: ['restaurant'], barbecue: ['restaurant'],
  wings: ['restaurant','fast_food'], sandwich: ['restaurant','fast_food','cafe'],
  salad: ['restaurant','cafe'], soup: ['restaurant','cafe'],
  // Groceries & convenience
  groceries: ['grocery','supermarket'], grocery: ['grocery','supermarket'],
  milk: ['grocery','convenience'], bread: ['grocery','convenience'],
  eggs: ['grocery','convenience'], snacks: ['grocery','convenience'],
  'toilet paper': ['grocery','convenience'], 'paper towels': ['grocery','convenience'],
  'laundry detergent': ['grocery','supermarket'], cleaning: ['grocery','convenience'],
  toiletries: ['grocery','pharmacy','convenience'],
  // Pharmacy & health
  pharmacy: ['pharmacy'], prescription: ['pharmacy'], meds: ['pharmacy'],
  medicine: ['pharmacy'], vitamins: ['pharmacy','grocery'],
  bandaids: ['pharmacy'], firstaid: ['pharmacy'],
  // Hardware & home repair
  hardware: ['hardware'], tools: ['hardware'], lumber: ['hardware'],
  plumbing: ['hardware','plumber'], drywall: ['hardware'],
  paint: ['hardware'], lightbulb: ['hardware','grocery','convenience'],
  batteries: ['hardware','grocery','convenience'], drill: ['hardware'],
  screws: ['hardware'], 'nails': ['hardware'],
  // Auto
  gas: ['gas_station'], gasoline: ['gas_station'], fuel: ['gas_station'],
  'oil change': ['automotive','car_repair'], tires: ['automotive','car_repair'],
  mechanic: ['car_repair','automotive'], carwash: ['car_wash'],
  // Pet
  'dog food': ['pet','veterinary'], 'cat food': ['pet','veterinary'],
  'pet food': ['pet','veterinary'], 'pet supplies': ['pet'],
  vet: ['veterinary'], veterinary: ['veterinary'],
  // Beauty & wellness
  haircut: ['hairdresser','beauty'], salon: ['beauty','hairdresser'],
  spa: ['wellness','beauty'], massage: ['wellness'],
  // Laundry
  laundry: ['laundry'], 'dry cleaning': ['laundry'], drycleaning: ['laundry'],
  // Bank & ATM
  atm: ['bank'], cash: ['bank'], bank: ['bank'],
  // Florist
  flowers: ['florist'], florist: ['florist'],
  // Fitness
  gym: ['fitness','fitness_centre'], workout: ['fitness','fitness_centre'],
  // Urgent home
  plumber: ['plumber'], electrician: ['electrician'], hvac: ['hvac'],
  locksmith: ['locksmith'],
};

// Pre-compute keyword list sorted by length desc so multi-word keys win
const _KEYWORD_KEYS_SORTED = Object.keys(KEYWORD_CATEGORY_MAP)
  .sort((a, b) => b.length - a.length);

// Lightweight ORDER_ITEM detector — mirrors the (looser) regex in localIntelAgent
// so callers can short-circuit before the heavier flow runs there.
const _ORDER_ITEM_HINT = /(?:\border(?:\s+me)?\s+|\bI(?:'d|\s+would)\s+like\s+|\bI\s+want\s+|\bget\s+me\s+|\bcan\s+I\s+(?:get|order)\s+)/i;

const _NEEDS_OPEN_RE = /\b(right now|open now|open right now|currently open|near me|nearby|tonight|now)\b/i;

/**
 * classifyIntent(query) →
 *   { type: 'ORDER_ITEM', raw }
 *   | { type: 'CATEGORY_SEARCH', categories, cuisines, needsOpenNow, raw }
 *   | { type: 'TEXT_SEARCH', raw }
 */
function classifyIntent(query) {
  const raw = String(query || '');
  const q   = raw.toLowerCase().trim();

  if (!q) return { type: 'TEXT_SEARCH', raw };

  // 1) ORDER_ITEM short-circuit — keep Basalt order flow intact
  if (_ORDER_ITEM_HINT.test(raw)) {
    return { type: 'ORDER_ITEM', raw };
  }

  // 2) Keyword → category lookup, longest match wins
  let matched = null;
  for (const kw of _KEYWORD_KEYS_SORTED) {
    const idx = q.indexOf(kw);
    if (idx === -1) continue;
    // word-boundary-ish: char before/after must NOT be alphanumeric
    const before = idx === 0 ? '' : q[idx - 1];
    const after  = idx + kw.length === q.length ? '' : q[idx + kw.length];
    if (before && /[a-z0-9]/.test(before)) continue;
    if (after && /[a-z0-9]/.test(after)) continue;
    matched = kw;
    break;
  }

  if (matched) {
    const categories = KEYWORD_CATEGORY_MAP[matched].slice();
    const hour = new Date().getHours();
    const lateNightCats = categories.includes('bar') || categories.includes('liquor_store');
    const needsOpenNow = _NEEDS_OPEN_RE.test(q) || (lateNightCats && hour >= 21);
    return {
      type: 'CATEGORY_SEARCH',
      categories,
      cuisines: [],
      needsOpenNow,
      matchedKeyword: matched,
      raw,
    };
  }

  // 3) Fallback — full-text search
  return { type: 'TEXT_SEARCH', raw };
}

module.exports = {
  route,
  detectVertical,
  detectZip,
  detectRegion,
  rankZipsForVertical,
  detectIntent,
  classifyIntent,
  KEYWORD_CATEGORY_MAP,
};
