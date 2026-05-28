-- Migration 054: fix trade_signals unique constraint
-- The inline UNIQUE (ticker, scored_at::date) in migration 053 is not valid Postgres syntax
-- (expressions can't be used in table-level UNIQUE constraints). This adds the proper
-- expression-based unique index so ON CONFLICT (ticker, (scored_at::date)) works.

-- Drop the invalid constraint if it somehow got created
ALTER TABLE trade_signals DROP CONSTRAINT IF EXISTS trade_signals_ticker_scored_at_date_key;

-- Add the correct expression unique index
CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_signals_ticker_day
  ON trade_signals (ticker, (scored_at::date));
