# Presence Protocol — The Fundamental Problem LocalIntel Solves

> Captured: 2026-06-10
> Author: Erik Osol
> Status: FOUNDATIONAL — this is what we are building

---

## The Core Problem

**How do people and businesses broadcast, signal, lighthouse, push, and enrobe the environment with their existence?**

Every person, every business, every service has the same fundamental need:

> *Here I am. This is who I am. What I am. Where I am. Why I am. How I am.*

This is the **W5+H** — the five questions plus How. It is the atomic unit of presence in the world.

Websites are window dressing on this more fundamental issue. They are a pretty picture painted over a data problem. AI agents expose the real issue because they function on **data availability** — not aesthetics. An agent doesn't see your logo. It reads your data.

---

## The Digital Flow Problem

```
DIGITAL IN  ←→  DIGITAL OUT
    ↑                 ↑
  Person           Business
  Agent            Agent
```

This is an **in-out / out-in** scenario. The struggle everyone has — person or business — is:

- **OUT**: How do I make my existence, availability, and capability known to the right people at the right time without paying a gatekeeper?
- **IN**: How do I receive signals, requests, and opportunities that are relevant to me without being drowned in noise?

The even flow of this is:

1. **I exist** — I declare my presence once
2. **I am findable** — my data is structured and queryable by any system, human or AI
3. **I receive** — relevant signals come to me when they match my declared presence
4. **I respond** — on my terms, at my cost, through my channel
5. **We transact** — the relationship between customer and business, not through a middleman

---

## The W5+H Presence Model

Every entity — person or business — has a presence profile made of six fields:

| Field | Question | Examples |
|---|---|---|
| **WHO** | Identity | Name, type, owner, team, agent key |
| **WHAT** | Capability / offering | Services, products, menu, skills, categories |
| **WHERE** | Location | ZIP, address, lat/lon, radius of service, delivery zone |
| **WHEN** | Availability | Hours, open now, booking slots, lead time |
| **WHY** | Value proposition | Why choose me, specialties, reviews, trust signals |
| **HOW** | Transaction method | Walk-in, appointment, RFQ, delivery, online order, agent-to-agent |

This is the schema. Everything else — search, discovery, RFQ, reservation, appointment, voice query, AI agent lookup — is just a query against this schema.

---

## The Two-Sided Architecture

LocalIntel is a **two-sided presence network**. Both sides broadcast and receive.

### Customer Side (People)

A person declares:
- WHO they are (optional — can be anonymous)
- WHAT they need (query, category, service type)
- WHERE they are (ZIP, address, coordinates)
- WHEN they need it (now, scheduled, flexible)
- WHY they need it (context — helps routing)
- HOW they want to transact (appointment, bid, delivery, walk-in)

They set this up **once** in their profile. Their AI agent carries it forward into every query.

### Business Side

A business declares:
- WHO they are (name, owner, license, Sunbiz ID)
- WHAT they offer (categories, menu, services, tags, keywords)
- WHERE they operate (ZIP, address, service radius for come-to-me)
- WHEN they are available (hours, booking calendar, lead time)
- WHY they are the right choice (description, reviews, trust signals)
- HOW they want to receive work (walk-in, RFQ, appointment request, agent endpoint)

They set this up **once** in their claimed profile. The system carries it forward.

---

## The Communication Model

### Four Service Types (from CTA routing work)

| Type | Who moves | Flow |
|---|---|---|
| **RFQ** | Provider comes to customer | Customer signals need → providers bid → customer selects → appointment confirmed |
| **Appointment** | Customer goes to provider | Customer requests slot → business confirms time → both get calendar entry |
| **Reservation** | Customer goes to provider | Customer requests table/room → business confirms → both get confirmation |
| **Info** | Neither (digital only) | Customer queries → gets info → contacts directly |

### The Notification Loop (both sides)

**Customer → Business:**
```
Customer submits request (with W5+H context)
  → Business notification_email receives structured job/request
  → Business reviews, asks for more info if needed
  → Business confirms / proposes time / submits bid
  → Appointment record created in DB
  → Both parties get confirmation with full context
```

**Business → Customer (proactive):**
```
Business updates their profile (new menu, new hours, special offer)
  → Change propagates to all relevant ZIP signals
  → Any agent querying that category/ZIP gets fresh data
  → Customer queries return updated info without business paying per-query
```

---

## The Cheapest Path Principle

> Build this in the cheapest way possible, not tied to gated tech.

**What this means in practice:**

- **No platform lock-in** — data lives in Postgres (our DB), not in Google, Yelp, Meta, or any walled garden
- **No per-query fees** — business pays once to be enrolled, not per search impression
- **No middleman on transactions** — the relationship is between customer and business. LocalIntel is infrastructure, not a broker.
- **Open channels** — email (Resend, free tier 3k/mo), SMS (Twilio, only when business has paid), voice (Twilio inbound), MCP (open protocol), direct agent-to-agent
- **AI-native from day one** — any AI agent (Claude, GPT, Gemini, local LLM) can query the MCP server and get structured presence data. No scraping, no HTML parsing, no API key required for read access.
- **Self-sovereign presence** — a business sets their profile once. It works across web search, voice query, SMS lookup, AI agent discovery, and reservation systems simultaneously.

---

## The Appointment / Transaction Completion Model

When a request moves to completion, an `appointments` record should capture:

```
WHO:   customer_contact + business_id
WHAT:  category + description + items/services agreed
WHERE: address (business address OR customer address for RFQ)
WHEN:  confirmed_datetime + duration_estimate
WHY:   original request context (the query that started it)
HOW:   transaction_type (rfq_confirmed | appointment | reservation)
       + payment_method if applicable
       + job_code for tracking
```

Both parties get this record delivered via their preferred channel (email, SMS, agent push).

---

## What Still Needs to Be Built

### Immediate (appointment loop closure)
- [ ] `appointments` table in Postgres
- [ ] Business-side inbox: see incoming requests, accept/decline, propose time
- [ ] Customer-side confirmation: email back with confirmed time + business contact
- [ ] For RFQ: bid submission form → customer accepts → becomes appointment record
- [ ] Appointment notification for non-wallet businesses (email to `contact_email`, no wallet required)

### Near-term (presence profile)
- [ ] Full W5+H profile editor on claimed business dashboard
- [ ] Customer presence profile (opt-in) — save preferred ZIP, categories, how they want to transact
- [ ] Agent profile endpoint: `GET /api/local-intel/presence/:business_id` returns structured W5+H JSON
- [ ] Presence completeness score — nudge businesses to fill in missing fields

### Strategic (open presence network)
- [ ] Any AI agent can POST a presence declaration for a person or business
- [ ] Any AI agent can GET a presence profile by ZIP + category + W5+H filters
- [ ] Presence updates propagate to zip_signals in real time
- [ ] Business sets update frequency: real-time, daily, weekly
- [ ] Customer agent carries W5+H context into every query automatically

---

## Why This Matters

Google charges businesses to appear in search. Yelp charges to suppress bad reviews. OpenTable takes a per-cover fee. DoorDash takes 30%. These are all toll booths on the same fundamental road: **I exist, I am available, I want to transact.**

LocalIntel eliminates the toll booth. The data is ours. The channel is open. The AI agent reads directly. The transaction is between the people.

The aesthetics (pretty websites, photos, ratings) matter and will be added — but they are **presentation layer on top of presence data**, not the other way around. Build the presence layer right and everything else follows.

---

## Session Reference

This vision was articulated by Erik Osol on 2026-06-10 during the search quality / CTA routing session. The immediate technical work (categoryMap, CTA routing, geo fallback, appointment notification) is the first concrete implementation of this model.

The north star is not a better Yelp. It is **presence infrastructure for the post-gatekeeper era**.
