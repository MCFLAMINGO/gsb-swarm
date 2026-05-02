/**
 * waveSurfaceWorker.js
 *
 * Layer 3 — WAVE SURFACE
 * Hourly aggregation of MCP query events per ZIP code.
 *
 * Reads events from `wave_events` table (Postgres).
 * Writes per-ZIP aggregates to `wave_surface` table (Postgres).
 *
 * Also exports appendEvent(event) for use by mcpMiddleware.js, which
 * inserts into the `wave_events` table.
 *
 * Runs on start, then every hour at :05.
 */

'use strict';

const pgStore = require('../lib/pgStore');

const INTERVAL_MS     = 60 * 60 * 1000; // 1 hour
const WINDOW_24H_MS   = 24 * 60 * 60 * 1000;
const WINDOW_30D_MS   = 30 * 24 * 60 * 60 * 1000;

// Valid agent types
const AGENT_TYPES = ['real_estate', 'financial', 'ad_placement', 'logistics', 'business_owner', 'civic'];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Find the most frequent value in an array of primitives.
 * Returns null for empty arrays.
 */
function mostCommon(arr) {
  if (!arr.length) return null;
  const counts = {};
  for (const v of arr) {
    counts[v] = (counts[v] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

// ── appendEvent (exported for mcpMiddleware) ─────────────────────────────────

/**
 * Append a single query event to the `wave_events` table.
 * Non-blocking — fire-and-forget; never throws.
 *
 * @param {object} event - { zip, tool, agent_type, lat, lon, agent_id, vertical, query, score, latency_ms }
 */
function appendEvent(event) {
  pgStore.appendWaveEvent({
    ts:         new Date().toISOString(),
    zip:        event.zip        || null,
    tool:       event.tool       || null,
    agent_id:   event.agent_id   || null,
    vertical:   event.vertical   || event.agent_type || null,
    query:      event.query      || null,
    score:      event.score      || null,
    latency_ms: event.latency_ms || null,
  }).catch(() => {});
}

// ── Main aggregation ──────────────────────────────────────────────────────────

async function aggregateWaveSurface() {
  console.log('[waveSurfaceWorker] Starting wave surface aggregation...');

  // Read recent events from Postgres
  let events = [];
  try {
    events = await pgStore.getWaveEvents(WINDOW_30D_MS);
  } catch (e) {
    console.log('[waveSurfaceWorker] Could not load wave_events:', e.message);
    return;
  }

  if (events.length === 0) {
    console.log('[waveSurfaceWorker] No events to aggregate.');
    return;
  }

  const now     = Date.now();
  const cutoff24h = now - WINDOW_24H_MS;
  const cutoff30d = now - WINDOW_30D_MS;

  // ── Group events by ZIP ───────────────────────────────────────────────────
  const byZip = {};

  for (const event of events) {
    const zip = event.zip;
    if (!zip) continue;
    if (!byZip[zip]) byZip[zip] = [];
    byZip[zip].push(event);
  }

  const zipCount = Object.keys(byZip).length;

  // ── Compute 24h counts per ZIP for ranking ────────────────────────────────
  const zip24hCounts = {};
  for (const [zip, evts] of Object.entries(byZip)) {
    zip24hCounts[zip] = evts.filter(e => new Date(e.ts).getTime() >= cutoff24h).length;
  }

  // Sort ZIPs by 24h count descending for hotspot_rank
  const rankedZips = Object.entries(zip24hCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([zip], i) => ({ zip, rank: i + 1 }));
  const rankMap = {};
  for (const { zip, rank } of rankedZips) rankMap[zip] = rank;

  // ── Per-ZIP aggregation ───────────────────────────────────────────────────
  for (const [zip, evts] of Object.entries(byZip)) {
    const evts24h = evts.filter(e => new Date(e.ts).getTime() >= cutoff24h);
    const evts30d = evts.filter(e => new Date(e.ts).getTime() >= cutoff30d);

    const queries24h  = evts24h.length;
    const queries30d  = evts30d.length;
    const avgDaily    = +(queries30d / 30).toFixed(2);

    // ── Velocity trend ──────────────────────────────────────────────────────
    let velocityTrend;
    if (avgDaily === 0) {
      velocityTrend = queries24h > 0 ? 'rising' : 'stable';
    } else {
      const ratio = queries24h / avgDaily;
      if (ratio >= 2.0)       velocityTrend = 'rising';
      else if (ratio >= 1.2)  velocityTrend = 'rising';
      else if (ratio <= 0.5)  velocityTrend = 'falling';
      else                    velocityTrend = 'stable';
    }

    // ── Peak query hour (UTC) ───────────────────────────────────────────────
    const hours30d = evts30d.map(e => new Date(e.ts).getUTCHours());
    const peakHour = hours30d.length ? parseInt(mostCommon(hours30d), 10) : null;

    // ── Peak query day of week (0=Sun) ──────────────────────────────────────
    const days30d = evts30d.map(e => new Date(e.ts).getUTCDay());
    const peakDay = days30d.length ? parseInt(mostCommon(days30d), 10) : null;

    // ── Top demanded category ───────────────────────────────────────────────
    const cats30d = evts30d.map(e => e.category || e.tool || null).filter(Boolean);
    const topCategory = cats30d.length ? mostCommon(cats30d) : null;

    // ── Agent type breakdown ────────────────────────────────────────────────
    const agentBreakdown = { real_estate: 0, financial: 0, ad_placement: 0, logistics: 0, business_owner: 0, civic: 0, unknown: 0 };
    for (const e of evts30d) {
      const at = e.vertical || e.agent_type || 'unknown';
      if (agentBreakdown.hasOwnProperty(at)) {
        agentBreakdown[at]++;
      } else {
        agentBreakdown.unknown++;
      }
    }

    // ── Tidal state ─────────────────────────────────────────────────────────
    let tidalState;
    if (queries24h === 0) {
      tidalState = 'slack';
    } else if (avgDaily === 0) {
      tidalState = 'surging'; // any activity vs zero baseline is a surge
    } else {
      const ratio = queries24h / avgDaily;
      if (ratio >= 2.0)       tidalState = 'surging';
      else if (ratio >= 1.5)  tidalState = 'flooding';
      else if (ratio <= 0.5)  tidalState = 'receding';
      else                    tidalState = 'stable';
    }

    // ── Hotspot rank ────────────────────────────────────────────────────────
    const hotspotRank = rankMap[zip] || zipCount;

    // ── Build record ─────────────────────────────────────────────────────────
    const record = {
      zip,
      computed_at:            new Date().toISOString(),
      queries_24h:            queries24h,
      queries_30d:            queries30d,
      avg_daily_queries:      avgDaily,
      query_velocity_trend:   velocityTrend,
      peak_query_hour_utc:    peakHour,
      peak_query_day:         peakDay,
      top_demanded_category:  topCategory,
      agent_type_breakdown:   agentBreakdown,
      tidal_state:            tidalState,
      hotspot_rank:           hotspotRank,
    };

    try {
      await pgStore.upsertWaveSurface(zip, record);
    } catch (e) {
      console.log(`[waveSurfaceWorker] Postgres write failed for ${zip}: ${e.message}`);
    }

    console.log(
      `[waveSurfaceWorker] ${zip}: tidal=${tidalState} 24h=${queries24h} 30d=${queries30d}` +
      ` avg=${avgDaily}/d rank=${hotspotRank}`
    );
  }

  console.log(`[waveSurfaceWorker] Wave surface aggregation complete: ${zipCount} ZIPs, ${events.length} events.`);
}

// ── Error handling ────────────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  console.error('[waveSurfaceWorker] Uncaught exception:', err.message, err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('[waveSurfaceWorker] Unhandled rejection:', reason);
});

// ── Scheduler — runs at :05 each hour ────────────────────────────────────────

function scheduleNextRun() {
  const now        = new Date();
  const msUntil05  = (() => {
    const next = new Date(now);
    next.setMinutes(5, 0, 0);
    if (next <= now) next.setHours(next.getHours() + 1);
    return next.getTime() - now.getTime();
  })();

  setTimeout(() => {
    aggregateWaveSurface().catch(e => console.error("[waveSurface] run error:", e.message));
    // After first :05 hit, run every hour
    setInterval(() => {
      aggregateWaveSurface().catch(e => console.error("[waveSurface] run error:", e.message));
    }, INTERVAL_MS);
  }, msUntil05);

  console.log(`[waveSurfaceWorker] Next scheduled run in ${Math.round(msUntil05 / 1000)}s (at :05)`);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

console.log('[waveSurfaceWorker] Starting — Layer 3 Wave Surface worker');

// Run immediately on start
aggregateWaveSurface().catch(e => console.error("[waveSurface] run error:", e.message));

// Then schedule recurring runs at :05 each hour
scheduleNextRun();

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { appendEvent };
