-- Migration 034: Business Layer Signals
-- Adds derived signals from the businesses + business_tasks tables to zip_signals.
-- Populated by workers/businessSignalWorker.js (24h freshness). The scoring
-- engine (lib/scoringEngine.js) reads zip_signals only — these columns feed
-- QSR_DRIVE_BY (sig_wallet_rate), GENERAL (sig_task_density), and act as a
-- closure-rate penalty multiplier for DESTINATION_DINING / QSR_DRIVE_BY.

ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS sig_claimed_rate       NUMERIC;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS sig_wallet_rate        NUMERIC;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS sig_task_density       NUMERIC;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS sig_closure_rate_food  NUMERIC;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS sig_unmet_demand_score NUMERIC;

COMMENT ON COLUMN zip_signals.sig_claimed_rate       IS 'B65: % of businesses in ZIP that are claimed (0-100)';
COMMENT ON COLUMN zip_signals.sig_wallet_rate        IS 'B65: % of businesses with a wallet (paid routing tier) (0-100)';
COMMENT ON COLUMN zip_signals.sig_task_density       IS 'B65: task templates per business, scaled (5 tasks/biz = 100)';
COMMENT ON COLUMN zip_signals.sig_closure_rate_food  IS 'B65: food/restaurant closure rate (0-100, higher = more closures = higher risk)';
COMMENT ON COLUMN zip_signals.sig_unmet_demand_score IS 'B65 placeholder: unmet demand from intent_dead_ends + rfq_gaps (taskSignalWorker, future)';
