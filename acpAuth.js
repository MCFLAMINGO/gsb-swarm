'use strict';
/**
 * ACP Auth — GSB Swarm
 *
 * Virtuals deprecated Privy JWT auth. All agents now use stable API keys
 * issued from the Compute tab at app.virtuals.io.
 *
 * Each agent has its own key stored in Railway:
 *   VIRTUALS_API_KEY_CEO             — agent 1332
 *   VIRTUALS_API_KEY_WALLET_PROFILER — agent 1333
 *   VIRTUALS_API_KEY_ALPHA_SCANNER   — agent 1334
 *   VIRTUALS_API_KEY_TOKEN_ANALYST   — agent 1335
 *   VIRTUALS_API_KEY_THREAD_WRITER   — agent 1336
 *
 * Compute endpoint: https://compute.virtuals.io/v1
 *   OpenAI-compatible:    POST /v1/chat/completions  — Authorization: Bearer $KEY
 *   Anthropic-compatible: POST /v1/messages          — x-api-key: $KEY
 */

const COMPUTE_BASE_URL = 'https://compute.virtuals.io/v1';

// Map agent ID → Railway env var name
const AGENT_KEY_MAP = {
  1332: 'VIRTUALS_API_KEY_CEO',
  1333: 'VIRTUALS_API_KEY_WALLET_PROFILER',
  1334: 'VIRTUALS_API_KEY_ALPHA_SCANNER',
  1335: 'VIRTUALS_API_KEY_TOKEN_ANALYST',
  1336: 'VIRTUALS_API_KEY_THREAD_WRITER',
};

/**
 * Get the Virtuals Compute API key for a given agent.
 * Falls back to VIRTUALS_API_KEY if set (generic / legacy).
 * Returns null if no key is configured — callers must handle gracefully.
 */
function getAgentKey(agentId) {
  if (agentId) {
    const envVar = AGENT_KEY_MAP[agentId];
    if (envVar && process.env[envVar]) return process.env[envVar];
  }
  // Generic fallback
  if (process.env.VIRTUALS_API_KEY) return process.env.VIRTUALS_API_KEY;
  return null;
}

/**
 * Returns headers for OpenAI-compatible calls (POST /v1/chat/completions).
 * agentId is optional — pass the agent number (e.g. 1333) to use per-agent key.
 */
function openaiHeaders(agentId) {
  const key = getAgentKey(agentId);
  if (!key) _warnNoKey(agentId);
  return {
    'Authorization': `Bearer ${key || ''}`,
    'Content-Type':  'application/json',
  };
}

/**
 * Returns headers for Anthropic-compatible calls (POST /v1/messages).
 * agentId is optional — pass the agent number (e.g. 1333) to use per-agent key.
 */
function anthropicHeaders(agentId) {
  const key = getAgentKey(agentId);
  if (!key) _warnNoKey(agentId);
  return {
    'x-api-key':         key || '',
    'anthropic-version': '2023-06-01',
    'Content-Type':      'application/json',
  };
}

/**
 * Legacy compat shim — anything still calling getValidToken() gets the
 * generic key (or null). Logs a deprecation notice once.
 */
let _legacyWarned = false;
async function getValidToken() {
  if (!_legacyWarned) {
    _legacyWarned = true;
    console.warn('[acpAuth] getValidToken() is deprecated — use getAgentKey(agentId) or openaiHeaders(agentId) directly.');
  }
  return getAgentKey(null);
}

// ── Internal helpers ──────────────────────────────────────────────────────────
let _lastNoKeyWarn = {};
function _warnNoKey(agentId) {
  const now = Date.now();
  const last = _lastNoKeyWarn[agentId || 'generic'] || 0;
  if (now - last > 10 * 60 * 1000) {
    _lastNoKeyWarn[agentId || 'generic'] = now;
    const envVar = agentId ? AGENT_KEY_MAP[agentId] : 'VIRTUALS_API_KEY';
    console.warn(`[acpAuth] ⚠️  No API key for agent ${agentId || '(generic)'}. Set ${envVar || 'VIRTUALS_API_KEY'} in Railway. (suppressed 10 min)`);
  }
}

module.exports = {
  COMPUTE_BASE_URL,
  AGENT_KEY_MAP,
  getAgentKey,
  openaiHeaders,
  anthropicHeaders,
  getValidToken, // legacy compat
};
