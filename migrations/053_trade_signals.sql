-- Migration 053: trade_signals table
-- Source: tradeSignalWorker.js
-- Purpose: FL-concentrated equity trade ideas scored against LocalIntel Postgres data
--
-- WHY: LocalIntel has ZIP/county-level leading indicators (BFS velocity, permit surge,
-- NES solo-operator growth, IRS migration inflows, sunbiz formation rate) that map
-- directly to FL-concentrated small/mid-cap stocks. This table stores weekly scored
-- trade ideas readable from the dashboard and queryable by LLM sessions.
--
-- ACCESS: Dashboard at /local-intel/market-intel
--         LLM session: SELECT * FROM trade_signals ORDER BY scored_at DESC LIMIT 20;

CREATE TABLE IF NOT EXISTS trade_signals (
  id              BIGSERIAL PRIMARY KEY,
  ticker          TEXT NOT NULL,            -- e.g. 'DHI', 'SBCF'
  company         TEXT NOT NULL,            -- e.g. 'D.R. Horton'
  direction       TEXT NOT NULL,            -- 'LONG' | 'SHORT' | 'WATCH'
  confidence      INT NOT NULL,             -- 0-100
  thesis          TEXT NOT NULL,            -- plain-English trade thesis (1-2 sentences)
  signal_source   TEXT NOT NULL,            -- which LocalIntel signal is driving it
  signal_value    TEXT,                     -- the actual value (e.g. 'BFS apps +18% MoM in Hillsborough')
  data_vintage    TEXT,                     -- e.g. '2026-05 BFS'
  options_note    TEXT,                     -- specific options play if applicable
  risk_note       TEXT,                     -- key risk to the thesis
  status          TEXT DEFAULT 'active',    -- 'active' | 'closed' | 'expired'
  scored_at       TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ,              -- when thesis is stale (default 90 days)
  -- note: unique constraint is expression-based, applied in migration 054
  -- UNIQUE (ticker, scored_at::date) ← invalid syntax, use CREATE UNIQUE INDEX instead
);

CREATE INDEX IF NOT EXISTS idx_trade_signals_ticker    ON trade_signals(ticker);
CREATE INDEX IF NOT EXISTS idx_trade_signals_direction ON trade_signals(direction);
CREATE INDEX IF NOT EXISTS idx_trade_signals_scored    ON trade_signals(scored_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_signals_status    ON trade_signals(status);
