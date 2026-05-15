-- Migration 031: FDOT AADT road traffic signals
-- Adds Florida Department of Transportation Annual Average Daily Traffic
-- columns to zip_signals. Populated by fdotWorker.js via FDOT ArcGIS REST API.
-- Source: https://gis.fdot.gov/arcgis/rest/services/FTO/fto_PROD/MapServer/7
-- No API key required. 2025 data. Polyline segments → ZIP centroid spatial join.

ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS fdot_max_aadt      INTEGER;      -- highest AADT road segment touching this ZIP
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS fdot_avg_aadt      INTEGER;      -- avg AADT across all segments in ZIP bbox
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS fdot_segment_count INTEGER;      -- number of road segments found
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS fdot_top_road      TEXT;         -- desc of highest-AADT segment (DESC_FRM field)
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS fdot_year          SMALLINT;     -- year of AADT data (2025)
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS fdot_updated_at    TIMESTAMPTZ;

COMMENT ON COLUMN zip_signals.fdot_max_aadt      IS 'FDOT FTO: peak Annual Average Daily Traffic across road segments in ZIP bbox';
COMMENT ON COLUMN zip_signals.fdot_avg_aadt      IS 'FDOT FTO: average AADT across all segments in ZIP bbox';
COMMENT ON COLUMN zip_signals.fdot_segment_count IS 'FDOT FTO: number of road segments found in ZIP bbox';
COMMENT ON COLUMN zip_signals.fdot_top_road      IS 'FDOT FTO: DESC_FRM of highest-AADT segment';
COMMENT ON COLUMN zip_signals.fdot_year          IS 'FDOT FTO: data year (typically current year)';
