-- Migration 058: make business_slang.business_id nullable + add description column
-- Allows slang for neighborhoods, streets, landmarks, local phrases — not just businesses.
-- business_id stays populated when a business match is found (aliasResolver still works).
-- description holds free-text for non-business submissions.

ALTER TABLE business_slang
  ALTER COLUMN business_id DROP NOT NULL;

ALTER TABLE business_slang
  DROP CONSTRAINT IF EXISTS business_slang_business_id_fkey;

ALTER TABLE business_slang
  ADD CONSTRAINT business_slang_business_id_fkey
    FOREIGN KEY (business_id)
    REFERENCES businesses(business_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE business_slang
  ADD COLUMN IF NOT EXISTS description TEXT;

-- New unique constraint: term_lower + COALESCE(business_id::text, description) to allow
-- same term for different places/businesses
ALTER TABLE business_slang
  DROP CONSTRAINT IF EXISTS business_slang_term_lower_business_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_slang_term_biz_desc
  ON business_slang (term_lower, COALESCE(business_id::text, description))
  WHERE business_id IS NOT NULL OR description IS NOT NULL;
