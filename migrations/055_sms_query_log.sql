-- 055_sms_query_log.sql
-- SMS/voice query logging for Twilio inbound queries.
-- Previously run as Railway pre-deploy command (migrateB16.js) — moved here
-- so it runs via dbMigrate.js on boot, not as a fragile pre-deploy step.

CREATE TABLE IF NOT EXISTS sms_query_log (
  id               SERIAL PRIMARY KEY,
  message_sid      TEXT,
  caller_id        TEXT,
  query            TEXT NOT NULL,
  zip              TEXT,
  intent           TEXT,
  resolved_via     TEXT,
  response_preview TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_log_created ON sms_query_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_log_caller  ON sms_query_log (caller_id);
