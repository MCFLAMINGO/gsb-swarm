-- migrations/013_rfq_quote_system.sql
-- RFQ Quote System: customer identity, magic token, bid window logic,
-- structured bid fields on rfq_responses, ref tracking, loser notification.

-- ── rfq_requests additions ────────────────────────────────────────────────────
-- customer contact for notifications + magic link
ALTER TABLE rfq_requests ADD COLUMN IF NOT EXISTS customer_phone   TEXT;
ALTER TABLE rfq_requests ADD COLUMN IF NOT EXISTS customer_email   TEXT;
-- magic token — sent to customer so they can return to their bid page
ALTER TABLE rfq_requests ADD COLUMN IF NOT EXISTS magic_token      TEXT UNIQUE;
-- ref tag — which business/channel referred this job (affiliate tracking)
ALTER TABLE rfq_requests ADD COLUMN IF NOT EXISTS ref_tag          TEXT;
-- bid window type: 'same_day' | 'scheduled' | 'large_job' (auto-set from budget)
ALTER TABLE rfq_requests ADD COLUMN IF NOT EXISTS bid_window_type  TEXT;
-- same-day flag (true = 4h window, false = 24h, large_job = 72h)
ALTER TABLE rfq_requests ADD COLUMN IF NOT EXISTS is_same_day      BOOLEAN NOT NULL DEFAULT FALSE;

-- ── rfq_responses additions ───────────────────────────────────────────────────
-- structured bid fields (quote_usd + eta_minutes already exist — add eta_text)
ALTER TABLE rfq_responses ADD COLUMN IF NOT EXISTS eta_text        TEXT;
-- loser notification sent flag
ALTER TABLE rfq_responses ADD COLUMN IF NOT EXISTS loser_notified  BOOLEAN NOT NULL DEFAULT FALSE;
-- business phone for SMS bid parsing
ALTER TABLE rfq_responses ADD COLUMN IF NOT EXISTS business_phone  TEXT;

-- ── rfq_bookings additions ────────────────────────────────────────────────────
ALTER TABLE rfq_bookings ADD COLUMN IF NOT EXISTS completed_at     TIMESTAMPTZ;
ALTER TABLE rfq_bookings ADD COLUMN IF NOT EXISTS customer_rating  INT;   -- 1-5

-- ── indexes ───────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_rfq_magic_token ON rfq_requests(magic_token) WHERE magic_token IS NOT NULL;
CREATE INDEX        IF NOT EXISTS idx_rfq_ref_tag     ON rfq_requests(ref_tag)     WHERE ref_tag IS NOT NULL;
CREATE INDEX        IF NOT EXISTS idx_rfq_deadline    ON rfq_requests(deadline_at) WHERE status = 'open';
