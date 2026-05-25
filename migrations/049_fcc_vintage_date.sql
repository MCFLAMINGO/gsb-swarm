-- Migration 049: fcc_vintage_date column
-- fccBroadbandWorker references fcc_vintage_date (DATE) for per-vintage freshness checks.
-- Migration 023 only added fcc_vintage (TEXT). Add the typed DATE column.

ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS fcc_vintage_date DATE;
