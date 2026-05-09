-- migrations/014_confirmed_jobs_agent_profiles.sql
-- Phase 1: confirmed_jobs table (RFQ wins + Surge purchases unified view)
--          business_agent_profiles table (who/what/where/when/why/how + settlement)

-- ── confirmed_jobs ─────────────────────────────────────────────────────────────
-- Single source of truth for "a job was confirmed for this business."
-- Written by bookRfq() on RFQ win AND by /api/surge/webhook on Surge purchase.
CREATE TABLE IF NOT EXISTS confirmed_jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
  source           TEXT NOT NULL CHECK (source IN ('rfq_win','surge_purchase','manual')),

  -- WHO
  customer_name    TEXT,
  customer_phone   TEXT,
  customer_email   TEXT,

  -- WHAT
  service_name     TEXT NOT NULL,
  description      TEXT,

  -- WHERE
  address          TEXT,
  zip              TEXT,
  map_url          TEXT,   -- google maps link

  -- WHEN
  scheduled_at     TIMESTAMPTZ,
  schedule_text    TEXT,   -- human readable e.g. "May 15, recurring monthly"
  is_recurring     BOOLEAN NOT NULL DEFAULT FALSE,
  recurrence_note  TEXT,   -- e.g. "3-month minimum"

  -- HOW (payment)
  paid_amount      NUMERIC(10,2),
  currency         TEXT    NOT NULL DEFAULT 'USD',
  settlement_hash  TEXT,   -- on-chain tx hash if pathUSD
  payment_method   TEXT    CHECK (payment_method IN ('surge','stripe','cash','pathusd','other')),

  -- Status
  status           TEXT    NOT NULL DEFAULT 'confirmed'
                   CHECK (status IN ('confirmed','in_progress','complete','cancelled')),
  completed_at     TIMESTAMPTZ,
  done_sms_sent    BOOLEAN NOT NULL DEFAULT FALSE,

  -- Source references
  rfq_id           UUID,   -- set if source = rfq_win
  rfq_booking_id   UUID,   -- set if source = rfq_win
  surge_order_id   TEXT,   -- set if source = surge_purchase

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_confirmed_jobs_business  ON confirmed_jobs(business_id);
CREATE INDEX IF NOT EXISTS idx_confirmed_jobs_status    ON confirmed_jobs(status);
CREATE INDEX IF NOT EXISTS idx_confirmed_jobs_created   ON confirmed_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_confirmed_jobs_zip       ON confirmed_jobs(zip);

-- ── business_agent_profiles ────────────────────────────────────────────────────
-- Structured agent-readable profile for each business.
-- Drives deterministic matching + RFQ routing + agent discovery.
CREATE TABLE IF NOT EXISTS business_agent_profiles (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID NOT NULL UNIQUE REFERENCES businesses(business_id) ON DELETE CASCADE,

  -- Industry template used to build this profile
  industry_type    TEXT CHECK (industry_type IN ('restaurant','service','professional','retail','other')),

  -- Who/What/Where/When/Why/How (free + structured)
  profile_summary  TEXT,           -- one sentence: "We are X that does Y"
  services_json    JSONB,          -- array of { name, description, price, unit, minimum, recurring }
  service_area     TEXT[],         -- ZIP codes or city names covered
  availability     TEXT,           -- e.g. "Mon-Fri 8am-5pm"
  response_time    TEXT,           -- e.g. "Same-day", "24 hours"
  specialties      TEXT[],         -- search/match tags

  -- Settlement path
  settlement_tier  TEXT NOT NULL DEFAULT 'none'
                   CHECK (settlement_tier IN ('surge_catalog','acp_wallet','stripe','none')),
  surge_wallet     TEXT,
  acp_wallet       TEXT,
  stripe_account   TEXT,

  -- Proof of service (raw uploaded text, parsed from docs)
  proof_text       TEXT,           -- extracted text from uploaded docs
  proof_source     TEXT,           -- e.g. "uploaded PDF 2026-05-09"

  -- Flat JSON for agent consumption (generated on save)
  agent_json       JSONB,

  -- Priority boost (funded wallet = higher routing rank)
  wallet_funded    BOOLEAN NOT NULL DEFAULT FALSE,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bap_business     ON business_agent_profiles(business_id);
CREATE INDEX IF NOT EXISTS idx_bap_industry     ON business_agent_profiles(industry_type);
CREATE INDEX IF NOT EXISTS idx_bap_settlement   ON business_agent_profiles(settlement_tier);
CREATE INDEX IF NOT EXISTS idx_bap_funded       ON business_agent_profiles(wallet_funded) WHERE wallet_funded = TRUE;

-- ── update trigger ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS confirmed_jobs_updated_at       ON confirmed_jobs;
CREATE TRIGGER confirmed_jobs_updated_at
  BEFORE UPDATE ON confirmed_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS bap_updated_at ON business_agent_profiles;
CREATE TRIGGER bap_updated_at
  BEFORE UPDATE ON business_agent_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
