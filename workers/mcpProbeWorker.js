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

// ── Personas + their prompt templates ────────────────────────────────────────
const PERSONAS = [
  {
    id: 'realtor_rosa',
    role: 'Realtor / Real Estate Investor',
    tool: 'local_intel_realtor',
    prompts: [
      (zip, name) => `What are the best commercial real estate opportunities in ${zip} ${name}? Focus on income demographics and infrastructure momentum.`,
      (zip, name) => `Is ${zip} ${name} a strong market for a new mixed-use development in the next 24 months?`,
      (zip, name) => `What is the flood risk profile for ${zip} and how does it affect commercial property values?`,
    ],
  },
  {
    id: 'chef_marco',
    role: 'Restaurant Group Owner',
    tool: 'local_intel_restaurant',
    prompts: [
      (zip, name) => `Is ${zip} ${name} oversaturated with casual dining, or is there a gap for a new concept?`,
      (zip, name) => `What cuisine types are missing from the ${zip} restaurant market? I'm looking for a whitespace opportunity.`,
      (zip, name) => `What's the income profile of ${zip} ${name} and will it support a $25 average check restaurant?`,
    ],
  },
  {
    id: 'builder_ben',
    role: 'Construction Company',
    tool: 'local_intel_construction',
    prompts: [
      (zip, name) => `What is the new construction activity level in ${zip} ${name}? Are permits trending up or down?`,
      (zip, name) => `Is there demand for a roofing and exterior contractor expanding into ${zip}?`,
      (zip, name) => `What infrastructure projects are planned for ${zip} ${name} in the next 12-36 months?`,
    ],
  },
  {
    id: 'retailer_rita',
    role: 'Retail Expansion Analyst',
    tool: 'local_intel_retail',
    prompts: [
      (zip, name) => `What retail categories are undersupplied in ${zip} ${name} given the income and population profile?`,
      (zip, name) => `Is ${zip} a good market for a specialty outdoor and fitness retail store?`,
      (zip, name) => `What is the spending capture rate in ${zip} and where are residents going outside the ZIP to shop?`,
    ],
  },
  {
    id: 'health_harriet',
    role: 'Healthcare Group',
    tool: 'local_intel_healthcare',
    prompts: [
      (zip, name) => `What healthcare provider gaps exist in ${zip} ${name}? I'm evaluating urgent care and specialty clinic locations.`,
      (zip, name) => `What is the senior population concentration in ${zip} and what services are underserved?`,
      (zip, name) => `Is there demand for a pediatric clinic in ${zip} ${name} based on family demographics?`,
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
  // Each persona gets 3 different ZIPs rotated by cycle
  const startIdx = (cycleIndex * 3) % zipPool.length;
  const zips     = [
    zipPool[startIdx % zipPool.length],
    zipPool[(startIdx + 1) % zipPool.length],
    zipPool[(startIdx + 2) % zipPool.length],
  ];

  for (let i = 0; i < zips.length; i++) {
    const { zip, name } = zips[i];
    const promptFn      = persona.prompts[i % persona.prompts.length];
    const query         = promptFn(zip, name);

    const t0 = Date.now();
    let entry = {
      ts:       new Date().toISOString(),
      persona:  persona.id,
      role:     persona.role,
      tool:     persona.tool,
      zip,
      name,
      query,
      score:    0,
      reason:   'not_run',
      latency_ms: 0,
      answer_length: 0,
      error:    null,
    };

    try {
      const resp = await callMcp(persona.tool, { query, zip });
      entry.latency_ms    = Date.now() - t0;
      const { score, reason } = scoreResponse(resp.body, persona.tool);
      entry.score         = score;
      entry.reason        = reason;
      entry.http_status   = resp.status;
      // Store first 300 chars of answer for morning review
      const content = resp.body?.result?.content;
      const text    = Array.isArray(content) ? content.map(c => c?.text || '').join(' ') : '';
      entry.answer_snippet = text.slice(0, 300);
      entry.answer_length  = text.length;

      console.log(`[mcp-probe] ${persona.id} | ${zip} | score:${score} | ${reason} | ${entry.latency_ms}ms`);
    } catch (err) {
      entry.latency_ms = Date.now() - t0;
      entry.error      = err.message;
      entry.score      = 0;
      entry.reason     = 'error';
      console.warn(`[mcp-probe] ${persona.id} | ${zip} | ERROR: ${err.message}`);
    }

    appendLog(entry);

    // Small gap between calls — don't hammer
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
