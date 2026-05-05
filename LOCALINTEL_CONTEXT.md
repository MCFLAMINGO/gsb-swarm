# LocalIntel — Agent Context File
> **READ THIS FIRST every session.** Updated after every commit. Source of truth for architecture, integrations, decisions, and pending tasks.
> Last updated: 2026-05-03 (session 10 — businessMergeWorker wired and tested, dedupe-on-ingest live)

---

## Repos & URLs

| App | Production URL | GitHub | Branch |
|---|---|---|---|
| GSB Swarm Backend | gsb-swarm-production.up.railway.app | MCFLAMINGO/gsb-swarm | main |
| LocalIntel Landing | www.thelocalintel.com | MCFLAMINGO/localintel-landing | main |
| Dashboard (INTERNAL) | swarm-deploy-throw.vercel.app | MCFLAMINGO/gsb-swarm-dashboard | main |

---

## Infrastructure

### Railway (Backend)
- Node.js / Express — `dashboard-server.js` is the main entry point
- Postgres: `postgresql://postgres:mHNhBVhHmYVQdPAKVuysgjpajxzneqkE@turntable.proxy.rlwy.net:25739/railway`
- Admin migration token: `localintel-migrate-2026`
- `db.query()` returns array directly — NEVER use `.rows`
- `pos_type` is NOT a column — always use `pos_config->>'pos_type'`

### Vercel (Landing)
- Project ID: `prj_xYhu03Voqiw1mtpTuQPXiXf6bnmk`
- orgId: `team_19iu8EDRFBkTdrRtK7s6oYuE`
- Deploy method: `rsync -a --exclude='.git' /home/user/workspace/localintel-landing/ /tmp/li-deploy/` then `NODE_TLS_REJECT_UNAUTHORIZED=0 npx vercel --token $VERCEL_TOKEN --yes --prod` from `/tmp/li-deploy/`

### Git Push Commands
- gsb-swarm: `HOME=/home/user GIT_CONFIG_GLOBAL=/home/user/.gitconfig-proxy git push origin main` with `api_credentials=["github"]`
- localintel-landing: same pattern

---

## Railway Environment Variables (SET — no values stored here)

| Key | Purpose |
|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio REST API |
| `TWILIO_AUTH_TOKEN` | Twilio REST API |
| `TWILIO_FROM_NUMBER` | (904) 506-7476 — outbound SMS + calls |
| `RESEND_API_KEY` | Resend email — send + inbound |
| `OWNER_ALERT_PHONE` | Erik's phone for alerts (fallback: +19045867887) |
| `VOICE_CALLER_KEY` | Legacy voice-intake key (now unused — rfqBroadcast handles it) |
| `RAILWAY_PUBLIC_DOMAIN` | Used by rfqCallback.js for TwiML URLs |
| `VIRTUALS_API_KEY_WALLET_PROFILER` | GSB Wallet Profiler + DCA Engine (agent 1333) — Virtuals Compute |
| `VIRTUALS_API_KEY_CEO` | GSB CEO (agent 1332) — Virtuals Compute |
| `VIRTUALS_API_KEY_ALPHA_SCANNER` | GSB Alpha Scanner (agent 1334) — Virtuals Compute |
| `VIRTUALS_API_KEY_TOKEN_ANALYST` | GSB Token Analyst (agent 1335) — Virtuals Compute |
| `VIRTUALS_API_KEY_THREAD_WRITER` | GSB Thread Writer (agent 1336) — Virtuals Compute |

---

## Third-Party Integrations

### Virtuals Compute (NEW — replaces old Privy JWT auth as of 2026-05-01)
- Base URL: `https://compute.virtuals.io/v1`
- Auth: `x-api-key: $VIRTUALS_API_KEY` (NOT Bearer token)
- OpenAI-compatible: `POST /v1/chat/completions` with `Authorization: Bearer $VIRTUALS_API_KEY`
- Anthropic-compatible: `POST /v1/messages` with `x-api-key: $VIRTUALS_API_KEY` + `anthropic-version: 2023-06-01`
- Available models: `anthropic/claude-sonnet-4-5`, `moonshotai/kimi-k2-0905`
- Old vars OBSOLETE: `VIRTUALS_PRIVY_TOKEN`, `VIRTUALS_PRIVY_REFRESH_TOKEN` — delete from Railway
- `acpAuth.js` will be rewritten to use per-agent keys once all keys are added by Erik
- Per-agent keys being added to Railway (Erik adding manually):
  - `VIRTUALS_API_KEY_CEO` — agent 1332 | Base Builder Code: `bc_qhc9o1lh` | Compute billing: FUNDED (2026-05-01)
    - Agent UUID: `019d7568-cd41-7523-9538-e501cc1875cc` | Created: 2026-04-09
    - EVM wallet: `0xb165a3b019eb1922f5dcda97b83be75484b30d27`
    - SOL wallet: `2XZYfpH6nSYL53C45RiNrCfkHr3LjSsrFxUgRcMc64Da`
    - Agent Token (GSB): `0x8E223841aA396d36a6727EfcEAFC61d691692a37` — tokenized
    - Wallet ID: `rrbxvrk8a6d8nb1tz9qdp76b`
    - Signer public key: `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEOloZLpdqX/gEW3gBAj4hAUQcFzbiFgEZ49Lb5WgvTH7Yb6IKd3vzCu41Sp+vtJA4UXwBYEz3p19EmLFRrqSNlg==`
  - `VIRTUALS_API_KEY_WALLET_PROFILER` — agent 1333 | Base Builder Code: `bc_7vtueq99`
    - Agent UUID: `019d756c-9eba-7600-81ba-f1c78f43277c` | Created: 2026-04-09
    - EVM wallet: `0xeb6447a8b44837458f391e2bac39990daf6bd522`
    - SOL wallet: `2CXT27mSGkriGmM5YtXZJ1HvkMxHNBgjpMArvfMzpn9m`
    - Wallet ID: `d3w35d9gcl1ll7bvdw1bx8b1`
    - Signer public key: `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEJVQtuRhQu2cgoT1zXk15viuU5Swy5oz/U/VVGv6JfJbcmDidbkliBeXeTz2wG/5NUHqHT4yivE9b9MIK4bVm7g==`
  - `VIRTUALS_API_KEY_ALPHA_SCANNER` — agent 1334 | Base Builder Code: `bc_5fdaj3ka`
    - Agent UUID: `019d755e-dfd0-7b6c-8b4c-21cfbe6fda1c` | Created: 2026-04-09
    - EVM wallet: `0x9d23bf7e4084e278a06c85e299a8ed5db3d663b5`
    - SOL wallet: `28v6FbWMkdv224cV3TS2brTdHK5LYAdmjFm6GUcQg23S`
    - Wallet ID: `gmk5zp1h21qq8ev4tlnv2nba`
    - Signer public key: `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEgKmR3QYy1aSj/42gHczjAoyuNA0Yp0ID3cT1rYkrlHkw8ZfWlaqvkc5AT8KeyWZhv5939h2txw8MhcTNc7xAWg==`
  - `VIRTUALS_API_KEY_TOKEN_ANALYST` — agent 1335 | Base Builder Code: `bc_hmt1owql`
    - Agent UUID: `019d756b-0217-7252-8094-7854afde1703` | Created: 2026-04-09
    - EVM wallet: `0x489a9d6c79957906540491a493a7a4d13ad0701a`
    - SOL wallet: `72W8cHsa6VSTcaWBWAnYZutH59CfP62xKK8zvwwB4XAo`
    - Wallet ID: `u0sqfq4gtr3ouz2o8bddgg81`
    - Signer public key: `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEQU/xmKDe9tNITxF1wkdcqHwAaE7LbZEQCry6q2peSavGNKdRiA+Qjy1lo6d3fVImzXA1kr5+VVFdZpobQL6L3g==`
  - `VIRTUALS_API_KEY_THREAD_WRITER` — agent 1336 | Base Builder Code: `bc_40rvhwqs`
    - Agent UUID: `019d7565-5b56-778e-8550-66ec4b179a81` | Created: 2026-04-09
    - EVM wallet: `0x2c281b4ba71e79dd91e3a9d78ed5348bc5774df9`
    - SOL wallet: `EJkaqQ2Z1mRQDJ2LMpiieaLFt7kqpSHcZSNXD5uV7SnX`
    - Wallet ID: `n83xb0y9gqm919ygu0trusm8`
    - Signer public key: `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEE8USEW4pWdqfupJJ+qQqmkCTTqdhANbCNSRu134A/UtUSUb1DIlSGOMJpMPIdLaocAPvruGBumkcM3llR4N1tw==`

### Twilio
- Voice number: **(904) 506-7476**
- Inbound voice webhook: `POST https://gsb-swarm-production.up.railway.app/api/voice/incoming`
- After Gather: `POST /api/voice/process`
- **PENDING SETUP:** SMS inbound webhook needs to be set in Twilio console to:
  `POST https://gsb-swarm-production.up.railway.app/api/rfq/sms-inbound`
  (Currently only voice is wired — SMS replies from providers won't work until this is set)
- Outbound callback calls: `POST /api/rfq/callback-twiml` (GET) + `/api/rfq/callback-process` (POST)
- Voice: `Polly.Joanna-Neural` everywhere

### Resend
- Domain: thelocalintel.com — verified, region us-east-1, registered on Namecheap
- Outbound: `jobs@thelocalintel.com` → providers get broadcast emails
- Reply-to encoding: `jobs+JOBCODE@thelocalintel.com` (e.g. `jobs+X4R9QW@thelocalintel.com`)
- DKIM: TXT record `resend._domainkey` — already set
- SPF: MX record `send` → `feedback-smtp.us-east-1.amazonses.com` priority 10 — already set
- Inbound MX: ✅ LIVE — `10 inbound-smtp.us-east-1.amazonaws.com` confirmed via dig (2026-05-02)
- Resend receiving: ✅ ENABLED — domain thelocalintel.com receiving active
- Resend webhook: ✅ LIVE — `email.received` → `https://gsb-swarm-production.up.railway.app/api/rfq/email-inbound` (enabled 2026-05-02)
- Inbound webhook: `POST /api/rfq/email-inbound` — extracts job code from To address

---

## Postgres Tables (auto-created, never drop)

### Core Business Intelligence
```
businesses           — 122k+ FL businesses. pos_config is JSONB. pos_type via pos_config->>'pos_type'
                        Enrichment cols (session 9): category_intel JSONB, enrichment_source TEXT
                        DEFAULT 'system', enrichment_updated_at TIMESTAMPTZ
business_tasks       — Per-business setup tasks seeded by taskSeedWorker.
                        Cols: id UUID PK, business_id UUID FK→businesses, title TEXT,
                        status TEXT ('pending'|'done'|'skipped'), task_type TEXT
                        ('setup'|'data'|'integration'), template_key TEXT, metadata JSONB,
                        created_at, updated_at. Indexed on business_id and status.
zip_intelligence     — 1,109 rows. Now includes irs_agi_median, irs_returns,
                        irs_wage_share, irs_updated_at (added by irsSoiWorker)
zip_briefs           — 1,193 rows. Single source for /brief/:zip
zip_enrichment       — 1,012 rows. OSM POIs cached by overpassWorker
census_layer         — 0 rows, DO NOT USE
task_events          — intelligence signal layer
worker_events        — enrichment worker logs (also feeds /source-log + /enrichment-log)
agent_sessions       — MCP agent sessions
task_patterns        — self-improvement patterns
business_responsiveness — response tracking
rfq_gaps             — unmatched voice/web requests for self-improvement batch
voice_leads          — legacy audit log (still written to for orders)
acp_broadcast_log    — every registry broadcast + per-zip announcements (acpBroadcaster)
mcp_probe_log        — probe scores per persona/tool/zip (auto-created)
router_learning_log  — proposed VERTICAL_SIGNALS keyword patches (auto-created)
```

### Postgres-only worker contract (session 8)
Every worker now follows the same five-step shape — **the Railway disk is
ephemeral; nothing persists across redeploys except Postgres**:

1. START → ASK Postgres what's already done.
2. WORK → only process what's missing/new.
3. END   → upsert the result back into Postgres.
4. REDEPLOY SAFE — step 1 naturally re-skips on the next boot.
5. `process.env.FULL_REFRESH === 'true'` ignores all skip logic.

| Worker | Skip query | Result table |
|---|---|---|
| overpassWorker | `SELECT DISTINCT zip FROM businesses WHERE 'osm' = ANY(sources) AND status != 'inactive'` | `businesses` (+ `zip_enrichment` cache) |
| zipBriefWorker | `SELECT zip FROM zip_briefs WHERE generated_at > NOW() - INTERVAL '7 days'` | `zip_briefs` |
| irsSoiWorker | `SELECT zip FROM zip_intelligence WHERE irs_agi_median IS NOT NULL` | `zip_intelligence` |
| acpBroadcaster | `SELECT DISTINCT zip FROM acp_broadcast_log WHERE broadcast_at > NOW() - INTERVAL '30 days'` | `acp_broadcast_log` |
| localIntelAcpCycle | `SELECT zip FROM zip_briefs WHERE generated_at > NOW() - INTERVAL '48 hours'` | `zip_briefs` |
| routerLearningWorker | `SELECT MAX(run_at) FROM router_learning_log` (skip if <30 min) | `router_learning_log` |
| enrichmentFillWorker | `SELECT business_id FROM businesses WHERE zip = ANY(TARGET_ZIPS) AND category_intel IS NOT NULL AND enrichment_source IS NOT NULL` | `businesses` (services_text, description, category_intel, enrichment_source, enrichment_updated_at) |
| taskSeedWorker | `SELECT DISTINCT business_id FROM business_tasks` (run-once) | `business_tasks` |

`embeddingWorker` is **disabled** in `dashboard-server.js` — needs pgvector
to be revived.

All `data/*.json` writes for these workers are removed. CSV downloads
(IRS SOI) live in `os.tmpdir()`. Static seeds (e.g. `data/spendingZones.json`)
remain on disk but are read-only.

### Voice / Session
```
voice_sessions       — Postgres-backed CallSid session state for multi-turn ordering
                       Stages: greeting | menu_presented | order_building | order_confirmed
```

### RFQ Broadcast System (NEW — auto-created by lib/rfqBroadcast.js)
```
rfq_jobs             — id(UUID), code(6-char), caller_phone, caller_name, caller_email,
                       category, zip, description, status, broadcast_count, response_count,
                       selected_biz_id, callback_fired, created_at, expires_at(24h)
                       Status: open | matched | confirmed | closed | expired | no_providers

rfq_broadcasts       — job_id(FK), business_id, business_name, phone, email,
                       sms_sent, email_sent, sent_at

rfq_responses        — id(UUID PK), rfq_id(FK→rfq_requests), business_id, business_name,
                       quote_usd, message, eta_minutes, status(pending|accepted|declined), created_at
```

### Identity (NEW — auto-created by lib/callerIdentity.js)
```
caller_identities    — phone(PK), name, email, email_pending, zip,
                       wallet_address, wallet_chain, wallet_provisioned,
                       agent_key, rfq_count, order_count, created_at, last_seen
```

---

## Key Files

### Backend (`gsb-swarm/`)
| File | Purpose |
|---|---|
| `dashboard-server.js` | Main Express server — all routes registered here |
| `localIntelAgent.js` | `/api/local-intel/*` routes — search, ask, sector-gap, oracle |
| `lib/intentMap.js` | **Single NL intent source of truth** — resolveIntent() + detectOpenIntent(). Both web + voice import this. Zero LLM. |
| `lib/voiceIntake.js` | Twilio voice handler — all stages, session state, RFQ routing |
| `lib/voiceSession.js` | Postgres CallSid session for multi-turn ordering |
| `lib/posRouter.js` | POS routing: fetchMenu, matchItems, placeOrder |
| `lib/ucpAgent.js` | Surge/UCP POS handler — normalizeItem resolves prices from modifier groups |
| `lib/rfqBroadcast.js` | RFQ job creation, provider broadcast (SMS+email), response recording |
| `lib/rfqCallback.js` | Outbound Twilio callback call — reads responses, confirms selection |
| `lib/callerIdentity.js` | Wallet-agnostic caller identity — phone→name/email/wallet |
| `lib/db.js` | Postgres client — returns arrays directly, never .rows |
| `workers/hoursParseWorker.js` | **OSM hours→hours_json** — batch parser + isOpenNow(). Runs on startup + daily. |
| `workers/enrichmentAgent.js` | Signal narrative builder — zero LLM, runs every 10 min |
| `workers/intentRouter.js` | MCP intent routing — deterministic vocabulary scoring |

### Landing (`localintel-landing/`)
| File | Purpose |
|---|---|
| `index.html` | Landing page — search bar + Call (904) 506-7476 CTA |
| `search.html` | Conversational thread UI — full Q&A history, follow-up context resolution, task handoff to RFQ. Thread above, cards below. Fresh on refresh. |

---

## API Endpoints (live on Railway)

### LocalIntel Intelligence
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/local-intel/search?q=&zip=&cat=&limit=` | Business search + service request detection + RFQ broadcast |
| GET/POST | `/api/local-intel/ask?q=&zip=` | MCP intelligence query |
| GET | `/api/sector-gap/feed` | ZIP market briefs |
| GET | `/api/local-intel/profile/:business_id` | Full business profile + tasks array + task_summary |
| GET | `/api/local-intel/tasks/:business_id` | Tasks array for business (404 if biz not found) |
| POST | `/api/local-intel/tasks/:business_id` | Insert new task or update by id (body: title, status, task_type, template_key, metadata) |
| PATCH | `/api/local-intel/tasks/:business_id/:task_id` | Update task status (body: {status}) |

### Voice
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/voice/incoming` | Twilio initial call — greeting gather |
| POST | `/api/voice/process` | Twilio SpeechResult — process intent |

### RFQ Broadcast
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/rfq/sms-reply` | Provider SMS replies (YES-CODE, 1/2/3, CONFIRM, WALLET) |
| POST | `/api/rfq/sms-inbound` | Alias for above |
| GET | `/api/rfq/callback-twiml?jobId=` | TwiML for outbound callback to caller |
| POST | `/api/rfq/callback-process?jobId=` | Caller's spoken provider selection |
| POST | `/api/rfq/callback-status` | Twilio call status log |
| POST | `/api/rfq/email-inbound` | Resend inbound email replies from providers |

---

## Architecture Decisions (locked in — don't revisit)

- **Phase 1 search foundation**: `search_vector` tsvector GIN index on businesses, `cuisine` column, `searchVectorBackfillWorker` runs on startup. Builder is `businesses_search_vector_build(name, category, description, services_text, tags, cuisine)` — weights A/B/B/C/C/D. Migration `migrations/005_search_vector.sql`; `lib/dbMigrate.js` now scans both `db/` and `migrations/`.
- **categoryReclassWorker**: runs on startup (forked alongside searchVectorBackfillWorker, 90s stagger), fixes rows where `category='LocalBusiness'` or `NULL` using `inferCategoryFromName` (copied from `workers/yellowPagesScraper.js`). Keyset-paged batches of 200 on `business_id`. Sets `category_source='inferred_backfill'` if column exists; rebuilds `search_vector` per row (try/catch). 24h skip-set via `worker_events`; `FULL_REFRESH=true` overrides.
- **Phase 2 search**: `classifyIntent()` in `workers/intentRouter.js` (deterministic, zero LLM) → `CATEGORY_SEARCH` (category filter + isOpenNow when needed) or `TEXT_SEARCH` (tsvector `ts_rank`). Wired into `POST /api/local-intel`. `ORDER_ITEM` intent passes through to legacy handler so Basalt order flow is untouched. Fallback to ILIKE on 0 results. `has_wallet` boost in both paths. Multi-ZIP fanout across `['32082','32081','32250','32266','32233','32259','32034']` when no ZIP pinned.
- **No LLM on the hot path** — zero LLM API calls for LocalIntel intelligence. Deterministic vocabulary scoring only.
- **Postgres is king** — all state lives in Postgres. No in-memory state across requests.
- **`db.query()` returns array directly** — never `.rows`. This is a custom wrapper.
- **`pos_type` is not a column** — always `pos_config->>'pos_type'`
- **Twilio voice** — `Polly.Joanna-Neural` always. CallSid keyed sessions.
- **Payment rails** — Tempo mainnet (pathUSD) for LocalIntel queries. Base USDC also supported.
- **Wallet-agnostic identity** — any chain, no lock-in. We can provision Tempo or Base wallets but never force them.
- **Service request detection** — `detectServiceRequest()` in localIntelAgent.js runs BEFORE name lookup so "I need my X fixed" doesn't match businesses named "Need"
- **RFQ callback trigger** — Hybrid C: 3 responses OR 30 min, whichever first. 10-min poll in setInterval.
- **Email confirmation** — voice-parsed emails go to `email_pending`, confirmed via SMS reply CONFIRM. Never trust voice-parsed email directly.
- **Dashboard is INTERNAL ONLY** — never build customer UX in swarm-deploy-throw.vercel.app

---

## McFlamingo Reference
- `business_id`: `232c34cb-ff82-4bf9-8a5c-d13306550709`
- ZIP: `32082`, phone: (904) 584-6665
- Address: 880 A1A N Suite 12, Ponte Vedra Beach FL 32082 (ONE LOCATION ONLY — second location closed)
- `pos_type`: `other` → routes to ucpAgent → surge.basalthq.com
- Surge price structure: `priceUsd: 0` on parent item, real price in `attributes.modifierGroups[].modifiers[].priceAdjustment`
- Wine items confirmed correct in Surge catalog (La Marca Prosecco 187ML $10, etc.)
- Hours: Mon-Sat 10:30-20:00, Wed 10:30-21:00, Sun 10:30-18:00
- Tags: healthy, organic, best_of_ponte_vedra, local_favorite, gluten_free, vegan_friendly, yelp_top_rated
- wallet: `0xe66cE7E6d31A5F69899Ecad2E4F3B141557e0dED`

---

## Payment / Chain Reference
| Chain | Token | Treasury |
|---|---|---|
| Tempo mainnet | pathUSD | `0x774f484192Cf3F4fB9716Af2e15f44371fD32FEA` |
| Base mainnet | USDC | `0x1447612B0Dc9221434bA78F63026E356de7F30FA` |

---

## Pending Setup (requires Erik action)

### 1. Twilio — ✅ FULLY DONE (2026-05-01)
- Webhook: `https://gsb-swarm-production.up.railway.app/api/rfq/sms-inbound` (HTTP POST, URL only, no 'POST ' prefix)
- A2P 10DLC: brand registered Low-Volume Standard ($4.50), campaign registered
- Account upgraded from Trial to paid
- SMS broadcasting fully unblocked

### 2. Resend inbound MX record — ✅ COMPLETE (2026-05-02)
- MX live, receiving enabled, webhook wired to `/api/rfq/email-inbound`
- Enables: provider email replies matched back to jobs by code

---

## Intent Layer — lib/intentMap.js

**The single source of truth for NL intent resolution. Both web search and Twilio voice import this module.**

`resolveIntent(text)` → `{ cat, tags, deflect, confidence }`
- `cat` — CAT_EXPAND key (e.g. `restaurant`, `landscaping`, `healthcare`)
- `tags` — optional filter hints (e.g. `['healthy','vegan']` for dietary queries)
- `deflect` — true for out-of-scope: home automation, weather, flights, recipes
- `confidence` — `'high'` (regex/NL match) | `'keyword'` (substring) | `null`

**Two-pass resolution:**
1. Regex rules — NL phrases and questions ("where should I eat", "I need a plumber")
2. Keyword map — voice-style substring match ("lawn", "eat", "hvac")

**Covers the 50 common human prompts deterministically. Zero LLM.**

Adding new intent = add one entry to `intentMap.js`. Voice + web both benefit instantly.

---

## Payment Model (locked in)

**Businesses pay micro-fees to be in the routing flow — not consumers.**
- `$0.001–$0.05` per agent/human query routed to them (compute cost for being surfaced)
- `0.05%–1%` on confirmed transactions (purchase, booking, RFQ accepted)
- `wallet IS NOT NULL` = in the paid routing tier. No wallet = in DB but agents skip you.
- x402 middleware flips from "consumer pays to query" → "business pays to be found"
- Payment rail: Tempo mainnet pathUSD

This means the claimed+wallet businesses are the product. The data layer is the engine.

---

## Data Layer — What's Actually In Postgres (corrected)

### businesses table — key enrichment columns
| Column | Status | Notes |
|---|---|---|
| `hours` | 72k rows populated (50k FL) | OSM string format `Mo-Fr 09:00-17:00` |
| `hours_json` | Column exists, mostly null | Parse pass needed to activate "open now" |
| `price_tier` | Column exists, mostly null | `casual` / `upscale` / `fine_dining` |
| `services_text` | Column exists, sparse | Free text from website scrape |
| `services_json` | Column exists, sparse | Structured services array |
| `tags` | Populated for claimed only | TEXT[] — used for dietary/specialty filters |
| `description` | Populated for claimed only | Business voice from website |
| `menu_url` | Sparse | Links to menu page |
| `wallet` | Claimed businesses only | Routing gate — no wallet = not in paid tier |

### zip_intelligence — rich ZIP-level data already live
`population`, `median_household_income`, `median_home_value`, `consumer_profile`,
`saturation_status`, `growth_state`, `sector_counts`, `market_opportunity_score`,
`dominant_sector`, `business_density` — all populated for FL ZIPs

---

## Roadmap (next sessions)

### Tier 2 — Data Activation ✅ COMPLETE (session 7)
1. ✅ `workers/hoursParseWorker.js` — OSM→hours_json JSONB, zero LLM. Startup + daily batch. `isOpenNow()` uses America/New_York.
2. ✅ Wired into `dashboard-server.js` LOCAL_INTEL_WORKERS
3. **Populate `price_tier`** — deterministic from `category` + `tags` (fast_food→$, upscale_dining→$$$) — NEXT
4. **Populate `tags` for unclaimed businesses** — from `category` + `services_text`, no LLM — NEXT
5. **Surface `zip_intelligence` fields** in ZIP queries — answers WHY — NEXT

### Tier 3 — Wallet Routing Priority ✅ COMPLETE (session 7)
1. ✅ `wallet IS NOT NULL` sort in SQL ORDER BY — all 9 GET /search queries. No JS sort. Postgres is king.
2. ✅ `in_routing_tier: true` flag returned per result
3. Micro-fee debit per routing event (x402 pathUSD `$0.001–$0.05`) — PENDING
4. Transaction fee hook in RFQ confirmation — PENDING

### Tier 4 — Open Now Query Path ✅ COMPLETE (session 7)
1. ✅ `detectOpenIntent(text)` in `lib/intentMap.js` — now / late / early / weekend
2. ✅ GET /search filters `rows` by `hours_json` when openIntent is set
3. ✅ Graceful fallback: < 3 results → returns full unfiltered list

---

## Conversational Search — Design Philosophy

LocalIntel search is built around how humans actually think and talk. A person asking "can you get me a landscaper at 205 Odoms Mill Blvd in Ponte Vedra" isn't running a database query — they're starting a conversation. They expect to follow up: "what kind of work do they do?" or "ok call them." That's the flow we support.

**Thread model:**
- Every Q&A pair is a turn. The full thread stays visible above — user bubbles right (green), agent left with avatar.
- The agent always has context of what came before. Follow-up pronouns (they/them/their/it) resolve to the last business returned.
- The API receives `ctx_business` and `ctx_names` on every call so the backend can use prior context too.
- Task handoff: if the user says "ok call them / go ahead / yes call / send it," the UI fires an RFQ for the last business in context and shows a task card with the job code and call CTA.
- Fresh on every refresh — no localStorage. Conversation state is in memory only.

**Why this matters for the north star ($546k):**
The data we're collecting isn't just a directory. It's the intelligence layer that lets an agent answer follow-up questions, surface context, and hand off to real action. The UI embodies that — it's not a search box, it's a conversation that ends in a task.

---

## Known Issues / Gotchas

- **Worker throttling (2026-05-02):** mcpProbeWorker disabled (no real users yet — re-enable when live traffic arrives). enrichmentAgent slowed to 6hr, zipCoordinator slowed to 1hr. All other workers unchanged. Re-enable/speed up when user volume justifies it.
- **rfq_responses schema:** Old table (job_id bigint PK, wrong columns) detected and dropped automatically by `migrate()` in rfqService.js on startup. Correct schema (rfq_id UUID FK, quote_usd, status, etc.) now live as of 2026-05-02. No manual intervention needed going forward.
- **caller_identities + voice_sessions:** Auto-create via `migrate()` in Railway process works but the `migrated=true` flag caches after first run. If tables are missing, create them directly in Postgres (done 2026-05-01).
- **`migrated` flag in rfqBroadcast.js:** Module-level boolean prevents re-running migrations on live process. If table schema changes, must run migration SQL directly against Postgres.
- **Resend MX value:** Correct value is `inbound-smtp.us-east-1.amazonaws.com` — NOT `inbound.resend.com`.
- **Twilio SMS URL:** Must be URL only — no `POST ` prefix. Twilio prepends method label in UI which caused initial save error.
- **`db.query()` returns array** — never `.rows`. Critical — breaks silently if wrong.
- **`pos_type` not a column** — always `pos_config->>'pos_type'`.

---

## Session History (what's been built)

### gsb-swarm commits (2026-05-03, session 10)
- `workers/businessMergeWorker.js` added — Union-Find cluster detection on phone (digits-only, ≥10) + name/address-prefix proximity. Scored canonical selection (confidence_score, claimed_at, owner_verified, field completeness, longer name as tie-breaker). Merges best non-null fields from siblings into canonical. Reassigns FKs in `business_tasks`, `source_evidence`, `notification_queue`, `task_events`, `business_responsiveness` BEFORE deleting sibling rows. Exports `runMerge()` and `triggerMerge()`. Standalone daemon mode (every 6h) only when `require.main === module`.
- Wired into `LOCAL_INTEL_WORKERS` in `dashboard-server.js` (forked alongside enrichmentFillWorker / taskSeedWorker).
- Triggered automatically at the END of `overpassWorker.runPass()` — every fresh ingestion pass now ends with a dedupe sweep, no manual intervention.
- Live Postgres test: **Valley Smoke 4 rows → 2 rows after merge** (3 cluster duplicates collapsed to canonical confidence=0.9; "Palm Valley Smoke" correctly left alone — different name root, no shared phone). Targeted run completed in 3.3s with 0 errors. Full-DB pass on 244k active rows finds ~13.7k clusters of ≥2 rows.

### gsb-swarm commits (2026-05-03, session 7)
- `608976e` — fix: Tier 3 wallet sort moved to SQL ORDER BY — all 9 GET /search queries now use `(wallet IS NOT NULL) DESC, (claimed_at IS NOT NULL) DESC, confidence_score DESC`. JS sort block removed. Postgres is king.
- `86ffdf1` — feat: Tiers 2-4 — hours parse worker, wallet routing priority, open-now filter. workers/hoursParseWorker.js (OSM→hours_json, zero LLM, 9/9 test cases, startup+daily batch, isOpenNow). dashboard-server.js wired into LOCAL_INTEL_WORKERS. lib/intentMap.js detectOpenIntent() now/late/early/weekend. localIntelAgent.js Tier 3 wallet sort + Tier 4 open-now filter with graceful fallback.

### gsb-swarm commits (2026-05-02, session 6)
- `0aae74f` — feat: shared NL intent layer (lib/intentMap.js) — web + voice unified. resolveIntent() covers 50 human prompts deterministically. localIntelAgent.js and voiceIntake.js both import it. BASE_SELECT now returns hours, hours_json, price_tier, services_text. McFlamingo record updated with real website description, mcflamingo.com URL, services_text, expanded tags.

### localintel-landing commits (2026-05-02, session 6)
- `3448e72` — feat: rich business cards (description/services blurb, hours, price_tier badge) + auto-seed changed to 'Where should I eat in Ponte Vedra?' + out_of_scope deflect message

### gsb-swarm commits (2026-05-02, session 5)
- `a7f7437` — docs: context update (session 4 close)
- `d426189` — fix: about-business query extraction (ABOUT_BIZ_RE regex); FL-only ILIKE scope (ZIPs 32004–34997); stop word expansion; longest-token-first fallback. Fixes "what kind of landscaping does X do" returning wrong businesses.
- `b4b8f49` — fix: remove duplicate /search route — old stub at line 451 intercepted all requests before full route with CAT_EXPAND, service_request detection, narratives. Caused all category expansion and NL intent to be silently skipped.
- `a0bf29d` — feat: brief narratives enriched — zipBriefWorker now includes description/tags in notable_businesses; /brief/:zip reads from Postgres not filesystem; search returns narrative for ZIP-level queries.
- `4a21278` — fix: expand GET /search category filter — dropdown slugs (restaurant/plumber/electrician/etc) now map to ALL matching DB sub-categories via ANY array; previously exact match returned 0 results for most categories
- `2dba0b2` — fix: rfq_jobs→rfq_requests (table was renamed in rfqService migration, dashboard-server still used old name → rfq-poll 500 errors); committed spendingZones.json to git (was in .gitignore → never deployed to Railway → zones.find crash on every acp-cycle ZIP); truncate overpass addr.postcode to 5 chars (ZIP+4 codes were hitting CHAR(5) column constraint)
- `c1580cc` — feat: add GET /api/local-intel/search — maps q/zip/cat query params to business search for search.html. Root cause of search returning nothing: search.html called GET /api/local-intel/search but only POST / existed — catch-all was serving dashboard HTML. Now fixed with proper GET route using same SQL logic.
- `05b4ee3` — feat: port all filesystem workers to Postgres — ocean_floor, census_layer, wave_surface, wave_events, oracle reads, gaps, briefs, zip_queue, source_log, btr, evolution. All `workers/*.js` workers now write/read dynamic data via `lib/pgStore.js` (with extended schema for `rfq_gaps`, `source_log`, and full-state `zip_queue`). No worker still writes JSON files under `data/` for dynamic state — only static seeds (e.g. `spendingZones.json`) remain on disk.
- `3a5f9bf` — fix: stop log spam — cap 32-bit setTimeout overflow + rate-limit ACP token error logs
- `6b41a26` — docs: update context — Virtuals Compute new auth, per-agent API key vars
- `e32a04a` — feat: replace Privy JWT auth with Virtuals Compute API keys (acpAuth.js rewrite)
- `0cf9841` — test: add /api/compute/test route
- `5907beb` — fix: compute/test — parallel Promise.all to avoid 75s sequential timeout
- `8056494` — fix: bedrockWorker + censusLayerWorker 32-bit overflow
- `8f674ad` — fix: bedrockWorker — once-a-month, graceful failure, FDOT stubbed
- `9e1e0ff` — fix: rfq_responses old schema drop+recreate on migration; createJob BigInt serialization
- `56f75e4` — docs: mark Resend inbound MX + webhook complete
- `1647d93` — feat: LocalIntelIntent JSDoc typedef + internal intent logging in /ask and /mcp (no public response change)
- `2926bb5` — perf: disable mcpProbeWorker; slow enrichmentAgent 10min→6hr; zipCoordinator 2min→1hr

### localintel-landing commits (2026-05-02)
- `858a5ee` — feat: conversational thread UI — full rewrite of search.html. Each Q&A pair stays visible in thread (user bubbles right, agent left). Follow-up pronouns (they/them/their/it) resolve to last business in context. Thread context (ctx_business, ctx_names) passed to API on every call. Task handoff regex fires RFQ when user says 'ok call them / go ahead / send it'. No localStorage — fresh on refresh. Auto-seeds '32082' on load. **DEPLOYED to www.thelocalintel.com (commit 858a5ee)**
- `cb7de6f` — feat: narrative card shows real business spotlight — description + tags from claimed businesses above result cards
- `9261a99` — fix: remove escaped backtick `\`` in renderServiceRequest template literal — this was a JS syntax error that prevented ALL JavaScript from parsing: runSearch, renderResults, esc(), and event listeners were all dead. Root cause of search showing nothing on load and not responding to any interaction.
- `3d45698` — fix: category option values now match DB slugs (was sending 'Restaurant', DB stores 'restaurant'); removed truncated broken `if (status === 'cla` line that was a JS syntax error killing all rendering. Deployed to www.thelocalintel.com.
- `83cf741` — fix: complete truncated renderResults + auto-search on load and filter change (search was broken — JS file cut off mid-function)

### Committed prior session (2026-05-01)
- `25b7cd9` — Voice session state: `lib/voiceSession.js`, `handleMenuResponse`, `handleOrderBuilding` — multi-turn ordering with Postgres CallSid sessions
- `6bead23` — Service request detection in `/search` — "I need my X fixed" no longer matches business names
- `258ae3f` — Full RFQ broadcast system:
  - `lib/rfqBroadcast.js` — job creation, provider blast SMS+email, response recording, confirmation
  - `lib/rfqCallback.js` — outbound Twilio callback call to caller, spoken selection
  - `lib/callerIdentity.js` — wallet-agnostic identity, email confirmation via SMS, wallet attach
  - All webhooks: `/api/rfq/sms-reply`, `/api/rfq/callback-twiml`, `/api/rfq/callback-process`, `/api/rfq/email-inbound`
  - 10-min background poll for 30-min callback trigger
  - `postVoiceRfq` in voiceIntake.js replaced with rfqBroadcast
  - `/search` service_request path broadcasts RFQ + returns job code in narrative

### Prior sessions (preserved from summary)
- Signal-based enrichment worker: `buildSignalNarrative` + `applySignalNarrative` in enrichmentAgent.js
- McFlamingo Postgres enriched: description, tags, no second location
- Voice fixes: food keyword map, pos_type column fix, honest feedback paths, SMS loop close
- Surge modifier price fix: normalizeItem walks modifierGroups for real price
- Narrative intel card: `/search` detects "what is X" intent, builds deterministic narrative
- intentRouter: removed 'realtor' as default vertical fallback
- LocalIntel landing: search bar, call CTA, narrative card UI

---

## North Star
**$546k / LocalIntel = Bloomberg of the agent economy for local commerce**
- Three buyer profiles: B2B SaaS/POS, Commercial RE/investors, Franchise operators
- Payment: Tempo mainnet pathUSD for all LocalIntel query pricing
- Everyone pays in pathUSD — no registration, no query. No balance, no response.
- All agents running without human in the loop — full autonomy

### gsb-swarm commits (2026-05-03, session 10)
- `023a9a2` (localintel-landing) — feat: card UI — website field always visible on every result card; clickable blue link (globe icon + ↗) if present, muted italic "No website listed" if not. Encourages business owners to claim profiles.
- `915e338` — feat: businessMergeWorker — cluster-merge duplicate business rows into one confident record
  - Union-Find clustering: phone (name-similarity gated, ≥4 char common prefix or substring match to avoid grouping shared-line group practices) + normName+normAddr
  - Scored canonical: wallet(8)+claimed_at(4)+website(2)+phone(1)+hours_json(1)+description(1)
  - Merge: best non-null fields across cluster members; services_text union; longer description wins; most-decimal lat/lon wins; non-LocalBusiness category preferred; confidence_score += 0.1/source capped at 1.0
  - Batch task ops: delete conflict titles first, then reassign remaining in 2 SQL calls (avoids unique constraint race)
  - Scoped to 7 target ZIPs (fast index hit, no full FL table scan)
  - worker_events logging: correct schema (worker_name, meta columns)
  - 6h skip window; respects FULL_REFRESH=true env var
  - Wired into LOCAL_INTEL_WORKERS in dashboard-server.js (auto-spawned on Railway)
  - Auto-triggered at end of overpassWorker.runPass() after each ingestion cycle
  - Live test result: 3600 rows loaded, 63 clusters found, 60 merged, 76 rows deleted, 0 errors
  - Valley Smoke: 3 ingestion dupes → 1 canonical (ZIP 32082, conf 0.9, website populated)
  - Phone-only shared lines (dental group practices) correctly NOT merged (name similarity gate)

### gsb-swarm + localintel-landing commits (2026-05-03, session 10 continued)
- `244f94b` (gsb-swarm) — feat: order intent routing — detect order queries, return menu_url CTA, log to usage_ledger
  - `_ORDER_INTENT_RE` fires BEFORE service-request and name-search branches in GET /search
  - Matches: "order food from X", "order from X", "place an order at X", "i'd like to order from X", "get/grab food from X", "food from X", "order at X", bare "i want to order"
  - Extracts business name → ZIP-scoped ILIKE lookup → NE-FL fallback
  - Returns `{ intent:'order', business, message, cta_label:'Start Order →', cta_url, fallback_phone }`
  - `cta_url` = `menu_url` (Toast/Surge link) || `website` fallback
  - Logs `query_type='order_routing'` to `usage_ledger` with `cost_path_usd=0` (fee hook for future on-chain confirmation)
  - `intent:'order_not_found'` when no business match
- `8951ffa` (localintel-landing) — feat: order-start card — render focused order CTA when intent=order
  - `buildAgentBubble` short-circuits on `intent==='order'`: agent bubble + `.order-card` with green "Start Order →" button → `cta_url` (new tab), `tel:` phone link, "Powered by Toast · Routed by LocalIntel" footer
  - `.order-card` styled to match existing result cards (white bg, green top border, shadow)
  - `intent==='order_not_found'` renders bubble only

### Payment model notes (architecture locked)
- LocalIntel = routing layer only. Does NOT process orders or payments.
- `menu_url` on `businesses` table is the agentic handoff link (Toast/Surge for McFlamingo)
- Routing fee (0.05%–1% on confirmed transactions) triggered by future on-chain confirmation wired to `usage_ledger.tx_hash`
- Businesses without `menu_url` fall back to `website`; future: Surge agentic API can place order directly

## Basalt/Surge API — Complete Reference

> Captured from Basalt developer docs shared in session. All endpoints use base URL `https://surge.basalthq.com`.

---

## Auth

- Header: `Ocp-Apim-Subscription-Key: <BASALT_API_KEY>` — this is the ONLY required auth header
- APIM automatically stamps `x-subscription-id` for the backend
- **NEVER send** `x-wallet`, `x-merchant-wallet`, or `wallet` headers — APIM strips them and returns 403

---

## Health

```
GET /healthz
```
- Public, no auth required
- Returns: `{ ok: true, status: "ok", dependencies: { apim, backend, database } }`
- Use to verify Basalt service is up

---

## Inventory

```
GET /api/inventory
```
- Fetch merchant SKU catalog
- Query params:
  - `priceMin=0.01` — filters out $0.00 modifier/add-on items
  - `pack=restaurant` — restaurant-optimized response shape
  - `q=<search term>` — full-text search
  - `category=<category>` — filter by category
  - `tags=<tag>` — filter by tag
  - `limit=<n>` — max 200 per page
  - `page=<n>` — pagination
- `stockQty: -1` means unlimited stock
- Returns array of SKU objects: `{ sku, name, description, price, category, tags, stockQty, imageUrl }`
- Use `priceMin=0.01` to exclude modifiers when building order UIs

---

## Orders

```
POST /api/orders
```
- Body: `{ items: [{ sku: string, qty: number }], jurisdictionCode: 'US-FL' }`
- `jurisdictionCode` is required — always `'US-FL'` for McFlamingo
- Returns: `{ ok: true, receipt: { receiptId, totalUsd, lineItems, status } }`
- Error `items_required` (400) if items array is empty
- Error `inventory_item_not_found` (400) if SKU doesn't exist
- Error `split_required` (403) if merchant split is not configured (McFlamingo split IS configured)

---

## Receipts

```
GET /api/receipts/status?receiptId=<id>
```
- Returns: `{ id, status, transactionHash, currency, amount }`
- Full status flow: `generated → pending → paid → completed`
- Other statuses: `refunded`, `tx_mined`, `recipient_validated`, `tx_mismatch`, `failed`
- Poll for `completed` / `tx_mined` / `recipient_validated` to confirm payment
- Webhook: Set `webhook_url` on `POST /api/receipts` for push notification on payment

---

## Payment Portal

- Payment URL: `https://surge.basalthq.com/portal/${receiptId}`
- Iframe embed params: `?recipient=<wallet>&embedded=1&correlationId=${receiptId}`
- McFlamingo recipient wallet: `0xe66cE7E6d31A5F69899Ecad2E4F3B141557e0dED`
- Full iframe URL: `https://surge.basalthq.com/portal/${receiptId}?recipient=0xe66cE7E6d31A5F69899Ecad2E4F3B141557e0dED&embedded=1&correlationId=${receiptId}`
- **CSP ACTION NEEDED**: Ask Basalt team to add `thelocalintel.com` to `frame-ancestors` for `/portal/*`
- PostMessage events from iframe:
  - `gateway-card-success` — payment completed
  - `gateway-card-cancel` — user cancelled
  - `gateway-preferred-height` — iframe resize hint
- Origin check: `event.origin !== 'https://surge.basalthq.com'` → return (ignore)
- CSP fallback: if iframe blocked after 4s, open `paymentUrl` in new tab

---

## Shop Config

```
GET /api/shop/config                          (by subscription key)
GET /api/shop/config?slug=mcflamingo         (public, no auth)
```
- Returns merchant configuration, branding, enabled features

---

## Split

- Split contract MUST be configured in Admin UI before orders can be placed
- McFlamingo split: **ALREADY CONFIGURED** — not a blocker
- Default split: merchant 99.5% (9950 bps) / platform 0.5% (50 bps)
- Processing fee: 0.5% base + configurable merchant add-on, applied after tax
- Error `split_required` (403) if split not configured

```
GET /api/split/transactions    (subscription key required)
```
- Returns split transaction history

---

## Billing

```
GET /api/billing/balance
```
- Returns: `{ balances: [{ currency, available, reserved }], usage: { monthUsd } }`

---

## Tax Catalog

```
GET /api/tax/catalog
```
- Returns valid `jurisdictionCode` values
- Use to validate before placing orders

---

## Users

```
GET /api/users/search?q=<query>&live=true
```
- Wallet lookup / user search
- `live=true` for real-time results

---

## GraphQL

```
POST /api/graphql
```
- Read-only API
- Supported queries:
  - `user(wallet: "<addr>")` — user profile
  - `liveUsers` — currently active users
  - `leaderboard(limit: <n>)` — top users

---

## Subscriptions (Recurring Payments)

```
POST /api/subscriptions/plans
```
- Uses EIP-712 SpendPermission for recurring billing
- SpendPermissionManager contract: `0xf85210B21cC50302F477BA56686d2019dC9b67Ad` (Base mainnet)
- Base mainnet USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals)

---

## Reserve

```
GET /api/reserve
```
- Returns reserve/liquidity data for the merchant

---

## Supported Cryptocurrencies

- ETH, USDC, USDT, cbBTC, cbXRP

---

## Error Codes

| Code | HTTP | Description |
|------|------|-------------|
| `split_required` | 403 | Merchant split contract not configured |
| `unauthorized` | 401 | Missing or invalid subscription key |
| `forbidden` | 403 | Wallet header present (strip it!) or other auth failure |
| `inventory_item_not_found` | 400 | SKU not found in merchant catalog |
| `rate_limited` | 429 | Too many requests |
| `items_required` | 400 | Empty items array in order POST |
| `cosmos_unavailable` | — | Basalt internal DB unavailable; `response.degraded=true` |

---

## Degraded Mode

- When Cosmos (Basalt's internal DB) is unavailable, responses include `degraded: true`
- Data temporarily served from memory/cache
- Orders and payments may still work in degraded mode

---

## McFlamingo Reference

| Field | Value |
|-------|-------|
| business_id | `232c34cb-ff82-4bf9-8a5c-d13306550709` |
| Basalt slug | `mcflamingo` |
| merchant wallet | `0xe66cE7E6d31A5F69899Ecad2E4F3B141557e0dED` |
| jurisdictionCode | `US-FL` |
| Split configured | YES |
| Inventory SKUs | 92 (wine, food, beverages, dressings) |
| $0.00 items | Modifiers/add-ons — exclude from order UI |

---

## Three-Tier Architecture

```
Frontend (no key)
    ↓
gsb-swarm backend (holds BASALT_API_KEY)
    ↓
Basalt API (https://surge.basalthq.com)
```

Never expose `BASALT_API_KEY` to frontend. All Basalt calls must go through the gsb-swarm backend proxy.

---

## Agentic Order Flow (Implemented)

1. User types "order X from Y" → `ORDER_ITEM` intent detected in `localIntelAgent.js`
2. `GET /api/local-intel/menu/:business_id?q=X` → fetches Basalt inventory, fuzzy-matches items
3. User selects item → `POST /api/local-intel/place-order` → creates Basalt order, returns `receiptId + portalLink`
4. Frontend shows payment iframe (`surge.basalthq.com/portal/${receiptId}`)
5. `GET /api/local-intel/order-status/:receiptId` polls receipt status → logs to `usage_ledger` on `gateway-card-success`

```
ORDER_ITEM regex (full):    /(?:\border(?:\s+me)?\s+|\bI(?:'d|\s+would)\s+like\s+|\bI\s+want\s+|\bget\s+me\s+|\bcan\s+I\s+(?:get|order)\s+)(?:a\s+|an\s+|some\s+)?(.+?)\s+(?:from|at)\s+(.+?)(?:\s+(?:in|near)\s+.+)?$/i
ORDER_ITEM regex (partial): /(?:\border(?:\s+me)?\s+|\bI(?:'d|\s+would)\s+like\s+|\bI\s+want\s+|\bget\s+me\s+|\bcan\s+I\s+(?:get|order)\s+)(?:a\s+|an\s+|some\s+)?(.+?)(?:\s+(?:in|near)\s+.+)?$/i
AT_BIZ regex (resolves pending intent): /^(?:at|from)\s+(.+?)(?:\s+(?:in|near)\s+.+)?$/i
```

Two-turn flow: a partial match ("I want chicken") returns `intent: 'ORDER_ITEM_PARTIAL'` and stores the item in an in-memory `_pendingOrderIntent` Map keyed by sessionId (5-min TTL). The next message ("at McFlamingo") matches `AT_BIZ`, pulls the pending item, and runs the normal ORDER_ITEM resolver. SessionId derives from `x-session-id` header or falls back to forwarded-for/remoteAddress IP.

Fuzzy match: token overlap scoring, no LLM, STOP words filtered.

---

## Shopify Future Path

Businesses with Shopify → Surge import can be routed via Shopify Storefront API (future feature).


---

## Patches Applied 2026-05-03 (session 11 — Basalt API correctness pass)

Three fixes to the agentic order flow in `localIntelAgent.js` (commit `7aab661`):

1. **Removed `x-merchant-wallet` header from menu fetch** — APIM resolves merchant wallet from the subscription key automatically. Sending the header causes 403. Inventory call now sends only `Ocp-Apim-Subscription-Key`.
2. **Canonical `paymentUrl` construction** — no longer parses `portalLink` from the order response. Always built from `receiptId`:
   ```js
   const paymentUrl = `https://surge.basalthq.com/portal/${receiptId}?recipient=0xe66cE7E6d31A5F69899Ecad2E4F3B141557e0dED&embedded=1&correlationId=${receiptId}`;
   ```
   Uses LocalIntel routing wallet `0xe66cE7E6d31A5F69899Ecad2E4F3B141557e0dED` and `embedded=1` for iframe mode.
3. **`jurisdictionCode: 'US-FL'` added to POST `/api/orders` body** — required for all McFlamingo orders. Body shape is now `{ items: [{sku, qty}], jurisdictionCode: 'US-FL' }`.

Frontend (localintel-landing) was upgraded to embedded iframe with PostMessage origin verification (`event.origin !== 'https://surge.basalthq.com'`), handling `gateway-card-success`, `gateway-card-cancel`, and `gateway-preferred-height`. Falls back to new tab if iframe load fails (CSP).

2026-05-03 patch 2: removed x-merchant-wallet from GET /api/inventory call in menu endpoint

---

## Patches Applied 2026-05-04

- `f31444d` — fix: fault-tolerant ensureSchema (per-stmt catch), migration_002 dollar-quoting
- `d18c59a` — feat: broader ORDER_ITEM regex + pending session intent
- `44a8348` — fix: agentic order routes use surgeAgent per-biz key (not global env var)
- `8512ee5` — feat: isOpenNow pre-check on place-order, friendly closed message
- `72bfcde` — feat: Phase 1 tsvector GIN index + cuisine + backfill worker
- `e7e9ddd` — feat: Phase 2 intent router + tsvector search wired to search bar
- `5560af7` — feat: Phase 3 data quality — 50+ OSM tags, YP infer expansion, OSM name/category wins merge
- `f9122a5` — feat: Phase 4 matchReason + open/claimed/confidence sort
- `7f1ab3c` — feat: categoryReclassWorker backfill
- `a520f3f` — feat: task dispatch layer — tasks/agents/task_events, dispatchTask, Twilio reply handler

## Architecture: Task dispatch layer (2026-05-04)

When LocalIntel search returns 0 results for a non-ORDER_ITEM intent, the
query is converted into a real-world task and dispatched to a registered
agent over SMS. The agent responds YES/NO/DONE/FAIL and the task moves
through `open → assigned → accepted → completed/failed`.

**Tier model (locked in):**
- `owner` — core operator (Erik). Always matches first when ZIP+category fit.
- `vetted` — invited/verified humans. Match second.
- `open` — public signups. Match last.

**Match policy (deterministic SQL, zero LLM):**
1. `available = true`
2. `task.zip = ANY(zips_served) OR zip = task.zip`
3. `'*' = ANY(categories) OR task.top_category = ANY(categories)`
4. ORDER BY tier ASC, verified DESC, rating DESC, tasks_completed DESC LIMIT 1

**Tables (migration `006_tasks_agents.sql`):**
- `agents` — agent_id UUID PK, name, phone (E.164), wallet, zip, zips_served TEXT[],
  categories TEXT[] default '{*}', available, verified, tier, source, rating,
  tasks_completed, created_at.
- `tasks` — task_id UUID PK, user_query, top_category, sub_category, entities_json,
  urgency ('now'|'today'|'low'), zip, status ('open'|'assigned'|'accepted'|
  'in_progress'|'completed'|'failed'|'cancelled'), assigned_agent_id FK→agents,
  business_id, result_json, created_at, assigned_at, completed_at, fee_usd, payment_tx.
- `task_events` — extended additively from migration 004 with `event_id UUID`,
  `agent_id` (TEXT in legacy, UUID values still valid), `event_type`, `meta`,
  `created_at`. `task_type` was relaxed to nullable so dispatch INSERTs
  (which only set event_type) coexist with the intelligence-signal layer.

**Seed agent:** Erik Osol, +19045846665, wallet `0xe66cE7E6d31A5F69899Ecad2E4F3B141557e0dED`,
home ZIP 32082, zips_served = the 7 NE-FL target ZIPs, categories `{*}`, tier='owner'.

**SMS message format:**
```
[TASK-xxxxxxxx] 🚨 URGENT: "<user_query>" in <zip>. Reply YES to accept or NO to pass.
```
- `xxxxxxxx` = first 8 chars of task_id
- urgency label: `🚨 URGENT` (now), `Today` (today/tonight), `New task` (otherwise)

**Agent reply commands (handled by `lib/taskDispatch.handleAgentReply`):**
- `YES` → status='accepted', agent gets DONE/FAIL prompt
- `NO`  → status='open', assigned_agent_id=NULL (free for re-dispatch)
- `DONE <notes>` → status='completed', tasks_completed++, result_json={notes,completed_by}
- `FAIL <reason>` → status='failed', result_json={reason}

Reply resolution: extracts `[TASK-xxxx]` prefix → exact match on assigned task;
falls back to most recent assigned/accepted/in_progress task for that agent
phone if no prefix.

**Wiring:**
- `localIntelAgent.js` Phase 2 search — if `phase2Rows.length === 0` AND
  `intent.type !== 'ORDER_ITEM'`, calls `dispatchTask(intent, query, zip)`
  inside try/catch. Returns `{ taskCreated: true, taskId, message, ... }`.
  Failures fall through to the legacy ILIKE path so the user is never blocked.
- `dashboard-server.js` `handleSmsInbound` (`/api/rfq/sms-reply` +
  `/api/rfq/sms-inbound`) — `handleAgentReply` runs FIRST. If it returns a
  result, TwiML `<Message>` reply is sent inline and the existing RFQ flow is
  skipped. If null, the existing RFQ logic (YES-CODE, CONFIRM, WALLET, etc.)
  runs unchanged.
- Twilio outbound: reuses `lib/rfqBroadcast.sendSms` — no new Twilio client.

**Patches Applied 2026-05-04 (task dispatch):**
- `a520f3f` — feat: task dispatch layer
  - `migrations/006_tasks_agents.sql` adds agents + tasks tables, extends
    task_events additively (event_id/agent_id/event_type/meta/created_at;
    task_type relaxed to nullable). Seeds owner agent. Indexed on
    tasks.status, (tasks.zip, top_category), tasks.created_at,
    agents.available WHERE available=true, task_events.task_id, task_events.event_type.
  - `lib/taskDispatch.js` — createTask, matchAgent, assignTask, notifyAgent,
    handleAgentReply, dispatchTask. Re-uses existing Twilio client via
    rfqBroadcast.sendSms.
  - 0-result fallback wired into Phase 2 search (POST /api/local-intel),
    ORDER_ITEM stays out of dispatch loop.
  - Twilio inbound webhook unchanged externally; task replies handled
    transparently before existing RFQ logic.

---

## 2026-05-04 — Step 1 merge: Phase 2-4 surgically merged into the live handler

The live POST `/api/local-intel/` handler in `localIntelAgent.js` already wires
the Phase 2 keyword classifier + tsvector + dispatchTask + buildMatchReason
along its **Phase 2 path** (lines ~445-510). The **legacy ILIKE path**
underneath it was running without those pieces, so free-text searches that
fell through Phase 2 produced thin results with no matchReason, no tsvector
fallback, and no task dispatch on miss.

This patch promotes Phase 2-4 features into the legacy path so the live
handler is uniformly enhanced — no parallel system, no new files (context doc
only).

### Changes

1. **`NL_INTENT_MAP` expanded** (`localIntelAgent.js` ~line 416):
   - Every existing entry now carries a `taskClass` field (`DISCOVER`,
     `ORDER`, or `STATUS`) so callers can read intent class straight off
     the rule, alongside `group` / `tags` / new `cuisine` / new `category`.
   - New cuisine entries (taskClass `DISCOVER`, group `food`):
     chinese, japanese (sushi/japanese/ramen), italian (italian/pasta/pizza),
     thai, indian, mexican (mexican/tacos/burritos), bbq (bbq/barbecue/
     smokehouse), seafood (seafood/fish/oysters/crab/lobster), american
     (burger/burgers/hamburger), steakhouse (steakhouse/steak).
   - New bar/drink entries (taskClass `DISCOVER`, group `bar`):
     bar (whiskey/bourbon/scotch/cocktail/cocktails/bar/nightlife/happy hour),
     brewery (beer/craft beer/brewery/tap room),
     wine_bar (wine/winery/wine bar).
   - New utility/errand entries (taskClass `DISCOVER`):
     pharmacy (pharmacy/drugstore — group health),
     hardware (hardware/home depot/lumber — group home),
     grocery (grocery/supermarket/food store — group food),
     gas_station (gas/fuel/gas station — group auto),
     pet (pets/dog/cat/vet/veterinarian — group pet),
     laundry (laundry/dry cleaning/laundromat — group home),
     florist (florist/flowers — group retail),
     bank (atm/cash/bank — group finance).
   - ORDER and STATUS sentinel rules added at the tail of the map for
     completeness (the ORDER_ITEM short-circuit lives in
     `workers/intentRouter.js` `_ORDER_ITEM_HINT` and still runs first
     inside `classifyIntent`).
   - `resolveNlIntent(query)` now returns
     `{ taskClass, group, tags, cuisine, category }`.

2. **Cuisine SQL filter** added inside the legacy WHERE-clause builder:
   ```
   AND (cuisine = $n OR cuisine ILIKE $n+1 OR description ILIKE $n+1)
   ```
   exact match on the `cuisine` column (migration 005), falling back to
   ILIKE on `cuisine` and `description`. Additive — does not replace the
   existing ILIKE name/category/address/description condition.

3. **tsvector fallback** runs after the legacy ILIKE query when:
   - the main query returned 0 rows AND
   - the user typed a free-text `query` (string).

   It tokenizes, strips stopwords (`the, a, an, is, are, can, i, where, get,
   find, nearest, closest, me, my, to, for, of, in, on, at, or, and, do, you,
   any, some`), joins with `&`, and runs:
   ```
   SELECT ... FROM businesses
    WHERE status != 'inactive'
      AND zip = ANY($zips)
      AND search_vector @@ to_tsquery('english', $tsq)
    ORDER BY ts_rank(...) DESC, confidence_score DESC
    LIMIT 20
   ```
   Bad tsquery syntax is caught and treated as 0 rows. When the fallback
   produces rows, response `meta.source = 'postgres+tsvector'` and
   `meta.ts_fallback = true`. The COUNT(*) total query is skipped because
   its WHERE clause does not match the tsvector path.

4. **dispatchTask wired** to the legacy 0-result path. After the tsvector
   fallback, if results are still empty AND the caller did not pin
   `category` / `group` AND the NL intent is not `ORDER` / `STATUS`,
   `dispatchTask({type:'TEXT_SEARCH', categories, cuisines, group,
   taskClass, raw}, query, zip)` is fired non-blocking
   (`Promise.resolve().then(...).catch(...)`). The empty results are still
   returned to the user — dispatch never blocks the response.

5. **buildMatchReason wired** into the legacy result map. Every row now
   gets a `matchReason` field. Wrapped in try/catch so a builder throw
   sets `matchReason: null` instead of breaking the response.

6. **Response meta enriched** — `intent_class`, `intent_group`,
   `intent_cuisine`, `ts_fallback` now exposed on the legacy path's
   response payload, mirroring what the Phase 2 path already returns.

### Not changed (intentional)

- **`classifyIntent` in `localIntelTidalTools.js`** is **NOT deleted**.
  Despite its name it has nothing to do with Phase 2 search — it routes
  `/ask` Q&A questions across `ASK_ROUTES` (zone, oracle, demographics,
  bedrock, etc.) and is called at line 1239 of the same file. Deleting it
  would break the entire `/ask` endpoint. The Phase 2 keyword classifier
  lives in `workers/intentRouter.js` and is unaffected.

- The original Phase 2 path (lines ~445-510) is unchanged — these patches
  only enhance the legacy path so both paths now behave consistently.

### Next planned step (Step 2 in roadmap)

Extract `NL_INTENT_MAP` + `resolveNlIntent` from `localIntelAgent.js` into
`lib/intentRegistry.js`. Currently the map lives inline alongside the
handler; the next refactor splits it out so other entry points (MCP, ACP,
Tidal Q&A) can share the same registry without re-importing the entire
agent module. The Phase 2 `KEYWORD_CATEGORY_MAP` in
`workers/intentRouter.js` is a candidate to fold into the same registry,
but that consolidation is a separate follow-up.

## ADR-001: Phases 2-4 Parallel System Mistake (May 2026)

**What happened:**
Phases 2-4 were built as a parallel system alongside the live handler instead of improving it. `classifyIntent` and `KEYWORD_CATEGORY_MAP` landed in `localIntelTidalTools.js` — the wrong file — and were never wired to `router.post('/')`. `buildMatchReason` was built but not called. `dispatchTask` was built but the 0-result fallback was never connected. The result was dead code that cost credits and left the live handler unchanged.

**Why it happened:**
Each phase was scoped and implemented in isolation without reading the live handler first. The correct approach is always: read the live system, understand the single code path, then enhance it in place.

**How it was corrected (Step 1 merge — commits 13b054d + 0fd6172):**
- `NL_INTENT_MAP` in `localIntelAgent.js` expanded with `taskClass` on every entry + 21 new cuisine/bar/utility rules
- Cuisine SQL filter added to the live ILIKE query
- tsvector fallback (`search_vector @@ to_tsquery`) added on 0 ILIKE results
- `dispatchTask` wired non-blocking on subsequent 0 results (skips ORDER/STATUS intents)
- `buildMatchReason` applied to every result with try/catch fallback
- Response `meta` now exposes `intent_class`, `intent_group`, `intent_cuisine`, `ts_fallback`
- `classifyIntent` in `localIntelTidalTools.js` was confirmed as the `/ask` Q&A router (line 1239) — NOT dead code — intentionally preserved

**Spec deviations caught during merge (document for future sessions):**
- Table is `businesses`, not `local_businesses`
- No `services_text` column — ILIKE runs on `description` instead
- No `distance` column — ordering uses `ts_rank` matching the existing Phase 2 helper

**Rule going forward:**
> Always read the live handler before writing any new code. One system. Enhance in place. Never build parallel.

## North Star: W5 Intent Reasoning (Who / What / When / Where / How / Why)

Every user query is a task expression with five dimensions. LocalIntel must eventually resolve all five — not just category matching.

| Dimension | Current State | Target State |
|---|---|---|
| **What** | taskClass (DISCOVER/ORDER/STATUS) in NL_INTENT_MAP | Full task class registry in `lib/intentRegistry.js` |
| **Where** | ZIP detection, proximity sort | Named place, geofenced zones, travel radius |
| **When** | isOpenNow pre-check on ORDER | Temporal intent: "happy hour", "Sunday brunch", "late night", scheduled tasks |
| **Who** | Stateless — no customer identity | Customer profile + task history in Postgres; personalized ranking |
| **How** | DISCOVER → results, ORDER → Surge | Resolution path per task class: RESERVE → reservation agent, COMPARE → aggregate, QUOTE → dispatch |
| **Why** | dispatchTask fires on 0 results | Gap detection: log unresolved intents → surface acquisition targets |

**Roadmap:**
- **Step 2 (next session):** Extract combined NL_INTENT_MAP into `lib/intentRegistry.js` — taskClass as first-class field, one front door for all future intent growth
- **Step 3:** Resolution history table in Postgres — every resolved task writes a signal back; system knows its own failure rate
- **Step 4:** Temporal intent — `temporalContext` field on registry entries; time-aware SQL filter against business hours
- **Step 5:** Customer profile + relationship graph — `task_history` table; personalized ranking
- **Step 6:** Resolution path per task class — registry owns the routing, handler just reads it
- **Step 7:** Gap detection — unresolved `dispatchTask` calls aggregated into acquisition intelligence

**The moat:** Every resolved task = enrichment signal. Every unresolved task = gap signal. Postgres holds both. The graph deepens with every query.

---

## Step 2 — Intent registry + gap visibility (2026-05-05)

**Shipped:**
- `lib/intentRegistry.js` created — single source of truth for all intent definitions
- `resolveNlIntent` deleted from `localIntelAgent.js` — replaced by `resolveIntent` from registry (imported as `resolveNlIntentFromRegistry` to avoid collision with existing `resolveIntent` from `lib/intentMap.js`)
- `NL_INTENT_MAP` deleted from `localIntelAgent.js`
- Normalizer guarantees safe defaults on every field — no silent undefined failures (`taskClass: 'DISCOVER'`, `group: 'general'`, `tags: []`, `cuisine: null`, `category: null`, `resolvesVia: 'search'`)
- `resolvesVia` field added to every registry entry (W5 "How" dimension, Step 6 prerequisite)
  - DISCOVER → `'search'`
  - ORDER → `'surge'`
  - STATUS → `'status'`
  - 0-result handler dispatch → set dynamically (not in registry)
- `meta.gap`, `meta.gap_query`, `meta.gap_intent` added to response when `dispatchTask` fires (both Phase 2 early-return and legacy fire-and-forget paths) — frontend search UI can now act on the gap signal with zero additional work
- `GET /api/local-intel/gaps` endpoint live — top 50 unresolved queries grouped by `intent + query + zip`, ordered by occurrences DESC then `last_seen` DESC

**Next step — Step 3:** Resolution history table, temporal intent (`temporalContext` field on registry entries).

---

## Step 3 — Resolution history table (2026-05-05)

**Shipped:**
- `migrations/007_resolution_history.sql` — `resolution_history` table with indexes on `intent_class`, `zip`, `resolved`, and `created_at DESC`. Auto-applied on startup via `lib/dbMigrate.js` (which discovers all `migrations/*.sql` and tracks applied files in `migrations_log`).
- `recordResolution()` helper in `localIntelAgent.js` — fire-and-forget, never awaits, never blocks the response, never throws. Logs failures via `.catch`.
- `_reqStart = Date.now()` added to top of `router.post('/')` for `response_ms` measurement.
- Four write points instrumented in `router.post('/')`:
  - **Phase 2 search hit** — `resolved=true, resolved_via='search'` (intent-aware path)
  - **Phase 2 dispatch (0 results)** — `resolved=false, resolved_via='dispatch'`
  - **Legacy ILIKE / tsvector hit** — `resolved=true, resolved_via='search'` or `'tsvector'` based on `usedTsFallback`
  - **Legacy 0-result dispatch** — `resolved=false, resolved_via='dispatch'` (gated on `dispatchedGap`)
- `GET /api/local-intel/resolution-stats` — total queries, resolved count, resolution rate %, avg response_ms, by-intent-group breakdown, top 20 unresolved gaps.
- The system now knows its own success rate per intent group and ZIP — closing the loop on Step 1's tsvector fallback and Step 2's gap detection.

**Next step — Step 4:** Temporal intent (`temporalContext` field on registry entries, time-aware SQL filter against `business_hours`).

---

## Step 4 — Temporal intent (When dimension) (2026-05-05)

**Shipped:**
- `temporalContext` added to `normalizeIntent()` defaults in `lib/intentRegistry.js` (defaults to `null` — no silent undefined).
- 7 new temporal trigger entries in `lib/intentRegistry.js` registry — placed BEFORE cuisine/general entries so they match first:
  - `open_now` — "open now", "open today", "currently open", "open right now"
  - `happy_hour` — "happy hour", "happy hours" (group `bar`)
  - `late_night` — "late night", "after hours", "open late", "midnight"
  - `morning` — "breakfast", "open for breakfast", "morning coffee", "early morning", "brunch", "sunday brunch", "weekend brunch" (group `food`)
  - `midday` — "lunch", "open for lunch", "lunchtime" (group `food`)
  - `evening` — "dinner", "open for dinner", "dinner reservation" (group `food`)
- `isOpenDuringWindow(business, temporalContext)` helper added near the top of `localIntelAgent.js`. Parses both OSM-style strings (the actual prod format, e.g. `Mo-Sa 11:00-20:00; Su 11:00-18:00`) and JSON-object hours (defensive). **Every uncertainty path returns `true`** — missing hours, unparseable hours, unknown context, parser exception. Never silently excludes.
  - Window definitions (24h): `happy_hour [15,19]`, `late_night [22,26]`, `morning [6,11]`, `midday [11,14]`, `evening [17,22]`. `open_now` = current time inside any of today's intervals.
  - Overnight close handled by adding 24 to `close` when `close < open` (and the alias `00:00 → 24:00`).
- Temporal post-filter applied to `rawRows` AFTER both the main ILIKE (Path A) and the tsvector fallback (Path B) — single point of application since `rawRows` is the unified result holder.
- **Phase 2 paths also wired** (since most live queries hit Phase 2 first and short-circuit before the legacy path runs): `nlIntentEarly` is resolved at the top of the handler and reused. The Phase 2 result-success branch applies the temporal filter to `phase2Rows` with the same data-hole guard, and both Phase 2 success + Phase 2 dispatch responses now carry `meta.temporal`.
- **Data-hole protection:** if the temporal filter would eliminate every result (`filtered.length === 0`), originals are kept. The system never silently shows "no results" because of missing hours data.
- `meta.temporal` added to all three response shapes — Phase 2 success (`source: postgres+intent`), Phase 2 dispatch (`source: task_dispatch`), and legacy (`source: postgres` / `postgres+tsvector`).
- **Live verification (2026-05-05):**
  - `"open now food near me"` → `source: postgres+intent`, `temporal: 'open_now'`, 3 results
  - `"where can I get chinese food"` → `source: postgres`, `temporal: null`, 0 results (unaffected baseline)
  - `"happy hour near me"` → `source: task_dispatch`, `temporal: 'happy_hour'`

**Next step — Step 5:** Customer profile + task history (`task_history` table, personalized ranking).

---

## Step 5 — Customer profile + personalized ranking (Who dimension) (2026-05-05)

**Shipped:**
- `migrations/008_customer_sessions.sql` — `customer_sessions` table. Columns: `customer_id` (TEXT, phone E.164 or anonymous token), `id_type` ('phone'|'anonymous'), `last_query`, `last_business_id` (UUID), `preferred_group` (most queried group: food/bar/health/etc), `query_count` (default 1), `created_at`, `last_seen`. Unique index on `customer_id`, secondary on `preferred_group`, ordered on `last_seen DESC`. Auto-applied on startup via `lib/dbMigrate.js`.
- `upsertCustomerSession({ customerId, idType, query, businessId, group })` helper in `localIntelAgent.js` — fire-and-forget, never awaited, never throws. Skips silently when `customerId` is null (anonymous web). `ON CONFLICT (customer_id) DO UPDATE` increments `query_count`, refreshes `last_seen`, preserves `last_business_id` via `COALESCE` when the new value is null.
- `personalizeResults(results, customerSession)` helper — boosts `last_business_id` to position 0 (sets `_boosted: true`), then pulls all `category_group === preferred_group` matches in front of the rest. No-ops when `customerSession` is null or results have ≤1 row. Wrapped in try/catch — falls back to original order on any error.
- Customer identity sourced from `req.body.From` (Twilio E.164) → falls back to `req.body.from` / `req.body.phone` / null. `customerIdType = 'phone'` when present, `'anonymous'` otherwise.
- `customerSession` fetched up-front (single SELECT, best-effort — error path leaves it null) so both Phase 2 and legacy paths share the same session object.
- Three write points wired in `router.post('/')`:
  - **Phase 2 search hit** — personalize `enriched`, then upsert with `nlIntentEarly.group`
  - **Phase 2 dispatch (0 results)** — upsert with null businessId + `nlIntentEarly.group`
  - **Legacy path** — personalize `rows`, then upsert with `nlIntent.group`
- `meta.personalized` (boolean) + `meta.customer_query_count` (integer or null) added to all three response shapes — Phase 2 success, Phase 2 dispatch, and legacy.
- **Anonymous safety:** web queries with no `From` field get `customerSession = null`, no personalization, no upsert, `meta.personalized = false`. Never crashes. Never silent fail — every error path logs.

**Next step — Step 6:** Resolution path per task class (`resolvesVia` field already present on every registry entry — drives routing: search/surge/status/dispatch).

---

## Step 6 — resolvesVia routing (How dimension) (2026-05-05)

**Shipped:**
- `resolvesVia` field on every `lib/intentRegistry.js` entry is now actively read by the `router.post('/')` handler in `localIntelAgent.js` — previously declared but ignored.
- **Routing contract** (added at the top of the handler, after `nlIntentEarly` resolution, before any SQL runs):
  - `surge` → HTTP 400 with `{ error, redirect: '/api/local-intel/place-order', intent_class, resolves_via, meta.resolves_via }` — ORDER intents must use the dedicated order endpoint.
  - `status` → HTTP 400 with `{ error, redirect: '/api/local-intel/order-status', intent_class, resolves_via, meta.resolves_via }` — STATUS intents must use the dedicated status endpoint.
  - `search` / `dispatch` → fall through to existing SQL search and 0-result dispatch flow (unchanged).
- `meta.resolves_via` added to all three success/dispatch response shapes (Phase 2 success, Phase 2 dispatch, legacy) plus the two new 400 redirect responses — every response now carries the routing dimension.
- **Registry audit** (`lib/intentRegistry.js`): all ORDER-class entries already had `resolvesVia: 'surge'`, all STATUS-class entries already had `resolvesVia: 'status'`, all DISCOVER entries (cuisine, bar, utility, temporal triggers, fallbacks) had `resolvesVia: 'search'`. No changes required.
- **STEP 0 finding — do ORDER/STATUS reach `router.post('/')`?** Yes. There are dedicated routes (`router.post('/place-order')` at line 4676 and `router.get('/order-status/:receiptId')` at line 4744), but `router.post('/')` had no upstream guard — free-text queries containing "order me a..." or "where's my order" would hit it. The legacy 0-result dispatch already skipped ORDER/STATUS (line 922-923) but didn't return early — they would run a useless SQL search and fall through to empty results. The Step 6 guard is a **real routing switch**, not just defensive.
- **Live verification (2026-05-05, pre-deploy baseline):**
  - `"where can I get seafood"` → 4 results, `meta.intent_class = DISCOVER`
  - `"chinese food near me"` → 27 results, `source: postgres+intent`
  - Post-deploy: both should additionally carry `meta.resolves_via = 'search'`.

**Next step — Step 7:** Gap detection intelligence (aggregate unresolved `dispatchTask` calls → acquisition targets).

---

## Step 7 — Acquisition intelligence + self-monitoring (2026-05-05)

**Shipped:**
- `GET /api/local-intel/acquisition-targets` — top 50 unresolved intent_group + cuisine + ZIP groups from `resolution_history`. Priority assigned by demand_count: `high` (5+), `medium` (2-4), `low` (1). Response shape: `{ acquisition_targets, total_targets, high_priority, recent_gaps }`.
- `[GAP ALERT]` console warning — fires from `router.post('/')` when the same `intent_group + zip` combination has 5+ unresolved queries in `resolution_history`. Fire-and-forget via `db.query(...).then(...).catch(() => {})` — never blocks the user response, never throws.
- `meta.acquisition_signal = true` — added to the response when `dispatchTask` fires (resolved=false, 0-result path), alongside the existing `meta.gap = true`. Frontend / consumer agents now know the query contributed to a gap signal.
- **W5 reasoning complete:** What (taskClass), Where (zip), When (temporalContext), Who (customerSession), How (resolvesVia), Why (acquisition_signal / gap intelligence).
- **Self-monitoring loop:** the system knows its success rate (`/resolution-stats`), knows its gaps (`/acquisition-targets`), and alerts on repeated failures (`[GAP ALERT]`). No LLM calls — pure Postgres aggregation, fully deterministic.
- **ADR-001 lesson preserved:** one system, enhanced in place, no parallel code paths. `intentRegistry.js` remains the single front door — add new intents there, nothing else changes.

**System now closes the loop:** every unresolved query becomes a row in `resolution_history`; aggregations surface as acquisition signal; repeated failures page console; new businesses fill the gap; resolution rate climbs.

---
### Official Product Roadmap (locked May 2026)

**North star:** Lay people use LocalIntel like Google. Small businesses save money and see ROI. Engineers are impressed by the architecture. The task/RFQ/order flow feels like a friend that knows everything.

#### NOW — Deepen the Moat
1. **pgvector semantic search** — nomic-embed-text as Railway sidecar, embeddings stored in Postgres via pgvector extension. Zero external API calls. Closes vocabulary gap (user says "light and fresh lunch", system finds the right restaurant without keyword match). Replaces brittle tsvector fallback with true semantic similarity.
2. **RFQ flow for non-food verticals** — plumber, electrician, contractor. User sends task request → LocalIntel routes structured RFQ to matching businesses in graph → businesses bid → user picks → fee on close. Real revenue model beyond food ordering.
3. **Merchant portal MVP** — thin dashboard showing each business: times routed to, order conversions, earnings. Proof of value. Reason to stay in the graph and pay to belong.

#### NEXT — Make the Surface Match the Depth
4. **Conversational result narrative on search.html** — not just cards. A sentence explaining the recommendation: "I found 3 seafood restaurants open now near you, ranked by how often people in your area order from them." W5 reasoning made visible to the user.
5. **JEPA-style predictive layer (local, A option)** — pgvector-based demand forecasting from `resolution_history`. Predict which ZIPs will have demand spikes, which businesses are trending toward churn, which customer segments are about to activate. Runs entirely on Railway, no external model API.

#### SCALE
6. **Merchant onboarding with wallet setup** — Tempo mainnet, pathUSD payment rails, split contract auto-configured on join. Every business in the graph has a wallet and earns on every routed transaction.
7. **Agent-to-agent RFQ** — structured bids, automated award logic, fee on close. LocalIntel as the routing and settlement layer, not just the discovery layer.

**Competitive position:**
- Google Local / Yelp: have data scale, no agentic task completion or payment rails
- DoorDash: food logistics only, high rake, no cross-vertical coverage
- Perplexity/ChatGPT search: LLM reasoning, no local graph depth, hallucination risk
- LocalIntel moat: local merchant graph in Postgres + Tempo payment rails + W5 intent router + task completion loop. Deepens with every resolved query.

**The demo that closes investors:** Someone orders dinner through a text message and feels like they have a concierge. One complete flow, flawless execution, filmed.

---
### pgvector Session A — Infrastructure Complete (May 2026)

**pgvector availability check:** Confirmed on Railway Postgres 18.3 — `pg_available_extensions` shows vector v0.8.2 available, not yet installed. Migration 009 enables it via `CREATE EXTENSION IF NOT EXISTS vector`. No Railway dashboard intervention needed.

**Files added (Session A):**
- `migrations/009_pgvector.sql` — pgvector extension + `embedding vector(768)` column on businesses. Auto-discovered by `lib/dbMigrate.js` (alphabetical sort under `migrations/`). ivfflat index commented out — Session B adds it after backfill (needs row count to set `lists` correctly).
- `services/embedder/` — nomic-embed-text sidecar (Node/Express, `@xenova/transformers`, quantized CPU model). Standalone Railway service. Endpoints: `GET /health`, `POST /embed { text }`, `POST /embed-batch { texts }`. Returns 768-dim vectors.
- `lib/embedderClient.js` — `embedText(text)` and `embedBatch(texts)`. **Always returns null on failure**, never throws, never blocks search. Reads `EMBEDDING_SERVICE_URL` env var.

**Operational requirements:**
- `EMBEDDING_SERVICE_URL` env var must be set in Railway main Node service pointing to sidecar URL (e.g. `https://localintel-embedder.up.railway.app`).
- If env var missing → semantic search silently disabled, normal search still works.
- Sidecar deploys separately to Railway — point new service at `services/embedder/` directory.

**Boundaries:**
- Search handler (`localIntelAgent.js router.post('/')`) NOT modified in Session A — pure infrastructure session.
- Session B will: (1) wire `embedderClient` into the search query chain as third fallback after registry/tsvector, (2) build `embeddingBackfillWorker` to populate the `embedding` column for existing businesses, (3) create the ivfflat index once data is in.

**Next:** Session B — embeddingBackfillWorker + pgvector as third search fallback in localIntelAgent.

---
### pgvector Session B — Search Wired (May 2026)

**Files added/modified (Session B):**
- `workers/embeddingBackfillWorker.js` — batches of 50, skips already-embedded rows, retries on embedder load (10s sleep), creates ivfflat index after completion. Respects `FULL_REFRESH=true` to re-embed all rows. Self-running entry mirroring `searchVectorBackfillWorker` pattern.
- `dashboard-server.js` — registered `Embedding Backfill` worker in `LOCAL_INTEL_WORKERS` list. Spawned as fork on dashboard server boot, fire-and-forget, never blocks server startup. Same exponential-backoff restart policy as siblings.
- `localIntelAgent.js` — semantic search wired as 4th path in fallback chain: **ILIKE → tsvector → pgvector → dispatchTask**. `meta.semantic_search = true` when pgvector path resolves the query. `meta.source = 'postgres+pgvector'` when semantic hit. Resolution recorded with `resolvedVia: 'pgvector'`.

**Embedding source text:** combines `name | description | cuisine | category` per business — richer than name-only embeddings, robust against missing fields.

**Index strategy:** `lists = max(1, floor(sqrt(total_businesses)))` — auto-tuned to corpus size, created post-backfill via `CREATE INDEX IF NOT EXISTS idx_businesses_embedding ... USING ivfflat (embedding vector_cosine_ops)`.

**Embedder sidecar:** `https://eloquent-energy-production.up.railway.app` — `/health` returns `{"status":"ready","model":"nomic-ai/nomic-embed-text-v1"}`.

**Failure modes (all silent-safe):**
- `EMBEDDING_SERVICE_URL` unset → fallback skipped, control falls through to dispatchTask.
- `embedText` returns null (timeout, HTTP error) → fallback skipped.
- pgvector query throws → caught, logged, falls through to dispatchTask.
- Backfill `embedBatch` null → 10s sleep + retry same batch.

**Next:** Session C — embed intent registry entries for semantic intent classification (replaces keyword matching in `intentMap` for ambiguous NL queries).

---
### RFQ Flow — Non-Food Verticals Live (May 2026)

LocalIntel now routes service-business queries (plumber, electrician, HVAC,
roofer, handyman, painter, landscaper, cleaner, mechanic, towing) through a
Request-For-Quote dispatch path. SMS bid request goes out to up to 5
matching businesses; first YES wins; customer is notified by SMS.

**Files added/modified:**
- `migrations/010_rfq.sql` — `rfq_requests_v2` (BIGSERIAL PK, customer_id,
  query, intent_group, category, zip, description, status, businesses_notified,
  created_at, expires_at) + `rfq_responses_v2` (BIGSERIAL PK, rfq_id FK,
  business_id UUID, business_name, business_phone, response, responded_at,
  created_at). Suffixed `_v2` to avoid collision with the legacy
  rfqService.js UUID schema; both tables coexist, the legacy
  rfqBroadcast/rfqCallback flow is untouched.
- `lib/intentRegistry.js` — 10 entries with `taskClass: 'RFQ'` +
  `resolvesVia: 'rfq'`: plumber, electrician, hvac, roofer, handyman,
  painter, landscaper, cleaner, mechanic, towing. Listed BEFORE the
  legacy fallbacks so service queries no longer fall into the broad
  `retail` / `services` buckets.
- `localIntelAgent.js` — `handleRFQ()` finds up to 5 matching businesses
  by category+ZIP (ANY($1::text[]) + ILIKE on category/description), inserts
  the rfq, fans out Twilio SMS, logs `resolution_history` with
  `intent_class='RFQ'` + `resolved_via='rfq'`. Each per-business send is
  wrapped in try/catch — one bad number never blocks the loop. Helpers
  `sendRfqSms` and `toE164` live alongside.
- `dashboard-server.js` — sms-inbound handler grew an RFQ-v2 reply check
  between taskDispatch and the legacy parseSmsCommand path. Matches by
  `RFQ-<id>` reference if present, else by most-recent pending row for
  the business phone. YES marks the RFQ matched + sends customer phone
  to the business; NO marks 'no'; if every response is non-yes the
  customer gets an "all passed" follow-up SMS.

**Payment model:** businesses pay micro-fee to be routed to; RFQ = first
routing event. Wallet column already on businesses; metering/charging
lives in a future task.

**Failure modes (all silent-safe):**
- Twilio env unset → SMS skipped per-recipient, RFQ row still written.
- Phone unparseable → response row written with raw phone, SMS skipped.
- Customer SMS notify failure → logged only, never blocks API response.
- Reply parser failure → logged, falls through to legacy parseSmsCommand.

**Next:** Merchant portal MVP — show businesses their RFQ activity,
routing stats, earnings.
