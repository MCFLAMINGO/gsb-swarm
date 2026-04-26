'use strict';
/**
 * lib/pgStore.js
 * Postgres-backed store for all flywheel data.
 * Replaces flat JSON files that were wiped on Railway restarts.
 *
 * Tables created on first use (idempotent):
 *   mcp_probe_log      — mcpProbeWorker query scores
 *   router_learning    — routerLearningWorker patch history + score trends
 *   router_patches     — individual VERTICAL_SIGNALS patches (applied on boot)
 *   zip_coverage       — which ZIPs have been processed + when
 *   zip_queue          — ZIP processing queue
 */

const db = require('./db');

// ── Schema ────────────────────────────────────────────────────────────────────
const SCHEMA = `
  -- Phase 2: computed intel tables
  CREATE TABLE IF NOT EXISTS zip_intelligence (
    zip                      TEXT PRIMARY KEY,
    name                     TEXT,
    state                    TEXT DEFAULT 'FL',
    population               INT,
    median_household_income  INT,
    median_home_value        INT,
    owner_occupied_pct       FLOAT,
    total_households         INT,
    wfh_pct                  FLOAT,
    affluence_pct            FLOAT,
    ultra_affluence_pct      FLOAT,
    retiree_index            FLOAT,
    new_build_pct            FLOAT,
    age_25_34_pct            FLOAT,
    age_35_54_pct            FLOAT,
    age_55_plus_pct          FLOAT,
    vacancy_rate_pct         FLOAT,
    family_hh_pct            FLOAT,
    restaurant_count         INT,
    total_businesses         INT,
    gap_count                INT,
    saturation_status        TEXT,
    growth_state             TEXT,
    consumer_profile         TEXT,
    oracle_json              JSONB,
    market_opportunity_score FLOAT,
    residential_score        FLOAT,
    dominant_sector          TEXT,
    business_density         FLOAT,
    sector_counts            JSONB,
    computed_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at               TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS bedrock_scores (
    zip         TEXT PRIMARY KEY,
    name        TEXT,
    lat         FLOAT,
    lon         FLOAT,
    score_json  JSONB,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS ocean_floor (
    zip                       TEXT PRIMARY KEY,
    consumer_profile          TEXT,
    carrying_capacity_score   FLOAT,
    market_saturation_index   FLOAT,
    census_json               JSONB,
    missing_sectors           JSONB,
    updated_at                TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS census_layer (
    zip         TEXT PRIMARY KEY,
    layer_json  JSONB,
    confidence  JSONB,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS acs_demographics (
    zip                  TEXT PRIMARY KEY,
    population           INT,
    total_households     INT,
    wfh_pct              FLOAT,
    affluence_pct        FLOAT,
    ultra_affluence_pct  FLOAT,
    median_home_value    INT,
    retiree_index        FLOAT,
    owner_occupied_pct   FLOAT,
    consumer_profile     TEXT,
    raw_json             JSONB,
    updated_at           TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS mcp_probe_log (
    id          BIGSERIAL PRIMARY KEY,
    ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    persona     TEXT,
    role        TEXT,
    tool        TEXT,
    zip         TEXT,
    name        TEXT,
    query       TEXT,
    score       INT,
    reason      TEXT,
    latency_ms  INT,
    answer_length INT,
    answer_snippet TEXT,
    http_status INT,
    error       TEXT,
    expected_vertical TEXT,
    detected_vertical TEXT,
    vertical_density  FLOAT
  );

  CREATE TABLE IF NOT EXISTS router_learning (
    id          BIGSERIAL PRIMARY KEY,
    ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cycle       INT,
    vertical    TEXT,
    log_entries INT,
    failures    INT,
    patches_applied INT,
    score_trends JSONB,
    run_record  JSONB
  );

  CREATE TABLE IF NOT EXISTS router_patches (
    id          BIGSERIAL PRIMARY KEY,
    ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    vertical    TEXT NOT NULL,
    term        TEXT NOT NULL,
    evidence    JSONB,
    score_before INT,
    score_after  INT,
    delta        INT,
    applied_to_file BOOLEAN DEFAULT FALSE,
    UNIQUE(vertical, term)
  );

  CREATE TABLE IF NOT EXISTS zip_coverage (
    zip           TEXT PRIMARY KEY,
    last_processed TIMESTAMPTZ,
    worker        TEXT,
    record_count  INT DEFAULT 0,
    status        TEXT DEFAULT 'pending',
    updated_at    TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS zip_queue (
    zip       TEXT PRIMARY KEY,
    priority  INT DEFAULT 0,
    queued_at TIMESTAMPTZ DEFAULT NOW(),
    source    TEXT
  );
`;

let _initialized = false;

async function ensureSchema() {
  if (_initialized) return;
  if (!db.isReady()) return;
  try {
    await db.query(SCHEMA);
    _initialized = true;
  } catch (e) {
    console.error('[pgStore] Schema init error:', e.message);
  }
}

// ── mcp_probe_log ─────────────────────────────────────────────────────────────

async function appendProbeLog(entry) {
  await ensureSchema();
  if (!db.isReady()) return;
  try {
    await db.query(
      `INSERT INTO mcp_probe_log
        (ts, persona, role, tool, zip, name, query, score, reason,
         latency_ms, answer_length, answer_snippet, http_status, error,
         expected_vertical, detected_vertical, vertical_density)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        entry.ts || new Date().toISOString(),
        entry.persona, entry.role, entry.tool,
        entry.zip, entry.name, entry.query,
        entry.score, entry.reason,
        entry.latency_ms, entry.answer_length,
        entry.answer_snippet ? entry.answer_snippet.slice(0, 500) : null,
        entry.http_status, entry.error,
        entry.expected_vertical, entry.detected_vertical,
        entry.vertical_density,
      ]
    );
  } catch (e) {
    console.error('[pgStore] appendProbeLog error:', e.message);
  }
}

async function getProbeLog(limit = 500) {
  await ensureSchema();
  if (!db.isReady()) return [];
  try {
    return await db.query(
      `SELECT * FROM mcp_probe_log ORDER BY ts DESC LIMIT $1`, [limit]
    );
  } catch (e) {
    console.error('[pgStore] getProbeLog error:', e.message);
    return [];
  }
}

async function getProbeLogForLearning(limit = 200) {
  await ensureSchema();
  if (!db.isReady()) return [];
  try {
    // Return recent entries in ascending order for routerLearningWorker
    return await db.query(
      `SELECT * FROM (
         SELECT * FROM mcp_probe_log ORDER BY ts DESC LIMIT $1
       ) sub ORDER BY ts ASC`,
      [limit]
    );
  } catch (e) {
    console.error('[pgStore] getProbeLogForLearning error:', e.message);
    return [];
  }
}

// ── router_learning ───────────────────────────────────────────────────────────

async function saveRouterRun(runRecord) {
  await ensureSchema();
  if (!db.isReady()) return;
  try {
    await db.query(
      `INSERT INTO router_learning
        (ts, cycle, vertical, log_entries, failures, patches_applied, score_trends, run_record)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        runRecord.ts || new Date().toISOString(),
        runRecord.cycle,
        runRecord.vertical || null,
        runRecord.log_entries,
        runRecord.failures_found,
        runRecord.patches?.reduce((s, p) => s + p.terms.length, 0) || 0,
        JSON.stringify(runRecord.score_trends || {}),
        JSON.stringify(runRecord),
      ]
    );
  } catch (e) {
    console.error('[pgStore] saveRouterRun error:', e.message);
  }
}

async function getRouterLearning() {
  await ensureSchema();
  if (!db.isReady()) return null;
  try {
    const rows = await db.query(
      `SELECT run_record FROM router_learning ORDER BY ts DESC LIMIT 100`
    );
    // Reconstruct the legacy object shape routerLearningWorker expects
    const runs = rows.map(r => r.run_record);
    const patches = runs.flatMap(r => r.patches || []);
    const score_trend = rows.map(r => ({
      ts: r.run_record?.ts,
      trends: r.run_record?.score_trends,
    }));
    return { runs, patches, score_trend, total_patches_applied: patches.length };
  } catch (e) {
    console.error('[pgStore] getRouterLearning error:', e.message);
    return null;
  }
}

// ── router_patches (survive deploys) ─────────────────────────────────────────

async function saveRouterPatch(vertical, terms, evidence, scoreBefore, scoreAfter) {
  await ensureSchema();
  if (!db.isReady()) return;
  try {
    for (const term of terms) {
      await db.query(
        `INSERT INTO router_patches (vertical, term, evidence, score_before, score_after, delta)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (vertical, term) DO UPDATE SET
           score_after = $5, delta = $6, ts = NOW()`,
        [vertical, term, JSON.stringify(evidence || []),
         scoreBefore, scoreAfter, (scoreAfter || 0) - (scoreBefore || 0)]
      );
    }
  } catch (e) {
    console.error('[pgStore] saveRouterPatch error:', e.message);
  }
}

async function getRouterPatches() {
  await ensureSchema();
  if (!db.isReady()) return {};
  try {
    const rows = await db.query(
      `SELECT vertical, array_agg(term) as terms FROM router_patches GROUP BY vertical`
    );
    const result = {};
    for (const row of rows) result[row.vertical] = row.terms;
    return result;
  } catch (e) {
    console.error('[pgStore] getRouterPatches error:', e.message);
    return {};
  }
}

// ── zip_coverage ──────────────────────────────────────────────────────────────

async function markZipProcessed(zip, worker, recordCount) {
  await ensureSchema();
  if (!db.isReady()) return;
  try {
    await db.query(
      `INSERT INTO zip_coverage (zip, last_processed, worker, record_count, status, updated_at)
       VALUES ($1, NOW(), $2, $3, 'done', NOW())
       ON CONFLICT (zip) DO UPDATE SET
         last_processed = NOW(), worker = $2,
         record_count = $3, status = 'done', updated_at = NOW()`,
      [zip, worker, recordCount || 0]
    );
  } catch (e) {
    console.error('[pgStore] markZipProcessed error:', e.message);
  }
}

async function getZipCoverage() {
  await ensureSchema();
  if (!db.isReady()) return {};
  try {
    const rows = await db.query(`SELECT zip, last_processed, worker, record_count, status FROM zip_coverage`);
    const result = {};
    for (const r of rows) result[r.zip] = r;
    return result;
  } catch (e) {
    console.error('[pgStore] getZipCoverage error:', e.message);
    return {};
  }
}

async function isZipProcessed(zip) {
  await ensureSchema();
  if (!db.isReady()) return false;
  try {
    const row = await db.queryOne(
      `SELECT status FROM zip_coverage WHERE zip = $1 AND status = 'done'`, [zip]
    );
    return Boolean(row);
  } catch (e) {
    return false;
  }
}

// ── zip_queue ─────────────────────────────────────────────────────────────────

async function enqueueZips(zips, source = 'auto', priority = 0) {
  await ensureSchema();
  if (!db.isReady()) return;
  try {
    for (const zip of zips) {
      await db.query(
        `INSERT INTO zip_queue (zip, priority, source, queued_at)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (zip) DO UPDATE SET priority = GREATEST(zip_queue.priority, $2), source = $3`,
        [zip, priority, source]
      );
    }
  } catch (e) {
    console.error('[pgStore] enqueueZips error:', e.message);
  }
}

async function dequeueZips(limit = 10) {
  await ensureSchema();
  if (!db.isReady()) return [];
  try {
    const rows = await db.query(
      `DELETE FROM zip_queue WHERE zip IN (
         SELECT zip FROM zip_queue ORDER BY priority DESC, queued_at ASC LIMIT $1
       ) RETURNING zip, priority, source`,
      [limit]
    );
    return rows.map(r => r.zip);
  } catch (e) {
    console.error('[pgStore] dequeueZips error:', e.message);
    return [];
  }
}

async function getQueueLength() {
  await ensureSchema();
  if (!db.isReady()) return 0;
  try {
    const row = await db.queryOne(`SELECT COUNT(*) as count FROM zip_queue`);
    return parseInt(row?.count || 0);
  } catch (e) {
    return 0;
  }
}

// ── Phase 2: computed intel upserts ──────────────────────────────────────────

async function upsertBedrockScore(zip, result) {
  await ensureSchema();
  if (!db.isReady()) return;
  try {
    await db.query(
      `INSERT INTO bedrock_scores (zip, name, lat, lon, score_json, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (zip) DO UPDATE SET
         name       = EXCLUDED.name,
         lat        = EXCLUDED.lat,
         lon        = EXCLUDED.lon,
         score_json = EXCLUDED.score_json,
         updated_at = NOW()`,
      [zip, result.name || null, result.lat || null, result.lon || null,
       JSON.stringify(result)]
    );
  } catch (e) {
    console.error('[pgStore] upsertBedrockScore error:', e.message);
  }
}

async function upsertOceanFloor(zip, result) {
  await ensureSchema();
  if (!db.isReady()) return;
  try {
    await db.query(
      `INSERT INTO ocean_floor
         (zip, consumer_profile, carrying_capacity_score, market_saturation_index,
          census_json, missing_sectors, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (zip) DO UPDATE SET
         consumer_profile        = EXCLUDED.consumer_profile,
         carrying_capacity_score = EXCLUDED.carrying_capacity_score,
         market_saturation_index = EXCLUDED.market_saturation_index,
         census_json             = EXCLUDED.census_json,
         missing_sectors         = EXCLUDED.missing_sectors,
         updated_at              = NOW()`,
      [
        zip,
        result.consumer_profile || null,
        result.carrying_capacity_score || null,
        result.market_saturation_index || null,
        JSON.stringify(result),
        JSON.stringify(result.missing_sectors || []),
      ]
    );
  } catch (e) {
    console.error('[pgStore] upsertOceanFloor error:', e.message);
  }
}

async function upsertCensusLayer(zip, layerData, confidence) {
  await ensureSchema();
  if (!db.isReady()) return;
  try {
    await db.query(
      `INSERT INTO census_layer (zip, layer_json, confidence, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (zip) DO UPDATE SET
         layer_json = EXCLUDED.layer_json,
         confidence = EXCLUDED.confidence,
         updated_at = NOW()`,
      [zip, JSON.stringify(layerData), confidence ? JSON.stringify(confidence) : null]
    );
  } catch (e) {
    console.error('[pgStore] upsertCensusLayer error:', e.message);
  }
}

async function upsertAcsDemographics(zip, result) {
  await ensureSchema();
  if (!db.isReady()) return;
  try {
    await db.query(
      `INSERT INTO acs_demographics
         (zip, population, total_households, wfh_pct, affluence_pct,
          ultra_affluence_pct, median_home_value, retiree_index,
          owner_occupied_pct, consumer_profile, raw_json, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT (zip) DO UPDATE SET
         population          = EXCLUDED.population,
         total_households    = EXCLUDED.total_households,
         wfh_pct             = EXCLUDED.wfh_pct,
         affluence_pct       = EXCLUDED.affluence_pct,
         ultra_affluence_pct = EXCLUDED.ultra_affluence_pct,
         median_home_value   = EXCLUDED.median_home_value,
         retiree_index       = EXCLUDED.retiree_index,
         owner_occupied_pct  = EXCLUDED.owner_occupied_pct,
         consumer_profile    = EXCLUDED.consumer_profile,
         raw_json            = EXCLUDED.raw_json,
         updated_at          = NOW()`,
      [
        zip,
        result.population || null,
        result.total_households || null,
        result.wfh_pct || null,
        result.affluence_pct || null,
        result.ultra_affluence_pct || null,
        result.median_home_value || null,
        result.retiree_index || null,
        result.owner_occupied_pct || null,
        result.consumer_profile || null,
        JSON.stringify(result),
      ]
    );
  } catch (e) {
    console.error('[pgStore] upsertAcsDemographics error:', e.message);
  }
}

async function getAcsDemographics(zip) {
  await ensureSchema();
  if (!db.isReady()) return null;  // DB not configured — caller handles null
  // NOTE: intentionally NOT catching errors here.
  // If Postgres throws, we let it propagate so the oracle's ZIP-level
  // try/catch can log it and skip that ZIP — no silent bad data.
  const row = await db.queryOne(
    'SELECT raw_json FROM acs_demographics WHERE zip = $1', [zip]
  );
  return row?.raw_json || null;  // null = no row found (ACS hasn't run for this ZIP)
}

async function getCensusLayer(zip) {
  await ensureSchema();
  if (!db.isReady()) return null;
  try {
    const row = await db.queryOne(
      'SELECT layer_json, confidence FROM census_layer WHERE zip = $1', [zip]
    );
    if (!row) return null;
    return { ...(row.layer_json || {}), _confidence: row.confidence || null };
  } catch (e) {
    console.error('[pgStore] getCensusLayer error:', e.message);
    return null;
  }
}

async function getZipIntelligence(zip) {
  await ensureSchema();
  if (!db.isReady()) return null;
  try {
    const row = await db.queryOne(
      'SELECT oracle_json FROM zip_intelligence WHERE zip = $1', [zip]
    );
    return row?.oracle_json || null;
  } catch (e) {
    console.error('[pgStore] getZipIntelligence error:', e.message);
    return null;
  }
}

// ── Bulk oracle reads — replace data/oracle/*.json everywhere ────────────────
// Returns Map<zip, oracle_json> for all ZIPs that have been computed.
async function getZipIntelligenceAll() {
  await ensureSchema();
  if (!db.isReady()) return new Map();
  const rows = await db.query(
    'SELECT zip, oracle_json, computed_at FROM zip_intelligence WHERE oracle_json IS NOT NULL'
  );
  const map = new Map();
  for (const r of rows) map.set(r.zip, { ...(r.oracle_json || {}), computed_at: r.computed_at });
  return map;
}

// Returns a single oracle_json row for a ZIP, or null if not found.
async function getZipIntelligenceRow(zip) {
  await ensureSchema();
  if (!db.isReady()) return null;
  const row = await db.queryOne(
    'SELECT zip, oracle_json, computed_at, wfh_pct, affluence_pct, population, median_household_income FROM zip_intelligence WHERE zip = $1',
    [zip]
  );
  if (!row) return null;
  return {
    ...(row.oracle_json || {}),
    // Ensure top-level demographic fields are available even if oracle_json is sparse
    _wfh_pct:    row.wfh_pct,
    _affluence:  row.affluence_pct,
    _population: row.population,
    _median_hhi: row.median_household_income,
    computed_at: row.computed_at,
  };
}

// ── ZIP discovery — replaces readdirSync(data/zips/) everywhere ────────────────
// Returns array of ZIP strings: ['32082','32081',...]
// Falls back to empty array if DB not ready (local dev without DB).
async function getDistinctZips() {
  await ensureSchema();
  if (!db.isReady()) return [];
  const rows = await db.query(
    'SELECT DISTINCT zip FROM businesses WHERE zip IS NOT NULL ORDER BY zip'
  );
  return rows.map(r => r.zip);
}

// Returns businesses array for a ZIP from Postgres.
// Shape matches what flat files stored: array of business objects.
// Returns null if DB not available (caller can fall back to flat file for local dev).
// Throws on DB error (caller should catch per-ZIP).
async function getBusinessesByZip(zip) {
  await ensureSchema();
  if (!db.isReady()) return null;
  const rows = await db.query(
    `SELECT business_id, name, zip, address, city, phone, website, hours,
            category, category_group, status, lat, lon,
            confidence_score, tags, description, sources,
            primary_source, registered_date, sunbiz_doc_number,
            sunbiz_entity_type, sunbiz_status, sunbiz_agent_name,
            last_confirmed, created_at, updated_at
     FROM businesses WHERE zip = $1 ORDER BY name`, [zip]
  );
  return rows;  // already plain objects matching column names
}

module.exports = {
  ensureSchema,
  // probe log
  appendProbeLog,
  getProbeLog,
  getProbeLogForLearning,
  // router learning
  saveRouterRun,
  getRouterLearning,
  // router patches
  saveRouterPatch,
  getRouterPatches,
  // zip coverage
  markZipProcessed,
  getZipCoverage,
  isZipProcessed,
  // zip queue
  enqueueZips,
  dequeueZips,
  getQueueLength,
  // Phase 2: computed intel
  upsertBedrockScore,
  upsertOceanFloor,
  upsertCensusLayer,
  upsertAcsDemographics,
  getAcsDemographics,
  getCensusLayer,
  getZipIntelligence,
  // ZIP discovery + business reads (replaces flat-file readdirSync)
  getDistinctZips,
  getBusinessesByZip,
  // Bulk oracle reads — replaces flat file loops
  getZipIntelligenceAll,
  getZipIntelligenceRow,
};
