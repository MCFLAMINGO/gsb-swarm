-- Migration 040: add detected_intent column to intent_dead_ends + sms_query_log
-- Fixes: column "detected_intent" does not exist (localIntelAgent.js:9177, 9183, 9517, 9523)
-- These tables are created by scripts/migrateB10.js and scripts/migrateB16.js;
-- localIntelAgent.js GROUP BY queries expect a detected_intent column for analytics.

ALTER TABLE intent_dead_ends ADD COLUMN IF NOT EXISTS detected_intent TEXT;
ALTER TABLE sms_query_log    ADD COLUMN IF NOT EXISTS detected_intent TEXT;

CREATE INDEX IF NOT EXISTS idx_dead_ends_detected_intent
  ON intent_dead_ends(detected_intent)
  WHERE detected_intent IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sms_log_detected_intent
  ON sms_query_log(detected_intent)
  WHERE detected_intent IS NOT NULL;
