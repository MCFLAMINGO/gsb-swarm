# LocalIntel — Agent Context File
> **READ THIS FIRST every session.** Updated after every commit. Source of truth for architecture, integrations, decisions, and pending tasks.
> Last updated: 2026-05-01 (session 2 — test + fix pass)

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

---

## Third-Party Integrations

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
- **PENDING SETUP — Inbound MX (Namecheap Advanced DNS):**
  - Type: `MX` | Host: `@` | Value: `inbound-smtp.us-east-1.amazonaws.com` | Priority: `10`
  - NOTE: correct value is `inbound-smtp.us-east-1.amazonaws.com` NOT `inbound.resend.com`
  - After adding: Resend dashboard → Domains → thelocalintel.com → Enable Receiving toggle → click "I've added the record"
  - Then add webhook route in Resend: `jobs+*@thelocalintel.com` → POST `https://gsb-swarm-production.up.railway.app/api/rfq/email-inbound`
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

rfq_responses        — job_id(FK), business_id, business_name, business_phone, business_email,
                       channel(sms|email|voice), raw_text, responded_at, selected(bool)
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

### 2. Resend inbound MX record — PENDING (Namecheap + Resend dashboard)
- **Namecheap Advanced DNS:** Add MX record:
  - Type: `MX` | Host: `@` | Value: `inbound-smtp.us-east-1.amazonaws.com` | Priority: `10`
- **Resend dashboard:** Domains → thelocalintel.com → Enable Receiving → "I've added the record"
- **Resend webhook route:** `jobs+*@thelocalintel.com` → POST `https://gsb-swarm-production.up.railway.app/api/rfq/email-inbound`
- Enables: provider email replies matched back to jobs by code

---

## Known Issues / Gotchas

- **rfq_responses legacy table:** Old table from health-tester swarm (Apr 28) had column `rfq_id` instead of `job_id`. Renamed to `rfq_responses_legacy` on 2026-05-01. New correct table created.
- **caller_identities + voice_sessions:** Auto-create via `migrate()` in Railway process works but the `migrated=true` flag caches after first run. If tables are missing, create them directly in Postgres (done 2026-05-01).
- **`migrated` flag in rfqBroadcast.js:** Module-level boolean prevents re-running migrations on live process. If table schema changes, must run migration SQL directly against Postgres.
- **Resend MX value:** Correct value is `inbound-smtp.us-east-1.amazonaws.com` — NOT `inbound.resend.com`.
- **Twilio SMS URL:** Must be URL only — no `POST ` prefix. Twilio prepends method label in UI which caused initial save error.
- **`db.query()` returns array** — never `.rows`. Critical — breaks silently if wrong.
- **`pos_type` not a column** — always `pos_config->>'pos_type'`.

---

## Session History (what's been built)

### Committed this session (2026-05-01)
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
