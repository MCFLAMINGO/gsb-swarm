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
const LOG_PATH  = path.join(BASE_DIR, 'data', 'mcp_probe_log.json'); // fallback only
const ZIPS_PATH = path.join(__dirname, 'flZipData.json');
const pgStore   = require('../lib/pgStore');

const CYCLE_MS      = 20 * 60 * 1000;  // 20 min
const STAGGER_MS    =  2 * 60 * 1000;  // 2 min startup delay
const MAX_LOG       = 500;
const MCP_URL       = 'http://localhost:8080/api/local-intel/mcp';

// ── Personas + natural language queries ──────────────────────────────────────
// All queries go through local_intel_query — the fuzzy intent router.
// No tool names needed. Query includes ZIP so router resolves it automatically.
// These are real questions a paying customer would ask.
const PERSONAS = [
  {
    id: 'realtor_rosa',
    role: 'Realtor / Real Estate Investor',
    queries: [
      zip => `What is the median household income in ${zip} and how does it compare to the county average?`,
      zip => `Is ${zip} a buyer's or seller's market right now?`,
      zip => `What is the flood zone exposure in ${zip} and how does it affect property values?`,
      zip => `What new development is in the pipeline for ${zip}?`,
      zip => `What is the commercial vacancy rate in ${zip}?`,
      zip => `What infrastructure investments are planned for ${zip} in the next 2 years?`,
    ],
  },
  {
    id: 'chef_marco',
    role: 'Restaurant Group Owner',
    queries: [
      zip => `Is ${zip} oversaturated with casual dining restaurants?`,
      zip => `What cuisine types are missing from the ${zip} restaurant market?`,
      zip => `Show me the restaurant density per capita in ${zip}`,
      zip => `Is there a breakfast daypart gap in ${zip}?`,
      zip => `What does the delivery versus dine-in split look like in ${zip}?`,
      zip => `I'm a franchise operator evaluating ${zip} — how many fast casual concepts are already there?`,
    ],
  },
  {
    id: 'builder_ben',
    role: 'Construction Company',
    queries: [
      zip => `What is the permit velocity in ${zip} — how many new residential permits in the last 12 months?`,
      zip => `Is ${zip} oversaturated with general contractors?`,
      zip => `Is there demand for a roofing contractor expanding into ${zip}?`,
      zip => `What is the luxury remodel demand in ${zip}?`,
      zip => `What is the renovation versus new build split in ${zip}?`,
      zip => `I'm a commercial contractor — what is the pipeline of commercial projects in ${zip}?`,
    ],
  },
  {
    id: 'retailer_rita',
    role: 'Retail Expansion Analyst',
    queries: [
      zip => `Is ${zip} oversaturated with boutique clothing stores?`,
      zip => `What retail spending categories are undersupplied in ${zip}?`,
      zip => `What is the luxury retail gap in ${zip}?`,
      zip => `Is there a specialty outdoor and fitness retail opportunity in ${zip}?`,
      zip => `What is the consumer spending profile in ${zip}?`,
      zip => `What retail categories are most underrepresented in ${zip} given the income level?`,
    ],
  },
  {
    id: 'health_harriet',
    role: 'Healthcare Group',
    queries: [
      zip => `Is ${zip} oversaturated with dentists?`,
      zip => `What is the primary care physician density in ${zip}?`,
      zip => `What specialist gaps exist in ${zip}?`,
      zip => `Is there demand for an urgent care clinic in ${zip}?`,
      zip => `How does the senior population in ${zip} affect healthcare demand?`,
      zip => `What does the pediatric care market look like in ${zip}?`,
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
// Postgres-backed log — survives Railway restarts
async function appendLog(entry) {
  await pgStore.appendProbeLog(entry);
}

async function loadLog() {
  return await pgStore.getProbeLog(MAX_LOG);
}

// ── Run one persona probe cycle ───────────────────────────────────────────────
async function runPersona(persona, zipPool, cycleIndex) {
  // Rotate through ZIPs and queries each cycle
  const startIdx   = (cycleIndex * 3) % zipPool.length;
  const startQuery = (cycleIndex * 2) % persona.queries.length;

  const calls = [
    { zipEntry: zipPool[startIdx % zipPool.length],     queryFn: persona.queries[startQuery % persona.queries.length] },
    { zipEntry: zipPool[(startIdx+1) % zipPool.length], queryFn: persona.queries[(startQuery+1) % persona.queries.length] },
    { zipEntry: zipPool[(startIdx+2) % zipPool.length], queryFn: persona.queries[(startQuery+2) % persona.queries.length] },
  ];

  for (const { zipEntry, queryFn } of calls) {
    const { zip, name } = zipEntry;
    const query = queryFn(zip);
    const t0    = Date.now();
    const entry = {
      ts:            new Date().toISOString(),
      persona:       persona.id,
      role:          persona.role,
      tool:          'local_intel_query',
      zip,
      name,
      query,
      score:         0,
      reason:        'not_run',
      latency_ms:    0,
      answer_length: 0,
      error:         null,
    };

    try {
      // local_intel_query is the fuzzy intent router — pass plain English, it resolves everything
      const resp = await callMcp('local_intel_query', { query });
      entry.latency_ms  = Date.now() - t0;
      const scored = scoreResponse(resp.body, 'local_intel_query', persona.expectedVertical);
      entry.score             = scored.score;
      entry.reason            = scored.reason;
      entry.expected_vertical = scored.expected_vertical || persona.expectedVertical;
      entry.detected_vertical = scored.detected_vertical || null;
      entry.vertical_density  = scored.vertical_density  || null;
      entry.http_status = resp.status;
      const content     = resp.body?.result?.content;
      const text        = Array.isArray(content) ? content.map(c => c?.text || '').join(' ') : '';
      entry.answer_snippet = text.slice(0, 400);
      entry.answer_length  = text.length;
      console.log(`[mcp-probe] ${persona.id} | ${zip} | score:${scored.score} | ${scored.reason} | density:${scored.vertical_density ?? '-'}% | ${entry.latency_ms}ms | "${query.slice(0,60)}..."`);
    } catch (err) {
      entry.latency_ms = Date.now() - t0;
      entry.error      = err.message;
      entry.score      = 0;
      entry.reason     = 'error';
      console.warn(`[mcp-probe] ${persona.id} | ${zip} | ERROR: ${err.message}`);
    }

    await appendLog(entry);
    await new Promise(r => setTimeout(r, 3000));
  }
}

// ── Summary stats for morning review ─────────────────────────────────────────
async function printSummary() {
  const log = await loadLog();
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
  setInterval(() => printSummary().catch(e => console.error('[mcp-probe] Summary error:', e.message)), 2 * 60 * 60 * 1000);

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
