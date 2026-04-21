'use strict';
/**
 * Local Intel Agent — GSB Swarm
 *
 * ACP offering: local_intel_query
 * Serves hyperlocal business intelligence for any US zip code.
 *
 * Currently covers: 32081 (Nocatee) + 32082 (Ponte Vedra Beach), FL
 * Expandable: add new zip pulls to the data directory and re-register.
 *
 * Data sources:
 *   - OpenStreetMap (OSM) — named businesses, amenities, services
 *   - US Census ACS 2022 — population, income, housing, rent vs own
 *   - SJC Business Tax Receipts — active licensed businesses (pending)
 *   - FL Sunbiz — registered corporations (pending)
 *
 * Endpoints consumed by ACP jobs:
 *   POST /api/local-intel  { zip, query, category, limit }
 *   GET  /api/local-intel/zones  — spending zone summary
 *   GET  /api/local-intel/stats  — coverage stats
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { paymentMiddleware } = require('x402-express');

// ── x402 payment config ───────────────────────────────────────────────
// TREASURY receives USDC on Base mainnet.
// Agents without a Base wallet still use the Tempo/pathUSD endpoint (/api/local-intel/mcp).
// This x402 gate is ADDITIVE — a second payment rail, not a replacement.
const X402_TREASURY = process.env.X402_TREASURY || '0x774f484192Cf3F4fB9716Af2e15f44371fD32FEA';
const x402Middleware = paymentMiddleware(
  X402_TREASURY,
  {
    'POST /api/local-intel/mcp/x402':         { price: '$0.01', network: 'base', config: { description: 'LocalIntel MCP — standard tool call' } },
    'POST /api/local-intel/mcp/x402/premium': { price: '$0.05', network: 'base', config: { description: 'LocalIntel MCP — local_intel_for_agent premium composite' } },
  }
);

const router = express.Router();

// ── Load dataset ──────────────────────────────────────────────────────────────
// In production this would be a DB — for now it's the JSON file written by the pull script
const DATA_PATH = path.join(__dirname, 'data', 'localIntel.json');
const ZONES_PATH = path.join(__dirname, 'data', 'spendingZones.json');
const LEDGER_PATH = path.join(__dirname, 'data', 'usageLedger.json');
const ZIPS_DIR_AGENT = path.join(__dirname, 'data', 'zips');

function loadData() {
  // Merge seed file + all accumulated zip files so tools see the full dataset
  const seen = new Set();
  const all  = [];
  const addBiz = (b) => {
    const key = `${(b.name||'').toLowerCase()}|${b.zip||''}|${b.lat||''}|${b.lon||''}`;
    if (!seen.has(key)) { seen.add(key); all.push(b); }
  };
  try { JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')).forEach(addBiz); } catch {}
  try {
    if (fs.existsSync(ZIPS_DIR_AGENT)) {
      fs.readdirSync(ZIPS_DIR_AGENT).filter(f => f.endsWith('.json')).forEach(f => {
        try { JSON.parse(fs.readFileSync(path.join(ZIPS_DIR_AGENT, f), 'utf8')).forEach(addBiz); } catch {}
      });
    }
  } catch {}
  return all;
}

function loadZones() {
  try { return JSON.parse(fs.readFileSync(ZONES_PATH, 'utf8')); }
  catch { return {}; }
}

// ── Category normalizer ───────────────────────────────────────────────────────
const CATEGORY_GROUPS = {
  food:     ['restaurant','fast_food','cafe','bar','pub','ice_cream','food_court','alcohol'],
  retail:   ['supermarket','convenience','clothes','shoes','electronics','hairdresser','beauty',
              'chemist','mobile_phone','copyshop','dry_cleaning','nutrition_supplements'],
  health:   ['dentist','clinic','hospital','doctor','veterinary','fitness_centre','gym',
              'sports_centre','swimming_pool','yoga'],
  finance:  ['bank','atm','estate_agent','insurance','financial','accountant'],
  civic:    ['school','college','place_of_worship','church','library','post_office',
              'police','fire_station','government','social_centre','community_centre'],
  services: ['fuel','car_wash','car_repair','hotel','motel','office','coworking'],
};

function getGroup(cat) {
  for (const [group, cats] of Object.entries(CATEGORY_GROUPS)) {
    if (cats.includes(cat)) return group;
  }
  return 'other';
}

// ── POST /api/local-intel — main query endpoint ───────────────────────────────
router.post('/', (req, res) => {
  const { zip, query, category, group, limit = 50, minConfidence = 0 } = req.body || {};

  let results = loadData();

  if (!results.length) {
    return res.status(503).json({ ok: false, error: 'Local intel dataset not loaded. Run data pull first.' });
  }

  // Filter
  if (zip)           results = results.filter(b => b.zip === zip);
  if (category)      results = results.filter(b => b.category === category);
  if (group)         results = results.filter(b => getGroup(b.category) === group);
  if (minConfidence) results = results.filter(b => b.confidence >= minConfidence);
  if (query) {
    const q = query.toLowerCase();
    results = results.filter(b =>
      b.name.toLowerCase().includes(q) ||
      b.category.toLowerCase().includes(q) ||
      b.address.toLowerCase().includes(q)
    );
  }

  // Sort by confidence desc
  results.sort((a, b) => b.confidence - a.confidence);

  // Apply limit
  const total = results.length;
  results = results.slice(0, Math.min(limit, 200));

  res.json({
    ok:      true,
    total,
    returned: results.length,
    zips:    zip ? [zip] : ['32081','32082'],
    results,
    meta: {
      sources:      ['OSM','Census ACS 2022'],
      coverage:     '32081 (Nocatee) + 32082 (Ponte Vedra Beach)',
      lastSync:     '2026-04-20',
      pendingSources: ['FL Sunbiz','SJC BTR','SJC Permits'],
    },
  });
});

// ── GET /api/local-intel/zones — spending zone summary ────────────────────────
router.get('/zones', (req, res) => {
  const zones = loadZones();
  res.json({ ok: true, ...zones });
});

// ── POST /api/local-intel/claim — forward to worker on port 3003 ────────────
router.post('/claim', express.json(), async (req, res) => {
  try {
    const body = JSON.stringify(req.body || {});
    const response = await fetch('http://localhost:3003/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: 'Local Intel Worker unavailable: ' + e.message });
  }
});

// ── POST /api/local-intel/ingest — proxy to DataIngestWorker on port 3005 ──────
router.post('/ingest', express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const body = JSON.stringify(req.body || {});
    const response = await fetch('http://localhost:3005/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: 'DataIngestWorker unavailable: ' + e.message });
  }
});

// ── GET /api/local-intel/ingest/log — proxy to DataIngestWorker log ────────────
router.get('/ingest/log', async (req, res) => {
  try {
    const response = await fetch('http://localhost:3005/ingest/log');
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: 'DataIngestWorker unavailable: ' + e.message });
  }
});

// ── Server-card at the MCP path — Smithery fetches .well-known relative to the URL given
// If URL given is /api/local-intel/mcp, they fetch /api/local-intel/.well-known/mcp/server-card.json
router.get('/.well-known/mcp/server-card.json', (req, res) => {
  res.json({
    serverInfo: { name: 'LocalIntel by MCFLAMINGO', version: '1.0.0', description: 'Agentic business intelligence for St. Johns County FL. 11 MCP tools. $0.01–$0.05/call.' },
    authentication: { required: false },
    tools: [
      { name: 'local_intel_context',   description: 'Full spatial context block for a ZIP or lat/lon.' },
      { name: 'local_intel_search',    description: 'Search businesses by name, category, or semantic group.' },
      { name: 'local_intel_nearby',    description: 'Find businesses within a radius of any lat/lon point.' },
      { name: 'local_intel_zone',      description: 'Spending zone and demographic data for a ZIP.' },
      { name: 'local_intel_corridor',  description: 'Businesses along a named street corridor.' },
      { name: 'local_intel_changes',   description: 'Recently added or updated business listings.' },
      { name: 'local_intel_stats',     description: 'Dataset coverage stats and query volume.' },
      { name: 'local_intel_tide',      description: 'Tidal momentum reading for a ZIP.' },
      { name: 'local_intel_signal',    description: 'Investment signal score 0-100 for a ZIP.' },
      { name: 'local_intel_bedrock',   description: 'Infrastructure momentum from permits and road data.' },
      { name: 'local_intel_for_agent', description: 'PREMIUM. Pre-ranked composite signals for agent type + intent.' },
    ],
    resources: [],
    prompts: [],
  });
});

// ── GET /api/local-intel/mcp — Smithery/scanner discovery ──────────────────
// Streamable HTTP spec: GET returns server info so scanners don't fall through
// to the static HTML handler.
router.get('/mcp', async (req, res) => {
  try {
    // Forward to internal MCP server for tools/list so Smithery sees real tools
    const response = await fetch('http://localhost:3004/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const data = await response.json();
    // Return as MCP initialize shape with embedded tools for discovery
    res.json({
      jsonrpc: '2.0',
      id: null,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'localintel', version: '1.0.0' },
        capabilities: { tools: {} },
        tools: data?.result?.tools || [],
      },
    });
  } catch (e) {
    res.json({
      jsonrpc: '2.0',
      id: null,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'localintel', version: '1.0.0' },
        capabilities: { tools: {} },
      },
    });
  }
});

// ── POST /api/mcp — proxy to MCP server on port 3004 ───────────────────────
// This is the public MCP endpoint agents call from outside Railway.
// Full URL: https://gsb-swarm-production.up.railway.app/api/mcp
router.post('/mcp', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    // MCP notifications have no "id" — return 204 immediately, never proxy
    // (Smithery + other clients send notifications/initialized before tools/list)
    if (body.method && body.method.startsWith('notifications/') && body.id === undefined) {
      return res.status(204).end();
    }
    const response = await fetch('http://localhost:3004/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(503).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'MCP server unavailable: ' + e.message } });
  }
});

// ── x402 MCP endpoints — Base/USDC payment rail (additive alongside pathUSD) ──
// Standard: $0.01 USDC on Base  |  Premium (local_intel_for_agent): $0.05 USDC
// Agents without Base wallets continue using /api/local-intel/mcp (Tempo/pathUSD)
// x402Middleware is scoped ONLY to these two routes — does NOT touch /mcp
router.post('/mcp/x402', x402Middleware, express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    if (body.method && body.method.startsWith('notifications/') && body.id === undefined) {
      return res.status(204).end();
    }
    const response = await fetch('http://localhost:3004/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(503).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'MCP unavailable: ' + e.message } });
  }
});

router.post('/mcp/x402/premium', x402Middleware, express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    // Force premium tool so agents can't use the $0.05 endpoint for cheap calls
    if (body.method === 'tools/call' && body.params?.name !== 'local_intel_for_agent') {
      return res.status(400).json({ jsonrpc: '2.0', id: body.id || null, error: { code: -32600, message: 'Premium endpoint is for local_intel_for_agent only' } });
    }
    const response = await fetch('http://localhost:3004/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(503).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'MCP unavailable: ' + e.message } });
  }
});

// ── GET /api/mcp/manifest — MCP tool discovery ────────────────────────────────
router.get('/mcp/manifest', async (req, res) => {
  try {
    const response = await fetch('http://localhost:3004/manifest');
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: 'MCP server unavailable' });
  }
});

// ── GET /api/local-intel/osm-queue — proxy to worker ─────────────────────────
router.get('/osm-queue', async (req, res) => {
  try {
    const response = await fetch('http://localhost:3003/osm-queue');
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: 'Local Intel Worker unavailable: ' + e.message });
  }
});

// ── GET /api/local-intel/stats — coverage stats ───────────────────────────────
router.get('/stats', (req, res) => {
  const data = loadData();
  const byZip = {};
  const byGroup = {};

  for (const b of data) {
    byZip[b.zip] = (byZip[b.zip] || 0) + 1;
    const g = getGroup(b.category);
    byGroup[g] = (byGroup[g] || 0) + 1;
  }

  const avgConf = data.length
    ? Math.round(data.reduce((s, b) => s + b.confidence, 0) / data.length)
    : 0;

  res.json({
    ok: true,
    totalBusinesses: data.length,
    avgConfidence:   avgConf,
    byZip,
    byGroup,
    sources: ['OSM','Census ACS 2022'],
    pendingSources: ['FL Sunbiz','SJC BTR','SJC Permits'],
    lastSync: '2026-04-20',
  });
});

// ── GET /api/local-intel/agent-card ────────────────────────────────────────────────
const AGENT_CARD = {
  schema_version: 'v1',
  name: 'LocalIntel Data Services',
  description: 'Hyperlocal business intelligence for AI agents. ZIP-level business data covering Florida and expanding across the Sunbelt. Phone, hours, foot traffic proxy, categories, confidence scores. Pay-per-query via pathUSD.',
  url: 'https://gsb-swarm-production.up.railway.app',
  mcp_endpoint: 'https://gsb-swarm-production.up.railway.app/api/local-intel/mcp',
  a2a_endpoint: 'https://gsb-swarm-production.up.railway.app/api/local-intel/mcp',
  skills: ['nearby_businesses', 'corridor_data', 'zip_stats', 'zone_context', 'business_search', 'change_detection'],
  pricing: { per_call: '$0.01-0.05', currency: 'pathUSD', subscription: '$49-499/month' },
  coverage: { current: 'Florida SJC zips + expanding', target: 'Florida 983 zips, then full Sunbelt' },
  contact: 'localintel@mcflamingo.com',
  provider: 'LocalIntel Data Services / MCFL Restaurant Holdings LLC',
};

router.get('/agent-card', (req, res) => {
  res.json(AGENT_CARD);
});

// ── GET /api/local-intel/revenue-summary ──────────────────────────────────────────────
router.get('/revenue-summary', (req, res) => {
  let ledger = [];
  try {
    if (fs.existsSync(LEDGER_PATH)) {
      ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    }
  } catch (e) {
    // Return zeros on parse error
  }

  const now = Date.now();
  const startOfToday   = new Date(); startOfToday.setUTCHours(0,0,0,0);
  const sevenDaysAgo   = now - 7  * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo  = now - 30 * 24 * 60 * 60 * 1000;

  function summarise(entries) {
    return {
      calls: entries.length,
      revenue_pathusd: parseFloat(entries.reduce((s, e) => s + (e.amount || 0), 0).toFixed(6)),
    };
  }

  const todayEntries  = ledger.filter(e => e.timestamp && new Date(e.timestamp).getTime() >= startOfToday.getTime());
  const weekEntries   = ledger.filter(e => e.timestamp && new Date(e.timestamp).getTime() >= sevenDaysAgo);
  const monthEntries  = ledger.filter(e => e.timestamp && new Date(e.timestamp).getTime() >= thirtyDaysAgo);

  // Top tools
  const toolMap = {};
  for (const e of ledger) {
    const key = e.tool || 'unknown';
    if (!toolMap[key]) toolMap[key] = { tool: key, calls: 0, revenue: 0 };
    toolMap[key].calls += 1;
    toolMap[key].revenue += (e.amount || 0);
  }
  const topTools = Object.values(toolMap)
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 10)
    .map(t => ({ ...t, revenue: parseFloat(t.revenue.toFixed(6)) }));

  // Top callers
  const callerMap = {};
  for (const e of ledger) {
    const key = e.caller || 'unknown';
    if (!callerMap[key]) callerMap[key] = { caller: key, calls: 0, revenue: 0 };
    callerMap[key].calls += 1;
    callerMap[key].revenue += (e.amount || 0);
  }
  const topCallers = Object.values(callerMap)
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 10)
    .map(c => ({ ...c, revenue: parseFloat(c.revenue.toFixed(6)) }));

  // Last call
  const sorted = [...ledger].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const lastCall = sorted.length ? sorted[0].timestamp : null;

  res.json({
    today:      summarise(todayEntries),
    week:       summarise(weekEntries),
    month:      summarise(monthEntries),
    allTime:    summarise(ledger),
    topTools,
    topCallers,
    lastCall,
    generatedAt: new Date().toISOString(),
  });
});

// ── Dashboard data proxy routes ──────────────────────────────────────────────
// These aggregate data files so the Vercel dashboard can poll one origin.

const DATA_DIR_AGENT = path.join(__dirname, 'data');

router.get('/coverage-stats', (req, res) => {
  try {
    const covFile   = path.join(DATA_DIR_AGENT, 'zipCoverage.json');
    const queueFile = path.join(DATA_DIR_AGENT, 'zipQueue.json');
    const zipsDir   = path.join(DATA_DIR_AGENT, 'zips');

    const cov   = covFile   && fs.existsSync(covFile)   ? JSON.parse(fs.readFileSync(covFile))   : { completed: {} };
    const queue = queueFile && fs.existsSync(queueFile) ? JSON.parse(fs.readFileSync(queueFile)) : [];

    const completedZips = Object.entries(cov.completed || {});
    let totalBusinesses = completedZips.reduce((s, [, v]) => s + (v.businesses || 0), 0);

    // Average confidence from zip files
    let confSum = 0, confCount = 0;
    if (fs.existsSync(zipsDir)) {
      fs.readdirSync(zipsDir).filter(f => f.endsWith('.json')).forEach(f => {
        try {
          const bizs = JSON.parse(fs.readFileSync(path.join(zipsDir, f)));
          bizs.forEach(b => { confSum += (b.confidence || 0); confCount++; });
        } catch(e) {}
      });
    }

    // ── Fallback: if zip files have 0 businesses, count from localIntel.json ──
    if (totalBusinesses === 0 || confCount === 0) {
      try {
        const flat = JSON.parse(fs.readFileSync(DATA_PATH));
        if (Array.isArray(flat) && flat.length > 0) {
          totalBusinesses = flat.length;
          flat.forEach(b => { confSum += (b.confidence || 0); confCount++; });
          // Also synthesize completedZips from localIntel.json grouping if cov is empty
          if (completedZips.length === 0) {
            const byZip = {};
            flat.forEach(b => { const z = b.zip || 'unknown'; byZip[z] = (byZip[z] || 0) + 1; });
            Object.entries(byZip).forEach(([zip, count]) => {
              completedZips.push([zip, { businesses: count, completedAt: new Date().toISOString(), source: 'localIntel.json' }]);
            });
          }
        }
      } catch(e) { console.warn('[coverage-stats] localIntel.json fallback failed:', e.message); }
    }

    const inProgress = queue.filter(z => z.status === 'inProgress').length;
    const pending    = queue.filter(z => z.status === 'pending').length;
    const failed     = queue.filter(z => z.status === 'failed').length;

    // Last 20 completed zips sorted by completedAt desc
    // Enrich with businesses + confidence from zip files if coordinator didn't capture them
    const recentZips = completedZips
      .map(([zip, v]) => {
        let businesses = v.businesses;
        let confidence = v.confidence;
        // If count is missing or zero, try reading the zip file directly
        if (!businesses) {
          try {
            const zipFile = path.join(zipsDir, `${zip}.json`);
            if (fs.existsSync(zipFile)) {
              const bizs = JSON.parse(fs.readFileSync(zipFile));
              if (Array.isArray(bizs) && bizs.length > 0) {
                businesses = bizs.length;
                confidence = Math.round(bizs.reduce((s, b) => s + (b.confidence || 0), 0) / bizs.length);
              }
            }
          } catch(e) { /* non-fatal */ }
        }
        return { zip, ...v, businesses: businesses || 0, confidence: confidence || 0 };
      })
      .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))
      .slice(0, 20);

    res.json({
      zipsCompleted:    completedZips.length,
      zipsTotal:        983,
      totalBusinesses,
      avgConfidence:    confCount ? Math.round(confSum / confCount) : 0,
      activeAgents:     inProgress,
      pendingZips:      pending,
      failedZips:       failed,
      recentZips,
      lastRun:          cov.lastRun || null,
      generatedAt:      new Date().toISOString(),
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/source-log', (req, res) => {
  try {
    const file = path.join(DATA_DIR_AGENT, 'sourceLog.json');
    const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {};
    // Flatten to per-source latest status across all zips
    const sources = {};
    Object.values(data).forEach(zipSources => {
      Object.entries(zipSources).forEach(([source, entry]) => {
        if (!sources[source] || new Date(entry.checked_at) > new Date(sources[source].checked_at)) {
          sources[source] = entry;
        }
      });
    });
    res.json({ sources, raw: data, generatedAt: new Date().toISOString() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/enrichment-log', (req, res) => {
  try {
    const file = path.join(DATA_DIR_AGENT, 'enrichmentLog.json');
    const log  = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : [];
    const today = new Date(); today.setUTCHours(0,0,0,0);
    const enrichedToday = log.filter(e => e.enrichedAt && new Date(e.enrichedAt) >= today).length;
    const recent = [...log].sort((a,b) => new Date(b.enrichedAt) - new Date(a.enrichedAt)).slice(0, 20);
    res.json({ enrichedToday, recent, total: log.length, generatedAt: new Date().toISOString() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/broadcast-log', (req, res) => {
  try {
    const file = path.join(DATA_DIR_AGENT, 'broadcastLog.json');
    const log  = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : [];
    const recent = [...log].sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 10);
    // Last successful hit per registry
    const lastByRegistry = {};
    log.forEach(e => {
      if (e.status === 'ok' && (!lastByRegistry[e.registry] || new Date(e.timestamp) > new Date(lastByRegistry[e.registry]))) {
        lastByRegistry[e.registry] = e.timestamp;
      }
    });
    res.json({ recent, lastByRegistry, total: log.length, generatedAt: new Date().toISOString() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/zip-queue', (req, res) => {
  try {
    const file = path.join(DATA_DIR_AGENT, 'zipQueue.json');
    const queue = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : [];
    res.json({
      total:      queue.length,
      pending:    queue.filter(z => z.status === 'pending').length,
      inProgress: queue.filter(z => z.status === 'inProgress').length,
      complete:   queue.filter(z => z.status === 'complete').length,
      failed:     queue.filter(z => z.status === 'failed').length,
      active:     queue.filter(z => z.status === 'inProgress'),
      generatedAt: new Date().toISOString(),
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/local-intel/reset-queue ───────────────────────────────────────────────
// Reset all completed ZIPs to pending so enrichment re-runs immediately
router.post('/reset-queue', (req, res) => {
  try {
    const file = path.join(DATA_DIR_AGENT, 'zipQueue.json');
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Queue file not found' });
    const queue = JSON.parse(fs.readFileSync(file));
    const before = queue.filter(z => z.status === 'complete').length;
    queue.forEach(z => {
      if (z.status === 'complete' || z.status === 'failed') {
        z.status = 'pending';
        z.attempts = 0;
        z.startedAt = null;
      }
    });
    fs.writeFileSync(file, JSON.stringify(queue, null, 2));
    // Also reset coverage lastRun so coordinator triggers immediately
    const covFile = path.join(DATA_DIR_AGENT, 'coverage.json');
    if (fs.existsSync(covFile)) {
      const cov = JSON.parse(fs.readFileSync(covFile));
      cov.lastRun = new Date(0).toISOString(); // epoch forces refresh
      fs.writeFileSync(covFile, JSON.stringify(cov, null, 2));
    }
    res.json({ ok: true, reset: before, message: `${before} ZIPs reset to pending — enrichment will resume within 2 minutes` });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/local-intel/budget-status ────────────────────────────────────────────────
// Proxies from zipCoordinatorWorker (port 3006) and normalises to snake_case
router.get('/budget-status', async (req, res) => {
  try {
    const r = await fetch('http://localhost:3006/budget-status', { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`zip-coordinator HTTP ${r.status}`);
    const d = await r.json();
    res.json({
      concurrent_agents: d.concurrentAgents ?? null,
      gate_status:       d.gateStatus       ?? 'normal',
      revenue_7d:        d.revenue7d        ?? 0,
      generatedAt:       d.generatedAt,
    });
  } catch (e) {
    // Return safe defaults so the dashboard doesn’t break
    res.json({ concurrent_agents: null, gate_status: 'normal', revenue_7d: 0, error: e.message });
  }
});

// ── GET /api/local-intel/oracle?zip=XXXXX ───────────────────────────────────
// Returns pre-baked economic narrative for a ZIP: restaurant capacity, market gaps, growth
router.get('/oracle', (req, res) => {
  try {
    const zip = (req.query.zip || '').replace(/\D/g, '').slice(0, 5);
    const oracleDir = path.join(DATA_DIR_AGENT, 'oracle');

    if (zip) {
      // Single ZIP
      const file = path.join(oracleDir, `${zip}.json`);
      if (!fs.existsSync(file)) {
        return res.status(404).json({ error: `No oracle data for ${zip}. Oracle worker may still be computing.` });
      }
      return res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
    }

    // No ZIP specified — return index
    const indexFile = path.join(oracleDir, '_index.json');
    if (!fs.existsSync(indexFile)) {
      return res.status(404).json({ error: 'Oracle index not ready yet. Check back in 60 seconds.' });
    }
    res.json(JSON.parse(fs.readFileSync(indexFile, 'utf8')));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
