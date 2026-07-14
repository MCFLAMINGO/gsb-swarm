# Business UX — Trust-First Broadcast Home

> **Canon for how Florida businesses (then every state) join LocalIntel.**  
> Swarm owns these APIs. Landing (`localintel-landing`) owns the screens.  
> Related: [`PRODUCT.md`](../PRODUCT.md) · [`presence-protocol.md`](presence-protocol.md) · [`SYSTEM_MAP.md`](SYSTEM_MAP.md)

---

## The problem

Today a business faces **many doors** (claim wizard, merchant magic link, provider-register, wallet, Surge APIM paste, W5+H patches, agent-profile). That feels like paperwork. People get scared and bounce.

**Surge / Basalt works** because: one merchant identity → catalog → receipt → pay → done. Secrets stay on the server. State is obvious.

We need that elegance for **every** business — restaurant, landscaper, dentist, florist — with one generalized format.

---

## One product sentence

**Claim with an email. Broadcast what you do in plain language. Get jobs. Connect pay when money shows up — not before.**

---

## The unified business home (one place)

```
┌─────────────────────────────────────────────────────────┐
>  YOUR BUSINESS HOME                                      │
>  presence score · next one action · open jobs            │
>                                                         │
>  [ Broadcast ]  [ Jobs ]  [ Get paid ]  [ Share pack ]  │
└─────────────────────────────────────────────────────────┘
```

| Tab | Job | Fear reducer |
|-----|-----|----------------|
| **Broadcast** | W5+H in plain words: who / what / where / when / why / how | Pre-filled from listing; they only *confirm* or edit |
| **Jobs** | RFQ / appointments / orders for **this** business only | One day’s live window; clear Accept / Quote / Done |
| **Get paid** | Surge · wallet · prepaid agent cards · invoice/cash | Shown **after** first job interest, not at claim |
| **Share pack** | One-pager + QR + “how agents find you” | Download or email — no form |

Auth: permanent **`dispatch_token`** in `inbox.html?token=…` (never the legacy 24h `dashboard_token`).

---

## Generalized format (every place)

Same schema for all verticals — W5+H presence:

| Field | Plain prompt | Example |
|-------|--------------|---------|
| WHO | What’s your business name? | McFlamingo |
| WHAT | What do you do specially? | Healthy bowls, chicken & broccoli, local wine |
| WHERE | Where do you work? | 880 A1A N · ZIP 32082 · deliver within 8 mi |
| WHEN | When can people get you? | Mon–Sat 10:30–8 · same-day when open |
| WHY | Why pick you? | Best of Ponte Vedra · organic options |
| HOW | How should work arrive? | Order · RFQ · appointment · walk-in |

Agents read `GET /api/local-intel/presence/:business_id`. Humans edit via Broadcast.  
**Surge merchants** map WHAT → catalog SKUs; **non-Surge** map WHAT → services/tags + RFQ.

---

## Trust-first claim (no scary forms)

### Do ask at claim
1. Find listing (`/claim/lookup`)  
2. Email **or** phone  
3. 6-digit code  

### Do **not** ask at claim
- Wallet / crypto  
- Surge APIM key  
- Full W5+H essay  
- Bank / SSN / EIN  

### After verify (automatic)
- Mint `dispatch_token`  
- `accepts_rfq = true` (open for work)  
- Email **welcome pack** (inbox link + one-pager + “agents can find you”)  
- Home shows **one next action**: “Add one specialty in a sentence”

Progressive unlock:

```
contact_verified → presence_draft → live → pay_ready
```

Pay connectors (Surge / wallet / prepaid agent settlement) unlock when:
- they have an open job, **or**
- they tap “I want to get paid for orders”

---

## Payment rails (simple menu, not a lecture)

| Rail | Who uses it | When to show |
|------|-------------|--------------|
| **Surge / Basalt portal** | Catalog merchants (McFlamingo pattern) | “Connect Surge” — slug first, APIM only if needed; secrets stay on Swarm |
| **Agent wallet (pathUSD / Tempo)** | Crypto-native businesses | Optional; never blocking |
| **MCP x402 (USDC Base)** | Agent→API paywalls | Agent side, not merchant claim |
| **Prepaid agent cards** | Agents funded with prepaid / card rails that settle jobs | Parallel to x402 — customer agent pays job; merchant receives via preferred HOW |
| **Invoice / cash / card-offline** | Everyone else | Default “get paid however you already do” |

**Design rule:** merchant never needs to understand x402. Agents pay; LocalIntel routes; merchant sees “Paid · Confirm · Done.”

Prepaid agent cards (product intent):
1. Agent holds prepaid balance (WildWallet / card product)  
2. Job completes → settle to merchant rail (Surge split, ACH later, or ledger credit)  
3. Same inbox UX as Surge receipt — one job state machine  

---

## Onboarding pack (send everything important)

One downloadable / emailable pack so they don’t hunt docs:

1. Inbox link (bookmark this)  
2. Public presence URL (what agents see)  
3. Plain-language “how jobs arrive”  
4. QR to their listing  
5. One specialty prompt  
6. Optional: Surge one-pager for catalog shops  

APIs:
- `GET /api/local-intel/inbox/home?token=` — home state + next actions  
- `GET /api/local-intel/business/:id/onboarding-pack` — JSON / HTML  
- `POST /api/local-intel/inbox/send-pack` — email the pack  

---

## Landing handoff (`localintel-landing`)

Wire screens to Swarm — do not rebuild brain:

1. Collapse claim to 3 steps matching trust-first rules  
2. Inbox → single **Business Home** calling `/inbox/home`  
3. Broadcast editor = W5+H plain prompts (pre-filled)  
4. “Share pack” button → download HTML + send-pack  
5. Hide wallet/Surge until Jobs or Get paid tab  

---

## Success looks like

- Owner claims in under 2 minutes with email only  
- They understand “agents and people can find what I do specially”  
- First job appears in Jobs without them configuring crypto  
- Surge stays the easy path for catalog merchants  
- Prepaid agent pay feels like a receipt, not a protocol  

---

*Aligned: 2026-07-13 — elegant, novel, not scary.*
