-- Migration 041: ensure verified + credited_to columns on business_slang
-- Fixes: column "verified" does not exist
--   Query: SELECT id, term, business_id, votes, verified, credited_to FROM business_slang
-- business_slang is created in scripts/migrateB7.js; older deployed versions may be
-- missing these columns. ADD COLUMN IF NOT EXISTS is idempotent.

ALTER TABLE business_slang ADD COLUMN IF NOT EXISTS verified    BOOLEAN DEFAULT FALSE;
ALTER TABLE business_slang ADD COLUMN IF NOT EXISTS credited_to TEXT;
