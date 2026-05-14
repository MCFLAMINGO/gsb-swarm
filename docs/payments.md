# Payments

Tempo mainnet, pathUSD, payment model (pay on confirmed completion only), viem usage, PLAYER wallet, EXECUTOR wallet.

## Payment / Chain Reference
| Chain | Token | Treasury |
|---|---|---|
| Tempo mainnet | pathUSD | `0x774f484192Cf3F4fB9716Af2e15f44371fD32FEA` |
| Base mainnet | USDC | `0x1447612B0Dc9221434bA78F63026E356de7F30FA` |

---


---

## Payment Model (locked in)

## Payment Model (locked in)

**Businesses pay micro-fees to be in the routing flow — not consumers.**
- `$0.001–$0.05` per agent/human query routed to them (compute cost for being surfaced)
- `0.05%–1%` on confirmed transactions (purchase, booking, RFQ accepted)
- `wallet IS NOT NULL` = in the paid routing tier. No wallet = in DB but agents skip you.
- x402 middleware flips from "consumer pays to query" → "business pays to be found"
- Payment rail: Tempo mainnet pathUSD

This means the claimed+wallet businesses are the product. The data layer is the engine.

---


---

## Payment Model Notes (architecture locked)

### Payment model notes (architecture locked)
- LocalIntel = routing layer only. Does NOT process orders or payments.
- `menu_url` on `businesses` table is the agentic handoff link (Toast/Surge for McFlamingo)
- Routing fee (0.05%–1% on confirmed transactions) triggered by future on-chain confirmation wired to `usage_ledger.tx_hash`
- Businesses without `menu_url` fall back to `website`; future: Surge agentic API can place order directly

