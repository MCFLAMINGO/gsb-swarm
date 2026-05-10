-- 015_osm_node_tracking.sql
-- Adds per-business OSM node tracking columns so we can:
--   1. Look up the exact OSM node for a business (not just the ZIP bbox)
--   2. Know when we last checked it
--   3. Know which fields are missing (for the inbox.html OSM prompt card)
--   4. Cache the direct edit URL for that node
-- The overpassWorker populate osm_node_id at promote time.
-- osmChecker.js uses it for per-business field audits.

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS osm_node_id       BIGINT,
  ADD COLUMN IF NOT EXISTS osm_node_type     TEXT,         -- 'node' | 'way' | 'relation'
  ADD COLUMN IF NOT EXISTS osm_last_checked  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS osm_missing_fields TEXT[];      -- e.g. ['phone','website','opening_hours']

-- Index for the scheduled re-check worker (find businesses due for re-check)
CREATE INDEX IF NOT EXISTS idx_biz_osm_recheck
  ON businesses (osm_last_checked)
  WHERE osm_node_id IS NOT NULL;

-- Index to quickly find claimed businesses missing OSM data
CREATE INDEX IF NOT EXISTS idx_biz_osm_node_null
  ON businesses (dispatch_token)
  WHERE osm_node_id IS NULL AND dispatch_token IS NOT NULL;
