# Basalt / Surge API — Complete Reference

Full API reference for surge.basalthq.com — endpoints, auth, error codes, payment portal, subscriptions, McFlamingo slug, three-tier architecture, agentic order flow, patches.

## Basalt/Surge API — Complete Reference

> Captured from Basalt developer docs shared in session. All endpoints use base URL `https://surge.basalthq.com`.

---

## Auth

- Header: `Ocp-Apim-Subscription-Key: <BASALT_API_KEY>` — this is the ONLY required auth header
- APIM automatically stamps `x-subscription-id` for the backend
- **NEVER send** `x-wallet`, `x-merchant-wallet`, or `wallet` headers — APIM strips them and returns 403

---

## Health

```
GET /healthz
```
- Public, no auth required
- Returns: `{ ok: true, status: "ok", dependencies: { apim, backend, database } }`
- Use to verify Basalt service is up

---

## Inventory

```
GET /api/inventory
```
- Fetch merchant SKU catalog
- Query params:
  - `priceMin=0.01` — filters out $0.00 modifier/add-on items
  - `pack=restaurant` — restaurant-optimized response shape
  - `q=<search term>` — full-text search
  - `category=<category>` — filter by category
  - `tags=<tag>` — filter by tag
  - `limit=<n>` — max 200 per page
  - `page=<n>` — pagination
- `stockQty: -1` means unlimited stock
- Returns array of SKU objects: `{ sku, name, description, price, category, tags, stockQty, imageUrl }`
- Use `priceMin=0.01` to exclude modifiers when building order UIs

---

## Orders

```
POST /api/orders
```
- Body: `{ items: [{ sku: string, qty: number }], jurisdictionCode: 'US-FL' }`
- `jurisdictionCode` is required — always `'US-FL'` for McFlamingo
- Returns: `{ ok: true, receipt: { receiptId, totalUsd, lineItems, status } }`
- Error `items_required` (400) if items array is empty
- Error `inventory_item_not_found` (400) if SKU doesn't exist
- Error `split_required` (403) if merchant split is not configured (McFlamingo split IS configured)

---

## Receipts

```
GET /api/receipts/status?receiptId=<id>
```
- Returns: `{ id, status, transactionHash, currency, amount }`
- Full status flow: `generated → pending → paid → completed`
- Other statuses: `refunded`, `tx_mined`, `recipient_validated`, `tx_mismatch`, `failed`
- Poll for `completed` / `tx_mined` / `recipient_validated` to confirm payment
- Webhook: Set `webhook_url` on `POST /api/receipts` for push notification on payment

---

## Payment Portal

- Payment URL: `https://surge.basalthq.com/portal/${receiptId}`
- Iframe embed params: `?recipient=<wallet>&embedded=1&correlationId=${receiptId}`
- McFlamingo recipient wallet: `0xe66cE7E6d31A5F69899Ecad2E4F3B141557e0dED`
- Full iframe URL: `https://surge.basalthq.com/portal/${receiptId}?recipient=0xe66cE7E6d31A5F69899Ecad2E4F3B141557e0dED&embedded=1&correlationId=${receiptId}`
- **CSP ACTION NEEDED**: Ask Basalt team to add `thelocalintel.com` to `frame-ancestors` for `/portal/*`
- PostMessage events from iframe:
  - `gateway-card-success` — payment completed
  - `gateway-card-cancel` — user cancelled
  - `gateway-preferred-height` — iframe resize hint
- Origin check: `event.origin !== 'https://surge.basalthq.com'` → return (ignore)
- CSP fallback: if iframe blocked after 4s, open `paymentUrl` in new tab

---

## Shop Config

```
GET /api/shop/config                          (by subscription key)
GET /api/shop/config?slug=mcflamingo         (public, no auth)
```
- Returns merchant configuration, branding, enabled features

---

## Split

- Split contract MUST be configured in Admin UI before orders can be placed
- McFlamingo split: **ALREADY CONFIGURED** — not a blocker
- Default split: merchant 99.5% (9950 bps) / platform 0.5% (50 bps)
- Processing fee: 0.5% base + configurable merchant add-on, applied after tax
- Error `split_required` (403) if split not configured

```
GET /api/split/transactions    (subscription key required)
```
- Returns split transaction history

---

## Billing

```
GET /api/billing/balance
```
- Returns: `{ balances: [{ currency, available, reserved }], usage: { monthUsd } }`

---

## Tax Catalog

```
GET /api/tax/catalog
```
- Returns valid `jurisdictionCode` values
- Use to validate before placing orders

---

## Users

```
GET /api/users/search?q=<query>&live=true
```
- Wallet lookup / user search
- `live=true` for real-time results

---

## GraphQL

```
POST /api/graphql
```
- Read-only API
- Supported queries:
  - `user(wallet: "<addr>")` — user profile
  - `liveUsers` — currently active users
  - `leaderboard(limit: <n>)` — top users

---

## Subscriptions (Recurring Payments)

```
POST /api/subscriptions/plans
```
- Uses EIP-712 SpendPermission for recurring billing
- SpendPermissionManager contract: `0xf85210B21cC50302F477BA56686d2019dC9b67Ad` (Base mainnet)
- Base mainnet USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals)

---

## Reserve

```
GET /api/reserve
```
- Returns reserve/liquidity data for the merchant

---

## Supported Cryptocurrencies

- ETH, USDC, USDT, cbBTC, cbXRP

---

## Error Codes

| Code | HTTP | Description |
|------|------|-------------|
| `split_required` | 403 | Merchant split contract not configured |
| `unauthorized` | 401 | Missing or invalid subscription key |
| `forbidden` | 403 | Wallet header present (strip it!) or other auth failure |
| `inventory_item_not_found` | 400 | SKU not found in merchant catalog |
| `rate_limited` | 429 | Too many requests |
| `items_required` | 400 | Empty items array in order POST |
| `cosmos_unavailable` | — | Basalt internal DB unavailable; `response.degraded=true` |

---

## Degraded Mode

- When Cosmos (Basalt's internal DB) is unavailable, responses include `degraded: true`
- Data temporarily served from memory/cache
- Orders and payments may still work in degraded mode

---

## McFlamingo Reference

| Field | Value |
|-------|-------|
| business_id | `232c34cb-ff82-4bf9-8a5c-d13306550709` |
| Basalt slug | `mcflamingo` |
| merchant wallet | `0xe66cE7E6d31A5F69899Ecad2E4F3B141557e0dED` |
| jurisdictionCode | `US-FL` |
| Split configured | YES |
| Inventory SKUs | 92 (wine, food, beverages, dressings) |
| $0.00 items | Modifiers/add-ons — exclude from order UI |

---

## Three-Tier Architecture

```
Frontend (no key)
    ↓
gsb-swarm backend (holds BASALT_API_KEY)
    ↓
Basalt API (https://surge.basalthq.com)
```

Never expose `BASALT_API_KEY` to frontend. All Basalt calls must go through the gsb-swarm backend proxy.

---

## Agentic Order Flow (Implemented)

1. User types "order X from Y" → `ORDER_ITEM` intent detected in `localIntelAgent.js`
2. `GET /api/local-intel/menu/:business_id?q=X` → fetches Basalt inventory, fuzzy-matches items
3. User selects item → `POST /api/local-intel/place-order` → creates Basalt order, returns `receiptId + portalLink`
4. Frontend shows payment iframe (`surge.basalthq.com/portal/${receiptId}`)
5. `GET /api/local-intel/order-status/:receiptId` polls receipt status → logs to `usage_ledger` on `gateway-card-success`

```
ORDER_ITEM regex (full):    /(?:\border(?:\s+me)?\s+|\bI(?:'d|\s+would)\s+like\s+|\bI\s+want\s+|\bget\s+me\s+|\bcan\s+I\s+(?:get|order)\s+)(?:a\s+|an\s+|some\s+)?(.+?)\s+(?:from|at)\s+(.+?)(?:\s+(?:in|near)\s+.+)?$/i
ORDER_ITEM regex (partial): /(?:\border(?:\s+me)?\s+|\bI(?:'d|\s+would)\s+like\s+|\bI\s+want\s+|\bget\s+me\s+|\bcan\s+I\s+(?:get|order)\s+)(?:a\s+|an\s+|some\s+)?(.+?)(?:\s+(?:in|near)\s+.+)?$/i
AT_BIZ regex (resolves pending intent): /^(?:at|from)\s+(.+?)(?:\s+(?:in|near)\s+.+)?$/i
```

Two-turn flow: a partial match ("I want chicken") returns `intent: 'ORDER_ITEM_PARTIAL'` and stores the item in an in-memory `_pendingOrderIntent` Map keyed by sessionId (5-min TTL). The next message ("at McFlamingo") matches `AT_BIZ`, pulls the pending item, and runs the normal ORDER_ITEM resolver. SessionId derives from `x-session-id` header or falls back to forwarded-for/remoteAddress IP.

Fuzzy match: token overlap scoring, no LLM, STOP words filtered.

---

## Shopify Future Path

Businesses with Shopify → Surge import can be routed via Shopify Storefront API (future feature).


---

## Patches Applied 2026-05-03 (session 11 — Basalt API correctness pass)

Three fixes to the agentic order flow in `localIntelAgent.js` (commit `7aab661`):

1. **Removed `x-merchant-wallet` header from menu fetch** — APIM resolves merchant wallet from the subscription key automatically. Sending the header causes 403. Inventory call now sends only `Ocp-Apim-Subscription-Key`.
2. **Canonical `paymentUrl` construction** — no longer parses `portalLink` from the order response. Always built from `receiptId`:
   ```js
   const paymentUrl = `https://surge.basalthq.com/portal/${receiptId}?recipient=0xe66cE7E6d31A5F69899Ecad2E4F3B141557e0dED&embedded=1&correlationId=${receiptId}`;
   ```
   Uses LocalIntel routing wallet `0xe66cE7E6d31A5F69899Ecad2E4F3B141557e0dED` and `embedded=1` for iframe mode.
3. **`jurisdictionCode: 'US-FL'` added to POST `/api/orders` body** — required for all McFlamingo orders. Body shape is now `{ items: [{sku, qty}], jurisdictionCode: 'US-FL' }`.

Frontend (localintel-landing) was upgraded to embedded iframe with PostMessage origin verification (`event.origin !== 'https://surge.basalthq.com'`), handling `gateway-card-success`, `gateway-card-cancel`, and `gateway-preferred-height`. Falls back to new tab if iframe load fails (CSP).

2026-05-03 patch 2: removed x-merchant-wallet from GET /api/inventory call in menu endpoint

---

## Patches Applied 2026-05-04

- `f31444d` — fix: fault-tolerant ensureSchema (per-stmt catch), migration_002 dollar-quoting
- `d18c59a` — feat: broader ORDER_ITEM regex + pending session intent
- `44a8348` — fix: agentic order routes use surgeAgent per-biz key (not global env var)
- `8512ee5` — feat: isOpenNow pre-check on place-order, friendly closed message
- `72bfcde` — feat: Phase 1 tsvector GIN index + cuisine + backfill worker
- `e7e9ddd` — feat: Phase 2 intent router + tsvector search wired to search bar
- `5560af7` — feat: Phase 3 data quality — 50+ OSM tags, YP infer expansion, OSM name/category wins merge
- `f9122a5` — feat: Phase 4 matchReason + open/claimed/confidence sort
- `7f1ab3c` — feat: categoryReclassWorker backfill
- `a520f3f` — feat: task dispatch layer — tasks/agents/task_events, dispatchTask, Twilio reply handler
