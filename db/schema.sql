-- LocalIntel PostgreSQL Schema v1.0
-- Run with: psql $LOCAL_INTEL_DB_URL -f schema.sql

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- fuzzy text search for entity resolution

-- ── businesses ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS businesses (
  business_id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name               TEXT NOT NULL,
  name_aliases       TEXT[]           DEFAULT '{}',
  zip                CHAR(5)          NOT NULL,
  address            TEXT,
  city               TEXT,
  state              CHAR(2)          DEFAULT 'FL',
  lat                DOUBLE PRECISION,
  lon                DOUBLE PRECISION,
  phone              TEXT,
  website            TEXT,
  hours              TEXT,
  naics_code         CHAR(6),
  category           TEXT,
  category_group     TEXT,             -- food / health / retail / finance / legal / civic / services
  status             TEXT             DEFAULT 'active',  -- active | inactive | pending | unverified
  registered_date    DATE,
  deregistered_date  DATE,
  confidence_score   FLOAT4           DEFAULT 0.0,
  owner_verified     BOOLEAN          DEFAULT FALSE,
  tags               TEXT[]           DEFAULT '{}',
  description        TEXT,
  -- Source tracking
  sources            TEXT[]           DEFAULT '{}',
  primary_source     TEXT,
  last_confirmed     TIMESTAMPTZ,
  -- Sunbiz fields
  sunbiz_doc_number  TEXT             UNIQUE,
  sunbiz_entity_type TEXT,
  sunbiz_status      TEXT,
  sunbiz_agent_name  TEXT,
  sunbiz_agent_addr  TEXT,
  -- Timestamps
  created_at         TIMESTAMPTZ      DEFAULT NOW(),
  updated_at         TIMESTAMPTZ      DEFAULT NOW()
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_businesses_zip        ON businesses(zip);
CREATE INDEX IF NOT EXISTS idx_businesses_status     ON businesses(status);
CREATE INDEX IF NOT EXISTS idx_businesses_category   ON businesses(category);
CREATE INDEX IF NOT EXISTS idx_businesses_confidence ON businesses(confidence_score DESC);
CREATE INDEX IF NOT EXISTS idx_businesses_name_trgm  ON businesses USING gin(name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_businesses_sunbiz_doc ON businesses(sunbiz_doc_number);
CREATE INDEX IF NOT EXISTS idx_businesses_zip_cat    ON businesses(zip, category_group);
CREATE INDEX IF NOT EXISTS idx_businesses_updated    ON businesses(updated_at DESC);

-- ── source_evidence ───────────────────────────────────────────────────────────
-- One row per (business_id, source_id) — multiple sources per business
CREATE TABLE IF NOT EXISTS source_evidence (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     UUID NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
  source_id       TEXT NOT NULL,      -- fl_sunbiz | sjc_btr | yellowpages | osm | census_cbp
  source_record_id TEXT,              -- PK in originating system
  raw_data        JSONB,              -- source fields verbatim
  fetched_at      TIMESTAMPTZ        DEFAULT NOW(),
  weight          FLOAT4             DEFAULT 0.0,  -- confidence contribution
  UNIQUE(business_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_evidence_business  ON source_evidence(business_id);
CREATE INDEX IF NOT EXISTS idx_evidence_source    ON source_evidence(source_id);

-- ── zip_intelligence ──────────────────────────────────────────────────────────
-- Cached oracle/census output per ZIP — replaces data/oracle/*.json
CREATE TABLE IF NOT EXISTS zip_intelligence (
  zip                       CHAR(5) PRIMARY KEY,
  name                      TEXT,
  -- Demographics (from ACS)
  population                INT,
  median_household_income   INT,
  median_home_value         INT,
  owner_occupied_pct        FLOAT4,
  total_households          INT,
  wfh_pct                   FLOAT4,
  retiree_index             FLOAT4,
  affluence_pct             FLOAT4,
  ultra_affluence_pct       FLOAT4,
  age_55_plus_pct           FLOAT4,
  age_25_34_pct             FLOAT4,
  age_35_54_pct             FLOAT4,
  new_build_pct             FLOAT4,
  vacancy_rate_pct          FLOAT4,
  family_hh_pct             FLOAT4,
  -- Market signals
  restaurant_count          INT,
  total_businesses          INT,
  gap_count                 INT,
  saturation_status         TEXT,
  growth_state              TEXT,
  consumer_profile          TEXT,
  -- Full oracle JSON (for backward compat with existing MCP layer)
  oracle_json               JSONB,
  -- Timestamps
  computed_at               TIMESTAMPTZ DEFAULT NOW(),
  acs_fetched_at            TIMESTAMPTZ,
  updated_at                TIMESTAMPTZ DEFAULT NOW()
);

-- ── zip_schedule ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS zip_schedule (
  zip                CHAR(5) PRIMARY KEY,
  state              CHAR(2)      DEFAULT 'FL',
  priority_score     FLOAT4       DEFAULT 0.0,
  coverage_status    TEXT         DEFAULT 'not_started',  -- active | queued | not_started
  last_full_run      TIMESTAMPTZ,
  next_run_at        TIMESTAMPTZ,
  business_count     INT          DEFAULT 0,
  subscriber_count   INT          DEFAULT 0,
  query_count_7d     INT          DEFAULT 0,
  source_counts      JSONB        DEFAULT '{}',
  created_at         TIMESTAMPTZ  DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  DEFAULT NOW()
);

-- ── usage_ledger ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS usage_ledger (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_token     TEXT,
  tool_name       TEXT,
  zip             CHAR(5),
  cost_path_usd   NUMERIC(10,6)  DEFAULT 0,
  tx_hash         TEXT,
  called_at       TIMESTAMPTZ    DEFAULT NOW(),
  response_ms     INT,
  cache_hit       BOOLEAN        DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_ledger_called    ON usage_ledger(called_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_zip       ON usage_ledger(zip);
CREATE INDEX IF NOT EXISTS idx_ledger_tool      ON usage_ledger(tool_name);

-- ── sunbiz_raw ────────────────────────────────────────────────────────────────
-- Staging table for raw Sunbiz import before entity resolution
CREATE TABLE IF NOT EXISTS sunbiz_raw (
  id                  SERIAL PRIMARY KEY,
  doc_number          TEXT UNIQUE,
  entity_name         TEXT,
  entity_type         TEXT,            -- CORPORATION | LLC | LP | etc.
  status              TEXT,
  principal_address   TEXT,
  principal_city      TEXT,
  principal_state     TEXT,
  principal_zip       CHAR(10),
  mailing_address     TEXT,
  mailing_city        TEXT,
  mailing_state       TEXT,
  mailing_zip         CHAR(10),
  registered_agent    TEXT,
  agent_address       TEXT,
  filed_date          DATE,
  last_event          TEXT,
  last_event_date     DATE,
  resolved            BOOLEAN         DEFAULT FALSE,
  resolved_business_id UUID,
  imported_at         TIMESTAMPTZ     DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sunbiz_zip      ON sunbiz_raw(principal_zip);
CREATE INDEX IF NOT EXISTS idx_sunbiz_status   ON sunbiz_raw(status);
CREATE INDEX IF NOT EXISTS idx_sunbiz_resolved ON sunbiz_raw(resolved);
CREATE INDEX IF NOT EXISTS idx_sunbiz_name_trgm ON sunbiz_raw USING gin(entity_name gin_trgm_ops);

-- ── Updated_at auto-trigger ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_businesses_updated
    BEFORE UPDATE ON businesses
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_zip_intel_updated
    BEFORE UPDATE ON zip_intelligence
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
