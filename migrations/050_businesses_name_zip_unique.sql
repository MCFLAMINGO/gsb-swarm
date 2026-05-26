-- Migration 050: unique constraint on (lower(name), zip) for businesses
-- Prevents duplicate real-world businesses inserted from different sources
-- (e.g. Yelp "McDonald's" vs SunBiz "MCDONALDS OF NOCATEE LLC" are different,
--  but "Ponte Vedra Dental" from Yelp and from enrichment should not be two rows).
--
-- Uses a partial unique index: only rows where sunbiz_doc_number IS NULL,
-- because sunbiz rows already have their own UNIQUE constraint and may have
-- corp-name variants that differ from the display name.
--
-- IMPORTANT: does NOT retroactively dedup existing rows — run dedup pass separately.
-- This only prevents NEW duplicates going forward.

CREATE UNIQUE INDEX IF NOT EXISTS idx_businesses_name_zip_unique
  ON businesses (lower(trim(name)), zip)
  WHERE sunbiz_doc_number IS NULL;
