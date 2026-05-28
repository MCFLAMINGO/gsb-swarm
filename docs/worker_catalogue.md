# Worker Catalogue — gsb-swarm

Generated: 2026-05-11. Source: `/home/user/workspace/gsb-swarm-80485282/workers/` (each file read), plus active/disabled state extracted from `dashboard-server.js` `LOCAL_INTEL_WORKERS` registry (the Railway entry point; `index.js` is unused on Railway).

Conventions:
- **active**: launched as a child process by `dashboard-server.js`.
- **disabled**: present in `dashboard-server.js` but commented out (mostly the 6 disabled in commit `b94b088`, plus a few earlier).
- **on-demand**: not auto-spawned — invoked by HTTP route, CLI, scheduled cron, or another worker.
- **library**: not a worker — pure helper module imported by others.
- **dead-code**: no longer referenced anywhere live.

---

## Individual Workers

### acpBroadcaster.js
- **Status**: active
- **Data Source**: Postgres `businesses` (DISTINCT zip) + `acp_broadcast_log`
- **Output Table/File**: `acp_broadcast_log` (Postgres); HTTP server on port 3008
- **Run Frequency**: setInterval 4h
- **Downstream Consumer**: External AI-agent registries (LocalIntel MCP URL announcements)
- **Goal**: Advertise LocalIntel ZIP coverage to the ACP/agent ecosystem so external agents discover and pay to use it.
- **Priority**: MEDIUM
- **Notes**: Skips ZIPs broadcast in last 30 days unless `FULL_REFRESH=true`.

### acsWorker.js
- **Status**: active
- **Data Source**: US Census ACS 5-year API (B08301 commute, B19001 income, B25077 home value, B01001 age, B25003 owner-occupancy, B11001 households, B01003 population) per ZCTA
- **Output Table/File**: `pgStore.upsertAcsDemographics` + `pgStore.upsertZipSignals` (Postgres); `data/acs/{zip}.json`
- **Run Frequency**: On startup, then every 24h
- **Downstream Consumer**: `oracleWorker` reads ACS signals to fill demographic zeros; `zip_signals` consumed by signal tools
- **Goal**: Provide per-ZIP demographic affluence / WFH / retiree / owner-occupancy signals for downstream scoring.
- **Priority**: HIGH
- **Notes**: Source of `wfh_pct`, `affluence_pct`, `retiree_index`, `new_build_pct`, `vacancy_rate_pct`, `median_home_value` that oracleWorker depends on.

### agentMemoryWorker.js
- **Status**: on-demand (library, called from MCP query handlers)
- **Data Source**: In-process MCP query events
- **Output Table/File**: Postgres `agent_memory`
- **Run Frequency**: Per-query (record); `clearOldMemory` prunes >90 days
- **Downstream Consumer**: MCP query handlers (`getDelta`, `getAgentContext`) — personalizes responses for repeat agents
- **Goal**: Track per-agent query patterns + ZIP-visit history so the MCP can deliver deltas instead of full state.
- **Priority**: MEDIUM
- **Notes**: Not in the worker launcher — it's hooked into MCP query path.

### bbbScraper.js
- **Status**: on-demand
- **Data Source**: Better Business Bureau public HTML search by ZIP
- **Output Table/File**: `businesses` (via `db.upsertBusiness`); `data/zips/{zip}.json`
- **Run Frequency**: Called by `enrichmentAgent` and bulk on-demand; no setInterval
- **Downstream Consumer**: `enrichmentAgent.enrichFromBBB`; core `businesses` table
- **Goal**: Discover/enrich BBB-accredited businesses as a high-confidence source.
- **Priority**: LOW
- **Notes**: Not in launcher — only fires when enrichmentAgent invokes it.

### beaWorker.js
- **Status**: on-demand (CLI / external cron)
- **Data Source**: BEA Regional Economic Accounts API — CAINC1 Line 3 per-capita personal income for FL counties
- **Output Table/File**: `pgStore.upsertZipSignals`; `worker_heartbeat`
- **Run Frequency**: Single-pass (run via scheduler externally); 2 API calls
- **Downstream Consumer**: `zip_signals` → oracle/scoring
- **Goal**: Add county-level per-capita income (level, YoY, 5yr CAGR) to every FL ZIP signal block.
- **Priority**: MEDIUM
- **Notes**: Not in launcher — counterpart to fred/qcew/qwi etc.

### bedrockWorker.js
- **Status**: active
- **Data Source**: SJC ArcGIS building-permit FeatureServer, FDOT road projects ArcGIS, FEMA NFHL (with hardcoded fallback), business data
- **Output Table/File**: `pgStore.upsertBedrockScore` (Postgres); `data/bedrock/{zip}.json` + `_index.json` (writes redirected to `/tmp/bedrock` on Railway)
- **Run Frequency**: On start, then weekly incremental + monthly full refresh
- **Downstream Consumer**: Oracle worker, `mcpMiddleware` (signal_block), localIntelTidalTools
- **Goal**: Compute `infrastructure_momentum_score` 0–100 per SJC ZIP from permits / roads / flood signals (Layer 1 — Bedrock).
- **Priority**: HIGH
- **Notes**: SJC-only currently.

### boundaryWorker.js
- **Status**: on-demand (CLI)
- **Data Source**: Census TIGER/Line ZCTA GeoJSON ArcGIS endpoint
- **Output Table/File**: `zip_intelligence.boundary_geojson` + lat/lon (Postgres)
- **Run Frequency**: One-shot CLI (`node workers/boundaryWorker.js`); processes missing-only unless `FULL_REFRESH=true`
- **Downstream Consumer**: Anything that needs ZIP polygons/centroids (mapping, geo filters); oracleWorker also backfills from this on demand
- **Goal**: Populate official ZCTA polygons and centroids for every ZIP in zip_intelligence.
- **Priority**: LOW
- **Notes**: One-shot bootstrap job; not in launcher.

### briefValidator.js
- **Status**: on-demand (called by zipBriefWorker each cycle)
- **Data Source**: Postgres `zip_briefs` + `businesses` cross-check; flat-file fallback
- **Output Table/File**: `data/brief_validation.json`; returns failed-ZIP set
- **Run Frequency**: Triggered before every zipBriefWorker 4h cycle
- **Downstream Consumer**: `zipBriefWorker.getFailedZips` to force-rebuild bad briefs
- **Goal**: Quality-gate ZIP briefs — fail those that are just business-name dumps or lack market reasoning.
- **Priority**: MEDIUM
- **Notes**: Listed as standalone in `index.js` workers array but no internal scheduler — relies on zipBriefWorker invocation.

### btrWorker.js
- **Status**: disabled (commit b94b088)
- **Data Source**: St. Johns County Tax Collector BTR live web via Python child-process extractor (VIEWSTATE pagination)
- **Output Table/File**: `businesses` (via `db.upsertBusiness`); `data/zips/{zip}.json` + `data/btr/raw_{zip}.json` + `_index.json`
- **Run Frequency**: On start, then every 24h
- **Downstream Consumer**: Core `businesses` table (`btr_verified` flag)
- **Goal**: Import county-issued Business Tax Receipts — highest-confidence active-business source.
- **Priority**: HIGH (when source is fixed)
- **Notes**: Disabled — `stjohnstax.us` was timing out on every ZIP and wasting retries. Reactivate after fixing the extractor.

### businessMergeWorker.js
- **Status**: active
- **Data Source**: Postgres `businesses` (full scan)
- **Output Table/File**: `businesses` (merge canonical row, delete duplicates) + reassign `business_tasks`; `worker_events`
- **Run Frequency**: Every 12h with 6h min-gap guard (unless `FULL_REFRESH=true`)
- **Downstream Consumer**: All downstream consumers of `businesses`
- **Goal**: Deduplicate business records by phone + name/address, merging to the highest-score canonical row.
- **Priority**: HIGH
- **Notes**: Cornerstone of data integrity for every search/RFQ path.

### categoryReclassWorker.js
- **Status**: active
- **Data Source**: Postgres `businesses` rows where `category IS NULL` or `'LocalBusiness'`
- **Output Table/File**: `businesses.category` UPDATE; `worker_events`
- **Run Frequency**: 24h min-gap; one-time backfill style; 90s stagger
- **Downstream Consumer**: Every query that filters/groups by category
- **Goal**: Backfill missing categories by inferring from business name (regex copy of yellowPagesScraper logic).
- **Priority**: HIGH
- **Notes**: Search and intent routing fail without good categories — direct quality contributor.

### censusLayerWorker.js
- **Status**: active
- **Data Source**: Census ZBP 2018, CBP 2023, PDB 2024 (no API key required)
- **Output Table/File**: `pgStore.upsertCensusLayer`, `upsertZipSignals`, `zip_intelligence` UPDATE, `census_layer_history`; flat `data/census_layer/{zip}.json`, `_confidence.json`, `_county_sectors.json`
- **Run Frequency**: ZBP at startup once; CBP monthly; PDB quarterly (separate timers)
- **Downstream Consumer**: oracleWorker (employment_density, sector_gaps, data_confidence_score)
- **Goal**: Per-ZIP economic-sector fingerprint + per-ZIP data confidence score for downstream scoring.
- **Priority**: HIGH

### cesWorker.js
- **Status**: on-demand (CLI / external cron)
- **Data Source**: BLS Public Data API v2 (CES SMU series), 21 FL MSAs × 8 supersectors
- **Output Table/File**: `pgStore.upsertZipSignals` (Postgres); `worker_heartbeat`
- **Run Frequency**: Single START→END run, 4 batched calls
- **Downstream Consumer**: zip_signals (AI-displacement risk, investment opportunity score, sector YoY)
- **Goal**: Compute AI-displacement risk + investment opportunity score per ZIP from MSA-level CES employment mix.
- **Priority**: MEDIUM
- **Notes**: Not in launcher — companion to fred/qcew/qwi/bea/lodes.

### chamberDirectory.js
- **Status**: library
- **Data Source**: Static in-file lookup table
- **Output Table/File**: none — exports `CHAMBER_DIRECTORY`, `getChambersForZip`, `getChambersForState`, `discoverChamber`
- **Run Frequency**: n/a
- **Downstream Consumer**: `chamberDiscovery` / `chamberScraper`
- **Goal**: ZIP→chamber lookup table (static seed data).
- **Priority**: LOW
- **Notes**: Pure module — not a worker.

### chamberDiscovery.js
- **Status**: on-demand
- **Data Source**: Seed registry + YellowPages / DuckDuckGo "city chamber of commerce" search; CMS detection (GrowthZone, Chambermaster, generic); Nominatim
- **Output Table/File**: `data/zips/{zip}.json` merge; persists learned URLs to `data/chamberRegistry.json`
- **Run Frequency**: On-demand library function (`discoverAndImport`); CLI mode supported
- **Downstream Consumer**: Triggered when expanding to a new ZIP/city without a known chamber
- **Goal**: Autonomously discover the local chamber for any ZIP/city and import its members.
- **Priority**: MEDIUM
- **Notes**: Powers Sunbelt expansion; not in launcher.

### chamberScraper.js
- **Status**: active (auto-triggered 2 min after startup if no `chamber_imported.flag`)
- **Data Source**: SJC Chamber member directory HTML (`business.sjcchamber.com`)
- **Output Table/File**: `businesses` (`db.upsertBusiness`); `data/zips/{zip}.json`
- **Run Frequency**: Bulk-import once on first startup (sentinel-gated); enrichment per-business on demand from enrichmentAgent
- **Downstream Consumer**: Core `businesses` table; `enrichmentAgent`
- **Goal**: SJC Chamber members as verified-business seed + on-demand enrichment for phone/hours/website.
- **Priority**: MEDIUM

### depositListenerWorker.js
- **Status**: on-demand (separate ACP/billing process)
- **Data Source**: Tempo mainnet + Base mainnet RPC `getLogs(Transfer)` for registered deposit addresses
- **Output Table/File**: `deposit_credits` (idempotent on tx_hash); `deposit_listener_state`; `agent_registry.balance_usd_micro`
- **Run Frequency**: Long-lived poll every 30 seconds, 500-block window
- **Downstream Consumer**: `agent_registry.balance_usd_micro` → pay-per-query billing
- **Goal**: Credit pathUSD / USDC deposits to agent balances so agents can pay for LocalIntel queries.
- **Priority**: HIGH (revenue-critical when monetization is live)
- **Notes**: Not in `LOCAL_INTEL_WORKERS` array but launched elsewhere in the swarm process tree.

### descriptionCleanerWorker.js
- **Status**: on-demand (CLI)
- **Data Source**: Postgres `businesses` rows whose `description` matches Yellow Pages boilerplate regex
- **Output Table/File**: `businesses.description` UPDATE
- **Run Frequency**: One-shot CLI
- **Downstream Consumer**: Any consumer of `businesses.description` (search, briefs, embeddings)
- **Goal**: Replace boilerplate descriptions with deterministic "Name is X in City, FL ZIP." templates.
- **Priority**: LOW (one-time cleanup)
- **Notes**: Already run; not in launcher.

### descriptionTemplateWorker.js
- **Status**: on-demand (CLI)
- **Data Source**: Postgres `businesses` (TARGET_ZIPS, weak/short descriptions, no real website)
- **Output Table/File**: `businesses.description` UPDATE
- **Run Frequency**: One-shot CLI
- **Downstream Consumer**: Any consumer of `businesses.description`
- **Goal**: Build richer deterministic descriptions (name + category + city + ZIP + phone + hours) when no website exists.
- **Priority**: LOW
- **Notes**: One-time backfill.

### embeddingBackfillWorker.js
- **Status**: disabled
- **Data Source**: Postgres `businesses` rows (name + description + cuisine + category)
- **Output Table/File**: `businesses.embedding` (768-d pgvector); creates `idx_businesses_embedding` ivfflat
- **Run Frequency**: Was fire-and-forget at startup, batches of 50
- **Downstream Consumer**: `local_intel_search` semantic mode via pgvector cosine
- **Goal**: Populate pgvector embedding column on every business for semantic search.
- **Priority**: FUTURE
- **Notes**: Disabled — index recreated at 1.2 GB with 0 scans because no query path uses the `<->` operator yet. Re-enable once a vector-search path is wired up.

### embeddingWorker.js
- **Status**: disabled
- **Data Source**: Local Python sentence-transformers sidecar `embed_server.py` (all-MiniLM-L6-v2, port 8765); `data/zips/{zip}.json`
- **Output Table/File**: `data/embeddings/{zip}.bin` (Float32Array) + `data/embeddings/_index.json`
- **Run Frequency**: Was startup + every 6h
- **Downstream Consumer**: `semanticSearch` export used by `local_intel_search`
- **Goal**: File-based 384-d embeddings for every business, free semantic search w/o API cost.
- **Priority**: FUTURE
- **Notes**: Disabled — Railway disk is ephemeral; superseded by pgvector path which is itself FUTURE.

### enrichmentAgent.js
- **Status**: active
- **Data Source**: Yelp public pages, Foursquare Places (FSQ_API_KEY), OSM Nominatim, 411.com reverse, name→domain HEAD probes, Chamber, BBB
- **Output Table/File**: `data/zips/{zip}.json` (redirected to `/tmp/zips` on Railway) + `enrichmentLog.json`, `sourceLog.json`; writes back to `businesses` via `db2.upsertBusiness`
- **Run Frequency**: HTTP service on port 3007; `setInterval(enrichmentCycle, 6h)`
- **Downstream Consumer**: verticalAgentWorker (Scout dispatch on cache miss), MCP tools, oracleWorker
- **Goal**: Autonomously raise per-business confidence (phone/hours/website/services/reviews) above 85 using free sources.
- **Priority**: HIGH

### enrichmentFillWorker.js
- **Status**: active
- **Data Source**: Postgres `businesses` + hard-coded category→services/description maps
- **Output Table/File**: `businesses.services_text`, `description`, `category_intel`, `enrichment_source='system'`, `enrichment_updated_at`; logs `worker_events`
- **Run Frequency**: On start, then every 24h
- **Downstream Consumer**: oracleWorker, localIntelMCP, verticalAgentWorker, search vectors
- **Goal**: Deterministic zero-LLM enrichment of services_text/description for the 7 target NE-FL ZIPs.
- **Priority**: HIGH
- **Notes**: TARGET_ZIPS = 32082/81/250/266/233/259/034.

### fccBroadbandWorker.js
- **Status**: disabled (commit b94b088)
- **Data Source**: FCC BDC public map API (FCC_BDC_USERNAME + FCC_BDC_API_KEY)
- **Output Table/File**: `zip_signals` (`fcc_*` cols — served/unserved counts, pct_25_3, pct_100_20, gigabit, BEAD pcts, provider_count)
- **Run Frequency**: Was weekly (7 × 24h cycle)
- **Downstream Consumer**: zip_signals → oracle, signal/bedrock tools, MCP intel
- **Goal**: County broadband availability apportioned to ZIPs for BEAD/connectivity scoring.
- **Priority**: FUTURE
- **Notes**: Disabled — FCC broadband isn't yet consumed by any search-quality path. Re-enable when a connectivity/BEAD vertical is added.

### flZipRegistry.js
- **Status**: library
- **Data Source**: Bundled `flZipData.json` (1,013 FL ZCTAs, ACS 2022) + 325 seeded centroids; Nominatim lazy resolver
- **Output Table/File**: In-process cache + `data/fl_zip_centroids.json`
- **Run Frequency**: Lazy on demand
- **Downstream Consumer**: oracleWorker, localIntelAcpCycle, overpassWorker, zipCoordinatorWorker, intentRouter
- **Goal**: Authoritative FL ZIP list (pop, median_hhi, lat/lon, bbox) for every other worker.
- **Priority**: HIGH (foundational)

### fredWorker.js
- **Status**: on-demand (CLI / external cron)
- **Data Source**: FRED API LAUS series LAUCN{FIPS5}03/04/06 for all 67 FL counties
- **Output Table/File**: `zip_signals` (unemployment rate, labor force, unemployed); `worker_heartbeat`
- **Run Frequency**: One-shot CLI; 500 ms pacing; ~2 min total
- **Downstream Consumer**: zip_signals → oracle, signal/bedrock tools, MCP
- **Goal**: Denormalize county unemployment to all ZIPs.
- **Priority**: MEDIUM
- **Notes**: Not in launcher.

### gapDataFetcher.js
- **Status**: on-demand (called by promptEvolutionWorker)
- **Data Source**: Census ACS, FDOT projects, county permit RSS, YellowPages, Chamber — per gap type
- **Output Table/File**: `data/ocean_floor/{zip}.json`, `data/bedrock/{zip}.json`, `data/zips/{zip}.json`; `data/evolution/_gap_fetch_log.json`
- **Run Frequency**: On-demand
- **Downstream Consumer**: ocean_floor + bedrock files → localIntelTidalTools, oracleWorker, MCP signal_block
- **Goal**: Reactive backfill of missing per-ZIP layer data when a query exposes the gap.
- **Priority**: MEDIUM
- **Notes**: Currently dormant because promptEvolutionWorker is disabled.

### geocodingWorker.js
- **Status**: on-demand (CLI)
- **Data Source**: US Census Geocoder batch (free); fallbacks Nominatim, Photon, Overpass
- **Output Table/File**: `UPDATE businesses SET lat, lon`
- **Run Frequency**: One-shot CLI (`node workers/geocodingWorker.js`)
- **Downstream Consumer**: lat/lon → neighborhoodWorker, oracleWorker, MCP tools
- **Goal**: Batch-geocode businesses missing lat/lon so they can be spatially queried.
- **Priority**: HIGH (when there's a backlog)
- **Notes**: Not in launcher; rerun whenever a new ingestion source lands.

### hoursParseWorker.js
- **Status**: active
- **Data Source**: `businesses.hours` (OSM-format string)
- **Output Table/File**: `businesses.hours_json` (JSONB) + `has_hours`
- **Run Frequency**: On startup, then daily
- **Downstream Consumer**: `hours_json` + exported `isOpenNow` for "open now" filters and display
- **Goal**: Convert opaque OSM hours strings into structured day-keyed JSONB for "open now" / scheduling.
- **Priority**: HIGH
- **Notes**: Zero LLM; handles 24/7, off/closed, ranges, wrap-around.

### inferenceCache.js
- **Status**: library
- **Data Source**: Postgres `router_patches`; answers pushed in by callers
- **Output Table/File**: Postgres `inference_cache` (fingerprint, vertical, answer, confidence, hits, TTL)
- **Run Frequency**: Library; learned-signal reload every 5 min (`setInterval(...).unref()`)
- **Downstream Consumer**: verticalAgentWorker.get/set; intentRouter reuses detectVertical/detectZip
- **Goal**: Prompt-fingerprint cache so repeat/near-duplicate intents skip the full tool chain.
- **Priority**: HIGH
- **Notes**: TTL HIGH 7d / MED 3d / LOW 6h.

### intelligenceAggWorker.js
- **Status**: active (scheduled nightly via `scheduleNightly` from `index.js`)
- **Data Source**: Postgres `task_events`
- **Output Table/File**: `task_patterns` (ZIP × category × week), `business_responsiveness` (per-biz 0–100)
- **Run Frequency**: Nightly at 2am Eastern
- **Downstream Consumer**: `local_intel_zip_intelligence` MCP tool ("Bloomberg layer"); per-business responsiveness MCP tool
- **Goal**: Nightly rollup of agent task telemetry into ZIP conformance and per-business responsiveness scores.
- **Priority**: MEDIUM
- **Notes**: Different launch path — `index.js` calls `scheduleNightly`, not the dashboard launcher.

### intentRouter.js
- **Status**: library
- **Data Source**: `detectVertical/detectZip` from inferenceCache; static REGION_EXPANSIONS; `data/census_layer/`, `data/spendingZones.json`
- **Output Table/File**: none — pure function returning `{ zip, vertical, tool, args, confidence, reasoning }`
- **Run Frequency**: Per request
- **Downstream Consumer**: MCP `local_intel_query` entry point
- **Goal**: Map fuzzy NL questions to a concrete tool call (ZIP + vertical + tool).
- **Priority**: HIGH

### irsMigrationWorker.js
- **Status**: disabled (commit b94b088)
- **Data Source**: IRS SOI county-to-county migration CSVs (`countyinflow2122.csv`, `countyoutflow2122.csv`)
- **Output Table/File**: `zip_signals` (`irs_mig_in/out_returns`, AGI, net_*, top_origin/dest)
- **Run Frequency**: Was weekly
- **Downstream Consumer**: zip_signals → oracle/signal/bedrock, MCP intel
- **Goal**: County migration in/out flows apportioned to ZIPs (population dynamism proxy).
- **Priority**: FUTURE
- **Notes**: Disabled — migration data not consumed by any query path yet.

### irsSoiWorker.js
- **Status**: disabled (commit b94b088)
- **Data Source**: IRS SOI ZIP CSV `22zpallagi.csv`
- **Output Table/File**: `zip_intelligence` (`irs_agi_median`, `irs_returns`, `irs_wage_share`, `irs_updated_at`) + `zip_signals`; backfills ZCTA boundary
- **Run Frequency**: Was daily
- **Downstream Consumer**: zip_intelligence → oracleWorker, MCP
- **Goal**: ZIP-level weighted-median AGI + wage share for income/affluence signals.
- **Priority**: FUTURE
- **Notes**: Disabled — IRS income data not consumed by any query path yet.

### localIntelAcpCycle.js
- **Status**: active
- **Data Source**: `pgStore.getZipEnrichment`/`getCensusLayer`/`getZipBrief`, `data/spendingZones.json`, handleSignal/handleBedrock/handleVerticalQuery (no outbound HTTP)
- **Output Table/File**: Postgres `zip_briefs` (`brief_json`, `generated_at`)
- **Run Frequency**: Every 30 min, 5 ZIPs/cycle; briefs valid 48h
- **Downstream Consumer**: MCP zip-brief endpoint, dashboards
- **Goal**: 5-agent (CEO/Scout/Analyst/Profiler/Narrator) pre-computed brief per ZIP using existing layered data.
- **Priority**: HIGH
- **Notes**: Different from zipBriefWorker — this one uses the multi-agent synthesis approach.

### lodesWorker.js
- **Status**: on-demand (CLI / external cron)
- **Data Source**: LEHD LODES8 FL bulk CSVs (`fl_wac`, `fl_rac`, `fl_xwalk`, public no auth)
- **Output Table/File**: `zip_signals` (jobs by sector C000/CNS07/CNS12/CNS18/CNS10, earnings tiers); `worker_heartbeat`
- **Run Frequency**: One-shot CLI; self-skips if heartbeat <7 days old (LODES is annual)
- **Downstream Consumer**: zip_signals → oracle, MCP, signal/bedrock
- **Goal**: Block-level employment aggregated to ZIP for jobs/retail/healthcare workforce signals.
- **Priority**: MEDIUM
- **Notes**: ~90–120s runtime, ~200 MB RAM. Annual cadence is appropriate.

### mcpMiddleware.js
- **Status**: library
- **Data Source**: Per-ZIP JSON `data/bedrock/{zip}.json`, `data/surface_current/{zip}.json`, `data/wave_surface/{zip}.json`
- **Output Table/File**: none — wraps handlers; event capture delegated to `waveSurfaceWorker.appendEvent`
- **Run Frequency**: Per-request
- **Downstream Consumer**: Every MCP tool handler in localIntelMCP wrapped via `wrapMCPHandler`
- **Goal**: Attach consistent score/direction/confidence `signal_block` to all MCP responses + persona-reranked results.
- **Priority**: HIGH
- **Notes**: >30-day file = stale.

### mcpProbeWorker.js
- **Status**: disabled
- **Data Source**: Self — POSTs to `http://localhost:8080/api/local-intel/mcp` with 5 personas × multi prompts × 3 ZIPs/cycle
- **Output Table/File**: `data/mcp_probe_log.json` (rolling 500) + pgStore mirror
- **Run Frequency**: Was every 20 min
- **Downstream Consumer**: routerLearningWorker; ops dashboards
- **Goal**: Continuous self-test scoring answer quality, confidence, data density.
- **Priority**: FUTURE
- **Notes**: Disabled — "no real users yet". Re-enable when production traffic flows OR keep disabled and rely on real user telemetry instead.

### menuFetchAgent.js
- **Status**: on-demand
- **Data Source**: Business website / menu URL via Playwright (Chromium), fallback to plain fetch
- **Output Table/File**: `businesses.services_json` + `menu_fetched_at`
- **Run Frequency**: On-demand (CLI or invoked from other workers)
- **Downstream Consumer**: MCP search, restaurant vertical tools, menu display
- **Goal**: Deterministic (no-LLM) extraction of menu items, prices, cuisine tags for restaurants.
- **Priority**: MEDIUM
- **Notes**: Heavy (Playwright) — keep on-demand.

### neighborhoodWorker.js
- **Status**: on-demand
- **Data Source**: `workers/jaxNeighborhoods.json` seed + `businesses.lat/lon`
- **Output Table/File**: Creates `neighborhoods`; adds `neighborhood_id`/`neighborhood_slug` to `businesses`; `worker_events`
- **Run Frequency**: One-shot `run()`; invoked on cron or after geocoding
- **Downstream Consumer**: MCP neighborhood filters, dashboard, neighborhood pages
- **Goal**: Assign every geocoded business to a Jacksonville neighborhood by spatial bbox.
- **Priority**: MEDIUM
- **Notes**: `FULL_REFRESH=true` wipes assignments before re-running.

### oceanFloorWorker.js
- **Status**: active
- **Data Source**: Census ACS 5-year (S1501, S1201, S2501/B25003, S1901) + Census CBP 2021 SJC (FIPS 12109)
- **Output Table/File**: `pgStore.upsertOceanFloor` → `ocean_floor` table (`census_json`); legacy `data/ocean_floor/{zip}.json`
- **Run Frequency**: On start (skip if hb fresh), then weekly
- **Downstream Consumer**: oracleWorker SELECTs `census_json` from ocean_floor; localIntelTidalTools `readLayerFile`
- **Goal**: Per-ZIP carrying capacity, consumer profile, market saturation index, missing sectors — the demographic "ocean floor" layer.
- **Priority**: HIGH
- **Notes**: 6 SJC ZIPs only (32082/81/92/84/86/80).

### oracleWorker.js
- **Status**: active
- **Data Source**: businesses, ocean_floor, census_layer, `spendingZones.json`, flZipRegistry (ACS fallback)
- **Output Table/File**: `zip_intelligence` via `upsertZipIntelligence` (oracle_json + flattened cols market_opportunity_score, restaurant_capacity, growth_state, sector_counts); `data/oracle/{zip}.json` + `_index.json` + history (redirected to `/tmp/oracle` on Railway); calls `refreshOracleSectors`
- **Run Frequency**: On start (skip if hb fresh) then every 6h
- **Downstream Consumer**: zip_intelligence.oracle_json read by localIntelMCP, public APIs, dashboards
- **Goal**: Synthesize all tidal layers into pre-baked economic narratives per ZIP — saturation, gaps, growth, top-questions, narrative.
- **Priority**: HIGH (the keystone synthesis layer)
- **Notes**: Backfills `boundary_geojson` from fetchZctaBoundary; ~90-day history per ZIP.

### overpassWorker.js
- **Status**: active
- **Data Source**: OSM Overpass API (amenity/shop/office/tourism/leisure/healthcare nodes per ZIP bbox)
- **Output Table/File**: Postgres `zip_enrichment` + `zip_signals` + promoted into `businesses`; `worker_events`
- **Run Frequency**: 24h daemon loop; 2.2s rate-limit per request
- **Downstream Consumer**: businesses → MCP / verticalAgent; zip_signals → worldModelWorker; zip_enrichment → enrichmentAgent
- **Goal**: Bulk POI inventory from a free public source — every FL ZIP gets a baseline business set.
- **Priority**: HIGH

### permitWorker.js
- **Status**: active
- **Data Source**: US Census BPS county-level permits + SJC ArcGIS supplemental
- **Output Table/File**: Postgres `county_permits`, `sjc_permits`; `worker_events`
- **Run Frequency**: Once-on-start then sleep 24h
- **Downstream Consumer**: `/api/local-intel/census` in localIntelAgent
- **Goal**: Authoritative federal permit signal for "is this ZIP building?" across all 67 FL counties.
- **Priority**: MEDIUM

### promptEvolutionWorker.js
- **Status**: disabled (commit b94b088)
- **Data Source**: Oracle history (Postgres) + zip_intelligence + gapDataFetcher
- **Output Table/File**: `data/evolution/_report.json`; rewrites `oracle_prompts_v2.json`
- **Run Frequency**: Was daily
- **Downstream Consumer**: oracleWorker (prompts), dashboard (report)
- **Goal**: Self-improvement loop — classify ZIPs RICH/THIN/BLIND/CONTRADICTED and evolve oracle prompts + fire gap fillers.
- **Priority**: FUTURE
- **Notes**: Disabled — no production traffic yet, nothing to learn from. Re-enable once query telemetry > N queries/day.

### qcewWorker.js
- **Status**: on-demand (CLI / external cron)
- **Data Source**: BLS QCEW API v2 (employment, establishments, weekly wages per FL county)
- **Output Table/File**: zip_signals (`qcew_*`); `worker_heartbeat`
- **Run Frequency**: Single-pass with 30-day heartbeat skip
- **Downstream Consumer**: worldModelWorker, localIntelAgent
- **Goal**: Quarterly employment / wages / establishment counts + YoY for every FL ZIP.
- **Priority**: MEDIUM

### qwiWorker.js
- **Status**: on-demand (CLI / external cron)
- **Data Source**: Census QWI API (Emp, EmpEnd, EarnBeg, HirA, Sep per FL county)
- **Output Table/File**: zip_signals (`qwi_*`); `worker_heartbeat`
- **Run Frequency**: Single-pass
- **Downstream Consumer**: worldModelWorker, localIntelAgent
- **Goal**: Workforce turnover / hires / separations / earnings per ZIP.
- **Priority**: MEDIUM

### reclassifyWorker.js
- **Status**: on-demand (CLI)
- **Data Source**: Postgres `businesses` (LocalBusiness/null categories)
- **Output Table/File**: Updates `businesses.category` + `category_group`; exports RULES + CATEGORY_LABELS
- **Run Frequency**: Run-once
- **Downstream Consumer**: All business read paths; RULES imported by websiteEnricherWorker
- **Goal**: Deterministic name-keyword classifier to fix catch-all 'LocalBusiness' rows.
- **Priority**: HIGH (rerun after any new ingest)
- **Notes**: Overlaps with `categoryReclassWorker` — this one is the rule-source library.

### refreshOracleSectors.js
- **Status**: on-demand (called by oracleWorker each cycle)
- **Data Source**: Postgres `businesses` grouped by zip + category_group; `zip_intelligence.oracle_json`
- **Output Table/File**: Patches `zip_intelligence.oracle_json.market_intelligence.sector_breakdown` + total_businesses; seeds `market_maturity`
- **Run Frequency**: Per oracle cycle (6h) + on-demand
- **Downstream Consumer**: oracleWorker, `/api/local-intel/oracle`, dashboard
- **Goal**: Keep oracle sector breakdowns in sync with live business counts (cheap, idempotent, no LLM).
- **Priority**: HIGH

### routerLearningWorker.js
- **Status**: active
- **Data Source**: Postgres `mcp_probe_log`
- **Output Table/File**: Postgres `router_learning_log`
- **Run Frequency**: Every 30 min, 5-min stagger
- **Downstream Consumer**: Human reviewer applies keyword patches to `inferenceCache.js` (Railway disk wiped per redeploy)
- **Goal**: Feedback loop between probe results and intentRouter — discover terms that should route to specific verticals.
- **Priority**: MEDIUM
- **Notes**: Source table `mcp_probe_log` is mostly empty while mcpProbeWorker is disabled — currently a no-op loop.

### searchVectorBackfillWorker.js
- **Status**: active
- **Data Source**: Postgres `businesses` (search_vector NULL or FULL_REFRESH)
- **Output Table/File**: Updates `businesses.cuisine` + `businesses.search_vector` (via DB function `businesses_search_vector_build()`); `worker_events`
- **Run Frequency**: 12h gap skip; one batch pass then idle pinger
- **Downstream Consumer**: Postgres full-text search → `local_intel_search` MCP tool
- **Goal**: Populate weighted tsvector + cuisine for fast business text search.
- **Priority**: HIGH

### sjcArcGisWorker.js
- **Status**: active
- **Data Source**: SJC GIS REST FeatureServer (activePermits, CO_Permits, Future_Land_Use)
- **Output Table/File**: Postgres `sjc_permits`; `worker_events`
- **Run Frequency**: 24h loop
- **Downstream Consumer**: permitWorker, localIntelAgent permit endpoints
- **Goal**: Per-address commercial/residential permit detail + counts for SJC ZIPs.
- **Priority**: MEDIUM

### stalenessUtils.js
- **Status**: library
- **Data Source**: Pure functions on business records
- **Output Table/File**: none
- **Run Frequency**: n/a
- **Downstream Consumer**: enrichmentAgent, localIntelMCP, localIntelTidalTools — attaches `data_freshness` to MCP responses
- **Goal**: Shared FRESH/WARM/STALE/COLD tier + confidence multiplier + grade A–D logic.
- **Priority**: HIGH

### sunbeltZipRegistry.js
- **Status**: library
- **Data Source**: Static hardcoded multi-state ZIP catalog (TX/AL/MS/LA/GA/SC/NC/TN/KY/NM/AZ/SoCal) with lat/lon/priority/phase
- **Output Table/File**: none — exports ALL_SUNBELT_ZIPS, getZipsByPhase, getSummary
- **Run Frequency**: n/a
- **Downstream Consumer**: zipCoordinatorWorker (phase gating — FL must hit 95% to unlock Phase 2)
- **Goal**: ~265-ZIP non-FL Sunbelt rollout roadmap.
- **Priority**: MEDIUM

### sunbizWorker.js
- **Status**: disabled
- **Data Source**: FL Sunbiz SFTP quarterly `cordata.zip` (pipe-delimited corporate records)
- **Output Table/File**: Postgres `businesses` (upsert by sunbiz_doc_number); `sunbiz_import_state`; `worker_heartbeat`; `worker_events`
- **Run Frequency**: Was one-shot on startup + weekly check for new quarterly file
- **Downstream Consumer**: Entire businesses pipeline
- **Goal**: Backfill millions of FL registered entities as ground truth.
- **Priority**: HIGH (when run off-volume)
- **Notes**: Disabled — `cordata.zip` is 7–8 GB and fills the Railway volume. Already seeded to Postgres. Re-enable only with off-volume processing (e.g. S3 streaming) for quarterly refresh.

### surfaceCurrentWorker.js
- **Status**: active
- **Data Source**: ZipAgent JSON outputs (`data/zips/{zip}.json`), prior snapshot file; pgStore writes
- **Output Table/File**: `data/surface_current/{zip}.json` + `_index.json` + `_prev.json` (redirected to `/tmp/surface_current` on Railway); pgStore
- **Run Frequency**: 24h
- **Downstream Consumer**: Layer-3 wave model / dashboard
- **Goal**: Layer-2 daily business-churn dynamics, seasonal index, freshness grade, confidence decay.
- **Priority**: MEDIUM

### taskSeedWorker.js
- **Status**: active
- **Data Source**: Postgres `businesses` in TARGET_ZIPS (32082/81/250/266/233/259/034); skip set from `business_tasks`
- **Output Table/File**: Postgres `business_tasks` (auto-creates schema); telemetry via `lib/telemetry`
- **Run Frequency**: Run-once; FULL_REFRESH=true to redo
- **Downstream Consumer**: Business onboarding UI, businessMergeWorker, localIntelAgent
- **Goal**: Deterministic per-category onboarding task list (no LLM).
- **Priority**: MEDIUM

### verticalAgentWorker.js
- **Status**: active
- **Data Source**: MCP endpoint (`http://localhost:3001/api/local-intel/mcp`), inferenceCache, oracleWorker; dispatches enrichmentAgent on miss
- **Output Table/File**: `data/gaps/{industry}.json` (writes redirected to `/tmp/gaps` on Railway); pgStore telemetry
- **Run Frequency**: setInterval 6h
- **Downstream Consumer**: gap files → zipAgent + chamberDiscovery; exposed as paid x402 MCP tools
- **Goal**: Self-training loop per vertical (realtor / healthcare / retail / construction / restaurant) — score, log gaps, close them.
- **Priority**: HIGH

### waveSurfaceWorker.js
- **Status**: active
- **Data Source**: Postgres `wave_events` (populated by mcpMiddleware's exported `appendEvent`)
- **Output Table/File**: Postgres `wave_surface` (per-ZIP 24h/30d aggregates)
- **Run Frequency**: Hourly
- **Downstream Consumer**: pgStore APIs / dashboard analytics
- **Goal**: Layer-3 aggregation that turns MCP query traffic into a per-ZIP demand surface.
- **Priority**: MEDIUM

### websiteEnricherWorker.js
- **Status**: on-demand (CLI)
- **Data Source**: Business homepages via HTTP fetch (uses `businesses.website` for TARGET_ZIPS); RULES from reclassifyWorker
- **Output Table/File**: Updates `businesses.description` + `businesses.category`
- **Run Frequency**: Run-once; skip desc ≥120 chars
- **Downstream Consumer**: All consumers of `businesses.description` (MCP, dashboard, vertical agents)
- **Goal**: Pull `<title>` / `<meta description>` to enrich descriptions and re-classify mis-categorized rows.
- **Priority**: MEDIUM

### worldModelWorker.js
- **Status**: disabled (commit b94b088)
- **Data Source**: Postgres `zip_signals` (every ACS/IRS/QCEW/QWI/OSM/permit signal already aggregated)
- **Output Table/File**: `zip_forecast` (12/24/36-mo projections), `zip_anomalies` (2σ+), `zip_signals_history` (daily snapshot). Version `v1-cohort-2026`.
- **Run Frequency**: Was 24h
- **Downstream Consumer**: localIntelAgent `/forecast`, lib/reportGenerator, dashboard anomalies
- **Goal**: Deterministic cohort-z-score model — growth/opportunity 0–100 and anomaly-driven self-questioning.
- **Priority**: FUTURE
- **Notes**: Disabled — z-score forecasting is expensive, no consumer on the hot path yet. Re-enable once a `/forecast` or anomaly endpoint is exposed to paying agents.

### yellowPagesScraper.js
- **Status**: active
- **Data Source**: YellowPages.com city × category HTML (LD+JSON + HTML parse); no API key
- **Output Table/File**: Postgres `businesses` (dual-write); fallback `data/zips/{zip}.json`; `worker_events` checkpoints
- **Run Frequency**: 24h loop when run as main; also invoked by zipAgent
- **Downstream Consumer**: zipAgent (bulk-scrape) + `lookupYellowPages` Express router
- **Goal**: Bulk enrich name/phone/address/website/category — fills the gap where OSM has only coords.
- **Priority**: HIGH

### zipAgent.js
- **Status**: on-demand (spawned per ZIP by zipCoordinatorWorker)
- **Data Source**: OSM Overpass, SJC ArcGIS, FL Sunbiz, Nominatim, YellowPages, Chamber, BBB
- **Output Table/File**: Postgres `businesses` via `db.upsertBusiness`; logs `data/sourceLog.json`
- **Run Frequency**: Per-ZIP child process — exits when done
- **Downstream Consumer**: businesses table; sourceLog.json for diagnostics
- **Goal**: Stateless single-ZIP discovery agent — one process per ZIP, non-blocking on source failures.
- **Priority**: HIGH

### zipBriefWorker.js
- **Status**: active
- **Data Source**: Postgres `businesses` (active per ZIP) + briefValidator
- **Output Table/File**: Postgres `zip_briefs` (upsert)
- **Run Frequency**: 4h cycle, 3-min stagger; skip if brief <7 days old
- **Downstream Consumer**: localIntelAcpCycle, localIntelAgent, dashboard market-summary card
- **Goal**: Deterministic per-ZIP market brief (saturation/growth/narrative) — zero API/LLM cost.
- **Priority**: HIGH
- **Notes**: Separate from `localIntelAcpCycle.js` which writes to same `zip_briefs` via multi-agent approach.

### zipCoordinatorWorker.js
- **Status**: active
- **Data Source**: FL priority seeds + flZipRegistry (1,013 ZIPs) + sunbeltZipRegistry; budget gate reads `usage_ledger`
- **Output Table/File**: `data/zipCoverage.json`; spawns zipAgent children; Express server on port 3006
- **Run Frequency**: setInterval 1h; per-ZIP re-enrichment every 6h
- **Downstream Consumer**: Operator/dashboard on port 3006; spawned zipAgent runs feed entire businesses pipeline
- **Goal**: Autonomous priority queue driving FL coverage to 95% before unlocking Sunbelt phases; concurrency 0–6 agents on revenue gate.
- **Priority**: HIGH

---

## Worker Groups

### 1. Search Quality — directly improve what users find
- `enrichmentAgent.js` — phone/hours/website/services/reviews
- `enrichmentFillWorker.js` — services_text + description backfill
- `hoursParseWorker.js` — `is_open_now` filters
- `categoryReclassWorker.js` / `reclassifyWorker.js` — fix `LocalBusiness` rows
- `searchVectorBackfillWorker.js` — full-text tsvector
- `descriptionCleanerWorker.js` / `descriptionTemplateWorker.js` / `websiteEnricherWorker.js` — describe better
- `businessMergeWorker.js` — dedup canonical rows
- `mcpMiddleware.js` — signal_block + persona rerank on every MCP response
- `stalenessUtils.js` — freshness gating
- `intentRouter.js` / `inferenceCache.js` — fuzzy NL → tool call

### 2. Business Data Enrichment — add/clean fields on business records
- `geocodingWorker.js` — lat/lon
- `neighborhoodWorker.js` — neighborhood_id
- `menuFetchAgent.js` — services_json for restaurants
- `bbbScraper.js` — BBB accreditation
- `chamberScraper.js` / `chamberDiscovery.js` / `chamberDirectory.js` — chamber members
- `yellowPagesScraper.js` — bulk name/phone/website/category
- `overpassWorker.js` — OSM POI baseline

### 3. World Model / Market Intelligence — ZIP-level economics, demographics, market gaps
- `acsWorker.js` — demographic core
- `censusLayerWorker.js` — sector fingerprint + confidence score
- `oceanFloorWorker.js` — Layer 1 carrying capacity
- `oracleWorker.js` — keystone synthesis
- `refreshOracleSectors.js` — keep oracle sectors in sync
- `localIntelAcpCycle.js` — multi-agent briefs
- `zipBriefWorker.js` — deterministic briefs
- `beaWorker.js`, `cesWorker.js`, `fredWorker.js`, `qcewWorker.js`, `qwiWorker.js`, `lodesWorker.js` — economic signal pumps
- `worldModelWorker.js` *(disabled)* — z-score forecasting
- `fccBroadbandWorker.js` *(disabled)* — connectivity signals
- `irsSoiWorker.js` / `irsMigrationWorker.js` *(disabled)* — income + migration

### 4. Self-Improvement / Learning — system learning from its own failures
- `mcpProbeWorker.js` *(disabled)* — synthetic persona probes
- `routerLearningWorker.js` — pattern → router-patch suggestions
- `promptEvolutionWorker.js` *(disabled)* — RICH/THIN/BLIND classification, prompt evolution
- `gapDataFetcher.js` — reactive gap backfill
- `briefValidator.js` — quality gate
- `verticalAgentWorker.js` — per-vertical self-training loop
- `agentMemoryWorker.js` — per-agent query memory for deltas
- `intelligenceAggWorker.js` — nightly task_events rollup

### 5. Data Ingestion — pulling in new business records from external sources
- `zipCoordinatorWorker.js` (driver)
- `zipAgent.js` (per-ZIP process)
- `yellowPagesScraper.js`
- `overpassWorker.js`
- `chamberScraper.js` / `chamberDiscovery.js`
- `bbbScraper.js`
- `btrWorker.js` *(disabled)* — SJC BTR
- `sunbizWorker.js` *(disabled)* — FL Sunbiz quarterly
- `sjcArcGisWorker.js` — SJC permits

### 6. Real Estate Intelligence — property, permits, parcel data
- `permitWorker.js` — Census BPS county permits
- `sjcArcGisWorker.js` — SJC permit detail
- `bedrockWorker.js` — infrastructure momentum score
- `surfaceCurrentWorker.js` — daily churn
- `waveSurfaceWorker.js` — demand surface from query traffic
- `boundaryWorker.js` — ZCTA polygons / centroids

### 7. Infrastructure / Support — helpers, registries, middleware
- `flZipRegistry.js` — FL ZIP authority
- `sunbeltZipRegistry.js` — multi-state phase plan
- `mcpMiddleware.js` — signal_block wrapper
- `stalenessUtils.js` — freshness scoring
- `inferenceCache.js` — fingerprint cache
- `intentRouter.js` — NL → tool
- `taskSeedWorker.js` — business onboarding seed
- `acpBroadcaster.js` — agent registry announcer
- `depositListenerWorker.js` — pathUSD/USDC deposit credit (billing)

### 8. On-Demand / Manual Only — should not run continuously, only when called
- `boundaryWorker.js` (CLI bootstrap)
- `descriptionCleanerWorker.js`, `descriptionTemplateWorker.js` (one-shot cleanup)
- `websiteEnricherWorker.js` (one-shot enrichment)
- `geocodingWorker.js` (post-ingest)
- `neighborhoodWorker.js` (post-geocode)
- `menuFetchAgent.js` (per-business; Playwright heavy)
- `reclassifyWorker.js` (post-ingest)
- `beaWorker.js`, `cesWorker.js`, `fredWorker.js`, `qcewWorker.js`, `qwiWorker.js`, `lodesWorker.js` (external cron)
- `gapDataFetcher.js` (invoked by promptEvolution)
- `bbbScraper.js` (invoked by enrichmentAgent)

---

## Recommended Re-enable Strategy

These six workers were disabled in commit `b94b088` (2026-05-11) because they consume resources without yet feeding a query path. Each is sound code and architecturally important — the disable is operational, not structural.

### 1. promptEvolutionWorker.js
- **Original intent**: Self-improvement loop that classifies every ZIP's oracle output as RICH / THIN / BLIND / CONTRADICTED, rewrites `oracle_prompts_v2.json`, and triggers `gapDataFetcher` to back-fill the missing data.
- **Produces**: `data/evolution/_report.json`, an updated `oracle_prompts_v2.json`, and on-demand `gapDataFetcher` calls writing into `ocean_floor` / `bedrock` / `data/zips` files.
- **Re-enable when**: There is real production query volume (>~500 queries/day) so it has actual failures to learn from. Today the failure set is dominated by the system probing itself.
- **Trigger/schedule**: Daily, off-peak (3am ET). Cron, not setInterval — it's idempotent and benefits from a clean start.

### 2. btrWorker.js
- **Original intent**: Import SJC Business Tax Receipts as the highest-confidence ground-truth source for "is this business actually operating?"
- **Produces**: Net-new and BTR-flagged rows in `businesses`; `data/btr/raw_{zip}.json`.
- **Re-enable when**: The Python extractor is fixed so `stjohnstax.us` no longer times out on every ZIP. Investigate whether the site requires a session cookie, a different User-Agent, or has been moved.
- **Trigger/schedule**: Weekly (BTRs renew annually). On-demand from operator dashboard for spot refresh of a single ZIP.

### 3. irsSoiWorker.js
- **Original intent**: Per-ZIP weighted-median AGI, returns count, and wage-share — the deepest income signal we have.
- **Produces**: `zip_intelligence.irs_*` columns + `zip_signals.irs_*`.
- **Re-enable when**: Any of these query paths goes live — affluence-aware search filtering, "where can my $X premium service work?" RFQs, or claimed-business "neighborhood income context" dashboards.
- **Trigger/schedule**: Monthly (IRS releases vintages annually, but our denorm logic changes more often).

### 4. irsMigrationWorker.js
- **Original intent**: County-to-county in/out migration flows, AGI-weighted, to capture which counties are growing vs draining.
- **Produces**: `zip_signals.irs_mig_*` columns.
- **Re-enable when**: The growth-state vertical lights up (e.g. realtor agent asks "where are people moving from to ZIP X?"). Currently no consumer reads these columns.
- **Trigger/schedule**: Quarterly. Source data is annual; once per quarter is plenty.

### 5. fccBroadbandWorker.js
- **Original intent**: Apportion FCC BDC county broadband stats to ZIPs — served/unserved counts, gigabit availability, BEAD eligibility.
- **Produces**: `zip_signals.fcc_*` columns.
- **Re-enable when**: A connectivity-aware vertical comes online (BEAD grant assistance, WFH-friendliness scoring, remote-work site selection). Today no query reads `fcc_*`.
- **Trigger/schedule**: Weekly. Source updates twice a year, but the worker is cheap; weekly catches mid-cycle revisions and lets the data become invisible-default-fresh.

### 6. worldModelWorker.js
- **Original intent**: Deterministic cohort z-score forecasting on all `zip_signals` columns → `zip_forecast`, `zip_anomalies`, `zip_signals_history`. The system's view of "where is each ZIP relative to its peers, and where will it be in 12/24/36 months?"
- **Produces**: `zip_forecast`, `zip_anomalies`, `zip_signals_history`.
- **Re-enable when**: A `/forecast` or `/anomalies` MCP tool is exposed to paying agents, OR after at least one of the disabled signal pumps (irsSoi, irsMigration, fccBroadband, qcew, qwi) is producing fresh data — the world model is only as good as its inputs and right now most of its inputs are stale.
- **Trigger/schedule**: Daily (24h), but only after a "fresh signals" guard (skip if no signal table changed in the last cycle). Consider running on the same nightly window as `intelligenceAggWorker`.

### Cross-cutting re-enable order

When the time comes, re-enable in this order:
1. **btrWorker** (fix extractor) — high-confidence ingest, immediate quality bump.
2. **irsSoiWorker** — populates income data already wired into oracle prompts.
3. **fccBroadbandWorker** — independent, weekly, cheap.
4. **irsMigrationWorker** — same source as SOI, similar cost.
5. **worldModelWorker** — once 2–4 are producing fresh signals.
6. **promptEvolutionWorker** — last, once real query traffic gives it real failures.

A practical gate: do not re-enable any "world-model-feeder" until there is an MCP endpoint that reads its columns. Otherwise we're burning CPU on dashboards no agent will ever ask about.

---

### censusMacroWorker.js
- **Status**: active
- **Data Sources**:
  - Census BFS (Business Formation Statistics) — `api.census.gov/data/timeseries/bfs` — monthly, county-level
  - Census NES (Nonemployer Statistics 2021) — `api.census.gov/data/2021/nonemp` — annual, ZCTA-level
  - Census Economic Census 2022 — `api.census.gov/data/2022/ecnbasic` — 5-year vintage, ZIP-level
- **Output Tables**:
  - `macro_indicators` — time-series BFS data keyed by (source, geo_id, period). One row per county per month.
  - `zip_macro_signals` — ZIP-level NES + ECN data. One row per ZIP.
  - `zip_signals` — summary columns: `macro_nes_total_firms`, `macro_ecn_total_sales_k`, `macro_bfs_apps_latest`, `macro_updated_at`
- **Run Frequency**: Daily check; BFS refreshes monthly (28d TTL), NES annually (300d TTL), ECN one-time (5-year vintage)
- **Downstream Consumers**:
  - Oracle: reads `zip_macro_signals` JOIN `zip_signals` by ZIP for revenue + solo-operator density
  - JEPA: uses `macro_indicators` BFS trend (ba_highprop over time) to predict ZIP business formation probability
  - MCP tools: `local_intel_signal` reads summary cols from `zip_signals` (no JOIN needed)
- **Why it exists**:
  - CBP counts employer businesses only. NES adds solo/gig operators — often 3-5x the employer count.
  - ZBP counts establishments. Economic Census adds REVENUE — the most granular revenue/payroll by ZIP ever published.
  - BFS tracks new business application velocity — leading indicator (6-18 month lag to actual formation).
  - Together these three datasets complete the economic picture that CBP/ZBP alone cannot provide.
- **Priority**: HIGH
- **Worker contract**: START → read Postgres for what's done (skip) → WORK only new → END → upsert to Postgres → REDEPLOY SAFE
