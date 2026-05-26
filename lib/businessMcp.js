'use strict';
/**
 * lib/businessMcp.js — Tier 3 per-business MCP proxy
 *
 * Two modes:
 *   1. Proxy mode  — business has `mcp_endpoint` set in business_agent_profiles.
 *                    Forwards JSON-RPC to their endpoint, parses SSE response,
 *                    returns the result.
 *   2. Hosted mode — no mcp_endpoint. Serves three built-in tools backed by
 *                    Postgres: get_business_info, get_hours, submit_rfq.
 *
 * Exports:
 *   - getDiscoveryManifest(business_id, baseUrl)
 *   - handleMcpRequest(business_id, jsonRpcBody, res, opts?)
 *   - probeEndpoint(mcp_endpoint)
 *   - migrateRfqJobs()
 */

const https = require('https');
const http  = require('http');
const { URL } = require('url');
const db = require('./db');

// ── one-time schema setup ────────────────────────────────────────────────────
let _rfqJobsEnsured = false;
async function migrateRfqJobs() {
  if (_rfqJobsEnsured) return;
  // The legacy rfq_jobs table (from lib/rfqBroadcast.js) has a different shape
  // with NOT NULL constraints on `code`, `caller_phone`, `category`. We add the
  // columns this MCP layer needs without breaking the broadcast schema, and
  // relax the legacy NOT NULL constraints so the two insert shapes can coexist.
  await db.query(`
    CREATE TABLE IF NOT EXISTS rfq_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`ALTER TABLE rfq_jobs ADD COLUMN IF NOT EXISTS business_id UUID`);
  await db.query(`ALTER TABLE rfq_jobs ADD COLUMN IF NOT EXISTS requester_name TEXT`);
  await db.query(`ALTER TABLE rfq_jobs ADD COLUMN IF NOT EXISTS requester_phone TEXT`);
  await db.query(`ALTER TABLE rfq_jobs ADD COLUMN IF NOT EXISTS message TEXT`);
  await db.query(`ALTER TABLE rfq_jobs ADD COLUMN IF NOT EXISTS status TEXT`);
  // Legacy required columns — DROP NOT NULL is itself NOT idempotent on PG <16,
  // so wrap each in a try/catch to keep startup non-fatal.
  await db.query(`ALTER TABLE rfq_jobs ALTER COLUMN code DROP NOT NULL`).catch(() => {});
  await db.query(`ALTER TABLE rfq_jobs ALTER COLUMN caller_phone DROP NOT NULL`).catch(() => {});
  await db.query(`ALTER TABLE rfq_jobs ALTER COLUMN category DROP NOT NULL`).catch(() => {});
  _rfqJobsEnsured = true;
}

// Fire schema setup on module load (non-blocking, log errors, do not throw).
migrateRfqJobs().catch(e =>
  console.error('[businessMcp] migrateRfqJobs failed:', e.message)
);

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Look up the business + its agent profile mcp_endpoint.
 */
async function loadBusiness(business_id) {
  return db.queryOne(
    `SELECT b.business_id, b.name, b.category, b.address, b.city, b.state, b.zip,
            b.phone, b.website, b.hours_json,
            bap.mcp_endpoint
       FROM businesses b
       LEFT JOIN business_agent_profiles bap ON bap.business_id = b.business_id
      WHERE b.business_id = $1
      LIMIT 1`,
    [business_id]
  );
}

/**
 * Forward a JSON-RPC body to an upstream MCP endpoint via HTTPS POST.
 * Parses SSE response, returns { json, sessionId, raw }.
 */
function forwardToUpstream(endpoint, jsonRpcBody, { timeoutMs = 8000, sessionId = null } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(endpoint); } catch (e) { return reject(new Error('invalid mcp_endpoint URL')); }
    const lib = parsed.protocol === 'http:' ? http : https;
    const body = Buffer.from(JSON.stringify(jsonRpcBody), 'utf8');

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Content-Length': body.length,
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;

    const req = lib.request({
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: parsed.pathname + (parsed.search || ''),
      headers,
    }, (res) => {
      const upstreamSessionId = res.headers['mcp-session-id'] || null;
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 400) {
          return reject(new Error(`upstream ${res.statusCode}: ${raw.slice(0, 200)}`));
        }
        const json = parseSseOrJson(raw);
        if (!json) return reject(new Error('failed to parse upstream response'));
        resolve({ json, sessionId: upstreamSessionId, raw });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`upstream timeout after ${timeoutMs}ms`));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Parse an SSE-or-JSON response body into a JSON object.
 * If body looks like SSE (contains `data: ` lines), collect every data line,
 * JSON.parse each, and return the LAST successfully-parsed object.
 * Otherwise try plain JSON.parse on the whole body.
 */
function parseSseOrJson(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed); } catch (_) { /* fall through to SSE parse */ }
  }
  const lines = raw.split(/\r?\n/);
  let last = null;
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trimStart();
    if (!payload || payload === '[DONE]') continue;
    try {
      last = JSON.parse(payload);
    } catch (_) { /* skip malformed data line */ }
  }
  return last;
}

/**
 * Write a JSON-RPC response to `res` as a single SSE message and end.
 */
function writeSseResponse(res, body, { sessionId = null } = {}) {
  if (res.headersSent) return;
  const headers = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  res.writeHead(200, headers);
  res.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
  res.end();
}

// ── hosted-mode tool definitions ─────────────────────────────────────────────

const HOSTED_TOOLS = [
  {
    name: 'get_business_info',
    description: 'Returns basic contact and location info for this business (name, category, address, city, state, zip, phone, website, hours).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_hours',
    description: 'Returns the operating hours for this business as a structured hours object.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'submit_rfq',
    description: 'Submit a request for quote (RFQ) to this business. Creates a pending job — the business will follow up directly. Submission is free; payment fires on acceptance/completion.',
    inputSchema: {
      type: 'object',
      properties: {
        name:    { type: 'string', description: 'Requester name' },
        phone:   { type: 'string', description: 'Requester phone' },
        message: { type: 'string', description: 'What they need' },
      },
      required: ['name', 'phone', 'message'],
    },
  },
];

async function toolGetBusinessInfo(biz) {
  return {
    name:          biz.name,
    category:      biz.category,
    address_line1: biz.address,
    city:          biz.city,
    state:         biz.state,
    zip:           biz.zip,
    phone:         biz.phone,
    website:       biz.website,
    hours_json:    biz.hours_json,
  };
}

async function toolGetHours(biz) {
  let hours = biz.hours_json;
  if (typeof hours === 'string') {
    try { hours = JSON.parse(hours); } catch (_) { /* return raw string */ }
  }
  return { hours: hours || null };
}

async function toolSubmitRfq(biz, args) {
  const { name, phone, message } = args || {};
  if (!name || !phone || !message) {
    throw new Error('submit_rfq requires name, phone, and message');
  }
  await migrateRfqJobs();
  const row = await db.queryOne(
    `INSERT INTO rfq_jobs (business_id, requester_name, requester_phone, message, status, created_at)
     VALUES ($1, $2, $3, $4, 'pending', NOW())
     RETURNING id`,
    [biz.business_id, name, phone, message]
  );
  return { success: true, rfq_id: row?.id };
}

async function dispatchHostedTool(biz, name, args) {
  switch (name) {
    case 'get_business_info': return toolGetBusinessInfo(biz);
    case 'get_hours':         return toolGetHours(biz);
    case 'submit_rfq':        return toolSubmitRfq(biz, args);
    default: throw new Error(`unknown tool: ${name}`);
  }
}

// ── public: discovery manifest ───────────────────────────────────────────────

async function getDiscoveryManifest(business_id, baseUrl) {
  const biz = await loadBusiness(business_id);
  if (!biz) throw new Error(`business ${business_id} not found`);

  if (biz.mcp_endpoint) {
    // Try to fetch their /.well-known/mcp at the same origin.
    const wellKnown = await fetchUpstreamWellKnown(biz.mcp_endpoint).catch(() => null);
    if (wellKnown) return wellKnown;
    // Fall back to a minimal manifest pointing at their endpoint.
    return {
      schema_version: 'v1',
      name: biz.name,
      description: `${biz.name} — proxied MCP endpoint`,
      endpoint: biz.mcp_endpoint,
      transport: 'http',
      tools: [],
    };
  }

  return {
    schema_version: 'v1',
    name: biz.name,
    description: `LocalIntel hosted MCP endpoint for ${biz.name}`,
    endpoint: `${baseUrl}/api/local-intel/mcp/${business_id}`,
    transport: 'http',
    tools: ['get_business_info', 'get_hours', 'submit_rfq'],
  };
}

function fetchUpstreamWellKnown(mcpEndpoint) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(mcpEndpoint); } catch (e) { return reject(e); }
    parsed.pathname = '/.well-known/mcp';
    parsed.search = '';
    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.request({
      method: 'GET',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: parsed.pathname,
      headers: { 'Accept': 'application/json' },
    }, (res) => {
      if (!res.statusCode || res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`well-known returned ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('well-known timeout')));
    req.end();
  });
}

// ── public: handle JSON-RPC request ──────────────────────────────────────────

async function handleMcpRequest(business_id, jsonRpcBody, res, { sessionId = null } = {}) {
  const biz = await loadBusiness(business_id);
  if (!biz) {
    return writeSseResponse(res, {
      jsonrpc: '2.0',
      id: jsonRpcBody?.id ?? null,
      error: { code: -32000, message: `business ${business_id} not found` },
    });
  }

  if (biz.mcp_endpoint) {
    // Proxy mode.
    try {
      const { json, sessionId: upstreamSid } = await forwardToUpstream(
        biz.mcp_endpoint, jsonRpcBody, { sessionId }
      );
      return writeSseResponse(res, json, { sessionId: upstreamSid });
    } catch (err) {
      return writeSseResponse(res, {
        jsonrpc: '2.0',
        id: jsonRpcBody?.id ?? null,
        error: { code: -32001, message: `proxy failed: ${err.message}` },
      });
    }
  }

  // Hosted mode.
  const id = jsonRpcBody?.id ?? null;
  const method = jsonRpcBody?.method;
  const params = jsonRpcBody?.params || {};

  if (method === 'initialize') {
    return writeSseResponse(res, {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: `LocalIntel/${biz.name}`, version: '1.0.0' },
      },
    });
  }

  if (method === 'tools/list') {
    return writeSseResponse(res, {
      jsonrpc: '2.0',
      id,
      result: { tools: HOSTED_TOOLS },
    });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};
    try {
      const result = await dispatchHostedTool(biz, toolName, toolArgs);
      return writeSseResponse(res, {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        },
      });
    } catch (err) {
      return writeSseResponse(res, {
        jsonrpc: '2.0',
        id,
        error: { code: -32002, message: err.message },
      });
    }
  }

  if (method === 'ping') {
    return writeSseResponse(res, { jsonrpc: '2.0', id, result: {} });
  }

  return writeSseResponse(res, {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `method not found: ${method}` },
  });
}

// ── public: probe an arbitrary MCP endpoint (for inbox.html Test button) ─────

async function probeEndpoint(mcp_endpoint) {
  if (!mcp_endpoint) throw new Error('mcp_endpoint required');
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  const { json } = await forwardToUpstream(mcp_endpoint, body, { timeoutMs: 5000 });
  const tools = json?.result?.tools || [];
  return { tools };
}

module.exports = {
  getDiscoveryManifest,
  handleMcpRequest,
  probeEndpoint,
  migrateRfqJobs,
};
