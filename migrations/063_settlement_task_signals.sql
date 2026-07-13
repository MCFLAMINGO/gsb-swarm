-- Migration 063: Last-mile settlement + micro task signals
-- Closes book → settle → forecast loop.
-- settlement_events is also auto-created by lib/settlementService.migrate().

CREATE TABLE IF NOT EXISTS settlement_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      TEXT,
  rfq_id          TEXT,
  business_id     TEXT,
  zip             TEXT,
  category        TEXT,
  amount_usd      NUMERIC(12,4) NOT NULL DEFAULT 0,
  token           TEXT NOT NULL DEFAULT 'pathUSD',
  status          TEXT NOT NULL,
  wallet          TEXT,
  tx_hash         TEXT,
  rail            TEXT DEFAULT 'tempo',
  meta            JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS settlement_events_booking_idx ON settlement_events(booking_id);
CREATE INDEX IF NOT EXISTS settlement_events_zip_idx ON settlement_events(zip);
CREATE INDEX IF NOT EXISTS settlement_events_created_idx ON settlement_events(created_at DESC);
CREATE INDEX IF NOT EXISTS settlement_events_status_idx ON settlement_events(status);

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS wallet TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

ALTER TABLE rfq_bookings
  ADD COLUMN IF NOT EXISTS payment_rail     TEXT,
  ADD COLUMN IF NOT EXISTS payment_token    TEXT DEFAULT 'pathUSD',
  ADD COLUMN IF NOT EXISTS payment_amount   NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS escrow_data      JSONB,
  ADD COLUMN IF NOT EXISTS stripe_intent_id TEXT,
  ADD COLUMN IF NOT EXISTS settled_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS settled_tx       TEXT;

-- Micro-action signals consumed by scoring / World Model
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS sig_task_velocity        NUMERIC;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS sig_settlement_volume_30d NUMERIC;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS sig_category_momentum    NUMERIC;

COMMENT ON COLUMN zip_signals.sig_unmet_demand_score IS
  'Unmet demand 0-100 from intent_dead_ends + rfq_gaps (taskSignalWorker)';
COMMENT ON COLUMN zip_signals.sig_task_velocity IS
  'RFQ + settlement completions per ZIP over 30d, scaled 0-100 (taskSignalWorker)';
COMMENT ON COLUMN zip_signals.sig_settlement_volume_30d IS
  'Sum of settled/settled_intent USD to local merchants in ZIP over 30d';
COMMENT ON COLUMN zip_signals.sig_category_momentum IS
  'Net RFQ category momentum 0-100 from recent resolutions vs dead ends';
