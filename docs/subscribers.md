# Subscribers — $9.99/mo Chat Tier

Subscriber accounts, $9.99/mo chat tier, agent wallet creation, LLM chat layer, trial flow, Surge subscription endpoints.

### B45 — LLM Chat Layer ($9.99/mo subscriber tier)
**Problem:** Deterministic layer answers structured queries but can't handle open-ended conversational questions. No subscription or monetization layer existed.
**Fix:** Migration 026 (subscriber_accounts + chat_log). POST /api/local-intel/chat: phone-based auth, 3 free trial queries, gates at $9.99/mo active status. Loads zip_signals context, computes data_confidence (0-100), builds grounding prompt, calls Claude Haiku (ANTHROPIC_API_KEY Railway env). Logs every query to chat_log with confidence + missing_signals. chatGapWorker surfaces which workers need to run to improve answer quality.
**Result:** $9.99/mo subscribers get LLM answers grounded in Postgres. Trial users get 3 free queries. Low-confidence answers flag data gaps for deterministic roadmap.

### B46 — Surge Subscription Endpoints
**Problem:** No payment flow to convert trial users to $9.99/mo subscribers.
**Fix:** POST /api/local-intel/subscribe creates Surge order (BASALT_API_KEY, SKU: LOCALINTEL-CHAT-MONTHLY), returns receiptId + portalUrl for Surge iframe. POST /api/local-intel/subscription-confirm verifies receipt + activates subscriber_accounts row (status='active', expires_at=+30d). Merchant wallet: 0xe66cE7E6d31A5F69899Ecad2E4F3B141557e0dED.
**Result:** Landing page can show Surge payment iframe, confirm payment via postMessage, activate subscriber in Postgres.


### B47 — Agent Wallet Creation for Subscribers
**Problem:** Subscribers had no agent wallet — couldn't dispatch tasks or settle payments via Tempo/pathUSD on their behalf.
**Fix:** Migration 027 (subscriber_wallets table). POST /api/local-intel/create-agent-wallet: verifies subscriber, generates Tempo-compatible viem wallet, stores address in subscriber_wallets + subscriber_accounts.path_usd_wallet. Private key NOT stored (custodial v1 — address only). Landing page shows wallet creation prompt after subscription-confirm success.
**Result:** Subscribers can create an agent wallet in one click post-subscription. Address linked to phone. Agents can dispatch RFQs and settle pathUSD payments to/from this address on Tempo mainnet.
