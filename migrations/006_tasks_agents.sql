-- ============================================================
-- Migration 006: Task dispatch layer
-- agents, tasks, task_events tables + seed owner agent (Erik Osol)
-- Supports A=owner, B=vetted, C=open signup tiers
--
-- Note: task_events table already exists from migration 004
-- (intelligence signal layer). We additively extend it with
-- the columns the dispatch layer needs (event_type, agent_id,
-- event_id) so both layers can coexist on the same table.
-- ============================================================

-- Agents table (supports A=owner, B=vetted, C=open signup)
CREATE TABLE IF NOT EXISTS agents (
  agent_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  phone           TEXT NOT NULL,              -- E.164 format +1XXXXXXXXXX
  wallet          TEXT,                       -- Tempo/pathUSD wallet for payment
  zip             TEXT,                       -- home base ZIP
  zips_served     TEXT[] DEFAULT '{}',        -- all ZIPs they cover
  categories      TEXT[] DEFAULT '{"*"}',     -- ['bar','grocery'] or ['*'] for all
  available       BOOLEAN DEFAULT true,
  verified        BOOLEAN DEFAULT false,
  tier            TEXT DEFAULT 'open',        -- 'owner','vetted','open'
  source          TEXT DEFAULT 'manual',      -- 'manual','signup','invite'
  rating          NUMERIC(3,2) DEFAULT 5.00,
  tasks_completed INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
  task_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_query        TEXT NOT NULL,
  top_category      TEXT,
  sub_category      TEXT,
  entities_json     JSONB DEFAULT '{}',       -- {item, quantity, urgency, location, brand}
  urgency           TEXT DEFAULT 'low',       -- 'now','today','scheduled','low'
  zip               TEXT,
  status            TEXT DEFAULT 'open',      -- 'open','assigned','accepted','in_progress','completed','failed','cancelled'
  assigned_agent_id UUID REFERENCES agents(agent_id),
  business_id       UUID,                     -- filled if resolves to known biz
  result_json       JSONB DEFAULT '{}',       -- agent completion data
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  assigned_at       TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  fee_usd           NUMERIC(10,2) DEFAULT 0,
  payment_tx        TEXT
);

-- Task events audit log
-- Existing table from migration 004 has: id BIGSERIAL PK, task_id UUID, task_type, etc.
-- We additively add the dispatch-layer columns. CREATE remains for fresh installs.
CREATE TABLE IF NOT EXISTS task_events (
  event_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     UUID,
  agent_id    UUID,
  event_type  TEXT NOT NULL,  -- 'created','assigned','accepted','declined','completed','failed','feedback'
  meta        JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Additive columns for the case where task_events pre-exists from migration 004.
-- Existing migration 004 schema has: id BIGSERIAL PK, task_type TEXT NOT NULL,
-- agent_id TEXT, etc. We add the dispatch-layer columns and relax task_type
-- so dispatch INSERTs (which only set event_type) succeed.
ALTER TABLE task_events ADD COLUMN IF NOT EXISTS event_id   UUID DEFAULT gen_random_uuid();
ALTER TABLE task_events ADD COLUMN IF NOT EXISTS agent_id   UUID;
ALTER TABLE task_events ADD COLUMN IF NOT EXISTS event_type TEXT;
ALTER TABLE task_events ADD COLUMN IF NOT EXISTS meta       JSONB DEFAULT '{}';
ALTER TABLE task_events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE task_events ALTER COLUMN task_type DROP NOT NULL;

-- Indexes
CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status);
CREATE INDEX IF NOT EXISTS tasks_zip_category_idx ON tasks(zip, top_category);
CREATE INDEX IF NOT EXISTS tasks_created_at_idx ON tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS agents_available_idx ON agents(available) WHERE available = true;
CREATE INDEX IF NOT EXISTS task_events_task_id_idx ON task_events(task_id);
CREATE INDEX IF NOT EXISTS task_events_event_type_idx ON task_events(event_type);

-- Seed owner agent (Erik / McFlamingo)
-- Only insert if no owner agent exists yet
INSERT INTO agents (name, phone, wallet, zip, zips_served, categories, available, verified, tier, source)
SELECT
  'Erik Osol',
  '+19045846665',
  '0xe66cE7E6d31A5F69899Ecad2E4F3B141557e0dED',
  '32082',
  ARRAY['32082','32081','32250','32266','32233','32259','32034'],
  ARRAY['*'],
  true,
  true,
  'owner',
  'manual'
WHERE NOT EXISTS (SELECT 1 FROM agents WHERE tier = 'owner');
