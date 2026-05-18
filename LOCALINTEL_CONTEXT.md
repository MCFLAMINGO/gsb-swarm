# LocalIntel Context Index

> Last updated: 2026-05-17
> This file is the table of contents. All detailed context lives in docs/.

## Quick Reference
- **Repo:** MCFLAMINGO/gsb-swarm (Railway) | MCFLAMINGO/gsb-swarm-dashboard (Vercel ops) | MCFLAMINGO/localintel-landing (thelocalintel.com)
- **Railway:** gsb-swarm-production.up.railway.app
- **Admin token:** localintel-migrate-2026
- **Git push:** `HOME=/home/user GIT_CONFIG_GLOBAL=/home/user/.gitconfig-proxy git push origin main`
- **North Star:** $546k
- **DB rule:** `db.query()` returns array directly — NEVER `.rows`
- **Payment:** Tempo mainnet, pathUSD, pay on confirmed completion only
- **LLM rule:** ZERO LLM API calls for LocalIntel intelligence (CEO/search layers) — LLM only in /api/local-intel/chat (subscriber tier)

## Docs

| File | What's in it |
|---|---|
| [architecture.md](docs/architecture.md) | Three access points, hive model, bees/macro/micro, messaging as routing |
| [basalt-surge-api.md](docs/basalt-surge-api.md) | Full Basalt/Surge API reference, payment portal, subscriptions |
| [subscribers.md](docs/subscribers.md) | $9.99/mo chat tier, trial flow, agent wallets, Surge subscription endpoints |
| [data-workers.md](docs/data-workers.md) | All 17 data workers, Railway env vars, worker contract, zip_signals coverage |
| [postgres-schema.md](docs/postgres-schema.md) | All tables, key columns, migration index (001–027) |
| [intent-routing.md](docs/intent-routing.md) | Intent layer, W5 reasoning, resolvesVia routing, conversational design |
| [infrastructure.md](docs/infrastructure.md) | Repos, Railway IDs, Vercel projects, git commands, env vars list |
| [session-log.md](docs/session-log.md) | Full B-series changelog (B1–B58), Problem/Fix/Result |
| [mcflamingo.md](docs/mcflamingo.md) | McFlamingo reference — business_id, address, wallet, Surge catalog |
| [ceo-layer.md](docs/ceo-layer.md) | CEO page, ceo-assess, ceo-query engine, 12 sections, zero LLM |
| [mcp-server.md](docs/mcp-server.md) | MCP server, 22 tools, market intel / discovery / task dispatch |
| [twilio-voice.md](docs/twilio-voice.md) | SMS + voice layer, voiceIntake, conversation threading, call logs |
| [payments.md](docs/payments.md) | Tempo, pathUSD, payment model, viem, wallets |
| [roadmap.md](docs/roadmap.md) | Official roadmap, north star, pending setup, strategic direction |

## Active B-Series
See [session-log.md](docs/session-log.md) for full history.
Latest: B68a — claimOutreachWorker dry-run guard + LocalIntel mission outreach message (CLAIM_OUTREACH_LIVE=true to go live) (2026-05-18)
Built & pushed: B66 (email harvest + claim outreach) · B67 (biz_density_per_1k fix) · B67b (Twilio appendTurn fix) · B67c (websiteEnricherWorker daemon + trigger) · B68a (claim outreach dry-run guard)
Next build: B69 — censusLayerWorker syntax fix + rfq-poll job_id column fix + content-engine env var refresh
