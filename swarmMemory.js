'use strict';
const fs   = require('fs');
const path = require('path');

// ── Swarm Memory — persistent shared context for all GSB agents ──────────────
// Agents write findings here. Agents read context from here before doing work.
// Stored as flat JSON on disk so it survives Railway restarts (within the run).
// Structure:
//   narratives: { [symbol]: { ...data, updatedAt } }  — token narratives
//   agentFindings: { [key]: { agent, content, createdAt } }  — any agent output
//   pinnedContext: [ { label, content, createdAt } ]  — CEO-pinned context blobs

const MEMORY_FILE = process.env.SWARM_MEMORY_FILE || '/tmp/gsb-swarm-memory.json';
const MAX_NARRATIVES   = 50;
const MAX_FINDINGS     = 100;
const MAX_PINNED       = 20;
const TTL_NARRATIVE_MS = 24 * 60 * 60 * 1000; // 24 hours — narrative/findings expire
const TTL_PINNED_MS    = 36 * 60 * 60 * 1000; // 36 hours — CEO brief stays longer
const SKIP_RESEARCH_MS =  1 * 60 * 60 * 1000; //  1 hour  — skip full re-research if thread posted
const TTL_MS           = TTL_NARRATIVE_MS;     // alias for backward compat

function load() {
  try {
    return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  } catch {
    return { narratives: {}, agentFindings: {}, pinnedContext: [] };
  }
}

function save(mem) {
  try { fs.writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2)); } catch {}
}

// ── Write a token narrative (CEO brief, intel report, etc.) ──────────────────
// symbol: '$PUMPCADE', data: { contractAddress, chain, summary, threadTweets, ... }
// Merges new data into existing narrative — preserves base knowledge, patches in new fields.
function writeNarrative(symbol, data) {
  const mem = load();
  const key = symbol.toUpperCase().replace(/^\$/, '');
  const existing = mem.narratives[key] || {};

  // Fields that should ALWAYS be overwritten with latest values (price, volume, etc.)
  const OVERWRITE_FIELDS = ['priceUsd', 'liquidity', 'volume24h', 'priceChange24h', 'marketCap', 'updatedAt', 'threadUrl', 'xTweetsFound'];
  // Fields that should ACCUMULATE (thread history, findings history)
  const merged = { ...existing };

  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) continue; // never overwrite with null
    if (OVERWRITE_FIELDS.includes(k)) {
      merged[k] = v; // always take latest
    } else if (k === 'thread_tweets' && existing.thread_tweets?.length) {
      // Keep prior tweets as history, store latest separately
      merged.thread_tweets = v;
      merged.prior_threads = [...(existing.prior_threads || []), { tweets: existing.thread_tweets, ts: existing.updatedAt }].slice(-5); // keep last 5
    } else if (k === 'ceoFindings' && existing.ceoFindings) {
      // Accumulate CEO findings across briefs
      merged.ceoFindings = [...new Set([...(existing.ceoFindings || []), ...(v || [])])];
    } else {
      merged[k] = v; // new field or no existing value — just set it
    }
  }

  merged.symbol    = `$${key}`;
  merged.updatedAt = Date.now();
  // Track when a full research pass happened (has X tweets or thread — not just a price patch)
  if (data.xTweetsFound !== undefined || data.thread_tweets !== undefined || data.summary !== undefined) {
    merged.lastResearchedAt = Date.now();
  }
  mem.narratives[key] = merged;

  // Prune oldest if over limit
  const keys = Object.keys(mem.narratives).sort((a, b) => mem.narratives[a].updatedAt - mem.narratives[b].updatedAt);
  while (keys.length > MAX_NARRATIVES) { delete mem.narratives[keys.shift()]; }
  save(mem);
  return mem.narratives[key];
}

// ── Read a token narrative ────────────────────────────────────────────────────
function readNarrative(symbol) {
  const mem = load();
  const key = symbol.toUpperCase().replace(/^\$/, '');
  const n = mem.narratives[key];
  if (!n) return null;
  if (Date.now() - n.updatedAt > TTL_NARRATIVE_MS) return null; // expired
  return n;
}

// ── Write an agent finding (any agent can write, any can read) ────────────────
// key: e.g. 'alpha:Eg2ymQ2...', agent: 'GSB Alpha Scanner', content: string|object
function writeFinding(key, agent, content) {
  const mem = load();
  mem.agentFindings[key] = {
    agent,
    content: typeof content === 'string' ? content : JSON.stringify(content),
    createdAt: Date.now(),
  };
  // Prune oldest
  const keys = Object.keys(mem.agentFindings).sort((a, b) => mem.agentFindings[a].createdAt - mem.agentFindings[b].createdAt);
  while (keys.length > MAX_FINDINGS) { delete mem.agentFindings[keys.shift()]; }
  save(mem);
}

// ── Read an agent finding ─────────────────────────────────────────────────────
function readFinding(key) {
  const mem = load();
  const f = mem.agentFindings[key];
  if (!f) return null;
  if (Date.now() - f.createdAt > TTL_NARRATIVE_MS) return null;
  return f;
}

// ── Pin context (CEO can pin summaries for agents to use) ────────────────────
function pinContext(label, content) {
  const mem = load();
  mem.pinnedContext = mem.pinnedContext.filter(p => p.label !== label); // replace if same label
  mem.pinnedContext.unshift({ label, content, createdAt: Date.now() });
  if (mem.pinnedContext.length > MAX_PINNED) mem.pinnedContext = mem.pinnedContext.slice(0, MAX_PINNED);
  save(mem);
}

// ── Get all pinned context (for injecting into agent prompts) ─────────────────
function getPinnedContext() {
  const mem = load();
  const now = Date.now();
  return mem.pinnedContext.filter(p => now - p.createdAt < TTL_PINNED_MS);
}

// ── Build a context string for injection into an agent's prompt ───────────────
// Pass symbol (optional) to also include that narrative.
function buildContextString(symbol) {
  const lines = [];

  if (symbol) {
    const n = readNarrative(symbol);
    if (n) {
      const age = Math.round((Date.now() - n.updatedAt) / 60000);
      lines.push(`[Swarm Memory — ${n.symbol} narrative, ${age}m ago]`);
      if (n.summary)          lines.push(`Summary: ${n.summary}`);
      if (n.contractAddress)  lines.push(`CA: ${n.contractAddress}`);
      if (n.chain)            lines.push(`Chain: ${n.chain}`);
      if (n.priceUsd)         lines.push(`Price: $${n.priceUsd}`);
      if (n.liquidity)        lines.push(`Liquidity: $${(n.liquidity/1000).toFixed(1)}K`);
      if (n.alphaVerdict)     lines.push(`Alpha verdict: ${n.alphaVerdict}`);
      if (n.threadPosted)     lines.push(`Thread already posted to X: ${n.threadUrl || 'yes'}`);
      lines.push('');
    }
  }

  const pinned = getPinnedContext();
  for (const p of pinned) {
    lines.push(`[Pinned: ${p.label}]`);
    lines.push(typeof p.content === 'string' ? p.content : JSON.stringify(p.content));
    lines.push('');
  }

  return lines.join('\n').trim();
}

// ── List recent narratives (for dashboard) ────────────────────────────────────
function listNarratives() {
  const mem = load();
  const now = Date.now();
  return Object.values(mem.narratives)
    .filter(n => now - n.updatedAt < TTL_NARRATIVE_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── Clear expired entries ─────────────────────────────────────────────────────
function prune() {
  const mem = load();
  const now = Date.now();
  for (const k of Object.keys(mem.narratives)) {
    if (now - mem.narratives[k].updatedAt > TTL_NARRATIVE_MS) delete mem.narratives[k];
  }
  for (const k of Object.keys(mem.agentFindings)) {
    if (now - mem.agentFindings[k].createdAt > TTL_NARRATIVE_MS) delete mem.agentFindings[k];
  }
  mem.pinnedContext = mem.pinnedContext.filter(p => now - p.createdAt < TTL_PINNED_MS);
  save(mem);
}

module.exports = {
  writeNarrative, readNarrative,
  writeFinding, readFinding,
  pinContext, getPinnedContext,
  buildContextString,
  listNarratives,
  prune,
  SKIP_RESEARCH_MS,
  TTL_NARRATIVE_MS,
  TTL_PINNED_MS,
};
