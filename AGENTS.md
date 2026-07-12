# AGENTS.md

## Cursor Cloud specific instructions

This is **LocalIntel** (`gsb-intelligence-swarm`): a Node.js app that exposes hyperlocal
Florida business intelligence as an **MCP server** for AI agents, plus an ops web dashboard.
It is backed by **PostgreSQL**. Standard run/test commands live in `package.json` `scripts`,
build config in `nixpacks.toml`, and architecture docs in `docs/` and `SYSTEM_SPEC.md`.

### Services (development)

| Service | Start command | Port | Notes |
|---|---|---|---|
| LocalIntel MCP server | `node localIntelMCP.js` | 3004 | Core product. Serves JSON-RPC at `POST /mcp`, tool list at `GET /manifest`. |
| Ops dashboard / API | `node --experimental-require-module --no-warnings dashboard-server.js` | 8080 | Web UI at `/`; also spawns ~21 background data workers. Public MCP proxy at `POST /api/local-intel/mcp` (forwards to `localhost:3004`). |
| Full swarm (all-in-one) | `node --import ./acp-loader.mjs index.js` | 8080/3004/3001 | Forks dashboard + MCP + extra workers + runs migrations. Heavy; prefer running the two services above individually in dev. |

`npm start` runs the dashboard only (port is hardcoded to 8080; `PORT` env is ignored).

### Database (required, non-obvious)

- The app needs Postgres via **`LOCAL_INTEL_DB_URL`** (NOT `DATABASE_URL`). Without it the
  server still boots but returns empty/degraded data.
- A local Postgres 16 cluster + a `localintel` DB/role are provisioned in this environment.
  The connection string is exported in `~/.bashrc`:
  `postgresql://localintel:localintel@127.0.0.1:5432/localintel`
- **Postgres is not auto-started on boot.** Start it each session with:
  `sudo pg_ctlcluster 16 main start`
- Migrations run automatically at boot (via `lib/dbMigrate.js`) whenever `LOCAL_INTEL_DB_URL`
  is set — they are idempotent, so you can also trigger them by starting `index.js` once.
- `pg` connects with `ssl: { rejectUnauthorized:false }` for any non-`railway.internal` host,
  so the local cluster must have `ssl = on` (it does, using the snakeoil cert).
- `lib/db.js` `db.query()` returns the **rows array directly** (no `.rows`).

### Seeding gotcha (important)

- The boot backfill (`scripts/backfillBusinesses.js`) uses `ON CONFLICT (lower(name), zip)`,
  which does **not** match the actual unique index `idx_businesses_name_zip_unique`
  = `(lower(trim(name)), zip) WHERE sunbiz_doc_number IS NULL`. On a **fresh** local DB the
  backfill therefore inserts 0 rows (in production it's a no-op because rows already exist).
- The `businesses` table in this environment was seeded from `data/zips/*.json` +
  `data/localIntel.json` using the correct conflict target (`lower(trim(name))`), matching
  `lib/db.js upsertBusiness`. If you need to reseed a fresh DB, insert with that conflict
  target rather than relying on the boot backfill.
- Free tools that read `businesses` (`local_intel_search`, `local_intel_stats`,
  `local_intel_nearby`, `local_intel_corridor`) return real data once seeded.
  `local_intel_ask` / `local_intel_oracle` / zone tools depend on the `zip_intelligence`
  table, which starts empty and is filled over time by background workers (needs external
  API / LLM keys); expect "No data found" from `ask` until then.

### Expected noise

- Background workers log non-fatal warnings for tables not created by migrations
  (e.g. `zip_queue`, `zip_coverage`, `rfq_requests`) and for missing optional API keys
  (`RESEND_API_KEY`, `NVIDIA_API_KEY`, `BASALT_API_KEY`, Twilio, `*_ENTITY_ID`, payment keys).
  These are safe to ignore for local development — all external integrations degrade gracefully.

### Quick end-to-end check

```bash
sudo pg_ctlcluster 16 main start            # ensure DB is up
node localIntelMCP.js &                      # MCP server on :3004
curl -s -X POST http://localhost:3004/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"local_intel_search","arguments":{"query":"restaurant","zip":"32082"}}}'
```
