# LocalIntel System Specification
**Version:** 2.0  
**Last Updated:** April 30, 2026  
**Status:** LIVE — update this file every session before pushing

> **Purpose:** This file is the canonical reference for everything built in this repo. It exists so no session ever loses context on what's implemented, what's stubbed, and what's next. Every merged feature must be reflected here.

---

## 1. North Star

**LocalIntel = universal local action layer for the agent economy.**

- Postgres is the source of truth. Workers enrich. Oracle reads. MCP exposes. Payment gate collects.
- Free to consumers (voice/routing). Businesses pay to be in the network.
- No LLM on the hot path — deterministic vocabulary scoring everywhere.
- Zero human in the loop — all agents run autonomously.
- **$546k** is the revenue north star.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│  DATA INGESTION                                                          │
│  overpassWorker → zip_enrichment → promoteOsmToBusinesses()             │
│  yellowPagesScraper → db.upsertBusiness() (source=yp)                   │
│  chamberScraper → db.upsertBusiness() (source=chamber)                  │
│  bbbScraper → db.upsertBusiness() (source=bbb)                          │
│  btrWorker → db.upsertBusiness() (source=btr)                           │
│  enrichmentAgent → Sunbiz match + confidence boost                      │
│                         │                                               │
│                         ▼                                               │
│  POSTGRES (turntable.proxy.rlwy.net:25739/railway)                      │
│  businesses 121,775 rows | zip_enrichment | zip_coverage                │
│  rfq_requests | rfq_responses | rfq_bookings | rfq_gaps | rfq_timeouts  │
│  push_subscriptions | source_evidence | zip_schedule                    │
│                         │                                               │
│                         ▼                                               │
│  MCP LAYER (localIntelMCP.js → dashboard-server.js)                     │
│  POST /mcp — JSON-RPC 2.0                                               │
│  26 tools registered (see Section 6)                                    │
│                         │                                               │
│                         ▼                                               │
│  PAYMENT GATE                                                            │
│  x402Middleware.js — USDC on Base (agent-to-agent)                      │
│  dispatchRail.js — Surge UCP / Stripe / Twilio SMS / Tempo escrow       │
│  dispatchWatchdog.js — 60s tick, retry, confidence feedback             │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Infrastructure

### Railway Services
| Service | ID | URL |
|---|---|---|
| gsb-swarm backend | `8d031580-e539-4d1e-a96a-92fd12116244` | gsb-swarm-production.up.railway.app |
| Postgres | `383353c2-6943-4e75-aebf-514ba1f42868` | turntable.proxy.rlwy.net:25739 |
| Project | `b6e49fbd-ddea-4d6f-9567-f920f6163538` | — |

**DB connection string:**
```
postgresql://postgres:mHNhBVhHmYVQdPAKVuysgjpajxzneqkE@turntable.proxy.rlwy.net:25739/railway
```

### Vercel
| App | Project ID | URL |
|---|---|---|
| LocalIntel Landing | `prj_xYhu03Voqiw1mtpTuQPXiXf6bnmk` | www.thelocalintel.com |
| Dashboard (internal) | — | swarm-deploy-throw.vercel.app |

### GitHub
- **gsb-swarm** → `MCFLAMINGO/gsb-swarm` branch `main`
- **localintel-landing** → `MCFLAMINGO/localintel-landing` branch `main`
- **gsb-swarm-dashboard** → `MCFLAMINGO/gsb-swarm-dashboard` branch `main`

### Push commands
```bash
# gsb-swarm
GIT_CONFIG_GLOBAL=/home/user/.gitconfig-proxy git push origin main  # api_credentials=["github"]

# Vercel (localintel-landing)
NODE_TLS_REJECT_UNAUTHORIZED=0 npx vercel --token $VERCEL_TOKEN --yes --prod
# in /tmp/<name>/ with api_credentials=["vercel"]
# orgId: team_19iu8EDRFBkTdrRtK7s6oYuE
```

---

## 4. McFlamingo (Seed Business Record)
| Field | Value |
|---|---|
| business_id | `232c34cb-ff82-4bf9-8a5c-d13306550709` |
| Sunbiz ID | `L18000286276` |
| ZIP | `32082` (Ponte Vedra Beach, FL) |
| Phone | `(904) 584-6665` |
| Dispatch token | `413fd263-747c-455b-94b2-e9686af02980` |
| Surge wallet | `0xe66cE7E6d31A5F69899Ecad2E4F3B141557e0dED` (Base) |
| pos_type | `other` (Surge) |
| notification_email | `erik@mcflamingo.com` |
| sources | `[osm, yellowpages]` |

---

## 5. Payment Rails
| Chain | Token | Treasury Address |
|---|---|---|
| Tempo mainnet | pathUSD | `0x774f484192Cf3F4fB9716Af2e15f44371fD32FEA` |
| Base mainnet | USDC | `0x1447612B0Dc9221434bA78F63026E356de7F30FA` |

**Rail selection priority in `dispatchRail.js`:**
1. Surge UCP (if business has `pos_config.apim_key`) → posts to Surge API
2. Stripe PaymentIntent (if business has `stripe_customer_id`) → manual capture, 5% fee
3. Twilio SMS (if business has `phone`) → job summary + accept/decline links
4. Email fallback → Resend via existing `rfqService` path

**Tempo escrow:** `holdOnBook` / `settleOnComplete` in `lib/settlementService.js` record settlement_events and pay treasury→merchant when `SETTLEMENT_ENABLED=true` + `TEMPO_EXECUTOR_PK`. Default is `settled_intent` (ledger + forecast advance without chain). `dispatchRail.releaseTempoEscrow` delegates to settlementService.

**PLAYER wallet holds pathUSD, not USDC.** Always use `tokenAddr: 'auto'` for sponsor-tx calls.

---

## 6. MCP Tool Registry (26 tools)

**Endpoint:** `POST https://gsb-swarm-production.up.railway.app/mcp`  
**Protocol:** JSON-RPC 2.0  
**Auth:** x402 USDC on Base (agent-to-agent) OR admin bypass header  

> Admin routes in `dashboard-server.js` are intercepted by the catch-all MCP proxy (JSON POSTs get proxied to localhost:3004/mcp). Use `Accept: text/plain` on curl admin calls to bypass.

| Tool | Description | Key Params |
|---|---|---|
| `local_intel_query` | General business query | name, zip, category |
| `local_intel_context` | Full business context | business_id |
| `local_intel_search` | Fuzzy text search | query, zip |
| `local_intel_nearby` | Proximity search | zip OR lat/lon, radius_miles (default 5mi) |
| `local_intel_zone` | Zone-level data | zip |
| `local_intel_corridor` | Corridor intelligence | zip, direction |
| `local_intel_changes` | Recent changes | zip, since |
| `local_intel_stats` | ZIP stats | zip |
| `local_intel_tide` | Tide data | zip |
| `local_intel_signal` | Market signals | zip, category |
| `local_intel_bedrock` | Bedrock/foundation data | zip |
| `local_intel_for_agent` | Agent-optimized response | query, zip |
| `local_intel_oracle` | Oracle intelligence | zip |
| `local_intel_sector_gap` | Gap analysis | zip, category |
| `local_intel_realtor` | Realtor intelligence | zip |
| `local_intel_healthcare` | Healthcare vertical | zip |
| `local_intel_retail` | Retail vertical | zip |
| `local_intel_construction` | Construction vertical | zip |
| `local_intel_restaurant` | Restaurant vertical | zip |
| `local_intel_ask` | Natural language query | question, zip |
| `local_intel_compare` | Compare businesses | zip, category |
| `local_intel_project` | Project planning | zip, type |
| `local_intel_rfq` | Create RFQ | task, zip, budget |
| `local_intel_rfq_status` | RFQ status | rfq_id |
| `local_intel_book` | Book a response | rfq_id, response_id |
| `local_intel_decline_response` | Decline a response | rfq_id, response_id |
| `local_intel_complete` | Mark booking complete | booking_id |

---

## 7. Database Tables

### businesses (121,775 rows as of 2026-04-30)
| Column | Notes |
|---|---|
| id | UUID primary key |
| name | Business name |
| zip | CHAR(5) |
| lat, lon | Float, from OSM or geocoding |
| phone, email, website | Contact |
| address | Street address |
| category, category_group | Normalized via categoryNormalizer.js |
| sources | TEXT[] — e.g. `['osm','yellowpages']` |
| confidence_score | 0.0–1.0 (see ladder below) |
| sunbiz_doc_number | FL Sunbiz entity ID (unique per legal entity) |
| status | operating/inactive/unknown |
| pos_type, pos_config | Payment rail config (encrypted via posDecrypt.js) |
| dispatch_token | UUID for RFQ dispatch |
| surge_wallet, stripe_customer_id | Payment rail identifiers |
| notification_email, notification_phone | Dispatch contacts |
| payment_rail | Enum: surge/stripe/sms/email/tempo |
| created_at, updated_at | Timestamps |

**Unique constraint:** `(lower(name), zip) WHERE sunbiz_doc_number IS NULL`

**Sources breakdown:** YellowPages 71k · OSM 43k+ · BTR 367 · Chamber 96

### Confidence Ladder
| Source | Score |
|---|---|
| OSM Overpass | 0.70 |
| YellowPages | 0.60 |
| Chamber member | 0.85 |
| BBB accredited | 0.85 |
| BTR (tax receipt) | +0.10 boost |
| Sunbiz match | +0.15 boost |

### Entity Resolution in db.js (3-step)
1. Exact `sunbiz_doc_number` match → UPDATE
2. `similarity(name, $2) > 0.7` + same ZIP → MERGE (add alias, boost confidence)
3. No match → INSERT

**Sources dedup:** `CASE WHEN NOT ($7 = ANY(sources)) THEN array_append(sources, $7) ELSE sources END`

### rfq_requests
| Column | Notes |
|---|---|
| id | UUID |
| task | Text description |
| zip | ZIP code |
| budget_usd | Decimal |
| payment_rail | Enum |
| payment_token | pathUSD/USDC/USD |
| escrow_tx_hash | Tempo TX (when live) |
| status | open/matched/booked/complete/timeout |
| matched_count | How many businesses matched |
| created_at | Timestamp |

### rfq_bookings
| Column | Notes |
|---|---|
| id | UUID |
| rfq_id | FK → rfq_requests |
| business_id | FK → businesses |
| response_id | FK → rfq_responses |
| payment_rail | Enum |
| payment_token | Token used |
| release_tx_hash | Tempo release TX (when live) |
| status | pending/confirmed/complete/cancelled |

### Other tables
| Table | Purpose |
|---|---|
| `zip_enrichment` | OSM POI cache per ZIP (raw JSON from Overpass) |
| `zip_coverage` | Which ZIPs processed, when, by which worker |
| `zip_schedule` | Queue of ZIPs to process |
| `source_evidence` | Per-source raw evidence per business |
| `rfq_responses` | Business responses to RFQs |
| `rfq_gaps` | ZIPs/categories with insufficient matches (feeds enrichment) |
| `rfq_timeouts` | Timed-out RFQs for retry tracking |
| `push_subscriptions` | Web push notification subscriptions |

---

## 8. lib/ Inventory

| File | Purpose | Status |
|---|---|---|
| `agentRegistry.js` | Agent registration + lookup | Live |
| `apiKeyMiddleware.js` | API key auth for external callers | Live |
| `categoryNormalizer.js` | Normalizes raw category strings to canonical groups | Live |
| `computeConfidence.js` | Confidence score calculation | Live |
| `db.js` | All Postgres reads/writes, entity resolution, upsertBusiness() | Live — sources dedup fixed 2026-04-30 |
| `dbMigrate.js` | Schema migrations | Live |
| `dispatchRail.js` | Multi-rail payment dispatch (Surge/Stripe/SMS/Tempo) | **NEW 2026-04-30** — Tempo is intent-only |
| `dispatchWatchdog.js` | 60s tick: RFQ timeout retry + confidence feedback | **NEW 2026-04-30** |
| `enrichmentTrigger.js` | Triggers enrichment runs based on rfq_gaps | Live |
| `notificationQueue.js` | Push notification queue | Live |
| `pgStore.js` | Higher-level Postgres helpers (coverage, queue, schedule) | Live |
| `posDecrypt.js` | Decrypt POS config from businesses.pos_config | Live |
| `rfqService.js` | RFQ lifecycle: create/match/book/complete/decline | **Modified 2026-04-30** — wired to dispatchRail + watchdog |
| `stateConfig.js` | Runtime config/feature flags | Live |
| `surgeAgent.js` | Surge UCP integration | Live |
| `voiceIntake.js` | Voice call intake + routing | Live |
| `workerHeartbeat.js` | Worker health pings | Live |
| `x402Middleware.js` | x402 USDC payment gating on MCP routes | Live |

---

## 9. workers/ Key Files

| File | Purpose | Last Modified |
|---|---|---|
| `overpassWorker.js` | Fetches OSM POIs via Overpass API → zip_enrichment → promotes to businesses | 2026-04-30 |
| `yellowPagesScraper.js` | Scrapes YP → direct db.upsertBusiness() | 2026-04-30 |
| `chamberScraper.js` | Chamber data → direct db.upsertBusiness() | 2026-04-30 |
| `bbbScraper.js` | BBB data → direct db.upsertBusiness() | 2026-04-30 |
| `btrWorker.js` | Business tax receipt → direct db.upsertBusiness() | 2026-04-30 |
| `zipAgent.js` | Orchestrates per-ZIP enrichment run | 2026-04-30 (flat file writes removed) |
| `zipCoordinatorWorker.js` | ZIP queue management — reads/writes Postgres only | 2026-04-30 (flat file state removed) |
| `enrichmentAgent.js` | Sunbiz + BTR enrichment pass on existing businesses | 2026-04-30 (flat file fallback removed) |
| `sunbizWorker.js` | Sunbiz legal entity matching | Live |
| `oracleWorker.js` | Computes zip_intelligence oracle rows | Live |
| `voiceIntake.js` | Twilio voice webhook → intent routing | Live |

---

## 10. scripts/ (one-time + utility)

| Script | Purpose |
|---|---|
| `promoteOsmPois.js` | Sequential OSM POI promotion (ZIP by ZIP, slow) |
| `promoteOsmBatch.js` | Fast SQL bulk OSM POI promotion — use this one |
| `migrate-json-to-pg.js` | One-time flat file → Postgres migration |
| `import-sunbiz.js` | Sunbiz CSV bulk import |
| `enrichConfidence.js` | Backfill confidence scores |
| `backfillBusinesses.js` | Backfill missing fields |
| `intel-sweep.js` | Full ZIP intelligence sweep |

---

## 11. Dispatch Layer — Built vs. Stubbed

| Feature | Status | Notes |
|---|---|---|
| Surge UCP dispatch | ✅ Built | Posts to Surge API with decrypted apim_key |
| Stripe PaymentIntent | ✅ Built | Manual capture, 5% fee, USD/USDC |
| Twilio SMS outbound | ✅ Built | Job summary + accept/decline links |
| Email fallback | ✅ Existing | rfqService Resend path (pre-existing) |
| Tempo / settlement hold | ✅ Wired | `settlementService.holdOnBook` writes escrow_data + settlement_events |
| Tempo / settlement release | ✅ Wired | `settleOnComplete` pays treasury→merchant when SETTLEMENT_ENABLED; else settled_intent |
| Task → forecast loop | ✅ Wired | `taskSignalWorker` writes sig_task_* + zip_forecast v1-task-loop |
| Twilio inbound SMS | ❌ Not built | Business texting YES/NO not wired |
| Stripe keys in Railway | ❌ Not set | STRIPE_SECRET_KEY env var needed |
| Watchdog 60s tick | ✅ Built | Starts on server boot via dashboard-server.js |
| Confidence feedback | ✅ Built | +0.02 on complete, -0.05 on no-show |

---

## 12. RFQ Flow (end-to-end)

```
1. Agent calls local_intel_rfq { task, zip, budget }
2. rfqService.createRfq()
   → matches businesses by category + ZIP
   → writes rfq_requests row (status=open)
   → writes rfq_gaps if matched_count < limit
   → calls dispatchRail.dispatchToBusiness() per match
      → Surge UCP → Stripe → Twilio SMS → email (priority order)
3. Business responds (SMS/email/Surge webhook) → rfq_responses row
4. Agent calls local_intel_book { rfq_id, response_id }
   → rfqService.bookRfq()
   → writes rfq_bookings row
   → settlementService.holdOnBook() → escrow_data + settlement_events(held)
5. Work completed → Agent calls local_intel_complete { booking_id }
   → rfqService.completeBooking() marks complete
   → settlementService.settleOnComplete() → treasury→merchant (or settled_intent)
   → feeService.logFee(job_complete)
   → rewardCompletion() → confidence +0.02
6. taskSignalWorker (6h):
   → aggregates RFQs + settlements + dead ends → zip_signals sig_task_*
   → writes zip_forecast model_version=v1-task-loop
7. dispatchWatchdog (60s tick):
   → finds open RFQs past timeout threshold
   → retries dispatch
   → penalises no-shows → confidence -0.05
   → writes rfq_timeouts row
```

---

## 13. MCP Routing Rules

**Fuzzy routing: deterministic vocabulary scoring — NO LLM.**

- `intentRouter.js` scores incoming queries against vocabulary maps
- `routerLearningWorker.js` updates vocabulary weights from feedback
- Query → category → ZIP → `pgCategorySearch()` or `toolNearby()`

**toolNearby ZIP support (fixed 2026-04-30):**
- Accepts `zip` param → looks up centroid from Postgres geo data
- Default radius: 5mi (was 0.5mi — bumped for hardware store searches)
- Response key: `businesses` (not `results`)

**pgCategorySearch token split (fixed 2026-04-30):**
- Was `/s+/` (missing backslash, never split) → `/\s+/` (correct)

---

## 14. Railway Environment Variables Required

| Var | Used By | Status |
|---|---|---|
| `DATABASE_URL` | All db.js calls | ✅ Set |
| `ADMIN_TOKEN` | Admin routes | ✅ Set (`localintel-migrate-2026`) |
| `RESEND_API_KEY` | Email dispatch | ✅ Set |
| `TWILIO_ACCOUNT_SID` | SMS dispatch | Needs verify |
| `TWILIO_AUTH_TOKEN` | SMS dispatch | Needs verify |
| `TWILIO_FROM_NUMBER` | SMS dispatch | Needs verify |
| `STRIPE_SECRET_KEY` | Stripe dispatch | ❌ Not set |
| `SURGE_BASE_URL` | Surge UCP | Needs verify |
| `TEMPO_RPC_URL` | Tempo escrow (future) | Needs set |
| `EXECUTOR_PK` | Tempo fee sponsorship | ✅ In Railway |
| `EXECUTOR_WALLET` | Tempo executor addr | ✅ In Railway |

---

## 15. Voice Line
- **Number:** (904) 506-7476
- **Handler:** `workers/voiceIntake.js` via Twilio webhook
- **Routing:** deterministic intent scoring → MCP lookup → spoken response
- **Honest failure:** must tell caller when it cannot match a request (no silent fail)

---

## 16. Data Integrity Rules

1. **Postgres is king** — never use flat files as primary storage
2. **Bulk SQL over sequential upserts** — Railway proxy latency ~893ms per call
3. **Sources dedup on every upsert** — `CASE WHEN NOT ($7 = ANY(sources))`
4. **No LLM on hot path** — LLM only at enrichment/batch time
5. **No Google Places API** — no Google data sources
6. **No Yelp/Foursquare** — running without for now
7. **OSM + YP + Sunbiz + BTR + Chamber + BBB** — current source stack
8. **pathUSD = B2B rail** — business dispatch wallets, LocalIntel fees
9. **USDC on Base = agent-to-agent** via x402
10. **USDC/card for customers** — not pathUSD
11. **All transactions use viem/tempo** — never ethers.js
12. **tokenAddr: 'auto'** for all sponsor-tx calls

---

## 17. ZIP Coverage (as of 2026-04-30)

| ZIP | Area | OSM POIs in businesses | Notes |
|---|---|---|---|
| 32082 | Ponte Vedra Beach | 130 | McFlamingo home ZIP |
| 32081 | Nocatee | promoted | |
| 32095 | Ponte Vedra | promoted | |
| 32259 | Switzerland/Orangedale | promoted | |
| 32256 | Deerwood/Southside | promoted | |
| 32080 | St. Augustine Beach | promoted | |
| 32086 | St. Augustine South | promoted | |
| 32084 | St. Augustine | promoted | |
| 32250 | Jacksonville Beach | promoted | |
| 32092 | World Golf Village | promoted | |

Total OSM POIs promoted: 1,884 across 10 SJC ZIPs.

---

## 18. Known Gaps / Next Builds

| Item | Priority | Notes |
|---|---|---|
| Geocode YP businesses (lat/lon null) | High | ~47k FL businesses have valid coords; YP records mostly null — geocodingWorker needs to run |
| Tempo viem escrow (hold + release) | High | Replace intent-only stubs in dispatchRail.js |
| Twilio inbound SMS (YES/NO) | High | Business acceptance flow not wired |
| STRIPE_SECRET_KEY Railway env var | High | Stripe dispatch non-functional until set |
| Twilio env vars verify | Medium | Check Railway for SID/token/from |
| Sunbiz bulk CSV import | Medium | Awaiting DOS_Sunbiz@dos.myflorida.com response |
| SJC ArcGIS BTR dataset | Medium | Awaiting publicrecords@sjctax.us response |
| Non-FL Sunbelt expansion | Low | Phase 2 gate — FL must hit 95% ZIP coverage first |
| Census/ACS enrichment pipeline | Low | Demographic layer |
| zip_intelligence computed table | Low | Oracle output materialized |
| x402 Stripe paywall on thelocalintel.com | Medium | Landing page monetization |

---

## 19. Commit History (this repo, significant)

| Commit | Description | Date |
|---|---|---|
| `faff9ca` | Fix pgCategorySearch limitN param | Pre-session |
| `fdcb678` | Fuzzy name search + proximity sort | Pre-session |
| `20444c5` | Postgres-first pipeline — all 9 workers | 2026-04-30 |
| `1a0f2ce` | Sources dedup fix + promoteOsmBatch script | 2026-04-30 |
| `9471800` | Token split regex fix + toolNearby Postgres geo | 2026-04-30 |
| `9886797` | Multi-rail dispatch layer + watchdog + feedback loop | 2026-04-30 |
| `<next>` | Fix db.query .rows bug + centroid lon filter (lon < -60) in pgCategorySearch + toolNearby | 2026-04-30 |

---

## 20. Session Rules (critical — do not violate)

- **One push per session** — batch all changes, single commit
- **Never push without asking** if it's a UX change
- **No PDFs/slides/docs** unless explicitly requested
- **No screenshots** (costs credits)
- **No double deploy** — deploy once per session
- **DO THE RIGHT THING ALWAYS** — when given A/B/C options, take the most complete/correct path
- **Think through architecture impacts before writing code** — reason first, code second
- **All transactions: viem/tempo, never ethers**
- **Agent identity for outbound:** Erik Osol / LocalIntel Data Services — BCC erik@mcflamingo.com
- **Dashboard (swarm-deploy-throw.vercel.app) = INTERNAL ONLY** — no customer UX inside it
- **Every completed feature committed to git before session ends**
- **Run `npm install` after any package.json edits before pushing**

---

## 21. POS Router Layer (added 2026-04-30)

### lib/posRouter.js
Universal POS dispatch — every business routes through here regardless of pos_type.

**Contract every handler must implement:**
- `fetchMenu(businessId)` → `{ items: [{sku, name, priceUsd, available, category, description}] }`
- `createOrder(businessId, items, opts)` → `{ receiptId, payUrl, total, items }`
- `getPaymentUrl(receiptId)` → string or null
- `sendPaymentSms(toPhone, payUrl, summary)` → `{ sent, sms_sid }`

**Handlers registered:**
| pos_type | Handler | Status |
|---|---|---|
| surge | surgeAgent.js | ✅ Live |
| other (Surge) | surgeAgent.js | ✅ Live (auto-detected via pos_config) |
| toast | toastAgent.js | ⚠️ Stub — needs client_id/client_secret/restaurant_guid in pos_config |
| square | squareAgent.js | ⚠️ Stub — needs access_token/location_id in pos_config |
| null/none | rfq fallback | ✅ Falls back to RFQ dispatch |

**matchItems() algorithm:**
1. Split order on "and" / "plus" / "," / "also" → segments
2. Each segment: Jaccard similarity score against all menu items (stop-word filtered)
3. Prefix matching bonus, phrase containment bonus
4. Single best match per segment (no double-matches)
5. Qty extraction: "two chicken tacos" → DIY CHICKEN TACO x2
6. Threshold: 0.15 minimum score to avoid false positives
7. Tested 13/13 on full McFlamingo menu

**voiceIntake.js integration:**
When category is resolved (non-uncertain), checks Postgres for POS-connected business in ZIP.
If found → posRouter.placeOrder() → speaks confirmed items + total → SMS payment link.
If no POS match or order fails → falls through to existing RFQ path.

### McFlamingo Surge Inventory (live as of 2026-04-30)
Key items: Chicken Pickles Sandwich $13.50, Double Chicken Smash Burger $13.95,
Big Nolan Spicy Double Chicken Burger $13.95, SWEET SOY SALMON $25,
SHRIMP CASHEW CURRY $22, DIY CHICKEN TACO $21, BRUSSEL SPROUTS $9,
HUMMUS WITH AVOCADO $8.50, Lemonade $5, SIDE RICE $3.50, SIDE QUINOA $3.50
