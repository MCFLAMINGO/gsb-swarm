'use strict';
/**
 * lib/mcpInvoke.js — Always-on MCP tool invocation.
 *
 * Prefer the child HTTP server on :3004 (production index.js fork).
 * If it is down (npm start dashboard-only, crash, cold boot), fall back
 * to in-process handleRPC so agents still complete tools.
 */

const MCP_URL = process.env.LOCALINTEL_MCP_URL || 'http://localhost:3004/mcp';
const FETCH_MS = Number(process.env.LOCALINTEL_MCP_FETCH_MS || 25000);

async function invokeMcp(rpcBody, { headers = {}, callerInfo = null } = {}) {
  const body = rpcBody && typeof rpcBody === 'object' ? rpcBody : {};

  try {
    const response = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_MS),
    });

    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }

    if (response.ok) {
      return { ok: true, status: response.status, json, via: 'http:3004' };
    }

    // Non-OK from child — still try in-process as last resort for 5xx
    if (response.status >= 500) {
      console.warn(`[mcpInvoke] :3004 returned ${response.status} — falling back to in-process handleRPC`);
      return invokeInProcess(body, callerInfo);
    }

    return { ok: false, status: response.status, json, via: 'http:3004' };
  } catch (err) {
    console.warn(`[mcpInvoke] :3004 unreachable (${err.message}) — falling back to in-process handleRPC`);
    return invokeInProcess(body, callerInfo);
  }
}

async function invokeInProcess(body, callerInfo) {
  try {
    const { handleRPC } = require('../localIntelMCP');
    const json = await handleRPC(body, callerInfo || null);
    return { ok: true, status: 200, json, via: 'in-process' };
  } catch (err) {
    console.error('[mcpInvoke] in-process handleRPC failed:', err.message);
    return {
      ok: false,
      status: 503,
      json: {
        jsonrpc: '2.0',
        id: body && body.id != null ? body.id : null,
        error: { code: -32000, message: `MCP unavailable: ${err.message}` },
      },
      via: 'in-process-failed',
    };
  }
}

module.exports = { invokeMcp, invokeInProcess, MCP_URL };
