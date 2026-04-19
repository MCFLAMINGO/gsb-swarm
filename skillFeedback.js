'use strict';
/**
 * Skill Feedback Loop — GSB Swarm
 *
 * Every agent calls recordOutcome() after a job completes or fails.
 * Over time, each skill accumulates:
 *   - successCount / failCount
 *   - averageMs (execution time)
 *   - confidenceScore (0–1, decays on fail, grows on success)
 *   - lastError (most recent failure message)
 *   - retryHints (suggestions written on failure for next attempt)
 *
 * The CEO agent can read all skill scores via getSkillReport() and use
 * them to route jobs to the most reliable agent for a task.
 *
 * Skills with confidenceScore < 0.3 are flagged DEGRADED and the CEO
 * writes a pinned swarm memory entry so all agents know.
 */

const fs   = require('fs');
const path = require('path');
const mem  = require('./swarmMemory');

const FEEDBACK_FILE = process.env.SKILL_FEEDBACK_FILE || '/tmp/gsb-skill-feedback.json';
const CONFIDENCE_INIT    = 0.7;   // new skill starts at 70%
const CONFIDENCE_BOOST   = 0.08;  // +8% per success (capped at 1.0)
const CONFIDENCE_DECAY   = 0.15;  // -15% per failure
const CONFIDENCE_FLOOR   = 0.0;
const CONFIDENCE_CEIL    = 1.0;
const DEGRADED_THRESHOLD = 0.3;   // below this → flag as degraded
const MAX_ERRORS         = 10;    // keep last N error messages per skill

function load() {
  try { return JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8')); }
  catch { return {}; }
}

function save(db) {
  try { fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(db, null, 2)); } catch {}
}

/**
 * Record the outcome of a skill execution.
 * @param {string} agentName    e.g. 'GSB Token Analyst'
 * @param {string} skillId      e.g. 'analyze_token'
 * @param {boolean} success     true = job completed + accepted, false = rejected/error
 * @param {object} opts
 *   opts.durationMs    number   how long the job took
 *   opts.error         string   error message on failure
 *   opts.retryHint     string   what to try differently next time
 *   opts.jobId         string   ACP job ID for traceability
 *   opts.clientAddr    string   who hired this agent
 */
function recordOutcome(agentName, skillId, success, opts = {}) {
  const db  = load();
  const key = `${agentName}::${skillId}`;

  if (!db[key]) {
    db[key] = {
      agentName,
      skillId,
      successCount:    0,
      failCount:       0,
      totalMs:         0,
      confidenceScore: CONFIDENCE_INIT,
      lastSuccess:     null,
      lastFailure:     null,
      recentErrors:    [],
      retryHints:      [],
      jobs:            [],
    };
  }

  const rec = db[key];
  const now = Date.now();

  if (success) {
    rec.successCount++;
    rec.confidenceScore = Math.min(CONFIDENCE_CEIL, rec.confidenceScore + CONFIDENCE_BOOST);
    rec.lastSuccess = now;
  } else {
    rec.failCount++;
    rec.confidenceScore = Math.max(CONFIDENCE_FLOOR, rec.confidenceScore - CONFIDENCE_DECAY);
    rec.lastFailure = now;
    if (opts.error) {
      rec.recentErrors.unshift({ ts: now, msg: opts.error.slice(0, 200) });
      if (rec.recentErrors.length > MAX_ERRORS) rec.recentErrors = rec.recentErrors.slice(0, MAX_ERRORS);
    }
    if (opts.retryHint && !rec.retryHints.includes(opts.retryHint)) {
      rec.retryHints.unshift(opts.retryHint);
      if (rec.retryHints.length > 5) rec.retryHints = rec.retryHints.slice(0, 5);
    }
  }

  if (opts.durationMs) rec.totalMs += opts.durationMs;

  // Compact job log — last 50 entries
  rec.jobs.unshift({
    ts:      now,
    jobId:   opts.jobId   || null,
    client:  opts.clientAddr || null,
    ok:      success,
    ms:      opts.durationMs || null,
    error:   success ? null : (opts.error || null),
  });
  if (rec.jobs.length > 50) rec.jobs = rec.jobs.slice(0, 50);

  save(db);

  // If confidence just dropped below DEGRADED_THRESHOLD, pin a swarm memory warning
  if (!success && rec.confidenceScore < DEGRADED_THRESHOLD) {
    const hint = rec.retryHints[0] ? ` Hint: ${rec.retryHints[0]}` : '';
    mem.pinContext(
      `DEGRADED:${key}`,
      `⚠️ Skill ${skillId} on ${agentName} is DEGRADED (confidence: ${(rec.confidenceScore * 100).toFixed(0)}%). ` +
      `${rec.failCount} failures, last error: ${rec.recentErrors[0]?.msg || 'unknown'}.${hint} ` +
      `Avoid routing to this skill until fixed.`
    );
    console.warn(`[skillFeedback] DEGRADED: ${key} — confidence ${(rec.confidenceScore * 100).toFixed(0)}%`);
  }

  // If confidence recovered above 0.5, unpin the degraded warning
  if (success && rec.confidenceScore >= 0.5) {
    const pinnedKey = `DEGRADED:${key}`;
    try {
      const m = JSON.parse(fs.readFileSync(require('./swarmMemory').MEMORY_FILE || '/tmp/gsb-swarm-memory.json', 'utf8'));
      m.pinnedContext = (m.pinnedContext || []).filter(p => p.label !== pinnedKey);
      fs.writeFileSync(require('./swarmMemory').MEMORY_FILE || '/tmp/gsb-swarm-memory.json', JSON.stringify(m, null, 2));
    } catch {}
  }

  return rec;
}

/**
 * Get the full skill report — used by CEO agent and dashboard.
 * Returns array sorted by confidence ascending (worst first).
 */
function getSkillReport() {
  const db = load();
  return Object.values(db).map(rec => ({
    agentName:       rec.agentName,
    skillId:         rec.skillId,
    successCount:    rec.successCount,
    failCount:       rec.failCount,
    totalJobs:       rec.successCount + rec.failCount,
    successRate:     rec.successCount + rec.failCount > 0
      ? ((rec.successCount / (rec.successCount + rec.failCount)) * 100).toFixed(1) + '%'
      : 'n/a',
    avgMs:           rec.totalMs && (rec.successCount + rec.failCount) > 0
      ? Math.round(rec.totalMs / (rec.successCount + rec.failCount))
      : null,
    confidenceScore: parseFloat(rec.confidenceScore.toFixed(3)),
    status:          rec.confidenceScore < DEGRADED_THRESHOLD ? 'DEGRADED' :
                     rec.confidenceScore < 0.5               ? 'WEAK'     :
                     rec.confidenceScore < 0.8               ? 'OK'       : 'STRONG',
    lastSuccess:     rec.lastSuccess,
    lastFailure:     rec.lastFailure,
    recentErrors:    rec.recentErrors.slice(0, 3),
    retryHints:      rec.retryHints,
  })).sort((a, b) => a.confidenceScore - b.confidenceScore);
}

/**
 * Get best agent for a task type (by skillId pattern or description keyword).
 * Returns the agent with highest confidence for that skill.
 */
function getBestAgent(skillId) {
  const db = load();
  const candidates = Object.values(db)
    .filter(r => r.skillId === skillId)
    .sort((a, b) => b.confidenceScore - a.confidenceScore);
  return candidates[0] || null;
}

/**
 * Reset feedback for a skill (after a code fix is deployed).
 * Bumps confidence back to CONFIDENCE_INIT and clears errors.
 */
function resetSkill(agentName, skillId) {
  const db  = load();
  const key = `${agentName}::${skillId}`;
  if (db[key]) {
    db[key].confidenceScore = CONFIDENCE_INIT;
    db[key].recentErrors    = [];
    db[key].retryHints      = [];
    db[key].failCount       = 0;
    save(db);
  }
}

module.exports = { recordOutcome, getSkillReport, getBestAgent, resetSkill };
