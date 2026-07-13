# Product Vision — TheLocalIntel + GSB Swarm

> Shared north star for both repos. Keep this file identical in
> `MCFLAMINGO/localintel-landing` and `MCFLAMINGO/gsb-swarm`.

## One-line product

**TheLocalIntel is the action layer over local historical data** — two datasets (macro ground truth + live task signals) that become real trend forecasters, plus the rails for small businesses to enter the agent-wallet economy and keep money local against Amazon and other big-tech gatekeepers.

Shorthand: Florida’s task router for people and AI agents — not a static directory — intent → pay → schedule → RFQ → complete, then copy the state model nationwide.

---

## The deeper “why” (locked)

| Pillar | Meaning |
|--------|---------|
| **Action layer** | Historical / public / merchant data alone is weather. LocalIntel sells the *forecast and the move* — route the job, settle payment, close the loop. |
| **Two datasets → trend forecasters** | **Macro:** census, labor, permits, Sunbiz, enrichment, `zip_signals` history. **Micro:** RFQs, bookings, `resolution_history`, dead ends, SMS/voice demand. World Model + scoring turn both into forward-looking ZIP / category trends. |
| **Agent-wallet on-ramp for SMBs** | Claimed businesses get a wallet (WildWallet / Tempo pathUSD) and become actionable nodes agents can pay — same rails big tech already uses, without leaving town. |
| **Keep money local** | Compete with Amazon, DoorDash, Google ads, and platform rake by routing spend to neighborhood merchants and settling on open rails — not extracting local demand to a national warehouse. |

> *“Let Google pay for the satellites. We sell the weather forecast.”* — and then we **act** on it.

---

## The 5 W’s and How

### Who

| Actor | Role |
|-------|------|
| **Customers** | People who need real-world work done, often via natural language |
| **Small businesses** | Restaurants, landscapers, dentists, pharmacies, pet stores, drivers, etc. who broadcast what they *actually* do — and earn via agent wallets |
| **AI agent wallets** | Agents funded via [wildwallet.ai](https://wildwallet.ai) that act for the customer |
| **MCFLAMINGO / LocalIntel** | Builds the Florida ground truth, the trend layer, the router, and the state playbook |

### What

A **two-surface system** on top of a **two-dataset brain**:

| Surface | Repo | Job |
|---------|------|-----|
| **TheLocalIntel** | [`localintel-landing`](https://github.com/MCFLAMINGO/localintel-landing) | Public brand, SEO ZIP / biz / neighborhood pages, claim / inbox / RFQ / search UI at [thelocalintel.com](https://www.thelocalintel.com) |
| **GSB Swarm** | [`gsb-swarm`](https://github.com/MCFLAMINGO/gsb-swarm) | Brain + router: business graph, macro/micro signals, MCP tools, search, chat, RFQ dispatch, wallets, payments — live at `gsb-swarm-production.up.railway.app` |

| Dataset | What it is | What it becomes |
|---------|------------|-----------------|
| **Macro (historical)** | Government + public records + merchant graph enrichment → `zip_signals` / history | Cohort scores, maturity, 12/24/36mo trajectory (`zip_forecast`) |
| **Micro (live action)** | RFQs, completions, dead ends, SMS/voice, orders | Real-time demand, unmet need, category momentum — the forecast that updates with every transaction |

This is **not** “here’s a listing.” It is:

> Get chicken and broccoli from McFlamingo, pay, schedule pickup; if delivery, RFQ drivers.  
> Same pattern for dentures, prescriptions, dog food, lawn jobs — with or without talking to the homeowner.  
> Every completed job feeds the hive so tomorrow’s routing is smarter than today’s.

### When

1. **Now** — Florida first (ZIP coverage, Sunbiz-backed listings, MCP live, macro signals live)
2. **Next** — Prove the full intent → fulfill → RFQ → wallet settlement loop; close the micro→forecast feedback loop
3. **Then** — Clone the state model across the country

### Where

| Layer | Location |
|-------|----------|
| Customer / agent UI | [thelocalintel.com](https://www.thelocalintel.com) (`localintel-landing`) |
| API / MCP / routing | `https://gsb-swarm-production.up.railway.app` (`gsb-swarm`) |
| Money / agent identity | [wildwallet.ai](https://wildwallet.ai) agent wallets (pathUSD / Tempo in current design) |
| Geography | Florida → every U.S. state as a copy of the same playbook |

### Why

Google and Angie’s List show you **who exists**. Amazon and DoorDash **extract** local demand and take a cut (or the whole sale).

LocalIntel exists so:

1. Historical local data becomes **actionable forecast**, not a static brief  
2. Small businesses **enter the agent-wallet world** without becoming Amazon sellers  
3. Customers / agents **complete tasks** — pay, schedule, hand off delivery or labor — and **money stays in the neighborhood**

### How (the loop)

1. Business claims / lists on TheLocalIntel → capabilities + wallet live in GSB Swarm  
2. Customer (or Dusty / wallet agent) speaks intent  
   - *“Chicken and broccoli at McFlamingo”*  
   - *“Where can I get my dentures replaced?”*  
   - *“I need my prescriptions”*  
   - *“The dog needs food”*  
3. Swarm matches using graph + macro/micro signals — not just a map pin  
4. Agent pays and schedules via wallet  
5. If a second actor is needed (driver, landscaper, …), TLI / Swarm **pushes an RFQ** to that supply side  
6. Job completes with or without the human in the middle  
7. `resolution_history` + dead ends feed ZIP signals → World Model → better forecasts  
8. Repeat the ZIP → county → state template for the next state  

---

## Repo split is packaging, not product

| If you are changing… | Work in… |
|----------------------|----------|
| Homepage, SEO pages, claim / inbox / search / RFQ **UI**, copy, brand | **`localintel-landing`** |
| Matching, MCP tools, RFQ dispatch, payments, wallets, business graph, signal/forecast workers, SMS / chat APIs, state expansion data | **`gsb-swarm`** |
| End-to-end “intent → pay → schedule → RFQ” behavior | **Both** — Swarm owns the loop; landing owns how humans and agents see it |

Default rule: **build the brain in `gsb-swarm`; dress and discover it in `localintel-landing`.**

---

## Example flows (north-star stories)

### Food order + optional delivery

1. Agent: “Get me chicken and broccoli at McFlamingo.”  
2. Swarm resolves McFlamingo, places / schedules the order, pays from the agent wallet.  
3. Pickup → done. Delivery → TLI pushes an RFQ to drivers; a driver accepts and completes.  
4. Settlement stays with the local merchant (+ driver), not a national marketplace.

### Home service without phone tag

1. Agent or homeowner posts a landscaping job.  
2. Swarm RFQs local landscapers.  
3. Winner takes the job and completes it with or without talking to the homeowner.

### Everyday errands

- Dentures → match specialty dental / prosthetics providers  
- Prescriptions → route to pharmacy capable of fulfillment  
- Dog food → match pet retailer / delivery as needed  

---

## Success looks like

- Macro + micro data **forecast** local demand (not just describe last year’s census)  
- A Florida small business can claim once, get a wallet, and receive real jobs from people and agents  
- A wildwallet.ai agent fulfills local tasks in natural language without hunting a directory or defaulting to Amazon  
- RFQs turn “I need X done” into competing local supply  
- Dollars that would have left town stay with local merchants  
- The Florida playbook is boring to copy into the next state  

---

*Last aligned: 2026-07-13 — keep both repos’ `PRODUCT.md` in sync when the vision changes.*
