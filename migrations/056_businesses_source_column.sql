-- 056_businesses_source_column.sql
-- Add missing 'source' column to businesses table.
-- pgStore.upsertZipQueue and seed scripts reference this column but it was
-- never added via migration, causing "[seed] column source does not exist" errors.

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS source TEXT;

COMMENT ON COLUMN businesses.source IS 'Data source identifier (e.g. yellow_pages, overpass, sunbiz, seed)';
