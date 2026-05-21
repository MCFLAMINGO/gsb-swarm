-- Migration 045: full NAICS 236/237/238 construction signals in zip_signals
-- Written by countyPermitsWorker. Replaces the NAICS-236-only columns from B87b.

-- School signals (044 may not have run if migration was already counted)
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS school_count      INT;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS total_enrollment  INT;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS school_pop_proxy  INT;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS school_updated_at TIMESTAMPTZ;

-- Remove old generic CBP columns if they exist (renamed to sector-specific below)
ALTER TABLE zip_signals DROP COLUMN IF EXISTS cbp_total_establishments;
ALTER TABLE zip_signals DROP COLUMN IF EXISTS cbp_total_employees;
ALTER TABLE zip_signals DROP COLUMN IF EXISTS cbp_total_payroll_k;
ALTER TABLE zip_signals DROP COLUMN IF EXISTS cbp_updated_at;

-- NAICS 236 — Construction of Buildings
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS cbp_bldg_estab  INT;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS cbp_bldg_emp    INT;

-- NAICS 237 — Heavy and Civil Engineering Construction
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS cbp_civil_estab INT;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS cbp_civil_emp   INT;

-- NAICS 238 — Specialty Trade Contractors
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS cbp_trade_estab      INT;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS cbp_trade_emp        INT;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS cbp_trade_payroll_k  INT;

-- Shared timestamp
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS cbp_construction_updated_at TIMESTAMPTZ;

-- Reset worker heartbeats so both workers re-run on next deploy
DELETE FROM worker_heartbeat WHERE worker_name IN ('countyPermitsWorker', 'schoolEnrollmentWorker');
