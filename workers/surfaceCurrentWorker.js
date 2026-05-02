/**
 * surfaceCurrentWorker.js
 *
 * Layer 2 — SURFACE CURRENT
 * Daily computation of business churn dynamics per ZIP code.
 *
 * Reads:   data/zips/{zip}.json          (business POI files from ZipAgent)
 *          data/surface_current/{zip}_prev.json  (previous snapshot for delta)
 * Writes:  data/surface_current/{zip}.json
 *          data/surface_current/_index.json
 *          data/surface_current/{zip}_prev.json  (snapshot for next run)
 *
 * Applies confidence decay to businesses in each ZIP file and writes them back.
 * Runs on start, then every 24 hours.
 */

'use strict';

const pgStore = require('../lib/pgStore');

const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Florida coastal ZIPs that get the coastal seasonal_index bonus ────────────
const COASTAL_ZIPS = new Set(['32082', '32080', '32084']);

// ── Expected category counts by population tier ──────────────────────────────
// These are rough baselines; gap = categories missing out of EXPECTED_CATEGORIES
const EXPECTED_CATEGORIES = [
  'restaurant', 'grocery', 'gas_station', 'pharmacy', 'bank',
  'healthcare', 'school', 'park', 'retail', 'service',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Determine Florida seasonal values for a given month and ZIP.
 * Returns { seasonal_bias, seasonal_index }.
 */
function getSeasonalInfo(month, zip) {
  const coastal = COASTAL_ZIPS.has(zip);
  // month is 1-based (1 = January)
  let bias, index;

  if (month >= 1 && month <= 3) {
    // Jan–Mar: snowbird peak
    bias  = 'peak';
    index = coastal ? 1.3 : 1.1;
  } else if (month >= 4 && month <= 5) {
    // Apr–May: shoulder
    bias  = 'shoulder';
    index = 1.0;
  } else if (month >= 6 && month <= 8) {
    // Jun–Aug: summer family peak
    bias  = 'peak';
    index = 1.2;
  } else if (month >= 9 && month <= 11) {
    // Sep–Nov: off/shoulder
    bias  = 'off';
    index = 0.85;
  } else {
    // Dec: holiday shoulder
    bias  = 'shoulder';
    index = 1.1;
  }

  return { seasonal_bias: bias, seasonal_index: index };
}

/**
 * Compute data_freshness_grade based on file mtime.
 */
function freshnessGrade(mtimeMs) {
  const ageDays = (Date.now() - mtimeMs) / (1000 * 60 * 60 * 24);
  if (ageDays < 7)  return 'A';
  if (ageDays < 30) return 'B';
  if (ageDays < 90) return 'C';
  return 'D';
}

/**
 * Apply confidence decay in-place to an array of businesses.
 * Returns the mutated array.
 *
 * Rules:
 *   - If claimed === true: no decay (owner anchor).
 *   - Else if lastVerified is missing or > 90 days ago: confidence -= 2 (min 0).
 */
function applyConfidenceDecay(businesses) {
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const biz of businesses) {
    if (biz.claimed === true) continue; // owner-verified anchor, skip decay

    const lastVerified = biz.lastVerified ? new Date(biz.lastVerified).getTime() : null;
    const stale = !lastVerified || (now - lastVerified) > ninetyDaysMs;

    if (stale) {
      biz.confidence = Math.max(0, (biz.confidence || 0) - 2);
    }
  }

  return businesses;
}

/**
 * Determine category_gap_score: count of expected category types missing in
 * the business list for this ZIP.
 */
function computeCategoryGap(businesses) {
  const presentCategories = new Set(
    businesses
      .map(b => (b.category || b.type || '').toLowerCase())
      .filter(Boolean)
  );

  let gap = 0;
  for (const cat of EXPECTED_CATEGORIES) {
    // Check if any present category contains this keyword
    let found = false;
    for (const present of presentCategories) {
      if (present.includes(cat)) { found = true; break; }
    }
    if (!found) gap++;
  }
  return gap;
}

// ── Main computation ──────────────────────────────────────────────────────────

async function computeSurfaceCurrent() {
  console.log('[surfaceCurrentWorker] Starting surface current computation...');

  // ZIP discovery: Postgres only
  let allZips = [];
  try {
    allZips = await pgStore.getDistinctZips();
    console.log(`[surfaceCurrentWorker] ZIP discovery: ${allZips.length} ZIPs from Postgres`);
  } catch (e) {
    console.warn('[surfaceCurrentWorker] Postgres ZIP discovery failed:', e.message);
    return;
  }

  if (allZips.length === 0) {
    console.log('[surfaceCurrentWorker] No ZIPs to process.');
    return;
  }

  const now   = new Date();
  const month = now.getMonth() + 1; // 1-based
  let processed = 0;

  for (const zip of allZips) {
    // ── Read businesses from Postgres ──────────────────────────────────────────
    let businesses = [];
    const fileMtimeMs = Date.now();
    try {
      const rows = await pgStore.getBusinessesByZip(zip);
      businesses = Array.isArray(rows) ? rows : [];
    } catch (e) {
      console.log(`[surfaceCurrentWorker] Postgres read failed for ${zip}: ${e.message}`);
      continue;
    }

    const currentCount = businesses.length;

    // ── Apply confidence decay ───────────────────────────────────────────────
    businesses = applyConfidenceDecay(businesses);

    // Write updated businesses back to Postgres
    try {
      const dbLib = require('../lib/db');
      for (const biz of businesses) {
        await dbLib.upsertBusiness({ ...biz, source_id: biz.primary_source || 'surface' }).catch(() => {});
      }
    } catch (e) {
      console.log(`[surfaceCurrentWorker] Postgres write-back failed for ${zip}: ${e.message}`);
    }

    // ── Load previous snapshot from wave_surface ─────────────────────────────
    let prevSnapshot = null;
    try {
      const prev = await pgStore.getWaveSurface(zip);
      if (prev?._snapshot) prevSnapshot = prev._snapshot;
    } catch (_) { /* no prev */ }

    // ── Compute delta ────────────────────────────────────────────────────────
    let birthRate   = 0;
    let deathRate   = 0;
    let netChange   = 0;

    if (prevSnapshot) {
      const daysDiff = (Date.now() - new Date(prevSnapshot.snapshotAt).getTime()) / (1000 * 60 * 60 * 24);
      const scaleTo30 = daysDiff > 0 ? 30 / daysDiff : 1;

      const prevIds  = new Set((prevSnapshot.businessIds || []));
      const currIds  = new Set(businesses.map(b => b.id || b.place_id || b.name));

      // New businesses (present now, not in prev)
      let births = 0;
      for (const id of currIds) { if (!prevIds.has(id)) births++; }

      // Removed businesses (in prev, not present now)
      let deaths = 0;
      for (const id of prevIds) { if (!currIds.has(id)) deaths++; }

      birthRate = +(births * scaleTo30).toFixed(2);
      deathRate = +(deaths * scaleTo30).toFixed(2);
      netChange = +(birthRate - deathRate).toFixed(2);
    }

    // ── Velocity score (0-100) ───────────────────────────────────────────────
    // Higher churn in either direction = higher velocity.
    const totalChurn  = birthRate + deathRate;
    const velocityRaw = Math.min(100, totalChurn * 2); // 50 net changes/30d = 100
    const velocityScore = Math.round(velocityRaw);

    // ── Current direction ────────────────────────────────────────────────────
    let currentDirection;
    if (netChange > 1)       currentDirection = 'flooding';
    else if (netChange < -1) currentDirection = 'ebbing';
    else                     currentDirection = 'stable';

    // ── Seasonal info ────────────────────────────────────────────────────────
    const { seasonal_bias, seasonal_index } = getSeasonalInfo(month, zip);

    // ── Data freshness ───────────────────────────────────────────────────────
    const dataFreshnessGrade = freshnessGrade(fileMtimeMs);

    // ── Category gap ─────────────────────────────────────────────────────────
    const categoryGapScore = computeCategoryGap(businesses);

    // ── Build output record ──────────────────────────────────────────────────
    const record = {
      zip,
      computed_at:         now.toISOString(),
      business_count:      currentCount,
      velocity_score:      velocityScore,
      current_direction:   currentDirection,
      birth_rate:          birthRate,
      death_rate:          deathRate,
      net_change_30d:      netChange,
      data_freshness_grade: dataFreshnessGrade,
      category_gap_score:  categoryGapScore,
      seasonal_bias,
      seasonal_index,
      has_prev_snapshot:   prevSnapshot !== null,
    };

    // Take snapshot for next run — store inside surface_json
    const snapshot = {
      zip,
      snapshotAt:    now.toISOString(),
      businessCount: currentCount,
      businessIds:   businesses.map(b => b.id || b.place_id || b.name).filter(Boolean),
    };

    // ── Write to wave_surface (Postgres) ─────────────────────────────────────
    try {
      await pgStore.upsertWaveSurface(zip, { ...record, _snapshot: snapshot });
      processed++;
    } catch (e) {
      console.log(`[surfaceCurrentWorker] Could not upsert wave_surface for ${zip}: ${e.message}`);
    }

    console.log(
      `[surfaceCurrentWorker] ${zip}: direction=${currentDirection} velocity=${velocityScore}` +
      ` births=${birthRate} deaths=${deathRate} freshness=${dataFreshnessGrade}`
    );
  }

  console.log(`[surfaceCurrentWorker] Surface current complete. ${processed}/${allZips.length} ZIPs upserted to wave_surface`);
}

// ── Error handling ────────────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  console.error('[surfaceCurrentWorker] Uncaught exception:', err.message, err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('[surfaceCurrentWorker] Unhandled rejection:', reason);
});

// ── Scheduler ─────────────────────────────────────────────────────────────────

console.log('[surfaceCurrentWorker] Starting — Layer 2 Surface Current worker');

// Run immediately on start — skip if ran within 24h
(async () => {
  const hb = require('../lib/workerHeartbeat');
  if (await hb.isFresh('surfaceCurrentWorker', INTERVAL_MS)) {
    console.log('[surfaceCurrentWorker] Fresh — skipping startup run');
  } else {
    await computeSurfaceCurrent().catch(err => console.error('[surfaceCurrentWorker] Initial run error:', err.message));
    await hb.ping('surfaceCurrentWorker');
  }
  setInterval(async () => {
    await computeSurfaceCurrent().catch(err => console.error('[surfaceCurrentWorker] Scheduled run error:', err.message));
    await hb.ping('surfaceCurrentWorker');
  }, INTERVAL_MS);
})();
