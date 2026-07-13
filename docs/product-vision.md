# Product Vision — Unified Program Brief (W5+H)

> **Status:** Swarm-side engineering canon of the shared product vision.
> **Shared twin (keep in sync with landing):** [`../PRODUCT.md`](../PRODUCT.md) — identical file in `localintel-landing` and `gsb-swarm`.
> **Captured:** 2026-07-12 · **Refined:** 2026-07-13 (action layer · two datasets · agent wallets · keep money local)
> **Author:** Erik Osol (via cloud agent merge of prior sessions + repo truth)
> **Related:** [presence-protocol.md](presence-protocol.md) · [architecture.md](architecture.md) · [intent-routing.md](intent-routing.md) · [roadmap.md](roadmap.md) · [data-workers.md](data-workers.md)

---

## One sentence

**TheLocalIntel is the action layer over local historical data** — macro ground truth + live task signals become real trend forecasters; small businesses claim a node, get an agent wallet, and compete for local spend that would otherwise go to Amazon and other big-tech platforms.

Engine form: LocalIntel (surface) + GSB Swarm (engine) + WildWallet agents (demand) = Florida’s local action router — Google discovery depth + Angie's List task completion — then copy the state model nationwide.

Not a better listing directory. A **router + forecast loop**: natural-language need → matched business node → pay / schedule / RFQ / delivery → confirmed completion → signals feed tomorrow’s forecast.

---

## Four pillars (do not dilute)

### 1. Action layer over historical data

Public records, census, permits, Sunbiz, and the merchant graph are the **historical base**. Alone they are lagging description (“what the market was”). LocalIntel’s job is to sit **on top** of that base as the **action layer**: match intent, dispatch work, settle payment, and write the outcome back into the hive.

> *“Let Google pay for the satellites. We sell the weather forecast.”* — then we execute the move.

### 2. Two datasets → real trend forecasters

| Dataset | Sources (Swarm truth) | Tables / outputs | Forecast role |
|---------|----------------------|------------------|---------------|
| **Macro (historical)** | Census/ACS, BLS/QCEW, IRS, permits/FDOT, enrichment workers, business density | `zip_signals`, `zip_signals_history`, CEO assess layers | Cohort maturity, growth/opportunity scores, 12/24/36mo `zip_forecast` |
| **Micro (live action)** | RFQs, bookings, completions, SMS/voice, dead ends, orders | `resolution_history`, `intent_dead_ends`, `rfq_*`, `sms_query_log`, task signals | Real-time demand, unmet need, category momentum — leads the federal lag |

**World Model** (`worldModelWorker` / JEPA path) is where the two fuse: peer cohorts + z-scores + task velocity → plain-English trajectory and anomalies. Macro without micro is yesterday’s census. Micro without macro is noisy. Together they are **trend forecasters**.

Architecture canon already names this hive loop: bees (micro events) → `zip_signals` → World Model → better routing. Closing that loop is product, not a side project.

### 3. Small businesses enter the agent-wallet world

A claimed business is not a Yelp page. It is an **actionable node**:

- W5+H presence (who/what/where/when/why/how)
- Wallet address (WildWallet / Tempo pathUSD) in the paid routing tier
- Ability to receive RFQs, orders, appointments from humans **and** agents

Onboarding is the bridge: claim → enrich → wallet → earn on routed completion. That is how Main Street shows up in the agent economy without becoming an Amazon seller.

### 4. Keep money local (vs Amazon / big tech)

| Incumbent pattern | What it does to local $ |
|-------------------|-------------------------|
| Amazon / national marketplace | Pulls demand and settlement out of town |
| DoorDash / delivery platforms | High rake on local food |
| Google / Yelp ads | Toll booth on “I exist” |
| LocalIntel | Routes to neighborhood merchants; settles on open rails; forecast moat deepens with every local completion |

Competitive frame is not only “better directory.” It is **local commerce infrastructure for the agent age** — keep the transaction (and the learning) in the community.

---

## The 5 W's and How (program level)

| | Question | Answer for this program |
|---|---|---|
| **WHO** | Who is this for / who acts? | **Customers** (humans + WildWallet.ai agents) · **Florida small businesses** (claimed + wallet nodes) · **Fulfillment agents** (drivers, vetted task agents) · **Operators** (CEO / intel briefs) |
| **WHAT** | What is the product? | **Action layer + two-sided presence network**: historical/macro + live/micro datasets power forecasts; businesses broadcast W5+H; customers state need; swarm routes and settles — not a static Google listing |
| **WHERE** | Where does it live / operate? | **Florida first** (Postgres FL graph, NE-FL seed ZIPs, McFlamingo reference) → **state-by-state clone** · Surfaces: thelocalintel.com, Twilio SMS/voice, MCP, GSB Swarm on Railway · Money: WildWallet / Tempo |
| **WHEN** | When does it matter / when does work happen? | **Now / today / scheduled** — open-now, booking slots, RFQ windows, pickup/delivery ETAs. Forecast horizon is 12/24/36mo for operators; action horizon is minutes-to-days for customers |
| **WHY** | Why does this exist? | Gatekeepers tax presence and extract local demand. LocalIntel owns open data + action rails so SMBs broadcast specialty, agents can pay them, and **money stays local** |
| **HOW** | How does a need become done? | Intent router (deterministic W5) → graph match (signals-aware) → HOW path (order / appointment / reservation / RFQ / delivery-RFQ / agent-to-agent) → pay on confirmed completion → resolution feeds macro/micro forecast loop |

---

## Surfaces are one system (do not separate)

| Surface | Repo / URL | Role in the same program |
|---|---|---|
| **GSB Swarm** | `MCFLAMINGO/gsb-swarm` · Railway `gsb-swarm-production` | Backend hive: Postgres, workers, RFQ, dispatch rails, MCP, Twilio webhooks, payment gate, signal/forecast brain |
| **TheLocalIntel** | `MCFLAMINGO/localintel-landing` · thelocalintel.com | Public brand + human UX (search, claim, subscribe). Same API brain as Swarm |
| **GSB Swarm Dashboard** | `MCFLAMINGO/gsb-swarm-dashboard` | Internal ops / CEO briefs only — never customer UX |
| **WildWallet.ai** | External agent-wallet layer | Customer AI agents hold wallets; speak natural language; call LocalIntel MCP / APIs to pay, book, and dispatch |
| **McFlamingo** | Seed merchant node in Swarm DB | Reference end-to-end business: menu, Surge catalog, wallet, ZIP 32082 |

**Rule for agents:** There is no “LocalIntel repo vs GSB Swarm repo” product split. LocalIntel is the product name and public surface; GSB Swarm is the production engine that powers it. WildWallet is the customer-agent demand side. Act on them as one program.

---

## What businesses broadcast (supply side)

Small businesses across Florida (then each state) enroll once and declare presence:

- **WHO** — legal/trade name, owner, Sunbiz / license, claim status  
- **WHAT** — specialties, menu, SKUs, services, tags (“chicken and broccoli”, dentures, landscaping, Rx pickup, pet food)  
- **WHERE** — address, ZIP, service radius, delivery zone  
- **WHEN** — hours, lead time, open now, booking calendar  
- **WHY** — trust, reviews, specialties, “why choose us”  
- **HOW** — walk-in, order, appointment, RFQ bid, agent endpoint, delivery handoff, **wallet settlement**

Claimed + wallet businesses sit in the **paid routing tier**. Unclaimed listings exist in the graph but are not the product; the product is the **actionable node**.

---

## What customers / agents do (demand side)

A customer (or their WildWallet agent) states need in natural language. Examples that must all route through the same stack:

| Need | Expected path |
|---|---|
| “Get me chicken and broccoli at McFlamingo” | Name match → menu/order → pay (Surge/pathUSD) → schedule pickup **or** spawn delivery RFQ |
| “I need a landscaper tomorrow before noon” | Category RFQ → providers bid → book → complete (with or without homeowner on the phone) |
| “Where can I get my dentures replaced?” | Healthcare / dental discover → appointment or RFQ |
| “I need my prescriptions” | Pharmacy discover → pickup / delivery HOW |
| “The dog needs food” | Pet / grocery discover → order or RFQ |

**Delivery branch:** If the fulfillment HOW is delivery, LocalIntel pushes an **RFQ to delivery drivers / task agents** so someone can pick up from the business and deliver to the customer. That is the same RFQ/task machinery used for landscapers — different category, same loop.

---

## End-to-end loop (canonical)

```
Customer / WildWallet agent
  → natural language need (W5+H context)
  → LocalIntel intent router (MCP | web | SMS | voice)
  → Business graph match (GSB Swarm / Postgres + macro/micro signals)
  → HOW branch:
        ORDER / APPOINTMENT / RESERVATION
        or RFQ to businesses
        or DELIVERY RFQ to drivers/agents
  → Business / driver responds
  → Book / confirm
  → Pay on confirmed completion (local merchant wallet)
  → resolution_history + dead_ends → zip_signals → World Model (hive gets smarter)
```

**Competitive frame (locked):**

| Incumbent | Has | Missing |
|---|---|---|
| Google Local / Yelp | Discovery scale | Agentic task completion + payment rails |
| Angie's List / Thumbtack | RFQ for home services | Cross-vertical local graph + agent wallets + food/delivery |
| DoorDash | Food logistics | Cross-vertical; high rake; not presence infrastructure |
| Amazon / national marketplaces | Agent-ready checkout at global scale | Local merchant graph; money stays in community |
| ChatGPT / Perplexity | NL reasoning | Local merchant graph depth; hallucination risk; no settlement |

**LocalIntel moat:** FL merchant graph in Postgres + Tempo/Surge rails + W5 intent router + task completion loop + **macro+micro forecast feedback**. Deepens with every resolved query.

---

## Scale model

1. **Prove Florida** — dense graph, claim + wallet outreach, RFQ + order demos, McFlamingo as filmed end-to-end; micro signals feeding forecasts.  
2. **Copy the state kit** — same schema, workers, MCP tools, claim flows; swap jurisdiction / public-records sources.  
3. **National agent road** — any WildWallet (or other) agent drives the same road; LocalIntel does not care which “car” (Honda UI / BMW personal AI / Ferrari autonomous).

---

## What is already built vs still open

### Live (engine exists)
- Business graph + enrichment workers (FL) — historical / macro base
- Intent / search / open-now routing — action layer entry
- MCP tools including RFQ book/complete
- Twilio SMS + voice intake
- Payment rail selection (Surge / Stripe / SMS / email; Tempo pathUSD model)
- Subscriber + agent wallet creation hooks
- `zip_signals` + World Model / forecast tables (cohort scoring path)
- Presence protocol + architecture canon documented

### Still to close for the full promise
- Full W5+H presence editor for claimed businesses
- Merchant wallet onboarding as default claim path (SMB → agent economy)
- Delivery-driver RFQ pool as first-class category (pickup → deliver loop)
- Real on-chain Tempo escrow (currently intent-only in places)
- Business inbox for bids / appointment propose-time
- Close micro→`taskSignalWorker`→World Model feedback loop (live traffic → fresher forecasts)
- WildWallet.ai as a documented first-class demand client (MCP + wallet settlement)
- State kit packaging for non-FL expansion

See [presence-protocol.md](presence-protocol.md) “What Still Needs to Be Built” and [roadmap.md](roadmap.md) for build order.

---

## Agent operating rules (session merge)

1. **One program** — GSB Swarm, TheLocalIntel, WildWallet demand, McFlamingo seed = one stack. Do not re-explain LocalIntel as “only ZIP intel MCP.”  
2. **Directory is not enough** — every feature should move toward *broadcast → match → transact → complete → feed the forecast*.  
3. **Two datasets** — when building intel or routing, ask whether the change strengthens macro history, micro action signals, or the join that produces forecasts.  
4. **W5+H is the schema** — queries, presence profiles, appointments, and RFQs are all W5+H records.  
5. **Florida first, then clone** — do not invent a national rewrite; deepen FL, then replicate.  
6. **Cheapest open path** — Postgres + open channels (email/SMS/MCP); no new gatekeeper; keep money local.  
7. **Examples to keep alive in demos:** McFlamingo chicken & broccoli · landscaper job · dentures · prescriptions · dog food · delivery RFQ after food order · claim→wallet for a Main Street merchant.

---

## North star reminder

Revenue north star **$546k**. Product north star: **action layer + trend forecasts + agent-wallet rails for the post-gatekeeper local economy** — laypeople use it like Google; small businesses get ROI as actionable paid nodes; agents complete real work; dollars stay in the neighborhood.
