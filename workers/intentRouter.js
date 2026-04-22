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
    { pattern: /gap|missing|undersupplied|need|demand|provider.ratio|unmet/i,                    tool: 'local_intel_healthcare' },
    { pattern: /signal|momentum|trend/i,                                                          tool: 'local_intel_signal' },
    { pattern: /demographic|senior|age|income|population/i,                                       tool: 'local_intel_zone' },
    { pattern: /permit|build|clinic.space|facility/i,                                             tool: 'local_intel_bedrock' },
  ],
  retail: [
    { pattern: /gap|missing|undersupplied|need|demand|spending.capture/i,                         tool: 'local_intel_retail' },
    { pattern: /corridor|street|anchor|shopping.center|plaza/i,                                   tool: 'local_intel_corridor' },
    { pattern: /demographic|income|spending|consumer/i,                                           tool: 'local_intel_zone' },
    { pattern: /signal|momentum/i,                                                                 tool: 'local_intel_signal' },
  ],
  construction: [
    { pattern: /permit|active|pipeline|project/i,                                                 tool: 'local_intel_bedrock' },
    { pattern: /gap|demand|opportunity|need/i,                                                    tool: 'local_intel_construction' },
    { pattern: /demographic|growth|population|household/i,                                        tool: 'local_intel_zone' },
    { pattern: /signal|momentum/i,                                                                 tool: 'local_intel_signal' },
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
function pickTool(query, vertical) {
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
  const tool        = pickTool(query, vertical || 'realtor');

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

  if (vertical) {
    reasoning.push(`vertical: ${vertical}`);
  } else {
    reasoning.push('no vertical detected — routing to ask tool');
  }

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
  };
}

module.exports = { route, detectVertical, detectZip, detectRegion, rankZipsForVertical };
