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

const path = require('path');
const fs   = require('fs');

const DATA_DIR           = path.join(__dirname, '..', 'data');
const ZIPS_DIR           = path.join(DATA_DIR, 'zips');
const SURFACE_CURRENT_DIR = path.join(DATA_DIR, 'surface_current');

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

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Atomic write: write to .tmp then rename to final path.
 */
function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

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

  ensureDir(SURFACE_CURRENT_DIR);

  // ZIP discovery: Postgres first, flat file fallback for local dev
  let allZips = [];
  let usePostgres = false;
  if (process.env.LOCAL_INTEL_DB_URL) {
    try {
      const { getDistinctZips } = require('../lib/pgStore');
      allZips = await getDistinctZips();
      if (allZips.length > 0) {
        usePostgres = true;
        console.log(`[surfaceCurrentWorker] ZIP discovery: ${allZips.length} ZIPs from Postgres`);
      }
    } catch (e) {
      console.warn('[surfaceCurrentWorker] Postgres ZIP discovery failed, falling back to flat files:', e.message);
    }
  }
  if (!usePostgres) {
    try {
      allZips = fs.readdirSync(ZIPS_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''));
    } catch (e) {
      console.log('[surfaceCurrentWorker] No zips directory found or empty:', e.message);
    }
  }

  if (allZips.length === 0) {
    console.log('[surfaceCurrentWorker] No ZIPs to process.');
    return;
  }

  const now   = new Date();
  const month = now.getMonth() + 1; // 1-based
  const index = {};

  for (const zip of allZips) {
    const zipFilePath = path.join(ZIPS_DIR, `${zip}.json`);

    // ── Read businesses ──────────────────────────────────────────────────────
    // ── Read businesses — Postgres first, flat file fallback ──────────────────
    let businesses = [];
    const fileMtimeMs = Date.now();
    if (usePostgres) {
      try {
        const { getBusinessesByZip } = require('../lib/pgStore');
        const rows = await getBusinessesByZip(zip);
        businesses = Array.isArray(rows) ? rows : [];
      } catch (e) {
        console.log(`[surfaceCurrentWorker] Postgres read failed for ${zip}: ${e.message}`);
        continue;
      }
    } else {
      try {
        const raw = fs.readFileSync(zipFilePath, 'utf8');
        businesses = JSON.parse(raw);
        if (!Array.isArray(businesses)) businesses = [];
      } catch (e) {
        console.log(`[surfaceCurrentWorker] Could not read flat file for ${zip}: ${e.message}`);
        continue;
      }
    }

    const currentCount = businesses.length;

    // ── Apply confidence decay ───────────────────────────────────────────────
    businesses = applyConfidenceDecay(businesses);

    // Write updated businesses back — Postgres if available, flat file fallback
    if (usePostgres) {
      try {
        const db2 = require('../lib/db');
        for (const biz of businesses) {
          await db2.upsertBusiness({ ...biz, source_id: biz.primary_source || 'surface' }).catch(() => {});
        }
      } catch (e) {
        console.log(`[surfaceCurrentWorker] Postgres write-back failed for ${zip}: ${e.message}`);
      }
    } else {
      try { atomicWrite(zipFilePath, businesses); } catch (e) {
        console.log(`[surfaceCurrentWorker] Could not write back flat file for ${zip}: ${e.message}`);
      }
    }

    // ── Load previous snapshot ───────────────────────────────────────────────
    const prevFilePath = path.join(SURFACE_CURRENT_DIR, `${zip}_prev.json`);
    let prevSnapshot = null;
    try {
      if (fs.existsSync(prevFilePath)) {
        prevSnapshot = JSON.parse(fs.readFileSync(prevFilePath, 'utf8'));
      }
    } catch (e) {
      console.log(`[surfaceCurrentWorker] Could not read prev snapshot for ${zip}: ${e.message}`);
    }

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

    // ── Write surface_current/{zip}.json ─────────────────────────────────────
    const outPath = path.join(SURFACE_CURRENT_DIR, `${zip}.json`);
    try {
      atomicWrite(outPath, record);
    } catch (e) {
      console.log(`[surfaceCurrentWorker] Could not write ${zip}.json: ${e.message}`);
    }

    // ── Take snapshot for next run ────────────────────────────────────────────
    const snapshot = {
      zip,
      snapshotAt:    now.toISOString(),
      businessCount: currentCount,
      businessIds:   businesses.map(b => b.id || b.place_id || b.name).filter(Boolean),
    };
    try {
      atomicWrite(prevFilePath, snapshot);
    } catch (e) {
      console.log(`[surfaceCurrentWorker] Could not write prev snapshot for ${zip}: ${e.message}`);
    }

    index[zip] = {
      zip,
      computed_at:        record.computed_at,
      velocity_score:     velocityScore,
      current_direction:  currentDirection,
      net_change_30d:     netChange,
      data_freshness_grade: dataFreshnessGrade,
      seasonal_bias,
      seasonal_index,
    };

    console.log(
      `[surfaceCurrentWorker] ${zip}: direction=${currentDirection} velocity=${velocityScore}` +
      ` births=${birthRate} deaths=${deathRate} freshness=${dataFreshnessGrade}`
    );
  }

  // ── Write _index.json ─────────────────────────────────────────────────────
  const indexPath = path.join(SURFACE_CURRENT_DIR, '_index.json');
  try {
    atomicWrite(indexPath, {
      generated_at: now.toISOString(),
      zip_count:    Object.keys(index).length,
      zips:         index,
    });
    console.log(`[surfaceCurrentWorker] Index written: ${Object.keys(index).length} ZIPs`);
  } catch (e) {
    console.log('[surfaceCurrentWorker] Could not write _index.json:', e.message);
  }

  console.log('[surfaceCurrentWorker] Surface current computation complete.');
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
ensureDir(SURFACE_CURRENT_DIR);

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
