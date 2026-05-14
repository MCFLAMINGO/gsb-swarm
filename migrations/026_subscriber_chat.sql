-- subscriber_accounts: tracks $9.99/mo subscribers
CREATE TABLE IF NOT EXISTS subscriber_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT UNIQUE NOT NULL,
  email TEXT,
  tier TEXT NOT NULL DEFAULT 'chat',
  status TEXT NOT NULL DEFAULT 'trial',
  trial_queries_used INT DEFAULT 0,
  trial_queries_limit INT DEFAULT 3,
  stripe_customer_id TEXT,
  path_usd_wallet TEXT,
  subscribed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_id TEXT NOT NULL,
  question TEXT NOT NULL,
  zip TEXT,
  category TEXT,
  data_confidence NUMERIC(5,2),
  missing_signals TEXT[],
  llm_model TEXT,
  tokens_used INT,
  answer_preview TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_log_caller ON chat_log(caller_id);
CREATE INDEX IF NOT EXISTS idx_chat_log_zip ON chat_log(zip);
CREATE INDEX IF NOT EXISTS idx_chat_log_confidence ON chat_log(data_confidence);
CREATE INDEX IF NOT EXISTS idx_subscriber_phone ON subscriber_accounts(phone);
