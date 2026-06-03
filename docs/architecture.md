# Architecture

Three access points, hive model, bees/macro/micro, messaging as routing, architecture decisions locked in.

## ARCHITECTURE CANON — LocalIntel Platform
**Written:** 2026-05-14
**Purpose:** Single source of truth for what each layer is, what it does, and why it exists.
**PRESERVE THIS SECTION — update in place, never delete.**

---

### The Three Access Points

#### 1. CEO Page (`/local-intel/ceo` on Vercel dashboard)
**Who:** Erik / operators — writing briefs for clients.
**What it is:** The brief creation workspace. Pulls full CEO assess (Layer 1 Postgres, zero LLM) for any ZIP. 12 structured sections — demographics, income, migration, labor, sectors, jobs, business activity, construction, broadband, property, world model, demand. World Model scores (growth/opportunity/risk/maturity/cohort) computed by `worldModelWorker` from all worker signals.
**Output:** Client-ready intelligence. Used to generate PDFs, market briefs, site selection reports.
**NOT for:** Public access, agent routing, or business discovery.

#### 2. MCP Server (`/api/local-intel/mcp` → Smithery)
**Who:** AI agents (Claude, GPT, Cursor), programmatic callers, humans via Smithery.
**What it is:** The canonical single entry point for ALL queries — market intelligence, business discovery, and task routing. 22 tools registered. `local_intel_query` is the START HERE tool — plain-English, auto-routes to the right ZIP + vertical + tool.
**Three roles inside MCP:**
- **Role 1 — Market Intelligence:** `local_intel_oracle` (now reads ceo-assess), `local_intel_signal`, `local_intel_sector_gap`, `local_intel_tide`, vertical agents (restaurant/healthcare/retail/construction/realtor). Answers "what is this market?" questions.
- **Role 2 — Business Discovery:** `local_intel_search`, `local_intel_nearby`, `local_intel_context`, `local_intel_project`. Searches 205,794 FL businesses by name/category/ZIP. Statewide. No ZIP restrictions on name search — proximity-sorted by caller ZIP.
- **Role 3 — Task Dispatch:** `local_intel_rfq` → `local_intel_rfq_status` → `local_intel_book` → `local_intel_decline_response` → `local_intel_complete`. Full loop: post job → ranked quotes → book → pay → complete. Payment on confirmed success only (Tempo/pathUSD).

#### 3. Twilio (`POST /api/local-intel` + voice)
**Who:** Regular customers — SMS and voice. No app required.
**What it is:** The human UX for task routing. A customer texts "I need a landscaper in 32082" or calls the Twilio number and says it. Same routing logic as MCP — intentRouter → category → businesses → RFQ dispatch. SMS log in `sms_query_log`. Voice transcripts in `call_transcripts`. Dead ends in `intent_dead_ends`.
**Positioning:** Like a Telegram bot but phone-native. No signup, no app, no login. Text or call → get routed → business gets the job.

---

### The Hive Mental Model

**Businesses are not static links.** A claimed business in LocalIntel is a living node with:
- SKUs, menu items, service listings (actionable by agents and humans)
- Task templates (pre-seeded by `taskSeedWorker`, editable by owner)
- Wallet address (receives pathUSD on job completion)
- Hours, phone, categories — all queryable
- Claimed status — verified via Sunbiz, owner can edit

**The micro layer (bees):** Every RFQ posted, every task routed, every order placed, every reservation, every SMS query. These are atomic events. Each writes to `business_tasks`, `task_events`, `rfq_gaps`, `resolution_history`, `intent_dead_ends`, `sms_query_log`.

**The macro layer (hive):** `zip_signals`, World Model scores (`sig_*`), sector gaps, business density, CES/QCEW/FRED labor data. This is the aggregate structure. Government workers (BLS, Census, BEA, IRS) provide the lagging confirmation of what task routing already shows in real time.

**The feedback loop (not yet live — activates with real traffic):**
Micro activity → `taskSignalWorker` → `zip_signals` (`sig_task_velocity`, `sig_unmet_demand_score`, `sig_category_momentum`) → World Model ingests → intelligence feeds better routing.

`intent_dead_ends` is the most valuable real-time signal: every failed query where no business could fulfill the task = a sector gap. More current than any federal dataset. When live traffic flows, this closes the loop automatically.

**Build order:**
1. ✅ Government data workers (BLS/Census/BEA/IRS) — macro foundation
2. ✅ World Model worker — computed sig_* signals from macro data
3. ✅ MCP oracle re-wired — intelligence flows to agents via Smithery
4. 🔜 Real traffic via Twilio/MCP → `intent_dead_ends` populates
5. 🔜 `taskSignalWorker` — reads dead_ends + resolution_history + rfq_gaps, writes sig_task_* back to zip_signals
6. 🔜 World Model picks up task signals alongside government signals

---

### Messaging as Task Routing (Strategic Direction — 2026-05-14)

SMS/voice via Twilio is currently implemented but underweighted in the product vision. The insight from session 2026-05-14:

**Messaging IS task routing.** The distinction between "sending a message" and "routing a task" is artificial at this layer. When someone texts "I need a plumber in Nocatee" they are not querying a database — they are initiating a workflow that ends with a confirmed booking and a payment. The message IS the task.

This positions LocalIntel closer to Telegram bots / WhatsApp Business / WeChat mini-programs than to Google Maps or Yelp. The difference: those platforms show you static listings. LocalIntel routes you to an actionable business node that can receive the job, respond with a quote, and get paid — all without a web app.

**Implication for future builds:**
- Twilio SMS should be treated as a first-class channel equal to MCP, not a secondary fallback
- Messaging threads (conversation state across multiple SMS turns) are more important than single-query resolution
- A business that has claimed their profile and set up tasks/menu items is findable AND actionable via message — this is the depth that matters
- Consider: WhatsApp Business API, iMessage for Business, or Telegram bot as additional messaging channels alongside Twilio
- `sms_query_log` + `call_transcripts` + `resolution_history` together = a full conversation layer. The next architectural move is threading these into stateful sessions per caller — not just individual query resolution.

---

### Key Tables — What Lives Where

| Table | What it stores | Written by | Read by |
|---|---|---|---|
| `zip_signals` | All macro signals (87 columns) | All data workers | CEO assess, World Model, MCP oracle |
| `businesses` | 205k FL businesses | OSM/YP/Sunbiz import | MCP search, RFQ routing, Twilio |
| `business_tasks` | Task templates per business | taskSeedWorker, business owners | MCP RFQ, agent routing |
| `intent_dead_ends` | Failed queries (0 rows — pre-traffic) | deadEndLog.js | taskSignalWorker (future) |
| `sms_query_log` | SMS query/reply pairs | Twilio handler | CEO demand section |
| `resolution_history` | Every resolved task outcome | Main POST handler | Analytics, routerLearningWorker |
| `rfq_gaps` | 0-result RFQ categories | RFQ handler | routerLearningWorker, taskSignalWorker (future) |
| `property_parcels` | 171k SJC parcels | CAMA import | CEO property section |
| `zip_intelligence` | Legacy oracle_json blobs | oracleWorker (legacy) | MCP oracle fallback only |
| `worker_events` | Worker START/END/ERROR logs | All workers | Nodes dashboard |
| `worker_heartbeat` | Last run timestamp per worker | All workers | Nodes status |


---

### B41 — Conversation Threading (SMS/Twilio Layer)
**Problem:** Each Twilio SMS query was stateless — no memory of prior ZIP, business, or intent. "That place" / "near here" / follow-up queries all failed.
**Fix:** Added `conversation_threads` table (migration 025). `lib/conversationThread.js` provides `getContext()` (loads last N turns, detects referential + zip-proxy patterns) and `appendTurn()` (fire-and-forget write). Injected into `localIntelAgent.js` POST handler: read before `resolveNlIntentFromRegistry`, write after each `res.json()` response path.
**Result:** SMS queries now carry thread context — ZIP resolved from history, referential business names resolved, follow-up intents enriched. Foundation for richer conversational routing.

### B43 — CEO Query Engine
**Problem:** CEO assess loaded all data sections but never answered the question — queries like "can this lease support a steakhouse" were echoed, not answered.
**Fix:** Added POST /api/local-intel/ceo-query. Accepts { zip, question }, reloads zip_signals + business data from Postgres, runs deterministic keyword-category matching (zero LLM), returns { verdict, answer, supporting_data, lease_signal, confidence }. Five categories: restaurant_concept, lease_viability, sector_gap, growth_trajectory, labor_staffing, general fallback.
**Result:** CEO page query bar now returns reasoned answers grounded in Postgres data — income profile vs concept viability, lease support math, sector gap analysis — all zero LLM API calls.

### B45 — LLM Chat Layer ($9.99/mo subscriber tier)
**Problem:** Deterministic layer answers structured queries but can't handle open-ended conversational questions. No subscription or monetization layer existed.
**Fix:** Migration 026 (subscriber_accounts + chat_log). POST /api/local-intel/chat: phone-based auth, 3 free trial queries, gates at $9.99/mo active status. Loads zip_signals context, computes data_confidence (0-100), builds grounding prompt, calls Claude Haiku (ANTHROPIC_API_KEY Railway env). Logs every query to chat_log with confidence + missing_signals. chatGapWorker surfaces which workers need to run to improve answer quality.
**Result:** $9.99/mo subscribers get LLM answers grounded in Postgres. Trial users get 3 free queries. Low-confidence answers flag data gaps for deterministic roadmap.

### B46 — Surge Subscription Endpoints
**Problem:** No payment flow to convert trial users to $9.99/mo subscribers.
**Fix:** POST /api/local-intel/subscribe creates Surge order (BASALT_API_KEY, SKU: LOCALINTEL-CHAT-MONTHLY), returns receiptId + portalUrl for Surge iframe. POST /api/local-intel/subscription-confirm verifies receipt + activates subscriber_accounts row (status='active', expires_at=+30d). Merchant wallet: 0xe66cE7E6d31A5F69899Ecad2E4F3B141557e0dED.
**Result:** Landing page can show Surge payment iframe, confirm payment via postMessage, activate subscriber in Postgres.

---

---

## North Star Vision — Human↔Digital↔Human Flow (2026-06-02)

**The fundamental problem LocalIntel solves:** Today there is friction at every boundary between human intent and real-world action. A person has a need → they search → they read a list → they pick up a phone → they wait → they talk to someone → maybe the job gets done. Every handoff is manual, every gate is a potential drop-off.

**The coming model:** Personal AI agents carry human intent. They talk to LocalIntel's agent layer directly. LocalIntel routes to business nodes. Business nodes respond programmatically. The human gets a notification: "Your mammogram is booked for Tuesday at 10am." Zero manual bridging.

**The three car tiers (agent quality spectrum):**
- **Honda (basic)** — The web search UI today. Human drives manually. LocalIntel is a tool they use. Types a query, reads results, makes a call.
- **BMW (personal AI)** — User's own AI agent (Claude, GPT, etc.) knows their preferences, schedule, location. Talks to LocalIntel MCP, posts RFQ, gets structured quotes back, asks user one question. Closes the loop with minimal human input.
- **Ferrari (fully autonomous)** — Agent knows the user's calendar, insurance, budget, preferences. Posts to LocalIntel, negotiates availability with business node, books, pays (pathUSD), confirms. Human gets a push notification.

**LocalIntel's job is the same for all three tiers:** Be the best possible road. Fast, reliable, deep data, agent-readable responses, zero friction at the API layer. The road doesn't care what car drives on it.

**The feedback loop that makes the road smarter:**
- Every failed query → `intent_dead_ends` → acquisition target for onboarding new businesses
- Every successful booking → `resolution_history` → signals which categories have capacity
- Every gap between what users ask and what's available → `rfq_gaps` → product roadmap
- Real traffic data is more current than any federal dataset — when live, this closes the loop automatically

**What this means for every build decision:**
- Every API response needs a `results` array (machine-readable) AND a `narrative` string (human-readable) — both channels always
- Session threading (`conversation_threads`) is the memory layer for all three tiers — human tab session, agent session, SMS thread — same table, same logic
- Business nodes with published services + availability are more valuable than listings alone — that's the depth that enables Ferrari-tier routing
- `intent_dead_ends` is the most important table in the system once traffic flows — it tells you exactly what to go sign up next

**Info-in / Info-out channels (all paths to the road):**

| Channel | Direction | Status | Notes |
|---|---|---|---|
| Web search UI | Human → LocalIntel | Live | Multi-turn as of B145 |
| SMS (Twilio) | Human → LocalIntel | Live | Thread-aware since B41 |
| Voice (Twilio) | Human → LocalIntel | Live | CallSid-keyed sessions |
| MCP server | Agent → LocalIntel | Live | 22 tools, Smithery registered |
| RFQ dispatch | LocalIntel → Business | Live | Email/SMS on confirmed job |
| Claim outreach | LocalIntel → Business | Live | SMS CLAIM reply flow |
| Business node API | Agent ↔ Business | Future | Business publishes services + availability, agents negotiate directly |
| WhatsApp/iMessage | Human → LocalIntel | Future | Same thread model, new channel |
| White-glove agent | LocalIntel agent → Business | Future | LocalIntel-owned agents that onboard businesses via conversation |

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


---

## Task Dispatch Layer (2026-05-04)

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


---

## ADR-001 + W5 Intent Reasoning

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
