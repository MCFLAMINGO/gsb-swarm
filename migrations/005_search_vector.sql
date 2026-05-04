-- ============================================================
-- Migration 005: Phase 1 — Full-text search foundation
-- Adds cuisine column, tsvector search_vector + GIN index, and
-- builder function for LocalIntel query engine.
-- ============================================================

-- Add cuisine column (extracted from OSM tags)
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS cuisine TEXT;

-- Add search_vector tsvector column
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- GIN index for fast full-text search
CREATE INDEX IF NOT EXISTS businesses_search_vector_gin
  ON businesses USING GIN(search_vector);

-- Index on cuisine for fast filtering
CREATE INDEX IF NOT EXISTS businesses_cuisine_idx
  ON businesses(cuisine)
  WHERE cuisine IS NOT NULL;

-- Function to build search vector for a business
CREATE OR REPLACE FUNCTION businesses_search_vector_build(
  p_name TEXT,
  p_category TEXT,
  p_description TEXT,
  p_services_text TEXT,
  p_tags TEXT[],
  p_cuisine TEXT
) RETURNS tsvector AS $$
BEGIN
  RETURN (
    setweight(to_tsvector('english', coalesce(p_name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(p_category, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(p_cuisine, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(p_description, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(p_services_text, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(array_to_string(p_tags, ' '), '')), 'D')
  );
END;
$$ LANGUAGE plpgsql IMMUTABLE;
