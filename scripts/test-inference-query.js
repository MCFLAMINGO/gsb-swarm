'use strict';
/**
 * test-inference-query.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Integration test for local_intel_query:
 *
 *  1. COLD CACHE   — wipe inference cache for test ZIP, call local_intel_query,
 *                    verify cache miss + scout dispatch fired
 *  2. WARM CACHE   — call again with same query, verify cache HIT path returns
 *                    the same answer (no re-run)
 *  3. REGION QUERY — call with a region phrase ("Northeast Florida") and verify
 *                    multi-ZIP routing returns ≥2 ZIPs evaluated
 *  4. INTENT ROUTE — verify routing logic resolves vertical + ZIP correctly
 *                    from plain-English queries without explicit ZIP
 *
 * Runs against the live Railway MCP endpoint by default.
 * Set MCP_BASE_URL=http://localhost:3001 to run against local server.
 *
 * Usage:
 *   node scripts/test-inference-query.js
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const BASE_URL    = process.env.MCP_BASE_URL || 'https://gsb-swarm-production.up.railway.app';
const MCP_URL     = `${BASE_URL}/api/local-intel/mcp`;
const DATA_DIR    = path.join(__dirname, '..', 'data');
const CACHE_DIR   = path.join(DATA_DIR, 'inference');
const ENRICH_LOG  = path.join(DATA_DIR, 'sourceLog.json');

const TEST_ZIP    = '32082';
const TEST_QUERY  = 'where should I open a healthcare clinic in Ponte Vedra Beach';
const REGION_Q    = 'what food gaps exist in Northeast Florida';
const INTENT_Q    = 'is there demand for a dental clinic in Nocatee';

// ── ANSI colors ───────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
};

// ── Test runner ───────────────────────────────────────────────────────────────
const results = [];

function pass(name, detail = '') {
  results.push({ name, status: 'PASS', detail });
  console.log(`  ${C.green}✓${C.reset} ${name}${detail ? C.dim + '  ' + detail + C.reset : ''}`);
}

function fail(name, detail = '') {
  results.push({ name, status: 'FAIL', detail });
  console.log(`  ${C.red}✗${C.reset} ${C.bold}${name}${C.reset}${detail ? C.dim + '  ' + detail + C.reset : ''}`);
}

function info(msg) {
  console.log(`  ${C.cyan}→${C.reset} ${C.dim}${msg}${C.reset}`);
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function post(url, body, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const lib     = url.startsWith('https') ? https : http;
    const parsed  = new URL(url);
    const req = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (url.startsWith('https') ? 443 : 80),
      path:     parsed.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Timeout after ${timeoutMs}ms`)); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── MCP JSON-RPC helper ───────────────────────────────────────────────────────
let _rpcId = 1;
async function callTool(toolName, params) {
  const res = await post(MCP_URL, {
    jsonrpc: '2.0',
    id:      _rpcId++,
    method:  'tools/call',
    params:  { name: toolName, arguments: params },
  });
  if (res.body.error) throw new Error(`RPC error: ${JSON.stringify(res.body.error)}`);
  // MCP returns result.content[0].text as JSON string
  const content = res.body.result?.content;
  if (Array.isArray(content) && content[0]?.text) {
    try { return JSON.parse(content[0].text); }
    catch (_) { return content[0].text; }
  }
  return res.body.result;
}

// ── Cache helpers (local only — skipped when testing remote Railway) ──────────
const IS_LOCAL = BASE_URL.includes('localhost') || BASE_URL.includes('127.0.0.1');

function wipeCacheEntry(zip) {
  if (!IS_LOCAL) return; // can't wipe Railway's in-memory cache remotely
  const f = path.join(CACHE_DIR, `${zip}.json`);
  if (fs.existsSync(f)) {
    fs.writeFileSync(f, JSON.stringify({ entries: [], meta: {} }));
    info(`wiped cache for ${zip}`);
  }
}

function readCacheEntries(zip) {
  if (!IS_LOCAL) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${zip}.json`), 'utf8'));
    return raw.entries || [];
  } catch (_) { return []; }
}

function getEnrichLogLength() {
  if (!IS_LOCAL) return -1;
  try { return JSON.parse(fs.readFileSync(ENRICH_LOG, 'utf8')).length; }
  catch (_) { return 0; }
}

// ── Suite 1: Cold cache → miss + scout dispatch ───────────────────────────────
async function suiteColCache() {
  console.log(`\n${C.bold}Suite 1 — Cold cache / miss path${C.reset}`);

  wipeCacheEntry(TEST_ZIP);
  const logLenBefore = getEnrichLogLength();

  let result;
  try {
    result = await callTool('local_intel_query', { query: TEST_QUERY });
  } catch (e) {
    fail('local_intel_query responds', e.message);
    return null;
  }

  // Tool responds
  pass('local_intel_query responds');
  info(`routed_to=${result.routed_to}  vertical=${result.vertical}  zip=${result.zip}  route_confidence=${result.route_confidence}`);

  // Routing sanity
  if (result.vertical === 'healthcare') {
    pass('vertical detected as healthcare');
  } else {
    fail('vertical detected as healthcare', `got: ${result.vertical}`);
  }

  if (result.zip === TEST_ZIP || result.zip === '32081') {
    pass(`ZIP resolved to ${result.zip} (Ponte Vedra / Nocatee area)`);
  } else {
    fail('ZIP resolved to NE Florida area', `got: ${result.zip}`);
  }

  if (result.route_confidence >= 50) {
    pass(`route_confidence ≥ 50 (got ${result.route_confidence})`);
  } else {
    fail('route_confidence ≥ 50', `got: ${result.route_confidence}`);
  }

  // Cache miss flag
  if (result._cache?.hit === false) {
    pass('_cache.hit = false (cold cache miss confirmed)');
  } else if (result._cache?.hit === true) {
    // On Railway we can't wipe remote cache — this is acceptable
    if (!IS_LOCAL) {
      pass('_cache.hit (Railway may have warm cache — acceptable for remote run)');
    } else {
      fail('_cache.hit = false', 'got hit=true after cache wipe');
    }
  } else {
    fail('_cache field present in response', `got: ${JSON.stringify(result._cache)}`);
  }

  // Answer is populated
  if (result.answer && (result.answer.data || result.answer.error === undefined)) {
    pass('answer field populated');
  } else {
    fail('answer field populated', `got: ${JSON.stringify(result.answer)?.slice(0, 120)}`);
  }

  // Scout dispatch — only verifiable locally
  if (IS_LOCAL) {
    // Give scout 500ms to fire and log
    await new Promise(r => setTimeout(r, 500));
    const logLenAfter = getEnrichLogLength();
    if (logLenAfter > logLenBefore || result.answer?.confidence_score >= 40) {
      pass('scout dispatch fired or confidence already sufficient (no dispatch needed)');
    } else {
      // Low-confidence result: check if gap file was updated
      const gapFile = path.join(DATA_DIR, 'gaps', 'healthcare.json');
      if (fs.existsSync(gapFile)) {
        const gaps = JSON.parse(fs.readFileSync(gapFile, 'utf8'));
        const hasEntry = gaps.some(g => g.zip === (result.zip || TEST_ZIP));
        if (hasEntry) {
          pass('gap logged (scout dispatch triggered on low confidence)');
        } else {
          fail('scout dispatch or gap log', 'no gap entry found and enrich log unchanged');
        }
      } else {
        fail('scout dispatch', 'healthcare gap file missing');
      }
    }
  } else {
    // Remote: verify via _llm_hint field
    if (typeof result._llm_hint === 'string') {
      pass('_llm_hint present (scout dispatch integrated)');
      info(result._llm_hint);
    } else {
      fail('_llm_hint present', `got: ${JSON.stringify(result._llm_hint)}`);
    }
  }

  return result; // pass to suite 2
}

// ── Suite 2: Warm cache → hit returns same answer ─────────────────────────────
async function suiteWarmCache(firstResult) {
  console.log(`\n${C.bold}Suite 2 — Warm cache / hit path${C.reset}`);

  if (!firstResult) {
    fail('warm cache suite', 'skipped — cold cache suite returned no result');
    return;
  }

  let result;
  try {
    result = await callTool('local_intel_query', { query: TEST_QUERY });
  } catch (e) {
    fail('local_intel_query second call responds', e.message);
    return;
  }

  pass('local_intel_query second call responds');

  // Cache hit on Railway may not be guaranteed (Railway restarts wipe in-memory),
  // but if the cache file persists we should see a hit.
  if (result._cache?.hit === true) {
    pass('_cache.hit = true (warm cache confirmed)');
    if (result._cache.similarity !== undefined) {
      pass(`similarity score present (${result._cache.similarity.toFixed(2)})`);
    }
    if (result._cache.expires_at) {
      pass(`expires_at present (${result._cache.expires_at})`);
    }
  } else {
    // Not a hard failure on remote — Railway may have restarted
    const msg = IS_LOCAL ? 'FAIL' : 'WARN (remote Railway — acceptable if server restarted)';
    if (IS_LOCAL) {
      fail('_cache.hit = true on second call', `got: ${JSON.stringify(result._cache)}`);
    } else {
      console.log(`  ${C.yellow}⚠${C.reset}  cache hit not confirmed on remote (Railway restart may have cleared cache)`);
    }
  }

  // Same vertical + routing
  if (result.vertical === firstResult.vertical) {
    pass(`vertical consistent across calls (${result.vertical})`);
  } else {
    fail('vertical consistent across calls', `first=${firstResult.vertical} second=${result.vertical}`);
  }

  // Answer data shape preserved
  const firstData  = JSON.stringify(firstResult.answer?.data  || firstResult.answer);
  const secondData = JSON.stringify(result.answer?.data || result.answer);
  if (firstData && secondData && firstData === secondData) {
    pass('answer data identical between cold and warm call');
  } else if (result._cache?.hit === true) {
    // Hit — data MUST match
    fail('answer data identical between cold and warm call', 'cache hit but data diverged');
  } else {
    // Miss on second call — not a hard failure, just log
    info('second call was also a miss (cache may not have persisted) — answer content may differ');
  }
}

// ── Suite 3: Region query → multi-ZIP ────────────────────────────────────────
async function suiteRegionQuery() {
  console.log(`\n${C.bold}Suite 3 — Region query / multi-ZIP routing${C.reset}`);

  let result;
  try {
    result = await callTool('local_intel_query', { query: REGION_Q });
  } catch (e) {
    fail('region query responds', e.message);
    return;
  }

  pass('region query responds');
  info(`query="${REGION_Q}"`);
  info(`zips_evaluated=${JSON.stringify(result.zips_evaluated)}`);

  if (Array.isArray(result.zips_evaluated) && result.zips_evaluated.length >= 2) {
    pass(`multi-ZIP evaluated (${result.zips_evaluated.length} ZIPs)`);
  } else {
    fail('multi-ZIP evaluated', `got: ${JSON.stringify(result.zips_evaluated)}`);
  }

  if (result.vertical === 'restaurant') {
    pass('vertical detected as restaurant for food gap query');
  } else {
    fail('vertical detected as restaurant', `got: ${result.vertical}`);
  }

  if (result.multi_zip_results !== null || result.zips_evaluated?.length >= 1) {
    pass('multi_zip_results field present');
  } else {
    fail('multi_zip_results field present', `got: ${JSON.stringify(result.multi_zip_results)}`);
  }
}

// ── Suite 4: Intent routing accuracy ─────────────────────────────────────────
async function suiteIntentRouting() {
  console.log(`\n${C.bold}Suite 4 — Intent routing accuracy${C.reset}`);

  const cases = [
    { query: 'what restaurant gaps exist in 32082',        expectedVertical: 'restaurant', expectedZip: '32082' },
    { query: 'is there a healthcare gap in Nocatee',       expectedVertical: 'healthcare', expectedZip: '32081' },
    { query: 'construction permits active in 32084',       expectedVertical: 'construction', expectedZip: '32084' },
    { query: 'retail undersupplied in Ponte Vedra Beach',  expectedVertical: 'retail', expectedZip: '32082' },
    { query: 'real estate investment signal for 32092',    expectedVertical: 'realtor', expectedZip: '32092' },
  ];

  for (const c of cases) {
    let result;
    try {
      result = await callTool('local_intel_query', { query: c.query });
    } catch (e) {
      fail(`route: "${c.query.slice(0, 40)}..."`, e.message);
      continue;
    }

    const vOk  = result.vertical === c.expectedVertical;
    const zOk  = result.zip       === c.expectedZip;
    const name = `route "${c.query.slice(0, 42)}..."`;

    if (vOk && zOk) {
      pass(name, `vertical=${result.vertical} zip=${result.zip}`);
    } else {
      const detail = [
        !vOk ? `vertical: expected ${c.expectedVertical} got ${result.vertical}` : '',
        !zOk ? `zip: expected ${c.expectedZip} got ${result.zip}` : '',
      ].filter(Boolean).join(' · ');
      fail(name, detail);
    }
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
function printSummary() {
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const total  = results.length;

  console.log(`\n${'─'.repeat(52)}`);
  console.log(`${C.bold}RESULT: ${passed}/${total} passed${failed > 0 ? `  (${failed} failed)` : ''}${C.reset}`);

  if (failed > 0) {
    console.log(`\n${C.red}Failed:${C.reset}`);
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  ${C.red}✗${C.reset} ${r.name}${r.detail ? C.dim + ' — ' + r.detail + C.reset : ''}`);
    });
    process.exitCode = 1;
  } else {
    console.log(`${C.green}All checks passed.${C.reset}`);
  }
  console.log('');
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const mode = IS_LOCAL ? 'LOCAL' : 'REMOTE';
  console.log(`\n${C.bold}╔══════════════════════════════════════════════════════╗`);
  console.log(`║  LocalIntel — local_intel_query integration test    ║`);
  console.log(`║  ${new Date().toISOString().slice(0, 19).replace('T', ' ')} EDT   mode=${mode.padEnd(6)}          ║`);
  console.log(`╚══════════════════════════════════════════════════════╝${C.reset}`);
  console.log(`  endpoint: ${MCP_URL}`);

  try {
    const coldResult = await suiteColCache();
    await suiteWarmCache(coldResult);
    await suiteRegionQuery();
    await suiteIntentRouting();
  } catch (e) {
    console.error(`\n${C.red}Unhandled error:${C.reset}`, e.message);
    process.exitCode = 1;
  }

  printSummary();
})();
