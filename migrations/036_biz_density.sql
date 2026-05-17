-- Migration 036: biz_density_per_1k column on zip_signals
-- B67 fix: localIntelAgent.js (ceo-county-query + getStatewideBounds) SELECTs
-- biz_density_per_1k from zip_signals, but no prior migration added the column,
-- causing a "column does not exist" crash. This adds the column; the value is
-- derived per-ZIP by workers/businessSignalWorker.js on its 24h cycle.

ALTER TABLE zip_signals
  ADD COLUMN IF NOT EXISTS biz_density_per_1k NUMERIC;

COMMENT ON COLUMN zip_signals.biz_density_per_1k IS
  'B67: businesses per 1k residents in ZIP — (total_biz / acs_population) * 1000, NULL when population is 0/null';
