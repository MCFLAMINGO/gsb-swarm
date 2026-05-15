# Postgres Schema — All Tables

All tables, key columns, migration index. Includes businesses, zip_signals, zip_intelligence, conversation_threads, subscriber_accounts, chat_log, subscriber_wallets, rfq, confirmed_jobs, sms_query_log, call_transcripts, intent_dead_ends, customer_sessions, property_parcels, and more.

## Postgres Tables (auto-created, never drop)

### Core Business Intelligence
```
businesses           — 122k+ FL businesses. pos_config is JSONB. pos_type via pos_config->>'pos_type'
                        Enrichment cols (session 9): category_intel JSONB, enrichment_source TEXT
                        DEFAULT 'system', enrichment_updated_at TIMESTAMPTZ
business_tasks       — Per-business setup tasks seeded by taskSeedWorker.
                        Cols: id UUID PK, business_id UUID FK→businesses, title TEXT,
                        status TEXT ('pending'|'done'|'skipped'), task_type TEXT
                        ('setup'|'data'|'integration'), template_key TEXT, metadata JSONB,
                        created_at, updated_at. Indexed on business_id and status.
zip_intelligence     — 1,109 rows. Now includes irs_agi_median, irs_returns,
                        irs_wage_share, irs_updated_at (added by irsSoiWorker)
zip_briefs           — 1,193 rows. Single source for /brief/:zip
zip_enrichment       — 1,012 rows. OSM POIs cached by overpassWorker
census_layer         — 0 rows, DO NOT USE
task_events          — intelligence signal layer
worker_events        — enrichment worker logs (also feeds /source-log + /enrichment-log)
agent_sessions       — MCP agent sessions
task_patterns        — self-improvement patterns
business_responsiveness — response tracking
rfq_gaps             — unmatched voice/web requests for self-improvement batch
voice_leads          — legacy audit log (still written to for orders)
acp_broadcast_log    — every registry broadcast + per-zip announcements (acpBroadcaster)
mcp_probe_log        — probe scores per persona/tool/zip (auto-created)
router_learning_log  — proposed VERTICAL_SIGNALS keyword patches (auto-created)
```

### Postgres-only worker contract (session 8)
Every worker now follows the same five-step shape — **the Railway disk is
ephemeral; nothing persists across redeploys except Postgres**:

1. START → ASK Postgres what's already done.
2. WORK → only process what's missing/new.
3. END   → upsert the result back into Postgres.
4. REDEPLOY SAFE — step 1 naturally re-skips on the next boot.
5. `process.env.FULL_REFRESH === 'true'` ignores all skip logic.

| Worker | Skip query | Result table |
|---|---|---|
| overpassWorker | `SELECT DISTINCT zip FROM businesses WHERE 'osm' = ANY(sources) AND status != 'inactive'` | `businesses` (+ `zip_enrichment` cache) |
| zipBriefWorker | `SELECT zip FROM zip_briefs WHERE generated_at > NOW() - INTERVAL '7 days'` | `zip_briefs` |
| irsSoiWorker | `SELECT zip FROM zip_intelligence WHERE irs_agi_median IS NOT NULL` | `zip_intelligence` |
| acpBroadcaster | `SELECT DISTINCT zip FROM acp_broadcast_log WHERE broadcast_at > NOW() - INTERVAL '30 days'` | `acp_broadcast_log` |
| localIntelAcpCycle | `SELECT zip FROM zip_briefs WHERE generated_at > NOW() - INTERVAL '48 hours'` | `zip_briefs` |
| routerLearningWorker | `SELECT MAX(run_at) FROM router_learning_log` (skip if <30 min) | `router_learning_log` |
| enrichmentFillWorker | `SELECT business_id FROM businesses WHERE zip = ANY(TARGET_ZIPS) AND category_intel IS NOT NULL AND enrichment_source IS NOT NULL` | `businesses` (services_text, description, category_intel, enrichment_source, enrichment_updated_at) |
| taskSeedWorker | `SELECT DISTINCT business_id FROM business_tasks` (run-once) | `business_tasks` |

`embeddingWorker` is **disabled** in `dashboard-server.js` — needs pgvector
to be revived.

All `data/*.json` writes for these workers are removed. CSV downloads
(IRS SOI) live in `os.tmpdir()`. Static seeds (e.g. `data/spendingZones.json`)
remain on disk but are read-only.

### Voice / Session
```
voice_sessions       — Postgres-backed CallSid session state for multi-turn ordering
                       Stages: greeting | menu_presented | order_building | order_confirmed
```

### RFQ Broadcast System (NEW — auto-created by lib/rfqBroadcast.js)
```
rfq_jobs             — id(UUID), code(6-char), caller_phone, caller_name, caller_email,
                       category, zip, description, status, broadcast_count, response_count,
                       selected_biz_id, callback_fired, created_at, expires_at(24h)
                       Status: open | matched | confirmed | closed | expired | no_providers

rfq_broadcasts       — job_id(FK), business_id, business_name, phone, email,
                       sms_sent, email_sent, sent_at

rfq_responses        — id(UUID PK), rfq_id(FK→rfq_requests), business_id, business_name,
                       quote_usd, message, eta_minutes, status(pending|accepted|declined), created_at
```

### Identity (NEW — auto-created by lib/callerIdentity.js)
```
caller_identities    — phone(PK), name, email, email_pending, zip,
                       wallet_address, wallet_chain, wallet_provisioned,
                       agent_key, rfq_count, order_count, created_at, last_seen
```

---


---

## Migration Index

| # | File | What it does |
|---|---|---|
| 017 | 017_world_model_schema.sql | zip_signals (168 cols), zip_signal_catalog, zip_intelligence_view |
| 018 | 018_*.sql | property_parcels, enrichment columns |
| 019 | 019_*.sql | rfq_jobs, rfq_broadcasts, rfq_responses |
| 020 | 020_*.sql | confirmed_jobs, sms_query_log |
| 021 | 021_*.sql | call_transcripts, voice_sessions |
| 022 | 022_*.sql | caller_identities, agent_memory |
| 023 | 023_ensure_worker_signal_columns.sql | ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS for all acs_* columns |
| 024 | 024_*.sql | router_learning_log, resolution_history |
| 025 | 025_*.sql | zip_enrichment, business_tasks |
| 026 | 026_*.sql | subscriber_accounts, chat_log |
| 027 | 027_*.sql | subscriber_wallets, agent_memory |
| 028 | 028_fl_place_index.sql | fl_place_index + fl_county_zips — all 67 FL counties, 150+ cities (replaces lib/flPlaceResolver.js) |
| 029 | 029_fl_zip_geo.sql | fl_zip_geo — 1,473 FL ZIPs with county, fips, lat/lon, population, median_hhi (replaces two static data files) |

### fl_zip_geo (migration 029)
```
fl_zip_geo — zip(PK), county, county_fips, state(default FL),
             lat, lon, population, median_hhi,
             created_at, updated_at
Indexes: fl_zip_geo_county_idx, fl_zip_geo_fips_idx
1,473 rows seeded — all FL ZIPs (951 with median_hhi, all with lat/lon + county)
```

---

## Key Tables — What Lives Where (Architecture Canon)

### Key Tables — What Lives Where

| Table | What it stores | Written by | Read by |
|---|---|---|---|
| `zip_signals` | All macro signals (168 columns) | All data workers | CEO assess, World Model, MCP oracle |
| `businesses` | 205k FL businesses | OSM/YP/Sunbiz import | MCP search, RFQ routing, Twilio |
| `business_tasks` | Task templates per business | taskSeedWorker, business owners | MCP RFQ, agent routing |
| `intent_dead_ends` | Failed queries (0 rows — pre-traffic) | deadEndLog.js | taskSignalWorker (future) |
| `sms_query_log` | SMS query/reply pairs | Twilio handler | CEO demand section |
| `resolution_history` | Every resolved task outcome | Main POST handler | Analytics, routerLearningWorker |
| `rfq_gaps` | 0-result RFQ categories | RFQ handler | routerLearningWorker, taskSignalWorker (future) |
| `property_parcels` | 171k SJC parcels | CAMA import | CEO property section |
| `zip_intelligence` | Legacy oracle_json blobs | oracleWorker (legacy) | MCP oracle fallback only |
| `worker_events` | Worker START/END/ERROR logs | All workers | Nodes dashboard |
| `worker_heartbeat` | Last run timestamp per worker | All workers | Nodes status |

