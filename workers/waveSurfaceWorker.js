/**
 * waveSurfaceWorker.js
 *
 * Layer 3 — WAVE SURFACE
 * Hourly aggregation of MCP query events per ZIP code.
 *
 * Reads:   data/wave_surface/_events.jsonl  (append-only log written by mcpMiddleware)
 * Writes:  data/wave_surface/{zip}.json
 *          data/wave_surface/_index.json
 * Prunes:  _events.jsonl to last 35 days
 *
 * Also exports appendEvent(event) for use by mcpMiddleware.js.
 *
 * Runs on start, then every hour at :05.
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const DATA_DIR        = path.join(__dirname, '..', 'data');
const WAVE_DIR        = path.join(DATA_DIR, 'wave_surface');
const EVENTS_FILE     = path.join(WAVE_DIR, '_events.jsonl');

const INTERVAL_MS     = 60 * 60 * 1000; // 1 hour

const KEEP_DAYS_PRUNE = 35;
const WINDOW_24H_MS   = 24 * 60 * 60 * 1000;
const WINDOW_30D_MS   = 30 * 24 * 60 * 60 * 1000;

// Valid agent types
const AGENT_TYPES = ['real_estate', 'financial', 'ad_placement', 'logistics', 'business_owner', 'civic'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Atomic write: write to .tmp then rename.
 */
function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Read all events from _events.jsonl. Returns array of parsed event objects.
 * Silently skips malformed lines.
 */
function readAllEvents() {
  if (!fs.existsSync(EVENTS_FILE)) return [];

  const lines = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n');
  const events = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch (e) {
      // Skip malformed line
    }
  }

  return events;
}

/**
 * Prune _events.jsonl: keep only events from the last KEEP_DAYS_PRUNE days.
 * Rewrites the file atomically.
 */
function pruneEvents(events) {
  const cutoff = Date.now() - KEEP_DAYS_PRUNE * 24 * 60 * 60 * 1000;
  const kept = events.filter(e => {
    const ts = e.ts ? new Date(e.ts).getTime() : 0;
    return ts >= cutoff;
  });

  if (kept.length === events.length) return kept; // nothing to prune

  const tmp = EVENTS_FILE + '.tmp';
  const lines = kept.map(e => JSON.stringify(e)).join('\n') + (kept.length > 0 ? '\n' : '');
  fs.writeFileSync(tmp, lines, 'utf8');
  fs.renameSync(tmp, EVENTS_FILE);

  console.log(`[waveSurfaceWorker] Pruned events: ${events.length} → ${kept.length} (kept last ${KEEP_DAYS_PRUNE}d)`);
  return kept;
}

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
 * Append a single query event to _events.jsonl.
 * Non-blocking — uses appendFileSync in try/catch, never throws.
 *
 * @param {object} event - { zip, tool, agent_type, lat, lon, agent_id }
 */
function appendEvent(event) {
  try {
    ensureDir(WAVE_DIR);
    const line = JSON.stringify({
      ts:         new Date().toISOString(),
      zip:        event.zip        || null,
      tool:       event.tool       || null,
      agent_type: event.agent_type || 'unknown',
      lat:        event.lat        || null,
      lon:        event.lon        || null,
      agent_id:   event.agent_id   || null,
    }) + '\n';
    fs.appendFileSync(EVENTS_FILE, line, 'utf8');
  } catch (e) {
    // Intentionally swallowed — never throw from appendEvent
  }
}

// ── Main aggregation ──────────────────────────────────────────────────────────

function aggregateWaveSurface() {
  console.log('[waveSurfaceWorker] Starting wave surface aggregation...');

  ensureDir(WAVE_DIR);

  // Read and prune events
  let events = readAllEvents();
  events = pruneEvents(events);

  if (events.length === 0) {
    console.log('[waveSurfaceWorker] No events to aggregate.');
    // Write empty index
    try {
      atomicWrite(path.join(WAVE_DIR, '_index.json'), {
        generated_at: new Date().toISOString(),
        total_events: 0,
        zip_count:    0,
        zips:         {},
      });
    } catch (e) {
      console.log('[waveSurfaceWorker] Could not write empty _index.json:', e.message);
    }
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
  const indexZips = {};

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
      const at = e.agent_type || 'unknown';
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

    // Write per-ZIP file
    const outPath = path.join(WAVE_DIR, `${zip}.json`);
    try {
      atomicWrite(outPath, record);
    } catch (e) {
      console.log(`[waveSurfaceWorker] Could not write ${zip}.json: ${e.message}`);
    }

    indexZips[zip] = {
      zip,
      computed_at:          record.computed_at,
      queries_24h:          queries24h,
      queries_30d:          queries30d,
      avg_daily_queries:    avgDaily,
      tidal_state:          tidalState,
      hotspot_rank:         hotspotRank,
      query_velocity_trend: velocityTrend,
    };

    console.log(
      `[waveSurfaceWorker] ${zip}: tidal=${tidalState} 24h=${queries24h} 30d=${queries30d}` +
      ` avg=${avgDaily}/d rank=${hotspotRank}`
    );
  }

  // ── Write _index.json ─────────────────────────────────────────────────────
  const indexPath = path.join(WAVE_DIR, '_index.json');
  try {
    atomicWrite(indexPath, {
      generated_at: new Date().toISOString(),
      total_events: events.length,
      zip_count:    zipCount,
      zips:         indexZips,
    });
    console.log(`[waveSurfaceWorker] Index written: ${zipCount} ZIPs, ${events.length} total events`);
  } catch (e) {
    console.log('[waveSurfaceWorker] Could not write _index.json:', e.message);
  }

  console.log('[waveSurfaceWorker] Wave surface aggregation complete.');
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
    aggregateWaveSurface();
    // After first :05 hit, run every hour
    setInterval(() => {
      aggregateWaveSurface();
    }, INTERVAL_MS);
  }, msUntil05);

  console.log(`[waveSurfaceWorker] Next scheduled run in ${Math.round(msUntil05 / 1000)}s (at :05)`);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

console.log('[waveSurfaceWorker] Starting — Layer 3 Wave Surface worker');
ensureDir(WAVE_DIR);

// Run immediately on start
aggregateWaveSurface();

// Then schedule recurring runs at :05 each hour
scheduleNextRun();

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { appendEvent };
