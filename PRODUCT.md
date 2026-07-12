# Product Vision — TheLocalIntel + GSB Swarm

> Shared north star for both repos. Keep this file identical in
> `MCFLAMINGO/localintel-landing` and `MCFLAMINGO/gsb-swarm`.

## One-line product

**TheLocalIntel + GSB Swarm is Florida’s task router for people and AI agents** — not a static directory like Google or Angie’s List, but a live marketplace that matches intent → pays → schedules → RFQs the next hop (delivery, landscaper, pharmacy, etc.), then copies that state model nationwide.

---

## The 5 W’s and How

### Who

| Actor | Role |
|-------|------|
| **Customers** | People who need real-world work done, often via natural language |
| **Small businesses** | Restaurants, landscapers, dentists, pharmacies, pet stores, drivers, etc. who broadcast what they *actually* do |
| **AI agent wallets** | Agents funded via [wildwallet.ai](https://wildwallet.ai) that act for the customer |
| **MCFLAMINGO / LocalIntel** | Builds the Florida ground truth, the router, and the state playbook |

### What

A **two-surface system**:

| Surface | Repo | Job |
|---------|------|-----|
| **TheLocalIntel** | [`localintel-landing`](https://github.com/MCFLAMINGO/localintel-landing) | Public brand, SEO ZIP / biz / neighborhood pages, claim / inbox / RFQ / search UI at [thelocalintel.com](https://www.thelocalintel.com) |
| **GSB Swarm** | [`gsb-swarm`](https://github.com/MCFLAMINGO/gsb-swarm) | Brain + router: business graph, MCP tools, search, chat, RFQ dispatch, wallets, payments — live at `gsb-swarm-production.up.railway.app` |

This is **not** “here’s a listing.” It is:

> Get chicken and broccoli from McFlamingo, pay, schedule pickup; if delivery, RFQ drivers.  
> Same pattern for dentures, prescriptions, dog food, lawn jobs — with or without talking to the homeowner.

### When

1. **Now** — Florida first (ZIP coverage, Sunbiz-backed listings, MCP live)
2. **Next** — Prove the full intent → fulfill → RFQ loop in Florida
3. **Then** — Clone the state model across the country

### Where

| Layer | Location |
|-------|----------|
| Customer / agent UI | [thelocalintel.com](https://www.thelocalintel.com) (`localintel-landing`) |
| API / MCP / routing | `https://gsb-swarm-production.up.railway.app` (`gsb-swarm`) |
| Money / agent identity | [wildwallet.ai](https://wildwallet.ai) agent wallets (pathUSD / Tempo in current design) |
| Geography | Florida → every U.S. state as a copy of the same playbook |

### Why

Google and Angie’s List show you **who exists**.

LocalIntel exists so small businesses can **broadcast specialty**, and customers / agents can **complete tasks** — pay, schedule, hand off delivery or labor — without phone tag or a dead directory page.

### How (the loop)

1. Business claims / lists on TheLocalIntel → capabilities live in GSB Swarm  
2. Customer (or Dusty / wallet agent) speaks intent  
   - *“Chicken and broccoli at McFlamingo”*  
   - *“Where can I get my dentures replaced?”*  
   - *“I need my prescriptions”*  
   - *“The dog needs food”*  
3. Swarm matches the right business(es) — not just a map pin  
4. Agent pays and schedules via wallet  
5. If a second actor is needed (driver, landscaper, …), TLI / Swarm **pushes an RFQ** to that supply side  
6. Job completes with or without the human in the middle  
7. Repeat the ZIP → county → state template for the next state  

---

## Repo split is packaging, not product

| If you are changing… | Work in… |
|----------------------|----------|
| Homepage, SEO pages, claim / inbox / search / RFQ **UI**, copy, brand | **`localintel-landing`** |
| Matching, MCP tools, RFQ dispatch, payments, wallets, business graph, SMS / chat APIs, state expansion data | **`gsb-swarm`** |
| End-to-end “intent → pay → schedule → RFQ” behavior | **Both** — Swarm owns the loop; landing owns how humans and agents see it |

Default rule: **build the brain in `gsb-swarm`; dress and discover it in `localintel-landing`.**

---

## Example flows (north-star stories)

### Food order + optional delivery

1. Agent: “Get me chicken and broccoli at McFlamingo.”  
2. Swarm resolves McFlamingo, places / schedules the order, pays from the agent wallet.  
3. Pickup → done. Delivery → TLI pushes an RFQ to drivers; a driver accepts and completes.

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

- A Florida small business can describe what they do specially and receive real jobs — from people and agents  
- A wildwallet.ai agent can fulfill local tasks in natural language without the user hunting a directory  
- RFQs turn “I need X done” into competing supply (drivers, trades, specialty care)  
- The Florida playbook is boring to copy into the next state  

---

*Last aligned: 2026-07-12 — keep both repos’ `PRODUCT.md` in sync when the vision changes.*
