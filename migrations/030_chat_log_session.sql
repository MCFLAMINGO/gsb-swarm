-- Migration 030: chat_log enhancements for multi-turn context
-- Adds: answer (full text), session_id (groups turns into a session),
--       cached_tokens / uncached_tokens (track Anthropic cache performance)
-- B55: enables prompt caching + multi-turn conversation history in /api/local-intel/chat

ALTER TABLE chat_log ADD COLUMN IF NOT EXISTS answer         TEXT;
ALTER TABLE chat_log ADD COLUMN IF NOT EXISTS session_id     TEXT;
ALTER TABLE chat_log ADD COLUMN IF NOT EXISTS cached_tokens  INT DEFAULT 0;
ALTER TABLE chat_log ADD COLUMN IF NOT EXISTS uncached_tokens INT DEFAULT 0;

-- Backfill answer from answer_preview where answer is null
UPDATE chat_log SET answer = answer_preview WHERE answer IS NULL AND answer_preview IS NOT NULL;

-- Index for session-based history reconstruction
CREATE INDEX IF NOT EXISTS idx_chat_log_session ON chat_log(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_log_caller_zip ON chat_log(caller_id, zip, created_at);
