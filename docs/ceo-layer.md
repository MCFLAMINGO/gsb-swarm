# CEO Layer

CEO page, ceo-assess endpoint, ceo-query engine, 12 sections, world model scores, zero LLM, Layer 1 Postgres.

## Access Point: CEO Page (Architecture Canon)

### The Three Access Points

#### 1. CEO Page (`/local-intel/ceo` on Vercel dashboard)
**Who:** Erik / operators — writing briefs for clients.
**What it is:** The brief creation workspace. Pulls full CEO assess (Layer 1 Postgres, zero LLM) for any ZIP. 12 structured sections — demographics, income, migration, labor, sectors, jobs, business activity, construction, broadband, property, world model, demand. World Model scores (growth/opportunity/risk/maturity/cohort) computed by `worldModelWorker` from all worker signals.
**Output:** Client-ready intelligence. Used to generate PDFs, market briefs, site selection reports.
**NOT for:** Public access, agent routing, or business discovery.


---

## B25 — CEO Assessment Endpoint

## B25 — CEO Assessment Endpoint
**Date:** 2026-05-13
**Problem:** Government data APIs (Census, CAMA, labor-market, zip-signals) were siloed — no single endpoint synthesized them into a business intelligence assessment.
**Fix:** Added GET /api/local-intel/ceo-assess?zip=&q= to localIntelAgent.js. Pulls business density, property stats, zip signals, SMS demand signals, and dead-end unmet demand from Postgres in parallel. Returns structured JSON + plain-English ceo_summary string. Zero LLM calls.
**Result:** CEO agent page on Vercel can call this endpoint and display a full data-driven ZIP assessment. Foundation for the GSB CEO agent voice/chat interface.


---

## B31 — CEO assess full rewrite — all 17 node signals, 12 structured sections

## 2026-05-13 — B31: CEO assess full rewrite — all 17 node signals, 12 structured sections

**Problem:** `GET /api/local-intel/ceo-assess` was a shallow stub — queried the wrong table (`properties` instead of `property_parcels`), read only a handful of zip_signals columns, and returned a single flat summary string. CEO could not actually "pull all data from all nodes that have written to Postgres" as intended. Sections for migration, income, labor, sectors, jobs, construction, broadband, world model, and demand were completely absent.

**Fix:**
- `localIntelAgent.js`: Full rewrite of `GET /api/local-intel/ceo-assess`. Now queries `property_parcels WHERE zip=$1` (fixed table). Reads ALL populated zip_signals columns across all 17 nodes and organizes into 12 structured sections: demographics (ACS), income (IRS SOI + BEA), migration (IRS Migration), labor (FRED + QWI + QCEW), sectors (CES), jobs (LODES), business_activity (businesses + sunbiz + OSM), construction (BPS), broadband (FCC), property (property_parcels), world_model (sig_* composite scores), demand (top SMS intents + dead ends). Response includes `populated_sections` array listing which sections have actual data. `ceo_summary` is multi-section plain-English string: "ZIP 32082 · Query: '...' DEMOGRAPHICS: ... INCOME: ... MIGRATION: ... LABOR: ... SECTORS: ... JOBS FLOW: ... BUSINESS: ... PROPERTY: ... WORLD MODEL: ..." Built entirely from Postgres — zero LLM calls (Layer 1 architecture).

**Result:** CEO assess endpoint now surfaces all available intelligence across all data workers. Architecture preserved: Layer 1 = pure Postgres aggregation (deterministic, zero cost), Layer 2 = LLM receives Postgres context (future), Layer 3 = JEPA world models trained on historical zip_signals (future). Response shape documented for Vercel CEO page UI update (pending Erik approval before frontend changes).


---

## B32 — CEO operational build — ACP offering + Vercel page full rewrite

## 2026-05-13 — B32: CEO operational build — ACP offering + Vercel page full rewrite

**Problem:** Vercel CEO page was wired to old response shape (business_density, property_snapshot, demand_signals keys) — completely broken against B31 API. No ACP offering exposed the new ceo-assess endpoint, so ACP agents could not hire LocalIntel CEO for market intelligence. CEO was a Virtuals/ACP agent and external consumers needed a proper offering.

**Fix:**
- `acpOfferings.js`: Added `local_intel_assess` offering to GSB CEO agent — takes `zip` + optional `query`, delivers full 12-section structured JSON + ceo_summary. $0.10, 5 min SLA. Covers all 7 St. Johns County ZIPs. Description surfaces all 17 data nodes for discoverability.
- `ceobuyer.js`: Added `local_intel_assess` offering handler — validates ZIP against TARGET_ZIPS, fetches `GET /api/local-intel/ceo-assess` on Railway base URL using ADMIN_TOKEN env var, delivers full assessment JSON via `job.deliver({ type: 'json', value: assessment })`. ZIP validation rejectPayable if out of coverage.
- `gsb-swarm-dashboard` `src/app/local-intel/ceo/page.tsx`: Full rewrite — updated CeoAssessment type to match B31 response shape. 12 dedicated section panels: DemographicsPanel, IncomePanel, MigrationPanel, LaborPanel, SectorsPanel, JobsPanel, BusinessPanel (full-width w/ bar chart), ConstructionPanel, BroadbandPanel, PropertyPanel, WorldModelPanel (full-width w/ score rings), DemandPanel (full-width). Populated-sections pill bar on summary card. CEO prompt bar context placeholder updated for brief creation workflow. Sections only render when populated_sections includes them — gracefully degrades as workers populate more data.

**Result:** CEO page is now the operational brief-creation workspace. Each populated data node surfaces its section automatically. ACP agents can call `local_intel_assess` to hire the CEO for LocalIntel market intelligence. Both expand automatically as more workers populate zip_signals.


---

## B39a — Fix CEO populated_sections filter

## B39a — Fix CEO populated_sections filter
**Date:** 2026-05-14
**Problem:** `populatedSections` filter used `Object.keys(v).length > 1` — required 2+ keys before a section was counted. Single-key sections (e.g. `property` with only `parcel_count`) were silently excluded from `populated_sections` list even though data was present.
**Fix:** Changed filter threshold from `> 1` to `> 0` in `localIntelAgent.js` ceo-assess endpoint.
**Result:** All sections with any data will now appear in `populated_sections`. CEO page correctly reflects full data availability for all ZIPs.


---

## B39b — World Model Worker

## B39b — World Model Worker
**Date:** 2026-05-14
**Problem:** CEO assess Layer 1 returned only raw Postgres values — no derived signals, no ZIP-vs-ZIP rankings, no market context. `sig_*` columns in zip_signals were always null. World Model node showed "BUILDING" on nodes page with no trigger.
**Fix:** Built `workers/worldModelWorker.js` — pure math, zero LLM calls. Reads all zip_signals rows + businesses counts for all 7 TARGET_ZIPS. Computes:
  - `sig_growth_score` (0–100): rank-normalized from qcew_emp_yoy_pct (40%), sunbiz_new_12mo (35%), bps_total_units_annual (25%)
  - `sig_opportunity_score` (0–100): rank-normalized from investment_opportunity_score (40%), lodes_net_flow (35%), biz_density_per_1k (25%)
  - `sig_risk_score` (0–100): rank-normalized from ai_displacement_risk (40%), fred_unemployment_rate (40%), qwi_turnover_rate (20%)
  - `sig_market_maturity` (text): "Emerging" / "Growing" / "Established" / "Mature" — derived from owner_occ_pct + median_age + emp_yoy + new_biz_12mo thresholds
  - `sig_income_tier` (text): "Moderate" / "Above Average" / "High" / "Affluent" / "Ultra-Affluent" — absolute per_capita_income thresholds
  - `sig_peer_cohort` (text): "Coastal Affluent" / "Suburban Growth" / "Job-Rich Suburb" / "Bedroom Community" / "Dense Commercial Core" / "Working Class Core"
  - `sig_biz_density_per_1k`: businesses / acs_population × 1000
  - `sig_job_capture_ratio`: lodes_jobs_here / qcew_employment
Worker has standalone entry point (spawned by trigger). NOT in auto-start list — must run after primary workers.
Updated nodes page: World Model node now has triggerEndpoint + status="active".
**Result:** After triggering, CEO assess world_model section will populate with scores. CEO can show "32082 ranks #1 in St. Johns for income, #2 for growth" derived purely from Postgres.


---

## B43 — CEO Query Engine

### B43 — CEO Query Engine
**Problem:** CEO assess loaded all data sections but never answered the question — queries like "can this lease support a steakhouse" were echoed, not answered.
**Fix:** Added POST /api/local-intel/ceo-query. Accepts { zip, question }, reloads zip_signals + business data from Postgres, runs deterministic keyword-category matching (zero LLM), returns { verdict, answer, supporting_data, lease_signal, confidence }. Five categories: restaurant_concept, lease_viability, sector_gap, growth_trajectory, labor_staffing, general fallback.
**Result:** CEO page query bar now returns reasoned answers grounded in Postgres data — income profile vs concept viability, lease support math, sector gap analysis — all zero LLM API calls.

