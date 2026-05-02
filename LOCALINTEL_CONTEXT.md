# LocalIntel — Agent Context File
> **READ THIS FIRST every session.** Updated after every commit. Source of truth for architecture, integrations, decisions, and pending tasks.
> Last updated: 2026-05-02 (session 4 — all filesystem workers ported to Postgres; GET /search route added)

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
zip_intelligence     — 1,109 rows
zip_briefs           — 1,193 rows
zip_enrichment       — 1,012 rows
census_layer         — 0 rows, DO NOT USE
task_events          — intelligence signal layer
worker_events        — enrichment worker logs
agent_sessions       — MCP agent sessions
task_patterns        — self-improvement patterns
business_responsiveness — response tracking
rfq_gaps             — unmatched voice/web requests for self-improvement batch
voice_leads          — legacy audit log (still written to for orders)
```

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
| `lib/voiceIntake.js` | Twilio voice handler — all stages, session state, RFQ routing |
| `lib/voiceSession.js` | Postgres CallSid session for multi-turn ordering |
| `lib/posRouter.js` | POS routing: fetchMenu, matchItems, placeOrder |
| `lib/ucpAgent.js` | Surge/UCP POS handler — normalizeItem resolves prices from modifier groups |
| `lib/rfqBroadcast.js` | RFQ job creation, provider broadcast (SMS+email), response recording |
| `lib/rfqCallback.js` | Outbound Twilio callback call — reads responses, confirms selection |
| `lib/callerIdentity.js` | Wallet-agnostic caller identity — phone→name/email/wallet |
| `lib/db.js` | Postgres client — returns arrays directly, never .rows |
| `workers/enrichmentAgent.js` | Signal narrative builder — zero LLM, runs every 10 min |
| `workers/intentRouter.js` | MCP intent routing — deterministic vocabulary scoring |

### Landing (`localintel-landing/`)
| File | Purpose |
|---|---|
| `index.html` | Landing page — search bar + Call (904) 506-7476 CTA |
| `search.html` | Search UI — calls `/api/local-intel/search`, renders narrative + cards + service request RFQ card |

---

## API Endpoints (live on Railway)

### LocalIntel Intelligence
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/local-intel/search?q=&zip=&cat=&limit=` | Business search + service request detection + RFQ broadcast |
| GET/POST | `/api/local-intel/ask?q=&zip=` | MCP intelligence query |
| GET | `/api/sector-gap/feed` | ZIP market briefs |

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

### Committed this session (2026-05-02)
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
