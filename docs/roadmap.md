# Roadmap

Official product roadmap, north star $546k, pending setup items, strategic direction notes.

## Pending Setup (requires Erik action)

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

---

## Roadmap (next sessions)

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

---

## North Star

## North Star
**$546k / LocalIntel = Bloomberg of the agent economy for local commerce**
- Three buyer profiles: B2B SaaS/POS, Commercial RE/investors, Franchise operators
- Payment: Tempo mainnet pathUSD for all LocalIntel query pricing
- Everyone pays in pathUSD — no registration, no query. No balance, no response.
- All agents running without human in the loop — full autonomy

---

## Official Product Roadmap (locked May 2026)

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

