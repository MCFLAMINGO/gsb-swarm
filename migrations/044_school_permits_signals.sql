-- Migration 044: school enrollment + county permits signals
-- New signal keys written by schoolEnrollmentWorker and countyPermitsWorker:
--   school_count, total_enrollment, school_pop_proxy (from Urban Institute CCD 2022)
--   permits_new_units (from Census BPS 2023)
--   construction_estab_count, construction_emp (from Census CBP 2022 NAICS 236)
-- zip_signals table already exists (migration 017). Columns added here as a
-- belt-and-suspenders safety net so upsertZipSignals does not fail on first run.

ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS school_count             integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS total_enrollment         integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS school_pop_proxy         integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS permits_new_units        integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS construction_estab_count integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS construction_emp         integer;

SELECT 1; -- idempotent
