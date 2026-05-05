-- migrations/010_rfq.sql
-- LocalIntel RFQ flow (non-food verticals: plumber, electrician, etc.)
--
-- NOTE: Uses rfq_requests_v2 / rfq_responses_v2 to avoid collision with the
-- existing rfqService.js tables (rfq_requests with UUID PK + caller_phone).
-- The legacy rfqBroadcast/rfqCallback flow keeps using the old tables; this
-- new BIGSERIAL flow handles inbound DISCOVER → RFQ from /api/local-intel.

CREATE TABLE IF NOT EXISTS rfq_requests_v2 (
  id              BIGSERIAL PRIMARY KEY,
  customer_id     TEXT,
  query           TEXT NOT NULL,
  intent_group    TEXT NOT NULL,
  category        TEXT NOT NULL,
  zip             TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'open',
  businesses_notified INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE TABLE IF NOT EXISTS rfq_responses_v2 (
  id              BIGSERIAL PRIMARY KEY,
  rfq_id          BIGINT NOT NULL REFERENCES rfq_requests_v2(id),
  business_id     UUID NOT NULL,
  business_name   TEXT,
  business_phone  TEXT,
  response        TEXT NOT NULL,
  responded_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rfq_v2_status     ON rfq_requests_v2(status);
CREATE INDEX IF NOT EXISTS idx_rfq_v2_zip        ON rfq_requests_v2(zip);
CREATE INDEX IF NOT EXISTS idx_rfq_v2_customer   ON rfq_requests_v2(customer_id);
CREATE INDEX IF NOT EXISTS idx_rfq_v2_resp_rfq   ON rfq_responses_v2(rfq_id);
CREATE INDEX IF NOT EXISTS idx_rfq_v2_resp_biz   ON rfq_responses_v2(business_id);
CREATE INDEX IF NOT EXISTS idx_rfq_v2_resp_phone ON rfq_responses_v2(business_phone);
