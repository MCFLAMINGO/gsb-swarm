'use strict';
/**
 * workerHealth.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Worker self-health system. Workers don't just log — they know when they
 * are failing and surface that as a queryable health state.
 *
 * "IT SHOULD NOT SILENTLY FAIL"
 *
 * Health state per worker:
 *   healthy   — last run completed, success_rate ≥ threshold, within expected window
 *   degraded  — success_rate < threshold OR last run older than soft deadline
 *   failing   — 2+ consecutive fails OR last run older than hard deadline
 *   unknown   — no worker_events rows found
 *
 * Usage:
 *   const wh = require('./workerHealth');
 *   const health = await wh.checkAll();          // all workers
 *   const h      = await wh.check('geocodingWorker'); // one worker
 *   wh.assertHealthy('posRouter');               // throws if not healthy
 *
 * Workers register themselves via wh.register(name, opts) at startup.
 * If a worker doesn't call in within its expected_interval_hours,
 * it is automatically marked stale.
 */

const db = require('./db');

// ── Worker registry ──────────────────────────────────────────────────────────
// Workers register here so health checks know what to expect.
// expected_interval_hours: how often the worker SHOULD run
// min_success_rate: below this → degraded
// hard_deadline_hours: beyond this since last run → failing
const WORKER_REGISTRY = {
  intelligenceAggWorker: { expected_interval_hours: 24, min_success_rate: 90, hard_deadline_hours: 30 },
  geocodingWorker:       { expected_interval_hours: 168, min_success_rate: 80, hard_deadline_hours: 200 }, // weekly
  voiceIntake:           { expected_interval_hours: 1,   min_success_rate: 95, hard_deadline_hours: 4  },
  posRouter:             { expected_interval_hours: 1,   min_success_rate: 95, hard_deadline_hours: 4  },
  localIntelMCP:         { expected_interval_hours: 1,   min_success_rate: 90, hard_deadline_hours: 4  },
  rfqFallback:           { expected_interval_hours: 1,   min_success_rate: 85, hard_deadline_hours: 4  },
  sunbizWorker:          { expected_interval_hours: 168, min_success_rate: 80, hard_deadline_hours: 200 },
  oracleWorker:          { expected_interval_hours: 24,  min_success_rate: 85, hard_deadline_hours: 36 },
};

// ── Check single worker health ───────────────────────────────────────────────
async function check(workerName) {
  const config = WORKER_REGISTRY[workerName] || {
    expected_interval_hours: 24, min_success_rate: 80, hard_deadline_hours: 48
  };

  // Get last 10 events for this worker
  const rows = await db.query(`
    SELECT event_type, success_rate, error_message, duration_ms, created_at,
           records_in, records_out, output_summary
    FROM worker_events
    WHERE worker_name = $1
    ORDER BY created_at DESC
    LIMIT 10
  `, [workerName]);

  if (!rows.length) {
    return {
      worker: workerName,
      status: 'unknown',
      reason: 'no events found — worker has never run or is not logging',
      last_run: null,
      consecutive_fails: 0,
      config,
    };
  }

  const lastEvent  = rows[0];
  const lastRun    = lastEvent.created_at;
  const hoursSince = (Date.now() - new Date(lastRun).getTime()) / (1000 * 60 * 60);

  // Count consecutive fails from most recent
  let consecutiveFails = 0;
  for (const row of rows) {
    if (row.event_type === 'fail') consecutiveFails++;
    else if (row.event_type === 'complete') break;
  }

  // Last completed event
  const lastComplete = rows.find(r => r.event_type === 'complete');
  const successRate  = lastComplete?.success_rate != null
    ? Number(lastComplete.success_rate)
    : null;

  // Determine status
  let status = 'healthy';
  let reason = null;

  if (consecutiveFails >= 2) {
    status = 'failing';
    reason = `${consecutiveFails} consecutive failures. Last error: ${lastEvent.error_message || 'unknown'}`;
  } else if (hoursSince > config.hard_deadline_hours) {
    status = 'failing';
    reason = `Last run ${hoursSince.toFixed(1)}h ago — exceeds hard deadline of ${config.hard_deadline_hours}h`;
  } else if (consecutiveFails === 1) {
    status = 'degraded';
    reason = `Last run failed: ${lastEvent.error_message || 'unknown error'}`;
  } else if (successRate != null && successRate < config.min_success_rate) {
    status = 'degraded';
    reason = `Success rate ${successRate}% below threshold ${config.min_success_rate}%`;
  } else if (hoursSince > config.expected_interval_hours) {
    status = 'degraded';
    reason = `Last run ${hoursSince.toFixed(1)}h ago — overdue (expected every ${config.expected_interval_hours}h)`;
  }

  return {
    worker:            workerName,
    status,
    reason,
    last_run:          lastRun,
    hours_since_run:   +hoursSince.toFixed(1),
    consecutive_fails: consecutiveFails,
    last_success_rate: successRate,
    last_duration_ms:  lastEvent.duration_ms,
    last_output:       lastComplete?.output_summary || null,
    config,
  };
}

// ── Check all registered workers ─────────────────────────────────────────────
async function checkAll() {
  const names = Object.keys(WORKER_REGISTRY);
  const results = await Promise.all(names.map(n => check(n)));

  const summary = {
    healthy:  results.filter(r => r.status === 'healthy').length,
    degraded: results.filter(r => r.status === 'degraded').length,
    failing:  results.filter(r => r.status === 'failing').length,
    unknown:  results.filter(r => r.status === 'unknown').length,
    workers:  results,
    checked_at: new Date().toISOString(),
  };

  summary.overall = summary.failing > 0 ? 'failing'
    : summary.degraded > 0             ? 'degraded'
    : summary.unknown === names.length  ? 'unknown'
    : 'healthy';

  return summary;
}

// ── Assert healthy (throws if not — use in critical paths) ───────────────────
async function assertHealthy(workerName) {
  const h = await check(workerName);
  if (h.status === 'failing') {
    throw new Error(`[workerHealth] ${workerName} is FAILING: ${h.reason}`);
  }
  if (h.status === 'degraded') {
    console.warn(`[workerHealth] WARNING: ${workerName} is DEGRADED: ${h.reason}`);
  }
  return h;
}

// ── Self-report: workers call this to announce they're alive ─────────────────
// Writes a 'heartbeat' event. If a worker is long-running (like a listener),
// call this on a schedule so health checks know it's still running.
async function heartbeat(workerName, meta = {}) {
  const { logWorker } = require('./telemetry');
  await logWorker({
    worker_name:    workerName,
    event_type:     'heartbeat',
    output_summary: `alive at ${new Date().toISOString()}`,
    meta,
  });
}

// ── Self-improvement: surface repeated failures for review ───────────────────
// Returns workers with >N failures in last 24h — used by CEO agent or alerts
async function getFailureReport(minFails = 2, windowHours = 24) {
  const rows = await db.query(`
    SELECT
      worker_name,
      COUNT(*) FILTER (WHERE event_type = 'fail') AS fail_count,
      COUNT(*) FILTER (WHERE event_type = 'complete') AS success_count,
      MAX(created_at) AS last_event,
      ARRAY_AGG(error_message ORDER BY created_at DESC) FILTER (WHERE event_type='fail') AS errors
    FROM worker_events
    WHERE created_at >= NOW() - INTERVAL '${windowHours} hours'
    GROUP BY worker_name
    HAVING COUNT(*) FILTER (WHERE event_type = 'fail') >= $1
    ORDER BY fail_count DESC
  `, [minFails]);

  return rows;
}

module.exports = { check, checkAll, assertHealthy, heartbeat, getFailureReport, WORKER_REGISTRY };
