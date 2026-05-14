-- Migration 025: Conversation threading for stateful SMS/voice/MCP/web queries
-- Keyed on caller_id (E.164 phone, session_id, or agent_id)
-- Provides rolling context window for intent router enrichment

CREATE TABLE IF NOT EXISTS conversation_threads (
  id           BIGSERIAL    PRIMARY KEY,
  caller_id    TEXT         NOT NULL,
  channel      TEXT         NOT NULL DEFAULT 'web',   -- 'sms' | 'voice' | 'mcp' | 'web'
  role         TEXT         NOT NULL DEFAULT 'user',  -- 'user' | 'system'
  content      TEXT         NOT NULL,                 -- raw message or system summary
  zip          TEXT,                                  -- resolved ZIP for this turn
  intent       TEXT,                                  -- resolved taskClass
  business_id  UUID,                                  -- business resolved (if any)
  business_name TEXT,                                 -- denormalized for fast context reads
  rfq_id       UUID,                                  -- RFQ created (if any)
  resolves_via TEXT,                                  -- search | rfq | reservation | task_followup
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ct_caller_recent
  ON conversation_threads(caller_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ct_channel
  ON conversation_threads(channel, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ct_zip
  ON conversation_threads(zip, created_at DESC);
