-- migrations/011_merchant_portal.sql
-- Merchant portal: magic-link dashboard tokens + claim metadata

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS merchant_email       TEXT,
  ADD COLUMN IF NOT EXISTS dashboard_token      TEXT,
  ADD COLUMN IF NOT EXISTS token_expires_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claimed              BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS claim_pin            TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_businesses_merchant_email
  ON businesses(merchant_email) WHERE merchant_email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_businesses_dashboard_token
  ON businesses(dashboard_token) WHERE dashboard_token IS NOT NULL;
