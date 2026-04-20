'use strict';
/**
 * agentMemoryWorker.js — LocalIntel Per-Agent Memory
 *
 * Manages per-agent memory files stored in data/agentMemory/{agentId}.json
 *
 * Exports:
 *   recordQuery(agentId, zip, tool, agentType)  — log a query event to agent memory
 *   getDelta(agentId, zip)                       — business count delta since last visit
 *   getAgentContext(agentId)                     — summarise agent's query patterns
 *   clearOldMemory()                             — prune entries older than 90 days
 *
 * Schema: { agentId, total_queries, member_since, last_seen, zip_visit_log: [],
 *           zip_frequency: {}, zip_last_count: {}, corridor_detected: bool }
 */

const path = require('path');
const fs   = require('fs');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const MEMORY_DIR  = path.join(DATA_DIR, 'agentMemory');
const ZIPS_DIR    = path.join(DATA_DIR, 'zips');
const MAX_LOG     = 100;          // keep last N visit log entries
const RETENTION_D = 90;          // prune entries older than this many days

// ── Ensure memory directory exists ───────────────────────────────────────────
try {
  if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
} catch {}

// ── Run prune on module load ──────────────────────────────────────────────────
// (deferred via setImmediate so module.exports is set before any IO)
setImmediate(() => { try { clearOldMemory(); } catch {} });

// ── Safe JSON reader ──────────────────────────────────────────────────────────
function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// ── Atomic write (write .tmp, rename) ────────────────────────────────────────
function writeAtomic(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

// ── Load or initialise agent memory ──────────────────────────────────────────
function loadMemory(agentId) {
  const filePath = path.join(MEMORY_DIR, `${agentId}.json`);
  const existing = readJson(filePath);
  if (existing) return { filePath, mem: existing };

  const now = new Date().toISOString();
  const mem = {
    agentId,
    total_queries:      0,
    member_since:       now,
    last_seen:          now,
    zip_visit_log:      [],
    zip_frequency:      {},
    zip_last_count:     {},
    corridor_detected:  false,
  };
  return { filePath, mem };
}

// ── Corridor detection: are the last 3+ unique ZIPs numerically sequential? ──
function detectCorridor(zipVisitLog) {
  try {
    // Collect last 3 unique ZIPs in order of visit
    const seen = [];
    for (let i = zipVisitLog.length - 1; i >= 0 && seen.length < 5; i--) {
      const z = zipVisitLog[i].zip;
      if (z && !seen.includes(z)) seen.unshift(z);
    }
    if (seen.length < 3) return false;

    // Check if at least 3 consecutive ZIPs are numerically sequential (differ by ≤2)
    const nums = seen.map(z => parseInt(z, 10)).filter(n => !isNaN(n));
    if (nums.length < 3) return false;

    // Check any 3-window for sequential pattern
    for (let i = 0; i <= nums.length - 3; i++) {
      const sorted = [...nums.slice(i, i + 3)].sort((a, b) => a - b);
      if (sorted[2] - sorted[0] <= 4) return true; // within 4 ZIP numbers = corridor
    }
    return false;
  } catch {
    return false;
  }
}

// ── recordQuery ───────────────────────────────────────────────────────────────
/**
 * Log a query event to the agent's memory file.
 *
 * @param {string} agentId
 * @param {string} zip
 * @param {string} tool
 * @param {string} agentType
 */
function recordQuery(agentId, zip, tool, agentType) {
  try {
    if (!agentId) return;

    const { filePath, mem } = loadMemory(agentId);
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

    writeAtomic(filePath, mem);
  } catch {
    // Never throw
  }
}

// ── getDelta ──────────────────────────────────────────────────────────────────
/**
 * Returns the business count delta since this agent last queried a ZIP.
 *
 * @param {string} agentId
 * @param {string} zip
 * @returns {object|null}
 */
function getDelta(agentId, zip) {
  try {
    const { mem } = loadMemory(agentId);

    // Find most recent visit log entry for this ZIP
    const visits = mem.zip_visit_log.filter(e => e.zip === zip);
    if (!visits.length) return null;

    const lastVisit = visits[visits.length - 1];
    const lastTs    = lastVisit.ts || null;
    const daysSince = lastTs
      ? Math.round((Date.now() - new Date(lastTs).getTime()) / (1000 * 60 * 60 * 24))
      : null;

    // Current business count
    let currentCount = 0;
    try {
      const zipData = JSON.parse(fs.readFileSync(path.join(ZIPS_DIR, `${zip}.json`), 'utf8'));
      currentCount  = Array.isArray(zipData) ? zipData.length : 0;
    } catch {}

    // Previous snapshot from memory
    const prevCount = mem.zip_last_count[zip] || currentCount;

    // Update snapshot for next call
    try {
      const { filePath, mem: freshMem } = loadMemory(agentId);
      freshMem.zip_last_count[zip] = currentCount;
      writeAtomic(filePath, freshMem);
    } catch {}

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
function getAgentContext(agentId) {
  try {
    const { mem } = loadMemory(agentId);

    // Top 3 most queried ZIPs
    const topZips = Object.entries(mem.zip_frequency || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([zip, count]) => ({ zip, query_count: count }));

    // Infer preferred categories from tool params in visit log
    // (visit log entries may carry a category field if enriched by caller)
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
    const totalQ = mem.total_queries || 0;
    const uniqueZips = Object.keys(mem.zip_frequency || {}).length;

    if (uniqueZips >= 3) {
      suggestedTool = 'You query multiple ZIPs often — try local_intel_for_agent for composite multi-ZIP results';
    } else if (totalQ > 10 && topZips.length > 0) {
      suggestedTool = `You query ${topZips[0]?.zip || 'nearby'} frequently — try local_intel_tide for real-time temperature`;
    } else if (totalQ > 0) {
      suggestedTool = 'Try local_intel_signal for investment-grade signal scoring on your top ZIP';
    }

    return {
      top_zips:            topZips,
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
 * Prunes zip_visit_log entries older than RETENTION_D days across all agent
 * memory files. Safe to run at any time.
 */
function clearOldMemory() {
  try {
    if (!fs.existsSync(MEMORY_DIR)) return;

    const cutoff = Date.now() - RETENTION_D * 24 * 60 * 60 * 1000;
    const files  = fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith('.json') && !f.endsWith('.tmp'));

    for (const file of files) {
      try {
        const filePath = path.join(MEMORY_DIR, file);
        const mem      = readJson(filePath);
        if (!mem || !Array.isArray(mem.zip_visit_log)) continue;

        const before = mem.zip_visit_log.length;
        mem.zip_visit_log = mem.zip_visit_log.filter(e => {
          try { return new Date(e.ts).getTime() >= cutoff; } catch { return true; }
        });

        if (mem.zip_visit_log.length !== before) {
          writeAtomic(filePath, mem);
        }
      } catch {
        // skip individual file errors
      }
    }
  } catch {
    // Never throw
  }
}

module.exports = { recordQuery, getDelta, getAgentContext, clearOldMemory };
