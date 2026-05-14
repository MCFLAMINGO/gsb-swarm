# Intent Routing

Intent layer (intentMap.js, intentRegistry.js, taskIntent.js, resolveNlIntentFromRegistry), W5 reasoning, resolvesVia routing, phase 2/3/4 merge, conversational NL design philosophy, slang table, business aliases, known issues.

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

