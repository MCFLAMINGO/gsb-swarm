'use strict';
/**
 * intelligenceAggWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Nightly aggregation worker for the LocalIntel intelligence layer.
 *
 * Reads: task_events (append-only)
 * Writes:
 *   task_patterns          — ZIP × category_group × week conformance + road stats
 *   business_responsiveness — per-business score 0–100
 *
 * Road classification (set at write time in telemetry.js):
 *   highway    = agent_closed  (fully machine, UCP/Surge)
 *   local      = human_assisted (SMS/voice handoff)
 *   cul-de-sac = dropped / pending / no handoff
 *
 * Conformance score = agent_closed / total_tasks × 100
 * Response score (0–100):
 *   40pts  avg_response_minutes < 5 min
 *   30pts  completion_rate_30d
 *   30pts  conformance_rate_30d
 *
 * Run:
 *   node workers/intelligenceAggWorker.js            — full nightly run
 *   node workers/intelligenceAggWorker.js --dry      — report only, no writes
 *   node workers/intelligenceAggWorker.js --days 7   — use last N days only
 *
 * Scheduled: Railway cron or setInterval from localIntelAgent.js
 */

const db           = require('../lib/db');
const { logWorker } = require('../lib/telemetry');

const isDry  = process.argv.includes('--dry');
const daysArg = process.argv.indexOf('--days');
const WINDOW_DAYS = daysArg >= 0 ? parseInt(process.argv[daysArg + 1], 10) || 90 : 90;

// ── Helpers ──────────────────────────────────────────────────────────────────

function scoreResponsiveness({ avg_response_min, completion_rate_30d, conformance_rate_30d }) {
  let score = 0;
  // Speed: 0–40pts — linear from 0 (≥60 min) to 40 (≤2 min)
  if (avg_response_min != null) {
    const mins = Number(avg_response_min);
    if (mins <= 2)  score += 40;
    else if (mins <= 5)  score += 32;
    else if (mins <= 10) score += 22;
    else if (mins <= 30) score += 12;
    else if (mins <= 60) score += 5;
  }
  // Completion: 0–30pts
  if (completion_rate_30d != null) score += Math.round(Number(completion_rate_30d) * 0.30);
  // Conformance: 0–30pts
  if (conformance_rate_30d != null) score += Math.round(Number(conformance_rate_30d) * 0.30);
  return Math.min(100, Math.max(0, score));
}

// ── Step 1: Aggregate task_patterns ─────────────────────────────────────────

async function aggregateTaskPatterns() {
  console.log('[agg] Step 1: aggregating task_patterns (ZIP × category × week)...');

  const rows = await db.query(`
    SELECT
      zip,
      category_group,
      DATE_TRUNC('week', initiated_at)::DATE AS week_start,
      COUNT(*)                                          AS total_tasks,
      COUNT(*) FILTER (WHERE resolution_type = 'agent_closed')   AS agent_closed,
      COUNT(*) FILTER (WHERE resolution_type = 'human_assisted') AS human_assisted,
      COUNT(*) FILTER (WHERE resolution_type IN ('dropped','failed')) AS dropped,
      ROUND(
        COUNT(*) FILTER (WHERE resolution_type = 'agent_closed')::NUMERIC
        / NULLIF(COUNT(*),0) * 100, 2
      )                                                 AS conformance_rate,
      ROUND(
        COUNT(*) FILTER (WHERE resolution_type IN ('agent_closed','human_assisted'))::NUMERIC
        / NULLIF(COUNT(*),0) * 100, 2
      )                                                 AS completion_rate,
      ROUND(AVG(
        EXTRACT(EPOCH FROM (responded_at - initiated_at)) / 60
      ) FILTER (WHERE responded_at IS NOT NULL), 2)    AS avg_response_minutes,
      ROUND(AVG(
        EXTRACT(EPOCH FROM (completed_at - initiated_at)) / 60
      ) FILTER (WHERE completed_at IS NOT NULL), 2)    AS avg_completion_minutes,
      MODE() WITHIN GROUP (ORDER BY handoff_type)       AS dominant_handoff_type,
      ROUND(
        COUNT(*) FILTER (WHERE pos_type IS NOT NULL)::NUMERIC
        / NULLIF(COUNT(*),0) * 100, 2
      )                                                 AS pos_connected_pct,
      ROUND(COUNT(*) FILTER (WHERE road_type='highway')::NUMERIC / NULLIF(COUNT(*),0)*100,2) AS highway_pct,
      ROUND(COUNT(*) FILTER (WHERE road_type='local')::NUMERIC   / NULLIF(COUNT(*),0)*100,2) AS local_pct,
      ROUND(COUNT(*) FILTER (WHERE road_type='cul-de-sac')::NUMERIC / NULLIF(COUNT(*),0)*100,2) AS cul_de_sac_pct
    FROM task_events
    WHERE initiated_at >= NOW() - INTERVAL '${WINDOW_DAYS} days'
      AND zip IS NOT NULL
      AND category_group IS NOT NULL
    GROUP BY zip, category_group, week_start
    ORDER BY week_start DESC
  `);

  console.log(`[agg]   computed ${rows.length} ZIP×category×week patterns`);
  if (isDry) { console.log('[agg]   DRY RUN — skipping writes'); return rows.length; }

  let upserted = 0;
  for (const row of rows) {
    // Build drop_rate_by_stage — what % drop at each stage
    const dropAtHandoff   = row.total_tasks > 0 ? +(row.dropped / row.total_tasks * 100).toFixed(2) : 0;
    const dropAtResponse  = row.total_tasks > 0 ? +(
      (row.total_tasks - row.agent_closed - row.human_assisted - row.dropped) / row.total_tasks * 100
    ).toFixed(2) : 0;

    await db.query(`
      INSERT INTO task_patterns (
        zip, category_group, week_start,
        total_tasks, completion_rate, avg_response_minutes, avg_completion_minutes,
        dominant_handoff_type, pos_connected_pct, drop_rate_by_stage,
        agent_closed_count, human_assisted_count, dropped_count, conformance_rate,
        highway_pct, local_pct, cul_de_sac_pct, computed_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
      ON CONFLICT (zip, category_group, week_start) DO UPDATE SET
        total_tasks            = EXCLUDED.total_tasks,
        completion_rate        = EXCLUDED.completion_rate,
        avg_response_minutes   = EXCLUDED.avg_response_minutes,
        avg_completion_minutes = EXCLUDED.avg_completion_minutes,
        dominant_handoff_type  = EXCLUDED.dominant_handoff_type,
        pos_connected_pct      = EXCLUDED.pos_connected_pct,
        drop_rate_by_stage     = EXCLUDED.drop_rate_by_stage,
        agent_closed_count     = EXCLUDED.agent_closed_count,
        human_assisted_count   = EXCLUDED.human_assisted_count,
        dropped_count          = EXCLUDED.dropped_count,
        conformance_rate       = EXCLUDED.conformance_rate,
        highway_pct            = EXCLUDED.highway_pct,
        local_pct              = EXCLUDED.local_pct,
        cul_de_sac_pct         = EXCLUDED.cul_de_sac_pct,
        computed_at            = NOW()
    `, [
      row.zip, row.category_group, row.week_start,
      row.total_tasks, row.completion_rate, row.avg_response_minutes, row.avg_completion_minutes,
      row.dominant_handoff_type, row.pos_connected_pct,
      JSON.stringify({ at_handoff: dropAtHandoff, at_response: dropAtResponse }),
      row.agent_closed, row.human_assisted, row.dropped, row.conformance_rate,
      row.highway_pct, row.local_pct, row.cul_de_sac_pct,
    ]);
    upserted++;
  }

  console.log(`[agg]   upserted ${upserted} task_pattern rows`);
  return upserted;
}

// ── Step 2: Aggregate business_responsiveness ────────────────────────────────

async function aggregateBusinessResponsiveness() {
  console.log('[agg] Step 2: aggregating business_responsiveness...');

  const rows = await db.query(`
    SELECT
      te.business_id,
      b.zip,
      b.category_group,

      -- Response speed (only tasks where responded_at is set)
      ROUND(AVG(
        EXTRACT(EPOCH FROM (te.responded_at - te.initiated_at)) / 60
      ) FILTER (WHERE te.responded_at IS NOT NULL), 2)  AS avg_response_min,

      -- 30-day completion rate
      ROUND(
        COUNT(*) FILTER (
          WHERE te.resolution_type IN ('agent_closed','human_assisted')
          AND te.initiated_at >= NOW() - INTERVAL '30 days'
        )::NUMERIC
        / NULLIF(COUNT(*) FILTER (WHERE te.initiated_at >= NOW() - INTERVAL '30 days'),0) * 100
      , 2)                                              AS completion_rate_30d,

      -- 90-day completion rate
      ROUND(
        COUNT(*) FILTER (
          WHERE te.resolution_type IN ('agent_closed','human_assisted')
          AND te.initiated_at >= NOW() - INTERVAL '90 days'
        )::NUMERIC
        / NULLIF(COUNT(*) FILTER (WHERE te.initiated_at >= NOW() - INTERVAL '90 days'),0) * 100
      , 2)                                              AS completion_rate_90d,

      -- 30-day conformance rate
      ROUND(
        COUNT(*) FILTER (
          WHERE te.resolution_type = 'agent_closed'
          AND te.initiated_at >= NOW() - INTERVAL '30 days'
        )::NUMERIC
        / NULLIF(COUNT(*) FILTER (WHERE te.initiated_at >= NOW() - INTERVAL '30 days'),0) * 100
      , 2)                                              AS conformance_rate_30d,

      -- Dominant road type
      MODE() WITHIN GROUP (ORDER BY te.road_type)       AS dominant_road_type,
      MODE() WITHIN GROUP (ORDER BY te.handoff_type)    AS handoff_type,
      MODE() WITHIN GROUP (ORDER BY te.pos_type)        AS pos_type,

      -- Task counts
      COUNT(*) FILTER (WHERE te.initiated_at >= NOW() - INTERVAL '7 days')  AS tasks_7d,
      COUNT(*) FILTER (WHERE te.initiated_at >= NOW() - INTERVAL '30 days') AS tasks_30d,
      COUNT(*) FILTER (WHERE te.initiated_at >= NOW() - INTERVAL '90 days') AS tasks_90d,
      MAX(te.initiated_at)                              AS last_task_at

    FROM task_events te
    JOIN businesses b ON b.business_id = te.business_id
    WHERE te.business_id IS NOT NULL
      AND te.initiated_at >= NOW() - INTERVAL '90 days'
    GROUP BY te.business_id, b.zip, b.category_group
  `);

  console.log(`[agg]   computed responsiveness for ${rows.length} businesses`);
  if (isDry) { console.log('[agg]   DRY RUN — skipping writes'); return rows.length; }

  let upserted = 0;
  for (const row of rows) {
    const response_score = scoreResponsiveness({
      avg_response_min:     row.avg_response_min,
      completion_rate_30d:  row.completion_rate_30d,
      conformance_rate_30d: row.conformance_rate_30d,
    });

    await db.query(`
      INSERT INTO business_responsiveness (
        business_id, zip, category_group,
        response_score, avg_response_min,
        completion_rate_30d, completion_rate_90d, conformance_rate_30d,
        dominant_road_type, handoff_type, pos_type,
        tasks_7d, tasks_30d, tasks_90d,
        last_task_at, computed_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
      ON CONFLICT (business_id) DO UPDATE SET
        zip                  = EXCLUDED.zip,
        category_group       = EXCLUDED.category_group,
        response_score       = EXCLUDED.response_score,
        avg_response_min     = EXCLUDED.avg_response_min,
        completion_rate_30d  = EXCLUDED.completion_rate_30d,
        completion_rate_90d  = EXCLUDED.completion_rate_90d,
        conformance_rate_30d = EXCLUDED.conformance_rate_30d,
        dominant_road_type   = EXCLUDED.dominant_road_type,
        handoff_type         = EXCLUDED.handoff_type,
        pos_type             = EXCLUDED.pos_type,
        tasks_7d             = EXCLUDED.tasks_7d,
        tasks_30d            = EXCLUDED.tasks_30d,
        tasks_90d            = EXCLUDED.tasks_90d,
        last_task_at         = EXCLUDED.last_task_at,
        computed_at          = NOW()
    `, [
      row.business_id, row.zip, row.category_group,
      response_score, row.avg_response_min,
      row.completion_rate_30d, row.completion_rate_90d, row.conformance_rate_30d,
      row.dominant_road_type, row.handoff_type, row.pos_type,
      row.tasks_7d, row.tasks_30d, row.tasks_90d,
      row.last_task_at,
    ]);
    upserted++;
  }

  console.log(`[agg]   upserted ${upserted} business_responsiveness rows`);
  return upserted;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const start = Date.now();
  console.log(`\n[intelligenceAggWorker] START ${new Date().toISOString()} (window: ${WINDOW_DAYS}d, dry: ${isDry})\n`);

  await logWorker({ worker_name: 'intelligenceAggWorker', event_type: 'start',
    input_summary: `window=${WINDOW_DAYS}d dry=${isDry}` });

  let patternsCount = 0, bizCount = 0, error = null;

  try {
    patternsCount = await aggregateTaskPatterns();
    bizCount      = await aggregateBusinessResponsiveness();

    const duration = Date.now() - start;
    console.log(`\n[intelligenceAggWorker] DONE in ${(duration/1000).toFixed(1)}s`);
    console.log(`  task_patterns rows:          ${patternsCount}`);
    console.log(`  business_responsiveness rows: ${bizCount}`);

    await logWorker({
      worker_name:    'intelligenceAggWorker',
      event_type:     'complete',
      output_summary: `patterns=${patternsCount} businesses=${bizCount}`,
      duration_ms:    duration,
      records_out:    patternsCount + bizCount,
      success_rate:   100,
    });
  } catch (e) {
    error = e;
    console.error('[intelligenceAggWorker] FAILED:', e.message);
    await logWorker({
      worker_name:   'intelligenceAggWorker',
      event_type:    'fail',
      error_message: e.message,
      duration_ms:   Date.now() - start,
    });
  }

  if (require.main === module) process.exit(error ? 1 : 0);
}

// ── Schedule (when run as a long-lived process) ───────────────────────────────
// If imported by localIntelAgent.js, call scheduleNightly() to register
// the 2am daily cron. If run directly, just run once.
function scheduleNightly() {
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  console.log('[intelligenceAggWorker] Scheduled nightly at 2am Eastern');

  function msUntil2am() {
    const now = new Date();
    const next2am = new Date(now);
    next2am.setHours(2, 0, 0, 0);
    if (next2am <= now) next2am.setDate(next2am.getDate() + 1);
    return next2am - now;
  }

  setTimeout(function tick() {
    run().catch(console.error);
    setTimeout(tick, TWENTY_FOUR_HOURS);
  }, msUntil2am());
}

module.exports = { run, scheduleNightly, aggregateTaskPatterns, aggregateBusinessResponsiveness };

if (require.main === module) run();
