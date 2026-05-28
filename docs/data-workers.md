# Data Workers

All workers (ACS, IRS, FRED, BEA, QWI, QCEW, CES, LODES, BPS, FCC, OSM, SunBiz, CAMA, World Model), Railway env vars for data APIs, worker contract, signal columns, zip_signals coverage.

## Postgres-only worker contract (session 8)

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
| fdotWorker | worker_heartbeat freshness 48h | zip_signals (fdot_max_aadt, fdot_avg_aadt, fdot_top_road) |
| businessSignalWorker | worker_heartbeat freshness 24h | zip_signals (sig_claimed_rate, sig_wallet_rate, sig_task_density, sig_closure_rate_food, sig_unmet_demand_score) |
| claimOutreachWorker | claim_outreach table dedup 30d | claim_outreach, businesses.contact_email |

`embeddingWorker` is **disabled** in `dashboard-server.js` — needs pgvector
to be revived.

All `data/*.json` writes for these workers are removed. CSV downloads
(IRS SOI) live in `os.tmpdir()`. Static seeds (e.g. `data/spendingZones.json`)
remain on disk but are read-only.


---

## Session 24 — World Model Full Build

---
### Session 24 — World Model Full Build (2026-05-10)

**Problem:** We had 6+ data workers writing to different tables (zip_intelligence, census_layer, zip_enrichment, county_permits, acs_demographics) with no unified signal store. The world model concept existed only architecturally — no implementation. Report generation was manual.

**Fix:** "Do it right — schema first, migrate all workers, then build world model on the clean foundation."

#### Migration 017 — Full World Model Schema (31KB, 552 lines, auto-runs on Railway deploy)
Seven new tables:
1. **`zip_signals`** — materialized signal store. One row per ZIP. All worker outputs land here via `upsertZipSignals()`. Bootstrapped from zip_intelligence on migration run.
2. **`zip_signals_history`** — append-only daily snapshots. Key metric fields only (not all 80+ columns). Training data for future ML. UNIQUE(zip, snapshot_date) = idempotent daily writes.
3. **`zip_causal_events`** — dated external events with announced/decided/effective/start/completion dates. Enables lag correlation analysis. The key innovation for causal inference.
4. **`zip_forecast`** — world model output: 12/24/36 month projections per ZIP. driver_signals JSONB, opportunity_gaps JSONB, plain-English summaries.
5. **`zip_anomalies`** — auto-detected signal divergences. z_score, auto-generated question, candidate_causes JSONB. The "questions we don't know to ask" mechanism.
6. **`zip_reports`** — consultation artifact table. report_json + report_html. access_token for shareable link. linked to consultation_leads via lead_id.
7. **`signal_registry`** — self-documenting table: every zip_signals column described with source, unit, frequency, correlates_with, questions_answered. Seeded with 14 signals.

#### pgStore.js — `upsertZipSignals(zip, colsObj)` helper
Dynamic column upsert: any subset of zip_signals columns passed as object. Builds SQL dynamically. Input-sanitized (snake_case only). Silently swallows table-not-exist errors (migration may not have run yet on first deploy).

#### Worker Migrations (all additive — no structural changes to existing logic)
Every worker now ALSO writes to zip_signals immediately after its existing write:
- `acsWorker.js` → `acs_population`, `acs_households`, `acs_owner_occ_pct`, `acs_median_hhi` (B19013), `acs_median_age` (B01002), `acs_college_pct` (B15003), `acs_poverty_pct` (B17001), `acs_vacancy_pct` (B25002), `acs_foreign_born_pct` (B05001), `acs_family_pct` (B11001), `acs_commute_time_min` (B08135/B08101), `acs_vintage`, `acs_updated_at`
  - **B54 fix:** Previously only wrote 5 fields — `acs_median_hhi` was always null causing all county scoring to return HHI $0. Now fetches B19013 directly and writes all 8 demographic signals in the same `upsertZipSignals` call.
  - **ZIP discovery:** Now reads from `fl_zip_geo` (migration 029, 1,473 FL ZIPs). Falls back to `businesses` table ZIPs if fl_zip_geo not ready.
- `irsSoiWorker.js` → `irs_agi_median`, `irs_returns`, `irs_wage_share`, `irs_updated_at`
- `censusLayerWorker.js` → `zbp_total_establishments`, `zbp_total_employees`, `zbp_sector_json` (in ingestZBP) + `cbp_total_establishments`, `cbp_total_employees`, `cbp_total_payroll_k`, `cbp_dominant_sector` (in ingestCBP)
- `overpassWorker.js` → `osm_biz_count`, `osm_with_phone_pct`, `osm_with_website_pct`, `osm_with_hours_pct`, `osm_food_count`, `osm_retail_count`, `osm_worship_count`, `osm_education_count`, `osm_healthcare_count` — computed from POIs array at write time
- `permitWorker.js` → NEW `materializeBpsSignals()` function runs after each BPS fetch. Queries county_permits + zip_intelligence to apportion county permit totals to ZIPs. Writes `bps_res_1unit_annual`, `bps_res_multifam_annual`, `bps_total_units_annual`, `bps_total_value_annual`, `bps_res_1unit_mo`, `bps_period_mo`, `bps_updated_at`.
- `sunbizWorker.js` — NOT directly migrated (no ZIP field in Sunbiz import). `sunbiz_*` signals computed by worldModelWorker via GROUP BY query instead.

#### New Workers
- **`workers/fccBroadbandWorker.js`** — FCC Form 477 (opendata.fcc.gov Socrata) area table. County-level broadband coverage at 25/100/1000 Mbps speed tiers. Writes: `fcc_has_25_3`, `fcc_has_100_20`, `fcc_has_gigabit`, `fcc_providers_cnt`, `fcc_max_down_mbps`, `fcc_fiber_available`. County→ZIP via zip_intelligence.county_fips. Runs weekly (data updates annually).
- **`workers/irsMigrationWorker.js`** — IRS SOI County-to-County Migration 2021-2022. `countyinflow2122.csv` + `countyoutflow2122.csv`. Writes: `irs_mig_in_returns`, `irs_mig_out_returns`, `irs_mig_in_agi`, `irs_mig_out_agi`, `irs_mig_net_returns`, `irs_mig_net_agi`, `irs_mig_top_origin`, `irs_mig_top_dest`. County→ZIP via county_fips. Caches CSVs 72h. Runs weekly.
- **`workers/worldModelWorker.js`** — The brain. Reads all zip_signals rows daily. Clusters ZIPs into peer cohorts (popTier × incTier × housingTier = up to ~45 cohorts). Computes cohort statistics (mean, stddev, median). Scores each ZIP: growth (0-100) + opportunity (0-100). Classifies market maturity (nascent→emerging→growing→stable→mature→saturated). Projects 12/24/36mo trajectory. Writes zip_forecast. Detects anomalies (>2σ from cohort median) → generates plain-English questions + candidate explanations → writes zip_anomalies. Snapshots current state to zip_signals_history daily. Computes sig_* columns back into zip_signals (growth_score, opportunity_score, market_maturity, peer_cohort, data_completeness). 90s startup stagger (waits for signal workers to populate zip_signals).

#### lib/reportGenerator.js — Consultation Report Generator
Reads zip_signals + zip_forecast + zip_anomalies + zip_signals_history + zip_causal_events + peer ZIPs. Generates structured report_json + pre-rendered report_html. Stores to zip_reports with unique access_token. Plain-English recommendations engine (no LLM). Branded HTML with score bars, projection cards, anomaly cards, data source attribution.

#### New API Endpoints (all in localIntelAgent.js)
- `POST /api/local-intel/generate-report` — admin-only (token: localintel-migrate-2026). Body: {zip, lead_id?, report_type?}. Returns report_id + access_token + scores + summary.
- `GET /api/local-intel/report/:token` — public shareable link. HTML if Accept:text/html, JSON otherwise.
- `GET /api/local-intel/zip-signals/:zip` — admin. Raw zip_signals row.
- `GET /api/local-intel/zip-forecast/:zip` — public. Latest forecast for ZIP.
- `GET /api/local-intel/anomalies` — admin. Open anomalies with optional ?zip= and ?severity= filters.

#### Self-Improvement Mechanism
- Anomalies table IS the feedback loop: the world model asks questions it can't answer itself
- Anomalies that stay open 30+ days = highest-value consultation hooks
- Causal events in zip_causal_events → anomalies auto-explained when event date aligns with signal divergence
- zip_signals_history accumulates daily snapshots → future model can train on actual vs predicted

**Commits:** (this commit) — migration 017, 5 worker migrations, 2 new data workers, worldModelWorker, reportGenerator, 5 API endpoints


---

## Session 25 — FCC BDC Worker Upgrade + Dashboard LocalIntel Panel
**Date:** 2026-05-10
**Commit:** (pending)

### Problem
fccBroadbandWorker.js was using FCC F477 Socrata (2021 vintage, unauthenticated). Data 5 years stale, Socrata API deprecated for new FCC data.

### Fix
Full rewrite to FCC BDC authenticated API (June 2025+ vintage):
- **Tier 1 (weekly):** `GET /api/public/map/availability/summary/county/{fips}` for all 67 FL counties
  - Auth: `FCC_BDC_USERNAME` + `FCC_BDC_API_KEY` Railway env vars
  - Paced at 8s/call (7.5/min, under 10/min rate limit)
  - New signals: `fcc_vintage_date`, `fcc_pct_25_3`, `fcc_pct_100_20`, `fcc_pct_gigabit`, `fcc_provider_count`, `fcc_fiber_pct`, `fcc_fixed_wireless_pct`, `fcc_bead_unserved_pct`, `fcc_bead_underserved_pct`
  - Hard fail-safe: logs loudly on error, NEVER clears existing fcc_* data
- **Tier 2 (stub):** `POST /api/local-intel/admin/fcc-deep-dive` — location-level BDC CSV download (500MB, 10min), returns `not_implemented` with full description of what it provides. Logged to zip_causal_events for pipeline awareness.
- **Dashboard:** New "LocalIntel" nav tab with worker pulse strip, Tier 1 status card, Tier 2 deep-dive card (amber badge, confirm dialog, result display), ZIP signal lookup, and open anomalies panel.

### Result
Worker produces current BDC data (semiannual FCC releases, June+December). Dashboard gives internal visibility into world model health + a clear upgrade path for paid consultation customers needing ZIP-level provider breakdowns.

### Files Changed
- `workers/fccBroadbandWorker.js` — full rewrite
- `localIntelAgent.js` — added POST /admin/fcc-deep-dive stub
- `dashboard-ui/index.html` — LocalIntel nav + section
- `dashboard-ui/style.css` — li-* component styles
- `dashboard-ui/app.js` — LocalIntel panel JS

### Session 25 — Addendum: fccBroadbandWorker endpoint correction
**Problem:** First BDC worker used assumed endpoint `/availability/summary/county/{fips}` (path param) and assumed `pct_*` response fields. BDC API spec confirmed the correct form is `/availability/summary?county_fips={fips}` (query param) and response fields are count-based: `total_locations`, `served_locations`, `unserved_locations`, `underserved_locations`, `provider_count`. Percentages must be computed locally.
**Fix:** Rewrote `fetchCountySummary()` to use correct query-param URL. Added 5-call strategy per county (25/3 baseline, 100/20, 1000/100, fiber tech=50, fixed wireless tech=70). Added explicit error messages for 401/403/429 (Railway datacenter IP + custom user-agent required). Computes `fcc_pct_*` and `fcc_bead_*_pct` from raw counts.
**Result:** Worker will produce accurate BDC signals without guessing field names. Also adds `fcc_total_locations`, `fcc_served_locations`, `fcc_unserved_locations`, `fcc_underserved_locations` as raw count signals alongside computed percentages.

### Session 25 — Addendum 2: Migration 017 verification + Census API key
**Problem 1:** `zip_anomalies` was missing from Postgres — migration 017 had `UNIQUE (zip, signal_name, detected_at::DATE)` which is invalid DDL (Postgres doesn't allow cast expressions in table-level UNIQUE constraints). Other 6 tables created fine.
**Fix 1:** Created `zip_anomalies` directly via Node with correct syntax. Fixed migration 017 SQL to use a comment instead (uniqueness enforced via index in future). All 7 world model tables now confirmed in Railway Postgres: zip_signals, zip_signals_history, zip_forecast, zip_anomalies, zip_causal_events, zip_reports, signal_registry.
**Problem 2:** `acsWorker.js` was hitting Census API unauthenticated (50 req/min). Census API key received and stored in Railway as `Census_Data_API`.
**Fix 2:** Wired `Census_Data_API` env var into `fetchACS()` — appends `&key=` to every Census request when present. Also drops inter-request sleep from 300ms → 120ms when authenticated (matches 500 req/min limit). Worker logs which mode it's in at startup. Falls back gracefully if key absent.
**Result:** Migration 017 complete (7/7 tables). ACS worker now runs 10× faster when key is set — full FL ZIP set completes in ~15 min instead of ~2.5 hours.


---

## Data Coverage Map

### Data Coverage Map (as of this commit)

| Source | Worker | API | Cadence | Lag | Key in Railway |
|---|---|---|---|---|---|
| Census ACS 5yr | acsWorker | census.gov/data | Annual | ~12mo | Census_Data_API |
| IRS SOI ZIP | irsSoiWorker | IRS bulk CSV | Annual | ~18mo | none (bulk) |
| IRS Migration | irsMigrationWorker | IRS bulk CSV | Annual | ~18mo | none (bulk) |
| Census CBP/ZBP | censusLayerWorker | census.gov/data | Annual | ~8mo | Census_Data_API |
| BEA CAINC1 | beaWorker | apps.bea.gov | Annual | ~18mo | BEA_API |
| LEHD LODES8 | lodesWorker | lehd.ces.census.gov | Annual | ~2yr | none (bulk) |
| FCC BDC | fccBroadbandWorker | broadbandmap.fcc.gov | Biannual | ~3mo | FCC_BDC_USERNAME + FCC_BDC_API_KEY |
| BLS LAUS/FRED | fredWorker | fred.stlouisfed.org | Monthly | ~6wk | FRED_API |
| Census QWI | qwiWorker | census.gov/data/qwi | Quarterly | ~9mo | Census_Data_API |
| BLS QCEW | qcewWorker | api.bls.gov | Quarterly | ~6mo | BLS_QCEW_API |
| FL ArcGIS Permits | permitWorker | FL county ArcGIS | Live | live | none |
| OSM Overpass | overpassWorker | overpass-api.de | Weekly | real-time | none |
| FL Sunbiz | sunbizWorker | sunbiz.org | Monthly | ~1mo | none |
| FDOT AADT | fdotWorker | gis.fdot.gov ArcGIS | 48h loop | Live 2025 | none (public) |
| Business Signals | businessSignalWorker | Postgres (businesses + business_tasks) | 24h | Real-time | none |
| Email Harvest | websiteEnricherWorker (extended) | Business websites (mailto extraction) | Weekly | Real-time | none |
| Claim Outreach | claimOutreachWorker | Twilio + Resend | Manual trigger | Real-time | TWILIO_*, RESEND_API_KEY |


---

## Session 15 — Property Data Layer (Duval + St. Johns)

---

## Session 16+ — Source workers, BEA/FRED/LODES/QWI/QCEW (excerpts)

## Session 16 — Source Worker Re-enablement (2026-05-07)

### Problem Discovered
During investigation of the source health dashboard showing "no data", we uncovered a critical gap: `overpassWorker`, `yellowPagesScraper`, `sunbizWorker`, and `businessMergeWorker` were all built and working before the Postgres migration, but were never re-added to `index.js` after `migrate-json-to-pg.js` moved the flat JSON data into Postgres. They existed in the codebase but were never spawned on Railway.

### Root Cause
The original architecture had source workers writing to `data/zips/*.json` (ephemeral Railway filesystem), with a reconciliation step collapsing them into a canonical dataset. `migrate-json-to-pg.js` migrated the **data** but not the **worker wiring**. Workers already had Postgres write code (`promoteOsmToBusinesses`, `db.upsertBusiness`, `sunbiz_import_state`) but were never added back to the `index.js` spawn list.

### What Was Fixed (commit `3402244`)
- **`workers/overpassWorker.js`** — added `logWorkerEvent()`, logs `start` + `complete` to `worker_events` under name `osm_overpass`. Timing via `Date.now()`.
- **`workers/yellowPagesScraper.js`** — added `logWorkerEvent()` (`yelp_public`), Postgres resume checkpoint (`getScrapedSet` + `markScraped` via `worker_events` `checkpoint` events), daemon loop (`require.main === module` guard). YP now skips already-scraped city+category combos within a 24h window on Railway restart.
- **`workers/sunbizWorker.js`** — added `logWorkerEvent()` (`fl_sunbiz`), logs `start` on resume, `complete` on finish with timing. Was already resume-safe via `sunbiz_import_state` table.
- **`workers/businessMergeWorker.js`** — already had `worker_events` logging. No changes needed.
- **`index.js`** — added all four workers to spawn list:
  ```
  { name: 'OSM Overpass',   file: 'workers/overpassWorker.js' }
  { name: 'Yellow Pages',   file: 'workers/yellowPagesScraper.js' }
  { name: 'FL SunBiz',      file: 'workers/sunbizWorker.js' }
  { name: 'Business Merge', file: 'workers/businessMergeWorker.js' }
  ```

### Worker Cadence (now active)
| Worker | Name in worker_events | Cadence | Resume-safe |
|---|---|---|---|
| overpassWorker | `osm_overpass` | 24h loop | YES — skips ZIPs already in Postgres |
| yellowPagesScraper | `yelp_public` | 24h loop | YES — checkpoint via worker_events |
| sunbizWorker | `fl_sunbiz` | Weekly | YES — sunbiz_import_state table |
| businessMergeWorker | `businessMerge` | 12h loop | YES — min 6h gap via worker_events |

### Source Health Dashboard
The frontend SOURCES list (`osm_overpass`, `yelp_public`, `fl_sunbiz`) now matches actual `worker_events` worker names. After Railway redeploy, the dashboard will show real run data for all sources.

### Architecture Restored
```
overpassWorker    → businesses (via promoteOsmToBusinesses) + zip_enrichment cache
yellowPagesScraper→ businesses (via db.upsertBusiness)
sunbizWorker      → businesses (via upsertBatch, resume from sunbiz_import_state)
                          ↓
              businessMergeWorker (Union-Find dedup every 12h)
                          ↓
                   canonical businesses table
```

### Next Vision (not yet built)
Layer 2 geo-economic intelligence overlay:
- `sjc_arcgis` worker — SJC GIS permits, parcel data, new development signals
- `irsSoiWorker` — IRS SOI zip-level income data (worker already exists)
- `censusLayerWorker` — Census demographic overlay (worker already exists)
- ZIP-level investment signal: new permits + government spending + zoning = market intelligence layer


### Session 16 (continued) — ZIP Intelligence Layer Workers Wired (commit `19e6d4e`)

**`irsSoiWorker`** and **`censusLayerWorker`** added to `index.js`. Both were fully built and Postgres-ready but never spawned after the flat-file migration.

**irsSoiWorker** (`irs_soi` in zip_intelligence):
- Downloads IRS SOI 2022 CSV once, caches to /tmp (re-downloads every 72h)
- Parses all FL ZIPs (STATEFIPS=12) — computes weighted median AGI, total returns, wage share
- Upserts to `zip_intelligence`: `irs_agi_median`, `irs_returns`, `irs_wage_share`, `irs_updated_at`
- 24h loop, skips already-enriched ZIPs unless FULL_REFRESH=true

**censusLayerWorker** (`census_layer` table via pgStore):
- **ZBP layer** (once): ZIP Business Patterns 2018 — establishment + employee count by NAICS sector per ZIP. The answer to "how many restaurants/clinics/retailers are in ZIP X"
- **CBP layer** (monthly): County Business Patterns 2023 — county-level sector health, derives `sector_gaps[]` (industries present at county but absent from ZIP = opportunity signal)
- **PDB layer** (quarterly): Planning Database 2024 — data confidence score (0-100), poverty%, vacancy%, new housing units added. Stamps confidence tier (VERIFIED/ESTIMATED/PROXY/SPARSE) onto zip_intelligence
- No API key required — all public Census endpoints

**NAICS sectors tracked**: Construction (23), Retail (44/45), Finance (52), Real Estate (53), Professional Services (54), Healthcare (62), Food Service (72), and 8 others — each mapped to LocalIntel oracle_vertical

**Workers now active on Railway** (full list):
- taskSeedWorker, enrichmentFillWorker, categoryReclassWorker, searchVectorBackfillWorker (existing)
- acsWorker (was already wired)
- osm_overpass, yelp_public, fl_sunbiz, businessMerge (re-enabled this session)
- irsSoiWorker, censusLayerWorker (wired this commit)

### Session 16 (continued) — SJC ArcGIS, ZBP Fix, Census API, Sunbelt Expansion (commit `1b0a1ee`)

**sjcArcGisWorker** (`workers/sjcArcGisWorker.js` — NEW):
- GIS REST base: `https://www.gis.sjcfl.us/portal_sjcgis/rest/services`
- Fetches `activePermits` + `CO_Permits` FeatureServer endpoints using spatial bounding box over all covered ZIPs
- Assigns ZIP by nearest centroid (WGS84 from Web Mercator conversion)
- Classifies permit type: `commercial`, `residential`, `industrial`, `civic`, `other`
- Upserts to `sjc_permits` table: `zip, permit_no, address, use_desc, permit_type, co_date, fetched_at`
- Logs to `worker_events` as `sjc_arcgis`, 24h loop
- `sjc_permits` table auto-created on first run

**ZBP Fix** (`censusLayerWorker.js`):
- Old skip logic checked only first ZIP — if CBP ran first, zbp never fired
- New logic: skip only if ≥80% of ZIPs already have zbp in `census_layer` — otherwise runs ingestion
- ZBP will now populate on next Railway restart

**Census API Endpoint** (`localIntelAgent.js`):
- `GET /api/local-intel/census?zip=32082`
- Returns: `county_industry_breakdown` (NAICS sectors sorted by establishment count), `permit_signals_6mo` (from sjc_permits), `income` (IRS median AGI, returns, wage share), `pdb` (confidence, poverty, college%, new units)
- Used by ZIP pages to surface investor-grade economic data

**Sunbelt ZIP Expansion** (`censusLayerWorker.js`):
- From 27 ZIPs → 41 ZIPs
- Added: Mandarin (32223), Avondale (32205), Argyle (32244), Green Cove (32043), Palm Coast (32137), Flagler Beach (32136), Ormond Beach (32174), Daytona (32117/32118), New Smyrna (32168), Palatka (32177), Gainesville (32601/32608)
- COUNTY_CONFIG expanded to include Volusia, Flagler, Putnam, Alachua counties

**Workers now in index.js** (full list):
- taskSeedWorker, enrichmentFillWorker, categoryReclassWorker, searchVectorBackfillWorker
- acsWorker, osm_overpass, yellowpages, fl_sunbiz, businessMergeWorker
- irsSoiWorker, censusLayerWorker, sjcArcGisWorker

**Next: ZIP pages** — surface census API data (industry breakdown + permit signals) on each ZIP page for investor view. Data now available at `/api/local-intel/census?zip=`.
## Session 17 — Hive Intelligence Layer (2026-05-07)

### Vision Established
- Workers = bees collecting daily signals (live)
- Hive Intelligence Layer = the greater signal synthesis for the whole swarm
- Three phases:
  1. **NOW** — LLM query layer in dashboard (interpret Postgres data, no hallucination)
  2. **NEXT** — ZIP opportunity scoring (deterministic math, no LLM)
  3. **LATER** — JEPA world model synthesizer (needs time-series ZIP snapshots to train on)

### census_layer_history Table (NEW)

---

## Worker Audit + Disable + On-Demand Trigger

## Session Entry — Worker Audit + Disable (2026-05-11)
**Problem:** 6 active workers consuming CPU/memory/retries with no benefit to search UX: promptEvolutionWorker (no traffic), btrWorker (stjohnstax.us timeouts), irsSoiWorker + irsMigrationWorker (data not queried), fccBroadbandWorker (not used), worldModelWorker (no hot-path consumer).
**Fix:** Commented out all 6 in LOCAL_INTEL_WORKERS array. 29 other dead-code worker files exist in workers/ but are never launched — left as-is (no impact).
**Result:** Reduced Railway CPU/memory churn. Active worker count: 22 → 16.

## Session Entry — Volume Cleanup Expansion (2026-05-11)
**Problem:** Volume audit showed 736MB used with stale dirs: embeddings/ (221MB), irs_soi_2022.csv (207MB), osm/ (52MB), vertical-runs/ (18MB), surface_current/ (17MB), oracle/ (17MB), briefs/ (6MB), and others — all data already in Postgres.
**Fix:** Expanded cleanup-volume to delete 14 stale dirs/files. Redirected surfaceCurrentWorker, oracleWorker, verticalAgentWorker to write to /tmp on Railway. irsSoiWorker already uses os.tmpdir().
**Result:** Volume should stay near baseline (~400MB WAL + DB overhead) after cleanup.

## 2026-05-11 On-Demand Worker Trigger System

**Problem:** 66 workers catalogued but 6 disabled (b94b088) and many others only runnable manually. No mechanism to trigger workers individually or by group without editing code or SSH-ing into Railway.

**Fix:** Added `lib/workerRunner.js` with `runWorker(name)` + `runGroup(groupName)`. Added admin endpoints `POST /api/local-intel/admin/worker/run` (individual or group trigger) and `GET /api/local-intel/admin/worker/status` (catalogue view). Worker groups: search_quality, enrichment, world_model, real_estate, self_improvement, data_ingestion, infrastructure. Workers are spawned as detached child processes (same pattern as LOCAL_INTEL_WORKERS). In-memory registry prevents double-spawn. `docs/worker_catalogue.md` committed to repo.

**Result:** Any worker or group can now be triggered via authenticated admin POST without code changes. The 6 disabled workers (btrWorker, irsSoiWorker, irsMigrationWorker, fccBroadbandWorker, worldModelWorker, promptEvolutionWorker) can be individually re-enabled on-demand by calling `/api/local-intel/admin/worker/run` with `{ worker: "btrWorker" }`.

## 2026-05-11 ZIP SEO Data Endpoint

**Problem:** generate-zip-pages.js only embedded generic marketing copy in ZIP HTML shells. Google saw 1,474 near-identical thin pages → 1,438 "Discovered - currently not indexed" in Search Console.

**Fix:** Added `GET /api/local-intel/zip-seo-data?zip=XXXXX` to localIntelAgent.js. Returns business_count, top_categories (top 3), population, median_income, median_home_value, affluence_pct, neighborhoods — all from Postgres (businesses + zip_intelligence/zip_signals + neighborhoods tables). No auth, read-only aggregate data. Called by generate-zip-pages.js at landing site build time to bake real per-ZIP stats into static HTML.

**Result:** Each ZIP page now contains unique, substantive static content visible to Google without JavaScript. Fixes the thin-content problem causing 1,438 pages to be discovered but not indexed.


---

## censusMacroWorker — Macro Census Layer
**Added:** 2026-05-27

### Why
CBP/ZBP give structural snapshots (establishments, employees). They miss:
1. Solo operators + gig workers (Nonemployer Statistics fills this)
2. Revenue and payroll per sector (Economic Census fills this)
3. New business formation velocity (BFS fills this as a leading indicator)

### Layers
| Layer | Source | Geo | Frequency | Table |
|---|---|---|---|---|
| BFS | Census timeseries/bfs | County (67 FL) | Monthly | `macro_indicators` + `zip_signals.macro_bfs_apps_latest` |
| NES | Census 2021/nonemp | ZCTA/ZIP | Annual | `zip_macro_signals` + `zip_signals.macro_nes_total_firms` |
| ECN | Census 2022/ecnbasic | ZIP | One-time (5yr) | `zip_macro_signals` + `zip_signals.macro_ecn_total_sales_k` |

### Key Signals Written
- `nes_total_firms` — total solo/gig operators in ZIP
- `nes_food_firms`, `nes_retail_firms`, `nes_health_firms`, `nes_prof_firms`, `nes_construction_firms` — sector breakdown
- `ecn_total_sales_k` — total revenue ($000s) for ZIP
- `ecn_sales_per_employee` — productivity proxy
- `ecn_avg_employees_per_firm` — scale indicator
- `bfs_county_apps_highprop` — high-propensity new business apps (leading indicator)

### Oracle / JEPA Access Pattern
```sql
SELECT zs.zip, zs.macro_nes_total_firms, zs.macro_ecn_total_sales_k,
       zm.ecn_sales_per_employee, zm.ecn_sector_json,
       zm.bfs_county_apps_highprop
FROM zip_signals zs
LEFT JOIN zip_macro_signals zm USING (zip)
WHERE zs.zip = $1
```
