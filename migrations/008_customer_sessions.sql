CREATE TABLE IF NOT EXISTS customer_sessions (
  id               BIGSERIAL PRIMARY KEY,
  customer_id      TEXT NOT NULL,
  id_type          TEXT NOT NULL DEFAULT 'anonymous',
  last_query       TEXT,
  last_business_id UUID,
  preferred_group  TEXT,
  query_count      INTEGER NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cs_customer_id ON customer_sessions(customer_id);
CREATE INDEX IF NOT EXISTS idx_cs_preferred_group ON customer_sessions(preferred_group);
CREATE INDEX IF NOT EXISTS idx_cs_last_seen ON customer_sessions(last_seen DESC);
