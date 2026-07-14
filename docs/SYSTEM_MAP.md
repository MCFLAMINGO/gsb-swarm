# System Map — Result = Task Done

> **Operating contract for GSB Swarm / LocalIntel.**  
> Read with [`PRODUCT.md`](../PRODUCT.md).  
> If an agent did a lot of work but the customer still has no food, no landscaper, no Rx — **it failed.**

---

## The result we optimize for

```
Intent (human or agent)
  → Match the right business (search / graph)
  → Fulfill (order | appointment | RFQ bid)
  → Optional second hop (delivery / labor RFQ)
  → Pay on confirmed completion
  → Done
```

Activity without that result is drift.

---

## Canonical surfaces (one program)

| Surface | Owns | Do not use for |
|---------|------|----------------|
| **`GET /api/local-intel/search`** | Human + landing discovery | Duplicate invent of intent |
| **`POST /api/local-intel/mcp`** (+ `/mcp`) | Agent tools | Filesystem MCP / dead workers |
| **`lib/rfqService.js` + `rfq_requests` (UUID)** | All RFQ create/book/complete | `rfq_requests_v2`, parallel `jobs`/`tasks` for new work |
| **`POST /api/local-intel/place-order`** | Surge catalog orders (McFlamingo seed) | Inventing a second order stack |
| **`/api/rfq/sms-inbound`** | Twilio SMS replies | Documenting SMS as `POST /api/local-intel` |
| **`lib/intentUnified.js`** | Single intent API for all channels | Picking a random intent module per route |

---

## Intent → HOW (resolvesVia)

| resolvesVia | Meaning | Next step |
|-------------|---------|-----------|
| `search` | Discover / info | Return ranked businesses + CTA |
| `surge` / order | Named item + orderable merchant | `place-order` / Surge menu |
| `rfq` | Need a provider to bid / come to me | `rfqService.createRfq` → dispatch → book → complete |
| `reservation` | Table / slot at a place | Reservation handler |
| `status` | Track existing order/job | Status endpoints |

Module: **`lib/intentUnified.js`** (`normalizeQueryIntent`).  
Legacy modules (`intentMap`, `intentRegistry`, `taskIntent`, `intentRouter`) still exist underneath — **new code must call the unified API.**

---

## Search = one upgraded chain (not a parallel product)

Humans (`GET /search`) and agents (POST/SMS / MCP) share the **same** discovery ladder. Semantic is a step on that ladder, not a second search app.

```
ILIKE / category / name
  → tsvector (Postgres full-text)
  → pgvector cosine via eloquent-energy (lib/semanticSearch.js)
  → RFQ / dispatch when still unresolved
```

| Canonical | Parallel — do not revive |
|-----------|--------------------------|
| `services/embedder/` + Railway `eloquent-energy` (nomic 768-d) | `workers/embeddingWorker.js` + `embed_server.py` (MiniLM → disk) |
| `workers/embeddingBackfillWorker.js` → `businesses.embedding` | Full statewide re-embed / second vector column |
| `lib/semanticSearch.js` used by GET + POST | Sidecar-only public search API |

---

## RFQ truth

| Use | Do not use for new work |
|-----|-------------------------|
| `rfq_requests` / `rfq_responses` / `rfq_bookings` via `rfqService` | `rfq_requests_v2` / `rfq_responses_v2` |
| Inbox respond + SMS YES/NO bound to UUID RFQs | Parallel `jobs` table MCP tools without linking RFQ |
| `dispatchRail` (Surge → Stripe → SMS → email) | Tempo escrow as if live (still intent-only) |

Business SMS replies: prefer Accept/Decline links; YES/NO also binds to canonical RFQ via phone + `rfq_broadcast_log`.

---

## MCP truth

1. Production boot: `nixpacks.toml` → `index.js` forks **dashboard :8080** + **MCP :3004**.  
2. Proxies (`/mcp`, `/api/local-intel/mcp`) prefer `:3004`, **fall back to in-process `handleRPC`** if the child is down.  
3. Canonical public URL: `https://gsb-swarm-production.up.railway.app/api/local-intel/mcp`

---

## Payments that are real vs aspirational

| Rail | Status |
|------|--------|
| Surge / Basalt checkout | **Real** — use for seed food/order demos |
| x402 USDC (Base) on MCP | **Real** for agent tool paywalls |
| pathUSD ledger (`apiKeyMiddleware`) | Ledger; deposits gated |
| Twilio SMS dispatch | **Real** when Twilio env + `twilio` package present |
| Stripe Connect | Coded; needs keys |
| Tempo escrow | **Log-only** — do not promise in demos |

---

## Worker budget (search SLO)

Keep on the web service (search / RFQ hot path): merge, hours, enrichment, overpass/sunbiz, notification, dispatch watchdog, task seed, category repair.

Macro batch (census, FRED, tidal, world model, etc.) must not starve search. Prefer separate process/cron when scaling.

---

## Deprecated / do-not-extend

See [`DEPRECATIONS.md`](DEPRECATIONS.md). Short list:

- `localIntelWorker.js`, `dataIngestWorker.js` — flat-file era  
- `rfq_requests_v2` write paths — legacy SMS only until drained  
- ACP fire-job / Virtuals agents without ENTITY_ID — paused  
- Documenting “zero LLM everywhere” while `/chat` and `/nl-query` exist — be honest per route  

---

## Where to change code

| Goal | Files |
|------|-------|
| Better matching / intent | `lib/intentUnified.js` → then registry/map |
| Search ranking / SQL | `localIntelAgent.js` `GET /search`, `lib/searchRank.js` |
| Semantic step in **same** search chain | `lib/semanticSearch.js` + `lib/embedderClient.js` → Railway `eloquent-energy` |
| Embedding backfill (same path) | `workers/embeddingBackfillWorker.js` → `businesses.embedding` |
| RFQ loop | `lib/rfqService.js`, `lib/dispatchRail.js` |
| Agent tools | `localIntelMCP.js` |
| SMS / voice | `dashboard-server.js` `handleSmsInbound`, `lib/voiceIntake.js` |
| Orders | `lib/surgeAgent.js`, `place-order` route |

Landing UI lives in **`localintel-landing`** — separate agent. Swarm owns the loop; landing dresses it.

---

## Smoke test

```bash
node scripts/smoke-task-loop.js
```

Expect: intent classification for food / landscaper / dentures / Rx / dog food, and RFQ vs search HOW tags that match PRODUCT.md stories.

---

*Aligned: 2026-07-12 — organize for task completion, not perpetual integration theater.*
