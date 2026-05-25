-- Migration 048: chamber_scraper_state
-- Tracks which chambers have been scraped and when.
-- Same (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ) pattern as sunbiz_import_state.

CREATE TABLE IF NOT EXISTS chamber_scraper_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
