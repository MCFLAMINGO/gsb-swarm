-- ============================================================
-- Migration 004: LocalIntel Intelligence Layer
-- Task events, worker observatory, pattern aggregation,
-- business responsiveness scores, and agent session tracking.
--
-- Road classification:
--   highway    = agent → UCP/Surge → agent_closed (fully machine)
--   local      = agent → SMS/voice → human_assisted
--   cul-de-sac = agent → email/RFQ → dropped or pending indefinitely
-- ============================================================

-- ── task_events ──────────────────────────────────────────────
-- Every customer/agent interaction, append-only.
CREATE TABLE IF NOT EXISTS task_events (
  id              BIGSERIAL PRIMARY KEY,
  task_id         UUID NOT NULL DEFAULT gen_random_uuid(),
  business_id     UUID REFERENCES businesses(business_id) ON DELETE SET NULL,
  zip             TEXT,
  category        TEXT,
  category_group  TEXT,

  -- How the task came in
  task_type       TEXT NOT NULL,  -- voice_order | agent_query | mcp_call | rfq | voice_listing
  channel_in      TEXT,           -- twilio | mcp | api | http

  -- Which POS handler was used (or attempted)
  pos_type        TEXT,           -- ucp | toast | square | other | null

  -- Where the task was handed off
  handoff_type    TEXT,           -- surge_checkout | sms | email | none
  road_type       TEXT,           -- highway | local | cul-de-sac

  -- Outcome
  resolution_type TEXT,           -- agent_closed | human_assisted | dropped | pending | failed
  lane_depth      SMALLINT DEFAULT 1, -- hops before close or drop

  -- Agent provenance (from X-Agent-* headers or AP2 mandate)
  agent_session_id UUID,
  agent_id        TEXT,
  agent_origin    TEXT,

  -- Timing
  initiated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at    TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,

  -- Meta
  error_message   TEXT,
  meta            JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_task_events_business   ON task_events(business_id);
CREATE INDEX IF NOT EXISTS idx_task_events_zip        ON task_events(zip);
CREATE INDEX IF NOT EXISTS idx_task_events_category   ON task_events(category_group);
CREATE INDEX IF NOT EXISTS idx_task_events_road       ON task_events(road_type);
CREATE INDEX IF NOT EXISTS idx_task_events_resolution ON task_events(resolution_type);
CREATE INDEX IF NOT EXISTS idx_task_events_initiated  ON task_events(initiated_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_events_agent_sess ON task_events(agent_session_id);


-- ── worker_events ─────────────────────────────────────────────
-- Every worker start/complete/fail. Observatory + self-improvement data.
CREATE TABLE IF NOT EXISTS worker_events (
  id              BIGSERIAL PRIMARY KEY,
  worker_name     TEXT NOT NULL,              -- voiceIntake | posRouter | geocodingWorker | localIntelMCP | rfqFallback
  event_type      TEXT NOT NULL,              -- start | complete | fail | retry | stall
  input_summary   TEXT,                       -- short human-readable description of input
  output_summary  TEXT,                       -- short human-readable description of output
  duration_ms     INTEGER,
  error_message   TEXT,
  records_in      INTEGER,
  records_out     INTEGER,
  success_rate    NUMERIC(5,2),               -- 0.00–100.00
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  meta            JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_worker_events_name    ON worker_events(worker_name);
CREATE INDEX IF NOT EXISTS idx_worker_events_type    ON worker_events(event_type);
CREATE INDEX IF NOT EXISTS idx_worker_events_created ON worker_events(created_at DESC);


-- ── agent_sessions ────────────────────────────────────────────
-- Per-agent call session. Built from X-Agent-* headers or AP2 mandate context.
CREATE TABLE IF NOT EXISTS agent_sessions (
  session_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id           TEXT,
  origin_domain      TEXT,
  prior_sources      TEXT[]  DEFAULT '{}',    -- ["google-maps","yelp"]
  failed_sources     TEXT[]  DEFAULT '{}',    -- ["yelp: rate-limited"]
  principal_intent   TEXT,
  call_count         INTEGER DEFAULT 1,
  zips_queried       TEXT[]  DEFAULT '{}',
  categories_queried TEXT[]  DEFAULT '{}',
  total_pathusd_spent NUMERIC(18,6) DEFAULT 0,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent   ON agent_sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_origin  ON agent_sessions(origin_domain);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_last    ON agent_sessions(last_seen_at DESC);


-- ── task_patterns ─────────────────────────────────────────────
-- Nightly aggregation: ZIP × category_group × week.
-- Written by nightly worker, read by MCP + buyer API.
CREATE TABLE IF NOT EXISTS task_patterns (
  id                    BIGSERIAL PRIMARY KEY,
  zip                   TEXT NOT NULL,
  category_group        TEXT NOT NULL,
  week_start            DATE NOT NULL,        -- Monday of the week (DATE_TRUNC('week', ...))

  total_tasks           INTEGER DEFAULT 0,
  completion_rate       NUMERIC(5,2),         -- 0.00–100.00
  avg_response_minutes  NUMERIC(10,2),
  avg_completion_minutes NUMERIC(10,2),
  dominant_handoff_type TEXT,                 -- surge_checkout | sms | email | none
  pos_connected_pct     NUMERIC(5,2),         -- % of tasks where pos_type != null
  drop_rate_by_stage    JSONB DEFAULT '{}',   -- { "at_handoff": 0.3, "at_response": 0.1 }

  -- Conformance breakdown
  agent_closed_count    INTEGER DEFAULT 0,
  human_assisted_count  INTEGER DEFAULT 0,
  dropped_count         INTEGER DEFAULT 0,
  conformance_rate      NUMERIC(5,2),         -- agent_closed / total * 100

  -- Road distribution
  highway_pct           NUMERIC(5,2),
  local_pct             NUMERIC(5,2),
  cul_de_sac_pct        NUMERIC(5,2),

  computed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(zip, category_group, week_start)
);

CREATE INDEX IF NOT EXISTS idx_task_patterns_zip      ON task_patterns(zip);
CREATE INDEX IF NOT EXISTS idx_task_patterns_cat      ON task_patterns(category_group);
CREATE INDEX IF NOT EXISTS idx_task_patterns_week     ON task_patterns(week_start DESC);
CREATE INDEX IF NOT EXISTS idx_task_patterns_conform  ON task_patterns(conformance_rate DESC);


-- ── business_responsiveness ───────────────────────────────────
-- Per-business score, updated nightly.
-- Read by getBusinessScore() MCP tool + buyer API.
CREATE TABLE IF NOT EXISTS business_responsiveness (
  business_id           UUID PRIMARY KEY REFERENCES businesses(business_id) ON DELETE CASCADE,
  zip                   TEXT,
  category_group        TEXT,

  response_score        SMALLINT DEFAULT 0,   -- 0–100
  avg_response_min      NUMERIC(10,2),
  completion_rate_30d   NUMERIC(5,2),
  completion_rate_90d   NUMERIC(5,2),
  conformance_rate_30d  NUMERIC(5,2),         -- agent_closed / total 30d
  dominant_road_type    TEXT,                 -- highway | local | cul-de-sac
  handoff_type          TEXT,                 -- surge_checkout | sms | email | none
  pos_type              TEXT,                 -- ucp | toast | square | other | null

  tasks_7d              INTEGER DEFAULT 0,
  tasks_30d             INTEGER DEFAULT 0,
  tasks_90d             INTEGER DEFAULT 0,

  last_task_at          TIMESTAMPTZ,
  computed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_biz_resp_zip    ON business_responsiveness(zip);
CREATE INDEX IF NOT EXISTS idx_biz_resp_cat    ON business_responsiveness(category_group);
CREATE INDEX IF NOT EXISTS idx_biz_resp_score  ON business_responsiveness(response_score DESC);
CREATE INDEX IF NOT EXISTS idx_biz_resp_conf   ON business_responsiveness(conformance_rate_30d DESC);
