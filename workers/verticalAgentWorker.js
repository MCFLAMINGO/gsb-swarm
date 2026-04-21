'use strict';
/**
 * verticalAgentWorker.js
 *
 * The self-training loop for LocalIntel vertical agents.
 *
 * Each vertical (realtor, healthcare, retail, construction, restaurant) has:
 *  - 100 industry prompts
 *  - A mapping from prompt intent → MCP tool + query params
 *  - A gap logger that records when our data can't answer
 *
 * Flow:
 *  1. On startup, each vertical fires a sample of prompts at MCP (free tier)
 *  2. Answer quality is scored (result count, confidence, coverage)
 *  3. Low-quality answers are written to data/gaps/{industry}.json
 *  4. Worker runs again every 6 hours — as data fills in, gaps close
 *  5. Each vertical exposes its own MCP tool that Claude/other LLMs can call
 *     and pay $0.01 per query via the x402 paywall
 *
 * Gap closure loop:
 *  - zipAgent reads data/gaps/*.json and prioritizes enrichment for those ZIPs
 *  - chamberDiscovery targets gap categories for those ZIPs
 *  - Scores improve over time automatically
 */

const path = require('path');
const fs   = require('fs');

const DATA_DIR     = path.join(__dirname, '..', 'data');
const VERTICALS_DIR = path.join(DATA_DIR, 'verticals');
const GAPS_DIR     = path.join(DATA_DIR, 'gaps');
const RUNS_DIR     = path.join(DATA_DIR, 'vertical-runs');

const MCP_ENDPOINT = process.env.MCP_ENDPOINT || 'http://localhost:3001/api/local-intel/mcp';

// ── Vertical Configs ──────────────────────────────────────────────────────────
// Each config maps industry intent to MCP tool + how to extract params from prompt

const VERTICALS = {

  realtor: {
    name: 'Real Estate',
    defaultZips: ['32082', '32081', '32084', '32086', '32092', '32080'],
    // Maps keyword patterns → MCP tool + param extraction
    toolRoutes: [
      // Zone first — catches owner-occ, home value, income, growth trajectory before falling to search
      { pattern: /income|household|median|owner.occup|home value|median home|HHI|affluent|wealth|demographic|population|growth.trajec|growth.state|consumer profile|spending profile/i, tool: 'local_intel_zone',      params: (zip) => ({ zip }) },
      { pattern: /neighborhood|undervalued|market trend|inventory|school|flood|infrastructure|saturation|gap|opportunity/i,                                                             tool: 'local_intel_oracle',    params: (zip) => ({ zip }) },
      { pattern: /permit|construction|build|develop|zoning/i,                                                                                                                           tool: 'local_intel_bedrock',   params: (zip) => ({ zip }) },
      { pattern: /investment|signal|score|momentum/i,                                                                                                                                   tool: 'local_intel_signal',    params: (zip) => ({ zip }) },
      { pattern: /corridor|A1A|street|road|highway/i,                                                                                                                                   tool: 'local_intel_corridor',  params: (zip, q) => ({ street: extractStreet(q), zip }) },
      { pattern: /nearby|radius|distance|close|around/i,                                                                                                                                tool: 'local_intel_nearby',    params: (zip) => ({ lat: ZIP_CENTERS[zip]?.lat, lon: ZIP_CENTERS[zip]?.lon, radius_miles: 2 }) },
      { pattern: /business|restaurant|dental|retail|commercial|service|office|contractor|realtor|agent/i,                                                                               tool: 'local_intel_search',    params: (zip, q) => ({ query: q, zip }) },
    ],
    // Prompts focused on what LocalIntel can actually answer
    mcpPrompts: [
      { q: 'What is the demographic profile and income level of buyers in this ZIP?', zip: '32082' },
      { q: 'Are there commercial gaps that signal neighborhood appreciation potential?', zip: '32082' },
      { q: 'What is the flood zone risk percentage for this ZIP?', zip: '32082' },
      { q: 'What infrastructure projects are active near this ZIP?', zip: '32082' },
      { q: 'What businesses are opening or recently added in this area?', zip: '32082' },
      { q: 'What is the owner-occupancy rate and home value median?', zip: '32081' },
      { q: 'What upscale dining or retail is undersupplied in this market?', zip: '32082' },
      { q: 'What is the investment signal score for this ZIP?', zip: '32082' },
      { q: 'What restaurants are on the A1A corridor?', zip: '32082' },
      { q: 'What healthcare providers are accessible in this neighborhood?', zip: '32082' },
      { q: 'What is the tidal momentum direction for buyer activity in this ZIP?', zip: '32082' },
      { q: 'What school-related businesses or services are in this area?', zip: '32082' },
      { q: 'What is the market saturation status for food and beverage?', zip: '32082' },
      { q: 'What growth trajectory is this ZIP on — growing, stable, or transitioning?', zip: '32082' },
      { q: 'What construction or remodeling contractors operate in this ZIP?', zip: '32082' },
      { q: 'What is the household income and consumer profile for this area?', zip: '32084' },
      { q: 'How many businesses are in this ZIP and what categories dominate?', zip: '32086' },
      { q: 'What is the capture rate for food spending in this market?', zip: '32092' },
      { q: 'What businesses are near latitude 30.189 longitude -81.38?', zip: '32082' },
      { q: 'What are the top market opportunity signals for a residential buyer?', zip: '32081' },
    ],
  },

  healthcare: {
    name: 'Healthcare',
    defaultZips: ['32082', '32081', '32084', '32086', '32092', '32080'],
    toolRoutes: [
      // Zone/demographic questions FIRST — must not fall through to search
      { pattern: /income|household|median|affluent|consumer profile|spending profile|demographic|age|senior|population|growth trend|growth rate|growth trajectory|owner.occup|home value|median home|HHI/i, tool: 'local_intel_zone',    params: (zip) => ({ zip }) },
      { pattern: /gap|undersupplied|need|opportunity|unmet|missing/i,                                                                                                                                       tool: 'local_intel_oracle',  params: (zip) => ({ zip }) },
      { pattern: /new.*added|recently.*added|new.*opening|recently.*open|new.*business/i,                                                                                                                   tool: 'local_intel_changes', params: (zip) => ({ zip }) },
      { pattern: /nearby|radius|within.*miles|3 miles|close to/i,                                                                                                                                           tool: 'local_intel_nearby',  params: (zip) => ({ lat: ZIP_CENTERS[zip]?.lat, lon: ZIP_CENTERS[zip]?.lon, radius_miles: 3 }) },
      { pattern: /patient|clinic|hospital|doctor|physician|dental|pharmacy|health|optom|vision|physical.therap|urgent.care|walk.in|mental.health|counseling|rehab/i,                                       tool: 'local_intel_search',  params: (zip, q) => ({ query: extractCategory(q, 'healthcare'), zip }) },
    ],
    mcpPrompts: [
      { q: 'What dentists operate in this ZIP?', zip: '32082' },
      { q: 'What pharmacies are accessible in this area?', zip: '32082' },
      { q: 'How many physicians or clinics are in this ZIP?', zip: '32082' },
      { q: 'What is the median household income of patients in this area?', zip: '32082' },
      { q: 'What healthcare services are undersupplied relative to population?', zip: '32082' },
      { q: 'What is the senior population percentage that drives home health demand?', zip: '32082' },
      { q: 'What mental health or counseling services exist in this ZIP?', zip: '32082' },
      { q: 'What fitness or wellness businesses operate here?', zip: '32082' },
      { q: 'What healthcare businesses are within 3 miles of Ponte Vedra Beach?', zip: '32082' },
      { q: 'What is the consumer profile — does it skew toward affluent established patients?', zip: '32082' },
      { q: 'What optometrists or vision care providers are in this area?', zip: '32084' },
      { q: 'What physical therapy or rehab centers operate in St Johns County?', zip: '32092' },
      { q: 'What is the population growth trend that affects patient demand?', zip: '32081' },
      { q: 'What are new healthcare businesses recently added to this ZIP?', zip: '32082' },
      { q: 'What urgent care or walk-in clinics are in this market?', zip: '32086' },
    ],
  },

  retail: {
    name: 'Retail & Grocery',
    defaultZips: ['32082', '32081', '32084', '32086'],
    toolRoutes: [
      { pattern: /store|shop|retail|grocery|supermarket|convenience|specialty/i, tool: 'local_intel_search',    params: (zip, q) => ({ query: extractCategory(q, 'retail'), zip }) },
      { pattern: /corridor|street|plaza|center|mall/i,                            tool: 'local_intel_corridor',  params: (zip, q) => ({ street: extractStreet(q), zip }) },
      { pattern: /gap|missing|undersupplied|need/i,                               tool: 'local_intel_oracle',    params: (zip) => ({ zip }) },
      { pattern: /income|spending|demographic/i,                                  tool: 'local_intel_zone',      params: (zip) => ({ zip }) },
      { pattern: /nearby|radius|close/i,                                           tool: 'local_intel_nearby',    params: (zip) => ({ lat: ZIP_CENTERS[zip]?.lat, lon: ZIP_CENTERS[zip]?.lon, radius_miles: 2 }) },
    ],
    mcpPrompts: [
      { q: 'What grocery stores or supermarkets operate in this ZIP?', zip: '32082' },
      { q: 'What retail categories are undersupplied for the income level here?', zip: '32082' },
      { q: 'What is the consumer spending profile — affluent or budget-conscious?', zip: '32082' },
      { q: 'What specialty retail shops operate on A1A in Ponte Vedra?', zip: '32082' },
      { q: 'What hardware or home improvement stores are nearby?', zip: '32082' },
      { q: 'What clothing or apparel retailers serve this market?', zip: '32082' },
      { q: 'How many retail businesses are in this ZIP total?', zip: '32082' },
      { q: 'What pet supply or pet service businesses exist here?', zip: '32082' },
      { q: 'What convenience stores operate in Nocatee?', zip: '32081' },
      { q: 'What is the capture rate for retail spending in this ZIP?', zip: '32082' },
      { q: 'What businesses have recently opened in this retail market?', zip: '32082' },
      { q: 'What wine or liquor stores operate in Ponte Vedra Beach?', zip: '32082' },
      { q: 'What florists or gift shops are in this area?', zip: '32082' },
      { q: 'What is the household income that determines retail price tier demand?', zip: '32082' },
      { q: 'What bookstores or stationery shops exist in St Johns County?', zip: '32084' },
    ],
  },

  construction: {
    name: 'Construction & Home Services',
    defaultZips: ['32082', '32081', '32084', '32086', '32092'],
    toolRoutes: [
      { pattern: /contractor|plumber|electrician|landscap|remodel|builder|roofing|hvac/i, tool: 'local_intel_search',  params: (zip, q) => ({ query: extractCategory(q, 'construction'), zip }) },
      { pattern: /permit|construction|development|project/i,                               tool: 'local_intel_bedrock', params: (zip) => ({ zip }) },
      { pattern: /population|growth|new homes|housing/i,                                   tool: 'local_intel_zone',    params: (zip) => ({ zip }) },
      { pattern: /signal|momentum|opportunity/i,                                            tool: 'local_intel_signal',  params: (zip) => ({ zip }) },
    ],
    mcpPrompts: [
      { q: 'What general contractors operate in Ponte Vedra Beach?', zip: '32082' },
      { q: 'What roofing companies serve this ZIP?', zip: '32082' },
      { q: 'What plumbing businesses are in this area?', zip: '32082' },
      { q: 'What HVAC or air conditioning companies operate here?', zip: '32082' },
      { q: 'What electricians serve Nocatee and surrounding ZIPs?', zip: '32081' },
      { q: 'What landscaping companies operate in St Johns County?', zip: '32082' },
      { q: 'What is the infrastructure momentum score — are there active permits?', zip: '32082' },
      { q: 'What new construction or development projects are active in this ZIP?', zip: '32082' },
      { q: 'What pool builders or outdoor construction companies are nearby?', zip: '32082' },
      { q: 'What is the population growth rate that drives construction demand?', zip: '32081' },
      { q: 'What painting or interior finishing contractors operate here?', zip: '32082' },
      { q: 'What flooring or tile companies serve this market?', zip: '32082' },
      { q: 'What home inspection services are available in this ZIP?', zip: '32082' },
      { q: 'What window or door replacement companies serve this area?', zip: '32084' },
      { q: 'What pest control or remediation businesses operate in 32086?', zip: '32086' },
    ],
  },

  restaurant: {
    name: 'Food Services & Restaurants',
    defaultZips: ['32082', '32081', '32084', '32086', '32080'],
    toolRoutes: [
      { pattern: /restaurant|cafe|bar|dining|food|pizza|sushi|burger|breakfast|lunch|dinner/i, tool: 'local_intel_search',    params: (zip, q) => ({ query: extractCategory(q, 'food'), zip }) },
      { pattern: /corridor|A1A|street/i,                                                         tool: 'local_intel_corridor',  params: (zip, q) => ({ street: extractStreet(q), zip }) },
      { pattern: /gap|saturation|undersupplied|market|opportunity/i,                             tool: 'local_intel_oracle',    params: (zip) => ({ zip }) },
      { pattern: /income|demographic|spending|capture/i,                                         tool: 'local_intel_zone',      params: (zip) => ({ zip }) },
      { pattern: /signal|trend|momentum/i,                                                        tool: 'local_intel_tide',      params: (zip) => ({ zip }) },
    ],
    mcpPrompts: [
      { q: 'What restaurants are in Ponte Vedra Beach?', zip: '32082' },
      { q: 'Is the upscale dining market undersupplied in this ZIP?', zip: '32082' },
      { q: 'What is the restaurant saturation status — room for more or oversupplied?', zip: '32082' },
      { q: 'What fast casual restaurants operate in Nocatee?', zip: '32081' },
      { q: 'What is the food and beverage capture rate for this market?', zip: '32082' },
      { q: 'What fine dining options exist in 32082?', zip: '32082' },
      { q: 'What bars or nightlife venues operate in this area?', zip: '32082' },
      { q: 'What breakfast or brunch spots are in Ponte Vedra?', zip: '32082' },
      { q: 'How many restaurants are on the A1A corridor?', zip: '32082' },
      { q: 'What is the estimated daily meal demand vs. current capacity?', zip: '32082' },
      { q: 'What coffee shops or cafes serve this ZIP?', zip: '32082' },
      { q: 'What food trucks or pop-up food businesses operate here?', zip: '32082' },
      { q: 'What is the median household income that determines restaurant price tier demand?', zip: '32082' },
      { q: 'What sushi or Asian cuisine restaurants are in St Augustine?', zip: '32084' },
      { q: 'What is the tidal momentum for food and beverage investment in this ZIP?', zip: '32082' },
    ],
  },
};

// ── ZIP center coordinates ────────────────────────────────────────────────────
const ZIP_CENTERS = {
  '32082': { lat: 30.1893, lon: -81.3815 },
  '32081': { lat: 30.1100, lon: -81.4175 },
  '32084': { lat: 29.8900, lon: -81.3150 },
  '32086': { lat: 29.8100, lon: -81.3000 },
  '32092': { lat: 30.1200, lon: -81.4800 },
  '32080': { lat: 29.8600, lon: -81.2700 },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractStreet(q) {
  const m = q.match(/\bA1A\b|\bA-1-A\b|\bAlternate A1A\b/i);
  if (m) return 'A1A';
  const streetMatch = q.match(/\b(on|along|near|at)\s+([A-Z][a-zA-Z\s]{2,20}(?:St|Ave|Blvd|Rd|Dr|Ln|Way|Ct)?)/i);
  return streetMatch ? streetMatch[2].trim() : 'A1A';
}

function extractCategory(q, fallback) {
  const cats = {
    dentist: /dent/i, doctor: /doctor|physician|clinic|medical/i, pharmacy: /pharma|drug/i,
    restaurant: /restaurant|dining|food|eat/i, cafe: /cafe|coffee|espresso/i,
    bar: /bar|nightlife|brewery/i, grocery: /grocery|supermarket/i,
    contractor: /contractor|general.contractor/i, plumber: /plumb/i,
    electrician: /electric/i, landscaping: /landscap/i, roofing: /roof/i,
    hvac: /hvac|air.condition/i, retail: /retail|store|shop/i,
  };
  for (const [cat, re] of Object.entries(cats)) {
    if (re.test(q)) return cat;
  }
  return fallback;
}

function ensureDirs() {
  [DATA_DIR, VERTICALS_DIR, GAPS_DIR, RUNS_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

function atomicWrite(p, data) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

// ── MCP caller ────────────────────────────────────────────────────────────────

async function callMCP(toolName, args, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(MCP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
        params: { name: toolName, arguments: args },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const text = data?.result?.content?.[0]?.text;
    if (!text) return null;
    return JSON.parse(text);
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Answer quality scorer ─────────────────────────────────────────────────────
// Returns 0-100. Used to decide if we have a gap.

function scoreAnswer(toolName, result) {
  if (!result) return 0;

  if (toolName === 'local_intel_search') {
    const count = result.total || result.returned || (result.results || []).length;
    if (count === 0) return 0;
    const avgConf = result.results
      ? result.results.reduce((s, b) => s + (b.confidence || 60), 0) / result.results.length
      : 60;
    return Math.min(100, Math.round((count / 10) * 50 + avgConf * 0.5));
  }

  if (toolName === 'local_intel_oracle') {
    if (!result.demographics) return 0;
    return result.restaurant_capacity ? 80 : 40;
  }

  if (toolName === 'local_intel_zone') {
    return result.population > 0 ? 85 : 0;
  }

  if (toolName === 'local_intel_signal') {
    return result.investment_score !== undefined ? 70 : 0;
  }

  if (toolName === 'local_intel_bedrock') {
    return result.infrastructure_momentum_score > 0 ? 75 : 20;
  }

  if (toolName === 'local_intel_tide') {
    return result.temperature !== undefined ? 70 : 0;
  }

  if (toolName === 'local_intel_corridor') {
    return (result.businesses || []).length > 0 ? 80 : 10;
  }

  return result ? 50 : 0;
}

// ── Route prompt to best MCP tool ─────────────────────────────────────────────

function routePrompt(vertical, prompt) {
  const config = VERTICALS[vertical];
  const zip = prompt.zip || config.defaultZips[0];
  for (const route of config.toolRoutes) {
    if (route.pattern.test(prompt.q)) {
      return {
        tool: route.tool,
        args: route.params(zip, prompt.q),
        zip,
      };
    }
  }
  // Default fallback
  return {
    tool: 'local_intel_search',
    args: { query: prompt.q, zip },
    zip,
  };
}

// ── Run one vertical ──────────────────────────────────────────────────────────

async function runVertical(verticalKey) {
  const config = VERTICALS[verticalKey];
  const runId  = `${verticalKey}-${Date.now()}`;
  const results = [];
  const gaps    = [];

  console.log(`[verticalAgent] Starting ${config.name} (${config.mcpPrompts.length} prompts)`);

  for (const prompt of config.mcpPrompts) {
    const { tool, args, zip } = routePrompt(verticalKey, prompt);

    const result = await callMCP(tool, args);
    const score  = scoreAnswer(tool, result);

    const entry = {
      prompt: prompt.q,
      zip,
      tool,
      args,
      score,
      answered: score >= 40,
      result_summary: result
        ? (result.total !== undefined ? `${result.total} results` : result.infrastructure_momentum_score !== undefined ? `score:${result.infrastructure_momentum_score}` : 'data present')
        : 'no data',
      ts: new Date().toISOString(),
    };

    results.push(entry);

    if (score < 40) {
      gaps.push({
        prompt: prompt.q,
        zip,
        tool,
        industry: verticalKey,
        score,
        needs: score === 0 ? 'data missing' : 'low confidence',
        ts: entry.ts,
      });
    }

    // Small delay to avoid hammering MCP
    await new Promise(r => setTimeout(r, 300));
  }

  const answered  = results.filter(r => r.answered).length;
  const total     = results.length;
  const passRate  = Math.round((answered / total) * 100);

  const summary = {
    vertical: verticalKey,
    name: config.name,
    run_id: runId,
    ran_at: new Date().toISOString(),
    total_prompts: total,
    answered,
    gap_count: gaps.length,
    pass_rate_pct: passRate,
    results,
  };

  // Save run
  atomicWrite(path.join(RUNS_DIR, `${runId}.json`), summary);

  // Save/merge gaps
  const gapFile = path.join(GAPS_DIR, `${verticalKey}.json`);
  let existingGaps = [];
  try { existingGaps = JSON.parse(fs.readFileSync(gapFile, 'utf8')); } catch (_) {}
  const gapMap = {};
  [...existingGaps, ...gaps].forEach(g => { gapMap[`${g.zip}|${g.prompt}`] = g; });
  // Remove closed gaps (score >= 40 now)
  results.filter(r => r.answered).forEach(r => { delete gapMap[`${r.zip}|${r.prompt}`]; });
  atomicWrite(gapFile, Object.values(gapMap));

  console.log(`[verticalAgent] ${config.name}: ${answered}/${total} answered (${passRate}%) · ${gaps.length} gaps`);
  return summary;
}

// ── Run all verticals ─────────────────────────────────────────────────────────

async function runAllVerticals() {
  console.log(`[verticalAgent] Starting full vertical sweep at ${new Date().toISOString()}`);
  ensureDirs();

  const summaries = [];
  for (const key of Object.keys(VERTICALS)) {
    try {
      const s = await runVertical(key);
      summaries.push({ vertical: key, pass_rate_pct: s.pass_rate_pct, gaps: s.gap_count });
    } catch (err) {
      console.error(`[verticalAgent] Error in ${key}:`, err.message);
    }
  }

  // Write index
  atomicWrite(path.join(VERTICALS_DIR, '_index.json'), {
    updated_at: new Date().toISOString(),
    verticals: summaries,
  });

  console.log(`[verticalAgent] Sweep complete:`, summaries.map(s => `${s.vertical}=${s.pass_rate_pct}%`).join(', '));
}

// ── MCP tool handler (called from localIntelMCP.js) ──────────────────────────
// This is exported so each vertical becomes its own callable MCP tool.

async function handleVerticalQuery(verticalKey, query, zip) {
  const config = VERTICALS[verticalKey];
  if (!config) return { error: `Unknown vertical: ${verticalKey}` };

  const prompt = { q: query, zip: zip || config.defaultZips[0] };
  const { tool, args } = routePrompt(verticalKey, prompt);
  const result = await callMCP(tool, args);
  const score  = scoreAnswer(tool, result);

  // Log gap if low quality
  if (score < 40) {
    const gapFile = path.join(GAPS_DIR, `${verticalKey}.json`);
    let gaps = [];
    try { gaps = JSON.parse(fs.readFileSync(gapFile, 'utf8')); } catch (_) {}
    const key = `${zip}|${query}`;
    if (!gaps.find(g => `${g.zip}|${g.prompt}` === key)) {
      gaps.push({ prompt: query, zip, tool, industry: verticalKey, score, ts: new Date().toISOString() });
      try { atomicWrite(gapFile, gaps); } catch (_) {}
    }
  }

  return {
    vertical: verticalKey,
    industry: config.name,
    query,
    zip,
    tool_used: tool,
    confidence_score: score,
    data: result,
  };
}

module.exports = { runAllVerticals, runVertical, handleVerticalQuery, VERTICALS };

// ── Bootstrap (when run as worker) ───────────────────────────────────────────

if (require.main === module) {
  const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

  process.on('uncaughtException', (err) => console.error('[verticalAgent] Uncaught:', err.message));
  process.on('unhandledRejection', (r) => console.error('[verticalAgent] Rejection:', r));

  (async () => {
    await runAllVerticals();

    setInterval(async () => {
      try { await runAllVerticals(); }
      catch (err) { console.error('[verticalAgent] Interval error:', err.message); }
    }, INTERVAL_MS);

    // Keep-alive
    setInterval(() => {}, 1 << 30);

    console.log(`[verticalAgent] Scheduled — re-runs every ${INTERVAL_MS / 3600000}h`);
  })();
}
