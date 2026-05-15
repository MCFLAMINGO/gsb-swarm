-- Migration 033: Psychographic Signal Layer
-- Adds OSM POI density (golf/arts/worship/fitness) and ACS demographic variables
-- (educational attainment, STEM occupations, median age) plus the composite
-- psycho_index used by lib/scoringEngine.js to score DESTINATION_DINING /
-- RETAIL_STRIP / GENERAL concepts. Populated by overpassWorker and acsWorker.

ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS osm_golf_count            INTEGER;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS osm_arts_count            INTEGER;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS osm_worship_count         INTEGER;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS osm_fitness_count         INTEGER;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS acs_pct_bachelors_plus    NUMERIC;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS acs_pct_stem_occupations  NUMERIC;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS acs_median_age            NUMERIC;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS psycho_index              NUMERIC;

COMMENT ON COLUMN zip_signals.osm_golf_count           IS 'OSM: count of leisure=golf_course (node|way|relation) in ZIP bbox';
COMMENT ON COLUMN zip_signals.osm_arts_count           IS 'OSM: count of arts/culture POIs (theatre|cinema|arts_centre|museum|gallery|artwork)';
COMMENT ON COLUMN zip_signals.osm_worship_count        IS 'OSM: count of amenity=place_of_worship in ZIP bbox';
COMMENT ON COLUMN zip_signals.osm_fitness_count        IS 'OSM: count of fitness/sports leisure POIs (fitness_centre|sports_centre|swimming_pool|yoga|tennis)';
COMMENT ON COLUMN zip_signals.acs_pct_bachelors_plus   IS 'ACS B15003: % of 25+ pop with bachelor''s degree or higher';
COMMENT ON COLUMN zip_signals.acs_pct_stem_occupations IS 'ACS C24010: % of civilian employed 16+ in STEM occupations';
COMMENT ON COLUMN zip_signals.acs_median_age           IS 'ACS B01002_001E: median age';
COMMENT ON COLUMN zip_signals.psycho_index             IS 'Composite 0-100 psychographic index — arts/golf/education/STEM/worship/fitness/age (lib/scoringEngine.js computePsychoIndex)';
