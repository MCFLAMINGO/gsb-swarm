CREATE TABLE IF NOT EXISTS resolution_history (
  id            BIGSERIAL PRIMARY KEY,
  query         TEXT NOT NULL,
  intent_class  TEXT,
  intent_group  TEXT,
  cuisine       TEXT,
  zip           TEXT,
  business_id   UUID,
  resolved      BOOLEAN NOT NULL DEFAULT false,
  resolved_via  TEXT,
  result_count  INTEGER DEFAULT 0,
  response_ms   INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rh_intent_class ON resolution_history(intent_class);
CREATE INDEX IF NOT EXISTS idx_rh_zip ON resolution_history(zip);
CREATE INDEX IF NOT EXISTS idx_rh_resolved ON resolution_history(resolved);
CREATE INDEX IF NOT EXISTS idx_rh_created_at ON resolution_history(created_at DESC);
