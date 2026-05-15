-- Migration 032: Unified Site Intelligence Scoring Engine
-- Adds OSM-derived competitor counts, road class signals, and statewide-normalized
-- factor columns used by lib/scoringEngine.js (MCDA/WLC concept-aware scoring).
-- Populated by workers/overpassWorker.js (osm_*) and per-query at scoring time (norm_*).

ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS osm_fast_food_count INTEGER;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS osm_road_class      TEXT;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS osm_access_score    NUMERIC;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS norm_aadt           NUMERIC;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS norm_hhi            NUMERIC;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS norm_daytime_pop    NUMERIC;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS norm_food_gap       NUMERIC;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS norm_growth         NUMERIC;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS norm_opportunity    NUMERIC;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS norm_risk           NUMERIC;

COMMENT ON COLUMN zip_signals.osm_fast_food_count IS 'OSM: count of nodes tagged amenity=fast_food in ZIP bbox (drive-by QSR competitor density)';
COMMENT ON COLUMN zip_signals.osm_road_class      IS 'OSM: dominant highway class in ZIP bbox (trunk>primary>secondary>tertiary>residential)';
COMMENT ON COLUMN zip_signals.osm_access_score    IS 'OSM-derived 0-100 site accessibility score: road class base + lane/oneway adjustments';
COMMENT ON COLUMN zip_signals.norm_aadt           IS 'Statewide-normalized AADT (0-1) used by scoringEngine factor_breakdown';
COMMENT ON COLUMN zip_signals.norm_hhi            IS 'Statewide-normalized median household income (0-1)';
COMMENT ON COLUMN zip_signals.norm_daytime_pop    IS 'Statewide-normalized daytime population (LODES jobs + ACS pop)';
COMMENT ON COLUMN zip_signals.norm_food_gap       IS 'Statewide-normalized food service gap (low biz density = high gap)';
COMMENT ON COLUMN zip_signals.norm_growth         IS 'Statewide-normalized growth score';
COMMENT ON COLUMN zip_signals.norm_opportunity    IS 'Statewide-normalized opportunity score';
COMMENT ON COLUMN zip_signals.norm_risk           IS 'Statewide-normalized risk score';
