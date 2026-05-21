-- Migration 044: school enrollment signals
-- New signal keys written by schoolEnrollmentWorker:
--   school_count, total_enrollment, school_pop_proxy, school_updated_at
-- CBP columns (cbp_total_establishments, cbp_total_employees, cbp_total_payroll_k,
-- cbp_updated_at) already exist in zip_signals via migration 017.
-- Safe to re-run.

ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS school_count       INT;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS total_enrollment   INT;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS school_pop_proxy   INT;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS school_updated_at  TIMESTAMPTZ;

SELECT 1; -- idempotent
