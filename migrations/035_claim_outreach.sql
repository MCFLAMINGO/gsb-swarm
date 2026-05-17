-- Migration 035: Claim Outreach (B66)
-- Adds contact_email harvesting columns to businesses and a tracking table for
-- outbound SMS/email outreach inviting unclaimed businesses to claim their
-- LocalIntel profile. Outreach state lives in Postgres so we can dedup sends,
-- track replies, and feed conversion analytics.

-- Email column on businesses (separate from merchant_email which is owner-entered)
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS contact_email TEXT,
  ADD COLUMN IF NOT EXISTS contact_email_source TEXT;  -- 'homepage_mailto' | 'contact_page'

COMMENT ON COLUMN businesses.contact_email        IS 'B66: harvested public business email (mailto/contact page). Distinct from merchant_email (owner-entered on claim).';
COMMENT ON COLUMN businesses.contact_email_source IS 'B66: where contact_email came from (homepage_mailto | contact_page)';

-- Outreach tracking table — dedups sends, tracks replies
CREATE TABLE IF NOT EXISTS claim_outreach (
  id              BIGSERIAL PRIMARY KEY,
  business_id     UUID NOT NULL REFERENCES businesses(business_id),
  channel         TEXT NOT NULL,        -- 'sms' | 'email'
  sent_at         TIMESTAMPTZ DEFAULT NOW(),
  message_sid     TEXT,                 -- Twilio SID for SMS
  email_id        TEXT,                 -- Resend email ID
  replied         BOOLEAN DEFAULT FALSE,
  reply_at        TIMESTAMPTZ,
  reply_body      TEXT,
  claimed         BOOLEAN DEFAULT FALSE,
  claimed_at      TIMESTAMPTZ,
  error           TEXT
);

CREATE INDEX IF NOT EXISTS idx_claim_outreach_business ON claim_outreach(business_id);
CREATE INDEX IF NOT EXISTS idx_claim_outreach_channel  ON claim_outreach(channel, sent_at);
