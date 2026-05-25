-- Migration 046: SJC ArcGIS WATS permit + PUD development counts in zip_signals
-- Populated by sjcArcGisWorker (St. Johns County only).
-- WATS_Project_Point = active development permit applications.
-- PUD_Development_Activity = planned unit developments.

ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS sjc_wats_permit_count INT DEFAULT 0;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS sjc_pud_count         INT DEFAULT 0;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS sjc_arcgis_updated_at TIMESTAMPTZ;
