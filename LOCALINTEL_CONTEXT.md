# LocalIntel — Agent Context File
> **READ THIS FIRST every session.** Updated after every commit. Source of truth for architecture, integrations, decisions, and pending tasks.
> Last updated: 2026-05-03 (session 9 — enrichment layer + tasks scaffolding for 7 ZIPs, 5,151 businesses)

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
