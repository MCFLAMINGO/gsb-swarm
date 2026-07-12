# Deprecations — Do Not Extend

Paths that still exist in the tree but are **not** the product. Prefer the canonical stack in [`SYSTEM_MAP.md`](SYSTEM_MAP.md).

| Path | Why deprecated | Use instead |
|------|----------------|-------------|
| `localIntelWorker.js` | Flat-file LocalIntel, 2-ZIP | Postgres + MCP |
| `dataIngestWorker.js` | Flat-file ingest | Dashboard workers / overpass / YP |
| Writing to `rfq_requests_v2` / `rfq_responses_v2` | Parallel RFQ schema | `lib/rfqService.js` + UUID tables |
| New features on `lib/rfqBroadcast.js` jobs | v1 SMS job codes | `rfqService.createRfq` (codes optional UX only) |
| New `jobs` table flows in `localIntelAgent` without RFQ link | Third job model | `rfq_requests` |
| `taskDispatch` as primary business RFQ | Routes to `agents` table humans, not businesses | Business RFQ via `rfqService` |
| Assuming Tempo escrow holds funds | Log-only today | Surge checkout or ledger fees |
| Calling only `intentMap` or only `intentRegistry` from new code | Split brain | `lib/intentUnified.js` |
| Documenting SMS webhook as `POST /api/local-intel` | Wrong URL | `/api/rfq/sms-inbound` |
| `npm start` → dashboard-only without MCP fallback | Agents 503 | `index.js` boot or in-process `handleRPC` fallback |

When removing code, delete call sites first, then files in a dedicated PR after traffic confirms zero use.
