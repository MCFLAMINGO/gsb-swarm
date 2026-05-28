-- Migration 051: add missing census layer columns to zip_signals
-- Fixes censusLayerWorker ZBP/CBP/PDB upsert failures (columns never existed or were dropped in 045)

-- ZBP (ZIP Business Patterns 2018 — structural baseline)
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS zbp_total_employees       INT;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS zbp_sector_json           JSONB;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS zbp_updated_at            TIMESTAMPTZ;

-- CBP totals (dropped in 045, needed by censusLayerWorker for county-level summary)
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS cbp_total_establishments  INT;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS cbp_total_employees       INT;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS cbp_total_payroll_k       INT;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS cbp_updated_at            TIMESTAMPTZ;

-- PDB / confidence (Planning Database 2024 — data quality scores per ZIP)
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS data_confidence_score     NUMERIC(5,2);
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS data_confidence_tier      TEXT;  -- VERIFIED / ESTIMATED / PROXY / SPARSE

-- Reset censusLayerWorker heartbeat so it runs immediately on next deploy
DELETE FROM worker_heartbeat WHERE worker_name IN (
  'censusLayerWorker',
  'censusLayerWorker_cbp',
  'censusLayerWorker_pdb'
);
