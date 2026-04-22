'use strict';
/**
 * mcpProbeWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 5 ACP agents act as REAL USERS hitting the MCP endpoint with natural-language
 * queries — exactly as a paying customer would.
 *
 * Agents / personas:
 *   1. Realtor Rosa      — real estate investor, uses local_intel_realtor + oracle
 *   2. Chef Marco        — restaurant group, uses local_intel_restaurant + oracle
 *   3. Builder Ben       — construction company, uses local_intel_construction + bedrock
 *   4. Retailer Rita     — retail expansion, uses local_intel_retail + sector_gap
 *   5. Health Harriet    — healthcare group, uses local_intel_healthcare + signal
 *
 * Each agent fires 3 prompts per cycle at 3 different ZIPs.
 * Results scored: did we get a real answer? confidence? data density?
 * All logged to data/mcp_probe_log.json (rolling, last 500 entries).
 *
 * Cycle: every 20 min — staggered so it runs all night without hammering.
 * ZIPs rotate across priority list so we test coverage breadth.
 *
 * Output: data/mcp_probe_log.json — queryable tomorrow morning.
 */

const fs   = require('fs');
const path = require('path');
const http = require('http');

const BASE_DIR  = path.join(__dirname, '..');
const LOG_PATH  = path.join(BASE_DIR, 'data', 'mcp_probe_log.json');
const ZIPS_PATH = path.join(__dirname, 'flZipData.json');

const CYCLE_MS      = 20 * 60 * 1000;  // 20 min
const STAGGER_MS    =  2 * 60 * 1000;  // 2 min startup delay
const MAX_LOG       = 500;
const MCP_URL       = 'http://localhost:8080/api/local-intel/mcp';

// ── Personas + their actual oracle tool names ────────────────────────────────
// Tools use real prefixes from the oracle: fb_=restaurant, re_=realtor,
// cx_=construction, rx_=retail, hc_=healthcare
// Each persona rotates through 6 tools so we test breadth.
const PERSONAS = [
  {
    id: 'realtor_rosa',
    role: 'Realtor / Real Estate Investor',
    tools: [
      're_001_whats_the_median_household_income',
      're_002_is_32082_a_buyers_market',
      're_006_whats_the_flood_zone_exposure',
      're_008_whats_the_new_development_pipeline',
      're_013_whats_the_commercial_vacancy_rate',
      're_015_what_infrastructure_investments_are_plan',
    ],
  },
  {
    id: 'chef_marco',
    role: 'Restaurant Group Owner',
    tools: [
      'fb_001_is_32082_oversaturated_with_casual',
      'fb_002_what_cuisine_types_are_missing',
      'fb_004_show_me_the_restaurant_density',
      'fb_005_whats_the_breakfasttodinner_ratio_of',
      'fb_009_what_does_the_deliveryversusdinein_split',
      'fb_010_im_a_franchise_operator_evaluating',
    ],
  },
  {
    id: 'builder_ben',
    role: 'Construction Company',
    tools: [
      'cx_001_whats_the_permit_velocity_in',
      'cx_002_is_32082_oversaturated_with_general',
      'cx_004_im_a_roofing_contractor_evaluating',
      'cx_007_whats_the_luxury_remodel_demand',
      'cx_009_whats_the_renovationversusnewbuild_split',
      'cx_016_im_a_commercial_contractor_whats',
    ],
  },
  {
    id: 'retailer_rita',
    role: 'Retail Expansion Analyst',
    tools: [
      'rx_001_is_32082_oversaturated_with_boutique',
      'rx_002_what_retail_spending_categories_are',
      'rx_004_whats_the_luxury_retail_gap',
      'rx_008_is_there_a_specialty_outdoor',
      'rx_009_what_is_the_consumer_spending',
      'rx_013_what_retail_categories_are_most',
    ],
  },
  {
    id: 'health_harriet',
    role: 'Healthcare Group',
    tools: [
      'hc_001_is_32082_oversaturated_with_dentists',
      'hc_002_whats_the_primary_care_physician',
      'hc_004_what_specialist_gaps_exist_in',
      'hc_005_is_there_demand_for_a',
      'hc_007_how_does_the_senior_population',
      'hc_009_what_does_the_pediatric_care',
    ],
  },
];

// ── ZIP rotation — use seeded + priority ZIPs ─────────────────────────────────
function getProbeZips() {
  try {
    const data = JSON.parse(fs.readFileSync(ZIPS_PATH, 'utf8'));
    // Seed ZIPs first (we know they have data), then top priority
    const seeded = ['32082', '32081'];
    const rest   = data
      .filter(z => !seeded.includes(String(z.zip)))
      .sort((a, b) => (b.pop || 0) - (a.pop || 0))
      .slice(0, 20)
      .map(z => ({ zip: String(z.zip), name: z.name || '' }));
    const seededFull = seeded.map(z => {
      const found = data.find(d => String(d.zip) === z);
      return { zip: z, name: found?.name || '' };
    });
    return [...seededFull, ...rest];
  } catch {
    return [
      { zip: '32082', name: 'Ponte Vedra Beach' },
      { zip: '32081', name: 'Nocatee' },
      { zip: '32084', name: 'St Augustine' },
    ];
  }
}

// ── MCP call via local HTTP ───────────────────────────────────────────────────
function callMcp(toolName, args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    });

    const opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };

    const url  = new URL(MCP_URL);
    opts.host  = url.hostname;
    opts.port  = url.port || 8080;
    opts.path  = url.pathname;

    const req = http.request(opts, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          resolve({ status: res.statusCode, body: parsed });
        } catch {
          resolve({ status: res.statusCode, body: raw });
        }
      });
    });
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Score a response — did we get real data? ─────────────────────────────────
function scoreResponse(body, toolName) {
  const result = body?.result;
  if (!result) return { score: 0, reason: 'no_result' };

  const content = Array.isArray(result?.content) ? result.content : [];
  const text    = content.map(c => c?.text || '').join(' ');

  if (!text || text.length < 20)          return { score: 0, reason: 'empty_response' };
  if (text.includes('no data')
   || text.includes('not found')
   || text.includes('0 businesses'))      return { score: 20, reason: 'no_data' };
  if (text.includes('confidence')
   || text.includes('businesses')
   || text.length > 200)                  return { score: 80, reason: 'has_data' };

  return { score: 50, reason: 'partial_data' };
}

// ── Log management ────────────────────────────────────────────────────────────
function loadLog() {
  try { return JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')); }
  catch { return []; }
}

function saveLog(entries) {
  const trimmed = entries.slice(-MAX_LOG);
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.writeFileSync(LOG_PATH, JSON.stringify(trimmed, null, 2));
}

function appendLog(entry) {
  const log = loadLog();
  log.push(entry);
  saveLog(log);
}

// ── Run one persona probe cycle ───────────────────────────────────────────────
async function runPersona(persona, zipPool, cycleIndex) {
  // Rotate through both ZIPs and tools each cycle
  const startIdx  = (cycleIndex * 3) % zipPool.length;
  const startTool = (cycleIndex * 2) % persona.tools.length;

  const calls = [
    { zip: zipPool[startIdx % zipPool.length].zip,       tool: persona.tools[startTool % persona.tools.length] },
    { zip: zipPool[(startIdx+1) % zipPool.length].zip,   tool: persona.tools[(startTool+1) % persona.tools.length] },
    { zip: zipPool[(startIdx+2) % zipPool.length].zip,   tool: persona.tools[(startTool+2) % persona.tools.length] },
  ];

  for (const { zip, tool } of calls) {
    const found = zipPool.find(z => z.zip === zip);
    const name  = found?.name || '';
    const t0    = Date.now();
    const entry = {
      ts:            new Date().toISOString(),
      persona:       persona.id,
      role:          persona.role,
      tool,
      zip,
      name,
      score:         0,
      reason:        'not_run',
      latency_ms:    0,
      answer_length: 0,
      error:         null,
    };

    try {
      const resp = await callMcp(tool, { zip });
      entry.latency_ms  = Date.now() - t0;
      const { score, reason } = scoreResponse(resp.body, tool);
      entry.score       = score;
      entry.reason      = reason;
      entry.http_status = resp.status;
      const content     = resp.body?.result?.content;
      const text        = Array.isArray(content) ? content.map(c => c?.text || '').join(' ') : '';
      entry.answer_snippet = text.slice(0, 400);
      entry.answer_length  = text.length;
      console.log(`[mcp-probe] ${persona.id} | ${zip} | ${tool} | score:${score} | ${reason} | ${entry.latency_ms}ms`);
    } catch (err) {
      entry.latency_ms = Date.now() - t0;
      entry.error      = err.message;
      entry.score      = 0;
      entry.reason     = 'error';
      console.warn(`[mcp-probe] ${persona.id} | ${zip} | ERROR: ${err.message}`);
    }

    appendLog(entry);
    await new Promise(r => setTimeout(r, 2000));
  }
}

// ── Summary stats for morning review ─────────────────────────────────────────
function printSummary() {
  const log = loadLog();
  if (!log.length) return;

  const byPersona = {};
  for (const e of log) {
    if (!byPersona[e.persona]) byPersona[e.persona] = { total: 0, scored: 0, errors: 0, noData: 0 };
    byPersona[e.persona].total++;
    byPersona[e.persona].scored   += e.score;
    if (e.error)             byPersona[e.persona].errors++;
    if (e.reason === 'no_data' || e.reason === 'empty_response') byPersona[e.persona].noData++;
  }

  console.log('\n[mcp-probe] ── OVERNIGHT SUMMARY ──────────────────────────');
  for (const [persona, stats] of Object.entries(byPersona)) {
    const avg = stats.total ? Math.round(stats.scored / stats.total) : 0;
    console.log(`[mcp-probe]   ${persona.padEnd(20)} | queries:${stats.total} | avg_score:${avg} | errors:${stats.errors} | no_data:${stats.noData}`);
  }
  console.log(`[mcp-probe]   Total log entries: ${log.length}`);
  console.log('[mcp-probe] ────────────────────────────────────────────────\n');
}

// ── Main daemon loop ──────────────────────────────────────────────────────────
(async function main() {
  console.log('[mcp-probe] MCP probe worker started — 5 agent personas, 20min cycles');

  // Wait for server + other workers to fully initialize
  await new Promise(r => setTimeout(r, STAGGER_MS));

  const zipPool    = getProbeZips();
  let   cycleIndex = 0;

  // Summary every 2 hours
  setInterval(printSummary, 2 * 60 * 60 * 1000);

  while (true) {
    console.log(`[mcp-probe] Cycle ${cycleIndex + 1} — ${zipPool.length} ZIPs in pool`);

    for (const persona of PERSONAS) {
      try {
        await runPersona(persona, zipPool, cycleIndex);
      } catch (err) {
        console.error(`[mcp-probe] Persona ${persona.id} cycle error:`, err.message);
      }
      // Stagger personas 10s apart
      await new Promise(r => setTimeout(r, 10000));
    }

    cycleIndex++;
    console.log(`[mcp-probe] Cycle ${cycleIndex} complete — sleeping 20min`);
    await new Promise(r => setTimeout(r, CYCLE_MS));
  }
})();
