-- 047_sunbiz_state_files.sql
-- B101: SunBiz 10-file split checkpoint tracking.
--
-- The sunbiz_import_state table uses a (key TEXT PRIMARY KEY, value TEXT)
-- KV layout established by earlier migrations. The new 10-file architecture
-- (cordata0-9.zip) tracks per-file completion as a JSON array stored under
-- the key 'files_completed' rather than adding a typed column, which keeps
-- the KV schema uniform with the rest of the worker's state.
--
-- This migration is a no-op safety net: it ensures the table exists and
-- documents the new key. Worker code initializes the row lazily on first
-- write via INSERT ... ON CONFLICT.

CREATE TABLE IF NOT EXISTS sunbiz_import_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Seed the files_completed key with an empty JSON array if not present, so
-- aggregations / dashboards can read it without a NULL check.
INSERT INTO sunbiz_import_state (key, value)
VALUES ('files_completed', '[]')
ON CONFLICT (key) DO NOTHING;
