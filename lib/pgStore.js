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

  CREATE TABLE IF NOT EXISTS wave_events (
    id          BIGSERIAL PRIMARY KEY,
    ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    zip         TEXT NOT NULL,
    tool        TEXT,
    agent_id    TEXT,
    vertical    TEXT,
    query       TEXT,
    score       INT,
    latency_ms  INT
  );
  CREATE INDEX IF NOT EXISTS wave_events_zip_ts ON wave_events (zip, ts DESC);
  CREATE INDEX IF NOT EXISTS wave_events_ts     ON wave_events (ts DESC);

  CREATE TABLE IF NOT EXISTS wave_surface (
    zip         TEXT PRIMARY KEY,
    surface_json JSONB NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS zip_enrichment (
    zip              TEXT PRIMARY KEY,
    irs_json         JSONB,
    osm_json         JSONB,
    irs_updated_at   TIMESTAMPTZ,
    osm_updated_at   TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS evolution_report (
    key         TEXT PRIMARY KEY,
    report_json JSONB NOT NULL,
    generated_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
  );


  CREATE TABLE IF NOT EXISTS agent_memory (
    agent_id         TEXT PRIMARY KEY,
    total_queries    INT NOT NULL DEFAULT 0,
    member_since     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    zip_visit_log    JSONB NOT NULL DEFAULT '[]',
    zip_frequency    JSONB NOT NULL DEFAULT '{}',
    zip_last_count   JSONB NOT NULL DEFAULT '{}',
    corridor_detected BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at       TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS inference_cache (
    zip         TEXT PRIMARY KEY,
    cache_json  JSONB NOT NULL DEFAULT '{"entries":[],"meta":{"total_entries":0,"avg_confidence":0,"last_sweep":null}}',
    updated_at  TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS zip_briefs (
    zip         TEXT PRIMARY KEY,
    brief_json  JSONB NOT NULL,
    generated_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS zip_queue (
    zip          TEXT PRIMARY KEY,
    priority     INT DEFAULT 0,
    queued_at    TIMESTAMPTZ DEFAULT NOW(),
    source       TEXT,
    state        TEXT,
    region       TEXT,
    name         TEXT,
    lat          DOUBLE PRECISION,
    lon          DOUBLE PRECISION,
    phase        INT DEFAULT 1,
    status       TEXT DEFAULT 'pending',
    attempts     INT DEFAULT 0,
    started_at   TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    last_error   TEXT
  );
  ALTER TABLE zip_queue ADD COLUMN IF NOT EXISTS state        TEXT;
  ALTER TABLE zip_queue ADD COLUMN IF NOT EXISTS region       TEXT;
  ALTER TABLE zip_queue ADD COLUMN IF NOT EXISTS name         TEXT;
  ALTER TABLE zip_queue ADD COLUMN IF NOT EXISTS lat          DOUBLE PRECISION;
  ALTER TABLE zip_queue ADD COLUMN IF NOT EXISTS lon          DOUBLE PRECISION;
  ALTER TABLE zip_queue ADD COLUMN IF NOT EXISTS phase        INT DEFAULT 1;
  ALTER TABLE zip_queue ADD COLUMN IF NOT EXISTS status       TEXT DEFAULT 'pending';
  ALTER TABLE zip_queue ADD COLUMN IF NOT EXISTS attempts     INT DEFAULT 0;
  ALTER TABLE zip_queue ADD COLUMN IF NOT EXISTS started_at   TIMESTAMPTZ;
  ALTER TABLE zip_queue ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
  ALTER TABLE zip_queue ADD COLUMN IF NOT EXISTS last_error   TEXT;

  CREATE TABLE IF NOT EXISTS rfq_gaps (
    vertical    TEXT NOT NULL,
    zip         TEXT NOT NULL,
    prompt      TEXT NOT NULL,
    tool        TEXT,
    score       INT,
    needs       TEXT,
    industry    TEXT,
    last_ts     TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (vertical, zip, prompt)
  );
  CREATE INDEX IF NOT EXISTS rfq_gaps_vertical ON rfq_gaps (vertical);
  CREATE INDEX IF NOT EXISTS rfq_gaps_zip      ON rfq_gaps (zip);

  CREATE TABLE IF NOT EXISTS source_log (
    id          BIGSERIAL PRIMARY KEY,
    zip         TEXT,
    source_name TEXT,
    status      TEXT,
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    detail      JSONB
  );
  CREATE INDEX IF NOT EXISTS source_log_zip      ON source_log (zip);
  CREATE INDEX IF NOT EXISTS source_log_fetched  ON source_log (fetched_at DESC);
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

// ── zip_queue full state (extended for zipCoordinatorWorker) ──────────────────
async function upsertZipQueueEntry(entry) {
  await ensureSchema();
  if (!db.isReady()) return;
  try {
    await db.query(
      `INSERT INTO zip_queue
         (zip, priority, source, state, region, name, lat, lon, phase, status, attempts,
          started_at, completed_at, last_error, queued_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,COALESCE($15,NOW()))
       ON CONFLICT (zip) DO UPDATE SET
         priority     = EXCLUDED.priority,
         source       = COALESCE(EXCLUDED.source, zip_queue.source),
         state        = COALESCE(EXCLUDED.state, zip_queue.state),
         region       = COALESCE(EXCLUDED.region, zip_queue.region),
         name         = COALESCE(EXCLUDED.name, zip_queue.name),
         lat          = COALESCE(EXCLUDED.lat, zip_queue.lat),
         lon          = COALESCE(EXCLUDED.lon, zip_queue.lon),
         phase        = COALESCE(EXCLUDED.phase, zip_queue.phase),
         status       = EXCLUDED.status,
         attempts     = EXCLUDED.attempts,
         started_at   = EXCLUDED.started_at,
         completed_at = EXCLUDED.completed_at,
         last_error   = EXCLUDED.last_error`,
      [
        entry.zip,
        entry.priority || 0,
        entry.source   || null,
        entry.state    || null,
        entry.region   || null,
        entry.name     || null,
        entry.lat      || null,
        entry.lon      || null,
        entry.phase    || 1,
        entry.status   || 'pending',
        entry.attempts || 0,
        entry.startedAt   ? new Date(entry.startedAt).toISOString()   : null,
        entry.completedAt ? new Date(entry.completedAt).toISOString() : null,
        entry.lastError || null,
        entry.queuedAt ? new Date(entry.queuedAt).toISOString() : null,
      ]
    );
  } catch (e) {
    console.error('[pgStore] upsertZipQueueEntry error:', e.message);
  }
}

async function getAllZipQueueEntries() {
  await ensureSchema();
  if (!db.isReady()) return [];
  try {
    const rows = await db.query(
      `SELECT zip, priority, source, state, region, name, lat, lon, phase, status, attempts,
              started_at, completed_at, last_error, queued_at
       FROM zip_queue ORDER BY priority DESC, queued_at ASC`
    );
    return rows.map(r => ({
      zip: r.zip,
      priority: r.priority || 0,
      source: r.source,
      state: r.state,
      region: r.region,
      name: r.name,
      lat: r.lat,
      lon: r.lon,
      phase: r.phase || 1,
      status: r.status || 'pending',
      attempts: r.attempts || 0,
      startedAt:   r.started_at,
      completedAt: r.completed_at,
      lastError:   r.last_error,
      queuedAt:    r.queued_at,
    }));
  } catch (e) {
    console.error('[pgStore] getAllZipQueueEntries error:', e.message);
    return [];
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

// ── Wave surface — Postgres-backed event log + aggregates ─────────────────────
async function appendWaveEvent(event) {
  await ensureSchema();
  if (!db.isReady()) return;
  await db.query(
    `INSERT INTO wave_events (ts, zip, tool, agent_id, vertical, query, score, latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [event.ts || new Date().toISOString(), event.zip, event.tool,
     event.agent_id, event.vertical, event.query, event.score, event.latency_ms]
  ).catch(e => console.warn('[pgStore] appendWaveEvent:', e.message));
}

async function getWaveEvents(sinceMs) {
  await ensureSchema();
  if (!db.isReady()) return [];
  const since = new Date(Date.now() - sinceMs).toISOString();
  return db.query(
    `SELECT ts, zip, tool, agent_id, vertical, query, score, latency_ms
     FROM wave_events WHERE ts >= $1 ORDER BY ts ASC`, [since]
  );
}

async function upsertWaveSurface(zip, record) {
  await ensureSchema();
  if (!db.isReady()) return;
  await db.query(
    `INSERT INTO wave_surface (zip, surface_json, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (zip) DO UPDATE
     SET surface_json = EXCLUDED.surface_json, updated_at = NOW()`,
    [zip, JSON.stringify(record)]
  ).catch(e => console.warn('[pgStore] upsertWaveSurface:', e.message));
}

async function getWaveSurface(zip) {
  await ensureSchema();
  if (!db.isReady()) return null;
  const row = await db.queryOne(
    'SELECT surface_json, updated_at FROM wave_surface WHERE zip = $1', [zip]
  );
  return row ? { ...(row.surface_json || {}), updated_at: row.updated_at } : null;
}

// ── ZIP enrichment — IRS SOI + OSM POIs per ZIP ───────────────────────────────
async function upsertZipEnrichment(zip, { irs, osm } = {}) {
  await ensureSchema();
  if (!db.isReady()) return;
  const sets = [], vals = [zip];
  if (irs !== undefined) { sets.push(`irs_json = $${vals.push(JSON.stringify(irs))}::jsonb, irs_updated_at = NOW()`); }
  if (osm !== undefined) { sets.push(`osm_json = $${vals.push(JSON.stringify(osm))}::jsonb, osm_updated_at = NOW()`); }
  if (!sets.length) return;
  await db.query(
    `INSERT INTO zip_enrichment (zip, ${irs!==undefined?'irs_json, irs_updated_at,':''} ${osm!==undefined?'osm_json, osm_updated_at,':''} updated_at)
     VALUES ($1, ${vals.slice(1).map((_,i)=>`$${i+2}::jsonb, NOW()`).join(', ')}, NOW())
     ON CONFLICT (zip) DO UPDATE SET ${sets.join(', ')}, updated_at = NOW()`,
    vals
  ).catch(() => {});
}

// Simpler targeted upserts
async function upsertIrsEnrichment(zip, irsData) {
  await ensureSchema();
  if (!db.isReady()) return;
  await db.query(
    `INSERT INTO zip_enrichment (zip, irs_json, irs_updated_at, updated_at)
     VALUES ($1, $2::jsonb, NOW(), NOW())
     ON CONFLICT (zip) DO UPDATE
     SET irs_json = EXCLUDED.irs_json, irs_updated_at = NOW(), updated_at = NOW()`,
    [zip, JSON.stringify(irsData)]
  ).catch(e => console.warn('[pgStore] upsertIrsEnrichment:', e.message));
}

async function upsertOsmEnrichment(zip, osmData) {
  await ensureSchema();
  if (!db.isReady()) return;
  await db.query(
    `INSERT INTO zip_enrichment (zip, osm_json, osm_updated_at, updated_at)
     VALUES ($1, $2::jsonb, NOW(), NOW())
     ON CONFLICT (zip) DO UPDATE
     SET osm_json = EXCLUDED.osm_json, osm_updated_at = NOW(), updated_at = NOW()`,
    [zip, JSON.stringify(osmData)]
  ).catch(e => console.warn('[pgStore] upsertOsmEnrichment:', e.message));
}

async function getZipEnrichment(zip) {
  await ensureSchema();
  if (!db.isReady()) return null;
  return db.queryOne('SELECT irs_json, osm_json, irs_updated_at, osm_updated_at FROM zip_enrichment WHERE zip = $1', [zip]);
}

// ── Evolution report — Postgres-backed, survives restarts ────────────────────
async function upsertEvolutionReport(report) {
  await ensureSchema();
  if (!db.isReady()) return;
  await db.query(
    `INSERT INTO evolution_report (key, report_json, generated_at, updated_at)
     VALUES ('latest', $1::jsonb, NOW(), NOW())
     ON CONFLICT (key) DO UPDATE
     SET report_json = EXCLUDED.report_json,
         generated_at = EXCLUDED.generated_at,
         updated_at   = NOW()`,
    [JSON.stringify(report)]
  );
}

async function getEvolutionReport() {
  await ensureSchema();
  if (!db.isReady()) return null;
  const row = await db.queryOne(
    `SELECT report_json, generated_at FROM evolution_report WHERE key = 'latest'`
  );
  if (!row) return null;
  return { ...(row.report_json || {}), _fetched_at: row.generated_at };
}

// ── ZIP discovery — replaces readdirSync(data/zips/) everywhere ────────────────
// Returns array of ZIP strings: ['32082','32081',...]
// Falls back to empty array if DB not ready (local dev without DB).
async function getDistinctZips() {
  await ensureSchema();
  if (!db.isReady()) return [];
  // Active states only — controlled by ACTIVE_STATES env var (default: FL)
  // Add new states in lib/stateConfig.js — no other changes needed
  const { activeZipSqlFilter } = require('./stateConfig');
  const rows = await db.query(
    `SELECT DISTINCT zip FROM businesses
     WHERE zip IS NOT NULL
       AND ${activeZipSqlFilter()}
     ORDER BY zip`
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


// ── agent_memory — per-agent Postgres-backed memory ──────────────────────────

async function upsertAgentMemory(mem) {
  await ensureSchema();
  if (!db.isReady()) return;
  try {
    await db.query(
      `INSERT INTO agent_memory
         (agent_id, total_queries, member_since, last_seen,
          zip_visit_log, zip_frequency, zip_last_count, corridor_detected, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,NOW())
       ON CONFLICT (agent_id) DO UPDATE SET
         total_queries     = EXCLUDED.total_queries,
         last_seen         = EXCLUDED.last_seen,
         zip_visit_log     = EXCLUDED.zip_visit_log,
         zip_frequency     = EXCLUDED.zip_frequency,
         zip_last_count    = EXCLUDED.zip_last_count,
         corridor_detected = EXCLUDED.corridor_detected,
         updated_at        = NOW()`,
      [
        mem.agentId,
        mem.total_queries || 0,
        mem.member_since  || new Date().toISOString(),
        mem.last_seen     || new Date().toISOString(),
        JSON.stringify(mem.zip_visit_log   || []),
        JSON.stringify(mem.zip_frequency   || {}),
        JSON.stringify(mem.zip_last_count  || {}),
        mem.corridor_detected || false,
      ]
    );
  } catch (e) {
    console.error('[pgStore] upsertAgentMemory error:', e.message);
  }
}

async function getAgentMemory(agentId) {
  await ensureSchema();
  if (!db.isReady()) return null;
  try {
    const row = await db.queryOne(
      `SELECT agent_id, total_queries, member_since, last_seen,
              zip_visit_log, zip_frequency, zip_last_count, corridor_detected
       FROM agent_memory WHERE agent_id = $1`, [agentId]
    );
    if (!row) return null;
    return {
      agentId:           row.agent_id,
      total_queries:     row.total_queries || 0,
      member_since:      row.member_since,
      last_seen:         row.last_seen,
      zip_visit_log:     row.zip_visit_log   || [],
      zip_frequency:     row.zip_frequency   || {},
      zip_last_count:    row.zip_last_count  || {},
      corridor_detected: row.corridor_detected || false,
    };
  } catch (e) {
    console.error('[pgStore] getAgentMemory error:', e.message);
    return null;
  }
}

async function listAgentMemories() {
  await ensureSchema();
  if (!db.isReady()) return [];
  try {
    return await db.query(
      `SELECT agent_id, total_queries, last_seen, corridor_detected
       FROM agent_memory ORDER BY last_seen DESC`
    );
  } catch (e) {
    console.error('[pgStore] listAgentMemories error:', e.message);
    return [];
  }
}

async function deleteOldAgentMemoryEntries(agentId, cutoffIso) {
  await ensureSchema();
  if (!db.isReady()) return;
  try {
    // Load, filter zip_visit_log, save back
    const mem = await getAgentMemory(agentId);
    if (!mem) return;
    const cutoff = new Date(cutoffIso).getTime();
    const before = mem.zip_visit_log.length;
    mem.zip_visit_log = mem.zip_visit_log.filter(e => {
      try { return new Date(e.ts).getTime() >= cutoff; } catch { return true; }
    });
    if (mem.zip_visit_log.length !== before) await upsertAgentMemory(mem);
  } catch (e) {
    console.error('[pgStore] deleteOldAgentMemoryEntries error:', e.message);
  }
}

// ── inference_cache — Postgres-backed prompt→answer cache per ZIP ─────────────

const INFERENCE_CACHE_DEFAULT = () => ({
  entries: [],
  meta: { total_entries: 0, avg_confidence: 0, last_sweep: null },
});

async function getInferenceCache(zip) {
  await ensureSchema();
  if (!db.isReady()) return null;
  try {
    const row = await db.queryOne(
      'SELECT cache_json FROM inference_cache WHERE zip = $1', [zip]
    );
    return row ? (row.cache_json || INFERENCE_CACHE_DEFAULT()) : null;
  } catch (e) {
    console.error('[pgStore] getInferenceCache error:', e.message);
    return null;
  }
}

async function upsertInferenceCache(zip, cacheData) {
  await ensureSchema();
  if (!db.isReady()) return;
  try {
    await db.query(
      `INSERT INTO inference_cache (zip, cache_json, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (zip) DO UPDATE
       SET cache_json = EXCLUDED.cache_json, updated_at = NOW()`,
      [zip, JSON.stringify(cacheData)]
    );
  } catch (e) {
    console.error('[pgStore] upsertInferenceCache error:', e.message);
  }
}

async function getAllInferenceCacheStats() {
  await ensureSchema();
  if (!db.isReady()) return [];
  try {
    return await db.query(
      'SELECT zip, cache_json, updated_at FROM inference_cache ORDER BY zip'
    );
  } catch (e) {
    console.error('[pgStore] getAllInferenceCacheStats error:', e.message);
    return [];
  }
}

// ── zip_briefs — brief narratives per ZIP, survive restarts ──────────────────

async function upsertZipBrief(zip, briefData) {
  await ensureSchema();
  if (!db.isReady()) return;
  try {
    await db.query(
      `INSERT INTO zip_briefs (zip, brief_json, generated_at, updated_at)
       VALUES ($1, $2::jsonb, NOW(), NOW())
       ON CONFLICT (zip) DO UPDATE
       SET brief_json   = EXCLUDED.brief_json,
           generated_at = NOW(),
           updated_at   = NOW()`,
      [zip, JSON.stringify(briefData)]
    );
  } catch (e) {
    console.error('[pgStore] upsertZipBrief error:', e.message);
  }
}

async function getZipBrief(zip) {
  await ensureSchema();
  if (!db.isReady()) return null;
  try {
    const row = await db.queryOne(
      'SELECT brief_json, generated_at FROM zip_briefs WHERE zip = $1', [zip]
    );
    if (!row) return null;
    return { ...(row.brief_json || {}), _stored_at: row.generated_at };
  } catch (e) {
    console.error('[pgStore] getZipBrief error:', e.message);
    return null;
  }
}

async function getAllZipBriefs() {
  await ensureSchema();
  if (!db.isReady()) return [];
  try {
    return await db.query(
      'SELECT zip, brief_json, generated_at FROM zip_briefs ORDER BY zip'
    );
  } catch (e) {
    console.error('[pgStore] getAllZipBriefs error:', e.message);
    return [];
  }
}

async function getZipBriefZips() {
  await ensureSchema();
  if (!db.isReady()) return [];
  try {
    const rows = await db.query('SELECT zip FROM zip_briefs ORDER BY zip');
    return rows.map(r => r.zip);
  } catch (e) {
    return [];
  }
}

// ── rfq_gaps — vertical agent gap log ────────────────────────────────────────
async function upsertRfqGap(gap) {
  await ensureSchema();
  if (!db.isReady()) return;
  try {
    await db.query(
      `INSERT INTO rfq_gaps (vertical, zip, prompt, tool, score, needs, industry, last_ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (vertical, zip, prompt) DO UPDATE SET
         tool     = EXCLUDED.tool,
         score    = EXCLUDED.score,
         needs    = EXCLUDED.needs,
         industry = EXCLUDED.industry,
         last_ts  = NOW()`,
      [gap.vertical, gap.zip, gap.prompt, gap.tool || null,
       gap.score || null, gap.needs || null, gap.industry || gap.vertical || null]
    );
  } catch (e) {
    console.error('[pgStore] upsertRfqGap error:', e.message);
  }
}

async function deleteRfqGap(vertical, zip, prompt) {
  await ensureSchema();
  if (!db.isReady()) return;
  try {
    await db.query(
      'DELETE FROM rfq_gaps WHERE vertical = $1 AND zip = $2 AND prompt = $3',
      [vertical, zip, prompt]
    );
  } catch (e) {
    console.error('[pgStore] deleteRfqGap error:', e.message);
  }
}

async function getRfqGaps(vertical) {
  await ensureSchema();
  if (!db.isReady()) return [];
  try {
    return await db.query(
      'SELECT vertical, zip, prompt, tool, score, needs, industry, last_ts FROM rfq_gaps WHERE vertical = $1',
      [vertical]
    );
  } catch (e) {
    return [];
  }
}

async function hasRfqGap(vertical, zip, prompt) {
  await ensureSchema();
  if (!db.isReady()) return false;
  try {
    const row = await db.queryOne(
      'SELECT 1 FROM rfq_gaps WHERE vertical = $1 AND zip = $2 AND prompt = $3',
      [vertical, zip, prompt]
    );
    return Boolean(row);
  } catch (e) {
    return false;
  }
}

// ── source_log — zipAgent source fetch log ───────────────────────────────────
async function appendSourceLog(entry) {
  await ensureSchema();
  if (!db.isReady()) return;
  try {
    await db.query(
      `INSERT INTO source_log (zip, source_name, status, fetched_at, detail)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [entry.zip || null, entry.source_name || entry.source || null,
       entry.status || null,
       entry.fetched_at || new Date().toISOString(),
       entry.detail ? JSON.stringify(entry.detail) : null]
    );
  } catch (e) {
    console.error('[pgStore] appendSourceLog error:', e.message);
  }
}

async function getSourceLog(limit = 500) {
  await ensureSchema();
  if (!db.isReady()) return [];
  try {
    return await db.query(
      'SELECT id, zip, source_name, status, fetched_at, detail FROM source_log ORDER BY fetched_at DESC LIMIT $1',
      [limit]
    );
  } catch (e) {
    return [];
  }
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
  upsertZipQueueEntry,
  getAllZipQueueEntries,
  // Phase 2: computed intel
  upsertBedrockScore,
  upsertOceanFloor,
  upsertCensusLayer,
  upsertAcsDemographics,
  getAcsDemographics,
  getCensusLayer,
  getZipIntelligence,
  // ZIP discovery + business reads (replaces flat-file readdirSync)
  appendWaveEvent,
  getWaveEvents,
  upsertWaveSurface,
  getWaveSurface,
  upsertIrsEnrichment,
  upsertOsmEnrichment,
  getZipEnrichment,
  upsertEvolutionReport,
  getEvolutionReport,
  getDistinctZips,
  getBusinessesByZip,
  // Bulk oracle reads — replaces flat file loops
  getZipIntelligenceAll,
  getZipIntelligenceRow,
  // agent memory
  upsertAgentMemory,
  getAgentMemory,
  listAgentMemories,
  deleteOldAgentMemoryEntries,
  // inference cache
  getInferenceCache,
  upsertInferenceCache,
  getAllInferenceCacheStats,
  // zip briefs
  upsertZipBrief,
  getZipBrief,
  getAllZipBriefs,
  getZipBriefZips,
  // rfq_gaps
  upsertRfqGap,
  deleteRfqGap,
  getRfqGaps,
  hasRfqGap,
  // source_log
  appendSourceLog,
  getSourceLog,
};
