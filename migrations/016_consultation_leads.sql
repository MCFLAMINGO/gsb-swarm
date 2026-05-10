-- 016_consultation_leads.sql
-- Stores inbound market consultation inquiries from the ZIP page permit gate
-- and sector gap CTAs. Every lead that self-qualifies here is a $500-$5k prospect.

CREATE TABLE IF NOT EXISTS consultation_leads (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,
  zip          TEXT,
  intent       TEXT,   -- 'opening_business' | 'investment' | 'real_estate' | 'expansion' | 'other'
  description  TEXT,
  ref          TEXT,   -- utm ref from CTA (e.g. 'permit', 'sector_gap')
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  contacted_at TIMESTAMPTZ,
  status       TEXT DEFAULT 'new'  -- 'new' | 'contacted' | 'closed'
);

CREATE INDEX IF NOT EXISTS idx_consult_leads_status ON consultation_leads (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_consult_leads_email  ON consultation_leads (email);
