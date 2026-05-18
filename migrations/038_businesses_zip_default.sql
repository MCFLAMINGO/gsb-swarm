-- Migration 038: allow sunbiz-only records that have no ZIP
-- The SunBiz quarterly file has no address/ZIP data.
-- businessMergeWorker will later reconcile with OSM/YP records that have real ZIPs.
ALTER TABLE businesses ALTER COLUMN zip SET DEFAULT '00000';
