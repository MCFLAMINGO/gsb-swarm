'use strict';
/**
 * agentMemoryWorker.js — LocalIntel Per-Agent Memory
 *
 * Postgres-backed. Previously used data/agentMemory/{agentId}.json which was
 * wiped on every Railway restart — agents started from zero every deploy.
 * Now all memory survives in the agent_memory table.
 *
 * Exports:
 *   recordQuery(agentId, zip, tool, agentType)  — log a query event to agent memory
 *   getDelta(agentId, zip)                       — business count delta since last visit
 *   getAgentContext(agentId)                     — summarise agent's query patterns
 *   clearOldMemory()                             — prune visit log entries older than 90 days
 *
 * Schema: { agentId, total_queries, member_since, last_seen, zip_visit_log: [],
 *           zip_frequency: {}, zip_last_count: {}, corridor_detected: bool }
 */

const MAX_LOG     = 100;   // keep last N visit log entries in memory
const RETENTION_D = 90;    // prune entries older than this many days

// ── Corridor detection: are the last 3+ unique ZIPs numerically sequential? ──
function detectCorridor(zipVisitLog) {
  try {
    const seen = [];
    for (let i = zipVisitLog.length - 1; i >= 0 && seen.length < 5; i--) {
      const z = zipVisitLog[i].zip;
      if (z && !seen.includes(z)) seen.unshift(z);
    }
    if (seen.length < 3) return false;

    const nums = seen.map(z => parseInt(z, 10)).filter(n => !isNaN(n));
    if (nums.length < 3) return false;

    for (let i = 0; i <= nums.length - 3; i++) {
      const sorted = [...nums.slice(i, i + 3)].sort((a, b) => a - b);
      if (sorted[2] - sorted[0] <= 4) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ── Load or initialise agent memory from Postgres ────────────────────────────
async function loadMemory(agentId) {
  try {
    if (process.env.LOCAL_INTEL_DB_URL) {
      const pgStore = require('../lib/pgStore');
      const mem = await pgStore.getAgentMemory(agentId);
      if (mem) return mem;
    }
  } catch (_) {}

  // Default empty memory for first-time agents
  const now = new Date().toISOString();
  return {
    agentId,
    total_queries:     0,
    member_since:      now,
    last_seen:         now,
    zip_visit_log:     [],
    zip_frequency:     {},
    zip_last_count:    {},
    corridor_detected: false,
  };
}

// ── Write memory back to Postgres ────────────────────────────────────────────
async function writeMem(mem) {
  try {
    if (process.env.LOCAL_INTEL_DB_URL) {
      const pgStore = require('../lib/pgStore');
      await pgStore.upsertAgentMemory(mem);
    }
  } catch (_) {
    // Never throw — memory writes are best-effort
  }
}

// ── recordQuery ───────────────────────────────────────────────────────────────
/**
 * Log a query event to the agent's memory.
 *
 * @param {string} agentId
 * @param {string} zip
 * @param {string} tool
 * @param {string} agentType
 */
async function recordQuery(agentId, zip, tool, agentType) {
  try {
    if (!agentId) return;

    const mem = await loadMemory(agentId);
    const now = new Date().toISOString();

    // Append to visit log
    mem.zip_visit_log.push({ zip, tool, ts: now, agentType: agentType || null });

    // Keep only last MAX_LOG entries
    if (mem.zip_visit_log.length > MAX_LOG) {
      mem.zip_visit_log = mem.zip_visit_log.slice(-MAX_LOG);
    }

    // Update frequency counter
    if (zip) {
      mem.zip_frequency[zip] = (mem.zip_frequency[zip] || 0) + 1;
    }

    // Detect corridor pattern
    mem.corridor_detected = detectCorridor(mem.zip_visit_log);

    // Update totals
    mem.total_queries += 1;
    mem.last_seen      = now;

    await writeMem(mem);
  } catch {
    // Never throw
  }
}

// ── getDelta ──────────────────────────────────────────────────────────────────
/**
 * Returns the business count delta since this agent last queried a ZIP.
 * Current count is read from Postgres (businesses table).
 *
 * @param {string} agentId
 * @param {string} zip
 * @returns {object|null}
 */
async function getDelta(agentId, zip) {
  try {
    const mem = await loadMemory(agentId);

    // Find most recent visit log entry for this ZIP
    const visits = mem.zip_visit_log.filter(e => e.zip === zip);
    if (!visits.length) return null;

    const lastVisit = visits[visits.length - 1];
    const lastTs    = lastVisit.ts || null;
    const daysSince = lastTs
      ? Math.round((Date.now() - new Date(lastTs).getTime()) / (1000 * 60 * 60 * 24))
      : null;

    // Current business count from Postgres
    let currentCount = 0;
    try {
      if (process.env.LOCAL_INTEL_DB_URL) {
        const pgStore = require('../lib/pgStore');
        const rows = await pgStore.getBusinessesByZip(zip);
        currentCount = Array.isArray(rows) ? rows.length : 0;
      }
    } catch (_) {}

    // Previous snapshot from memory
    const prevCount = mem.zip_last_count[zip] || currentCount;

    // Update snapshot for next call
    try {
      mem.zip_last_count[zip] = currentCount;
      await writeMem(mem);
    } catch (_) {}

    const netChange = currentCount - prevCount;
    return {
      businesses_added:   Math.max(0, netChange),
      businesses_removed: Math.max(0, -netChange),
      last_visit:         lastTs,
      days_since:         daysSince,
      prev_count:         prevCount,
      current_count:      currentCount,
    };
  } catch {
    return null;
  }
}

// ── getAgentContext ───────────────────────────────────────────────────────────
/**
 * Returns a summary of this agent's query patterns.
 *
 * @param {string} agentId
 * @returns {object}
 */
async function getAgentContext(agentId) {
  try {
    const mem = await loadMemory(agentId);

    // Top 3 most queried ZIPs
    const topZips = Object.entries(mem.zip_frequency || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([zip, count]) => ({ zip, query_count: count }));

    // Infer preferred categories from visit log entries
    const catCounts = {};
    for (const entry of (mem.zip_visit_log || [])) {
      if (entry.category) {
        catCounts[entry.category] = (catCounts[entry.category] || 0) + 1;
      }
    }
    const preferredCategories = Object.entries(catCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([cat]) => cat);

    // Suggested tool based on query patterns
    let suggestedTool = null;
    const totalQ    = mem.total_queries || 0;
    const uniqueZips = Object.keys(mem.zip_frequency || {}).length;

    if (uniqueZips >= 3) {
      suggestedTool = 'You query multiple ZIPs often — try local_intel_for_agent for composite multi-ZIP results';
    } else if (totalQ > 10 && topZips.length > 0) {
      suggestedTool = `You query ${topZips[0]?.zip || 'nearby'} frequently — try local_intel_tide for real-time temperature`;
    } else if (totalQ > 0) {
      suggestedTool = 'Try local_intel_signal for investment-grade signal scoring on your top ZIP';
    }

    return {
      top_zips:             topZips,
      preferred_categories: preferredCategories,
      suggested_tool:       suggestedTool,
      corridor_detected:    mem.corridor_detected || false,
      total_queries:        mem.total_queries     || 0,
      member_since:         mem.member_since      || null,
      last_seen:            mem.last_seen         || null,
    };
  } catch {
    return {
      top_zips:             [],
      preferred_categories: [],
      suggested_tool:       null,
      corridor_detected:    false,
      total_queries:        0,
      member_since:         null,
      last_seen:            null,
    };
  }
}

// ── clearOldMemory ────────────────────────────────────────────────────────────
/**
 * Prunes zip_visit_log entries older than RETENTION_D days across all agents
 * stored in Postgres. Safe to run at any time.
 */
async function clearOldMemory() {
  try {
    if (!process.env.LOCAL_INTEL_DB_URL) return;
    const pgStore  = require('../lib/pgStore');
    const cutoffIso = new Date(Date.now() - RETENTION_D * 24 * 60 * 60 * 1000).toISOString();
    const agents   = await pgStore.listAgentMemories();
    for (const agent of agents) {
      await pgStore.deleteOldAgentMemoryEntries(agent.agent_id, cutoffIso);
    }
    if (agents.length > 0) {
      console.log(`[agentMemory] Pruned visit logs older than ${RETENTION_D}d for ${agents.length} agents`);
    }
  } catch {
    // Never throw
  }
}

// Run prune on module load (deferred so module.exports is set first)
setImmediate(() => { clearOldMemory().catch(() => {}); });

module.exports = { recordQuery, getDelta, getAgentContext, clearOldMemory };
