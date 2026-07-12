# Product Vision — Unified Program Brief (W5+H)

> **Status:** CANONICAL — read this before treating GSB Swarm, TheLocalIntel, or WildWallet as separate products.
> **Captured:** 2026-07-12
> **Author:** Erik Osol (via cloud agent merge of prior sessions + repo truth)
> **Related:** [presence-protocol.md](presence-protocol.md) · [architecture.md](architecture.md) · [intent-routing.md](intent-routing.md) · [roadmap.md](roadmap.md)

---

## One sentence

**LocalIntel (surface) + GSB Swarm (engine) + WildWallet agents (customer demand) = the local action router for Florida small business — Google discovery depth + Angie's List task completion — then copy the state model nationwide.**

Not a better listing directory. A **router**: natural-language need → matched business node → pay / schedule / RFQ / delivery → confirmed completion.

---

## The 5 W's and How (program level)

| | Question | Answer for this program |
|---|---|---|
| **WHO** | Who is this for / who acts? | **Customers** (humans + their AI agents with WildWallet.ai wallets) · **Florida small businesses** (claimed nodes that broadcast capability) · **Fulfillment agents** (delivery drivers, vetted task agents) · **Operators** (CEO / intel layer for market briefs) |
| **WHAT** | What is the product? | A **two-sided presence + task network**: businesses broadcast W5+H presence; customers state need in natural language; the swarm routes to the right business and closes the loop (order, appointment, RFQ bid, or delivery job) — not a static Google listing |
| **WHERE** | Where does it live / operate? | **Florida first** (Postgres graph of FL businesses, NE-FL seed ZIPs, McFlamingo as reference merchant) → **state-by-state clone** of the same model · Surfaces: thelocalintel.com, Twilio SMS/voice, MCP (agents), GSB Swarm on Railway |
| **WHEN** | When does it matter / when does work happen? | **Now / today / scheduled** — open-now filters, booking slots, RFQ bid windows, pickup times, delivery ETAs. Availability is part of presence, not an afterthought |
| **WHY** | Why does this exist? | Gatekeepers (Google ads, Yelp, DoorDash rake, OpenTable covers) tax the same fundamental road: *I exist, I am available, I want to transact.* LocalIntel owns the data and the open channel so small businesses broadcast specialties and customers complete real tasks without a toll booth middleman |
| **HOW** | How does a need become done? | Intent router (deterministic W5) → discover business node → **HOW path**: order / appointment / reservation / RFQ / delivery-RFQ / agent-to-agent → payment on confirmed completion (Tempo pathUSD / Surge / Stripe / SMS) → resolution_history feeds the hive |

---

## Surfaces are one system (do not separate)

| Surface | Repo / URL | Role in the same program |
|---|---|---|
| **GSB Swarm** | `MCFLAMINGO/gsb-swarm` · Railway `gsb-swarm-production` | Backend hive: Postgres, workers, RFQ, dispatch rails, MCP, Twilio webhooks, payment gate |
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
- **HOW** — walk-in, order, appointment, RFQ bid, agent endpoint, delivery handoff  

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
  → Business graph match (GSB Swarm / Postgres)
  → HOW branch:
        ORDER / APPOINTMENT / RESERVATION
        or RFQ to businesses
        or DELIVERY RFQ to drivers/agents
  → Business / driver responds
  → Book / confirm
  → Pay on confirmed completion
  → resolution_history + dead_ends feed ZIP signals (hive gets smarter)
```

**Competitive frame (locked):**

| Incumbent | Has | Missing |
|---|---|---|
| Google Local / Yelp | Discovery scale | Agentic task completion + payment rails |
| Angie's List / Thumbtack | RFQ for home services | Cross-vertical local graph + agent wallets + food/delivery |
| DoorDash | Food logistics | Cross-vertical; high rake; not presence infrastructure |
| ChatGPT / Perplexity | NL reasoning | Local merchant graph depth; hallucination risk |

**LocalIntel moat:** FL merchant graph in Postgres + Tempo/Surge rails + W5 intent router + task completion loop. Deepens with every resolved query.

---

## Scale model

1. **Prove Florida** — dense graph, claim outreach, RFQ + order demos, McFlamingo as filmed end-to-end.  
2. **Copy the state kit** — same schema, workers, MCP tools, claim flows; swap jurisdiction / public-records sources.  
3. **National agent road** — any WildWallet (or other) agent drives the same road; LocalIntel does not care which “car” (Honda UI / BMW personal AI / Ferrari autonomous).

---

## What is already built vs still open

### Live (engine exists)
- Business graph + enrichment workers (FL)
- Intent / search / open-now routing
- MCP tools including RFQ book/complete
- Twilio SMS + voice intake
- Payment rail selection (Surge / Stripe / SMS / email; Tempo pathUSD model)
- Subscriber + agent wallet creation hooks
- Presence protocol + architecture canon documented

### Still to close for the full “Google + Angie's List” promise
- Full W5+H presence editor for claimed businesses
- Delivery-driver RFQ pool as first-class category (pickup → deliver loop)
- Real on-chain Tempo escrow (currently intent-only in places)
- Business inbox for bids / appointment propose-time
- WildWallet.ai as a documented first-class demand client (MCP + wallet settlement)
- State kit packaging for non-FL expansion

See [presence-protocol.md](presence-protocol.md) “What Still Needs to Be Built” and [roadmap.md](roadmap.md) for build order.

---

## Agent operating rules (session merge)

1. **One program** — GSB Swarm, TheLocalIntel, WildWallet demand, McFlamingo seed = one stack. Do not re-explain LocalIntel as “only ZIP intel MCP.”  
2. **Directory is not enough** — every feature should move toward *broadcast → match → transact → complete*.  
3. **W5+H is the schema** — queries, presence profiles, appointments, and RFQs are all W5+H records.  
4. **Florida first, then clone** — do not invent a national rewrite; deepen FL, then replicate.  
5. **Cheapest open path** — Postgres + open channels (email/SMS/MCP); no new gatekeeper.  
6. **Examples to keep alive in demos:** McFlamingo chicken & broccoli · landscaper job · dentures · prescriptions · dog food · delivery RFQ after food order.

---

## North star reminder

Revenue north star **$546k**. Product north star: **presence + task infrastructure for the post-gatekeeper local economy** — laypeople use it like Google; small businesses get ROI from being actionable nodes; agents complete real work.
