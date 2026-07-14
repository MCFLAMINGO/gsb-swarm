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
| `workers/embeddingWorker.js` + `workers/embed_server.py` (MiniLM → `data/embeddings/`) | Parallel semantic build; Railway disk ephemeral; 384-d file vectors never shared with GET/POST search | `lib/embedderClient.js` + `lib/semanticSearch.js` + `workers/embeddingBackfillWorker.js` → `businesses.embedding` (768-d pgvector) via Railway `eloquent-energy` |
| Re-enabling full-corpus embedding of all Sunbiz rows | Parallel “boil the ocean” index (1.2GB, 0 scans) | Selective backfill only (claimed / showcase / rich text / NE-FL); raise cap only after scans prove value |
| A second search product / sidecar-only API for discovery | Splits humans vs agents | Same chain on `GET /search` and POST/SMS: ILIKE → tsvector → **pgvector** → RFQ/dispatch |
| New file-based or alternate-model embedder (another MiniLM, OpenAI embeddings, etc.) | Parallel vector spaces | One model: `nomic-ai/nomic-embed-text-v1` @ 768-d in `services/embedder/` |

When removing code, delete call sites first, then files in a dedicated PR after traffic confirms zero use.
