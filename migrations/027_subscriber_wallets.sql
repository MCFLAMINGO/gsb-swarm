CREATE TABLE IF NOT EXISTS subscriber_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_phone TEXT NOT NULL REFERENCES subscriber_accounts(phone) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL UNIQUE,
  encrypted_pk TEXT,           -- future: encrypted private key storage
  wallet_type TEXT DEFAULT 'tempo_custodial',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriber_wallets_phone ON subscriber_wallets(subscriber_phone);
CREATE INDEX IF NOT EXISTS idx_subscriber_wallets_address ON subscriber_wallets(wallet_address);
