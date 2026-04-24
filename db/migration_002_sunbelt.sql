-- LocalIntel Migration 002 — Multi-state Sunbelt schema
-- Run with: psql $LOCAL_INTEL_DB_URL -f db/migration_002_sunbelt.sql

-- 1. businesses — widen state default, add state-level indexes
ALTER TABLE businesses ALTER COLUMN state DROP DEFAULT;
ALTER TABLE businesses ALTER COLUMN state TYPE CHAR(2);
ALTER TABLE businesses ALTER COLUMN state SET DEFAULT 'FL';

-- state + zip compound index for multi-state queries
CREATE INDEX IF NOT EXISTS idx_businesses_state       ON businesses(state);
CREATE INDEX IF NOT EXISTS idx_businesses_state_zip   ON businesses(state, zip);
CREATE INDEX IF NOT EXISTS idx_businesses_state_cat   ON businesses(state, category_group);

-- 2. zip_intelligence — add state column if missing
ALTER TABLE zip_intelligence ADD COLUMN IF NOT EXISTS state CHAR(2) DEFAULT 'FL';
ALTER TABLE zip_intelligence ADD COLUMN IF NOT EXISTS region TEXT;        -- HOU, DAL, AUS, MOB, etc.
ALTER TABLE zip_intelligence ADD COLUMN IF NOT EXISTS phase SMALLINT DEFAULT 1; -- 1=FL,2=Gulf,3=Atlantic,4=Interior,5=Pacific
CREATE INDEX IF NOT EXISTS idx_zip_intel_state  ON zip_intelligence(state);
CREATE INDEX IF NOT EXISTS idx_zip_intel_phase  ON zip_intelligence(phase);

-- 3. zip_schedule — add state + phase + region columns
ALTER TABLE zip_schedule ADD COLUMN IF NOT EXISTS region       TEXT;
ALTER TABLE zip_schedule ADD COLUMN IF NOT EXISTS phase        SMALLINT DEFAULT 1;
ALTER TABLE zip_schedule ADD COLUMN IF NOT EXISTS phase_locked BOOLEAN  DEFAULT FALSE; -- true = blocked by phase gate
ALTER TABLE zip_schedule DROP COLUMN IF EXISTS state; -- drop & re-add to set correct type if needed
ALTER TABLE zip_schedule ADD COLUMN IF NOT EXISTS state CHAR(2) DEFAULT 'FL';
CREATE INDEX IF NOT EXISTS idx_zip_sched_state  ON zip_schedule(state);
CREATE INDEX IF NOT EXISTS idx_zip_sched_phase  ON zip_schedule(phase);
CREATE INDEX IF NOT EXISTS idx_zip_sched_locked ON zip_schedule(phase_locked);

-- 4. state_registry — tracks per-state coverage progress and phase gate
CREATE TABLE IF NOT EXISTS state_registry (
  state              CHAR(2)    PRIMARY KEY,
  name               TEXT       NOT NULL,
  phase              SMALLINT   NOT NULL DEFAULT 1,
  status             TEXT       NOT NULL DEFAULT 'locked',  -- locked | active | complete
  zip_total          INT        DEFAULT 0,
  zip_covered        INT        DEFAULT 0,
  zip_pct            FLOAT4     DEFAULT 0.0,  -- updated by coordinator on each cycle
  phase_unlocked_at  TIMESTAMPTZ,
  first_zip_at       TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  notes              TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_state_reg_phase  ON state_registry(phase);
CREATE INDEX IF NOT EXISTS idx_state_reg_status ON state_registry(status);

-- Seed state_registry with all Sunbelt states
INSERT INTO state_registry (state, name, phase, status, zip_total, notes) VALUES
  ('FL', 'Florida',          1, 'active',  1013, 'Phase 1 — primary market. Must hit 95% before Phase 2 unlocks.'),
  ('TX', 'Texas',            2, 'locked',   36,  'Phase 2 — Gulf Coast + Dallas/Austin/SA/HOU/CC metros'),
  ('AL', 'Alabama',          2, 'locked',   17,  'Phase 2 — Mobile Gulf Coast + Birmingham + Huntsville'),
  ('MS', 'Mississippi',      2, 'locked',   12,  'Phase 2 — Gulf Coast + Jackson metro'),
  ('LA', 'Louisiana',        2, 'locked',   19,  'Phase 2 — New Orleans + Baton Rouge + Lafayette + Shreveport'),
  ('GA', 'Georgia',          3, 'locked',   20,  'Phase 3 — Atlanta suburbs + Savannah + Augusta'),
  ('SC', 'South Carolina',   3, 'locked',   17,  'Phase 3 — Charleston + Myrtle Beach + Columbia + Greenville'),
  ('NC', 'North Carolina',   3, 'locked',   19,  'Phase 3 — Charlotte + Raleigh-Durham + Wilmington + Asheville'),
  ('TN', 'Tennessee',        3, 'locked',   17,  'Phase 3 — Nashville + Memphis + Chattanooga + Knoxville'),
  ('OK', 'Oklahoma',         3, 'locked',   17,  'Phase 3 — OKC + Tulsa metros'),
  ('AR', 'Arkansas',         3, 'locked',   15,  'Phase 3 — NW Arkansas (Bentonville/Walmart HQ) + Little Rock'),
  ('KY', 'Kentucky',         4, 'locked',   14,  'Phase 4 — Louisville + Lexington + Northern KY (Cincinnati spillover)'),
  ('NM', 'New Mexico',       4, 'locked',   13,  'Phase 4 — Albuquerque + Rio Rancho + Santa Fe + Las Cruces'),
  ('AZ', 'Arizona',          4, 'locked',   21,  'Phase 4 — Scottsdale/PHX + Tucson + Flagstaff'),
  ('CA', 'California',       5, 'locked',   36,  'Phase 5 — SoCal: San Diego + OC + LA beach cities + Inland Empire + Palm Springs')
ON CONFLICT (state) DO UPDATE SET
  name       = EXCLUDED.name,
  phase      = EXCLUDED.phase,
  zip_total  = EXCLUDED.zip_total,
  notes      = EXCLUDED.notes,
  updated_at = NOW();

-- Trigger: auto-update updated_at + recompute zip_pct on state_registry
CREATE OR REPLACE FUNCTION update_state_registry_pct()
RETURNS TRIGGER AS $
BEGIN
  NEW.updated_at = NOW();
  NEW.zip_pct = CASE WHEN NEW.zip_total > 0 THEN NEW.zip_covered::float / NEW.zip_total * 100.0 ELSE 0 END;
  RETURN NEW;
END;
$ LANGUAGE plpgsql;

DO $ BEGIN
  CREATE TRIGGER trg_state_registry_updated
    BEFORE UPDATE ON state_registry
    FOR EACH ROW EXECUTE FUNCTION update_state_registry_pct();
EXCEPTION WHEN duplicate_object THEN NULL; END $;
