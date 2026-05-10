-- =============================================================================
-- 017_world_model_schema.sql
-- LocalIntel World Model Foundation
-- =============================================================================
--
-- Philosophy:
--   Every worker writes its signal columns into zip_signals (current state).
--   zip_signals_history is append-only — snapshotted daily — this is the
--   training data for future predictive models. We are building the dataset
--   now so we have history when the model needs it.
--
--   zip_causal_events stores DATED external events (policy changes, 
--   infrastructure decisions, disasters, elections) so the world model can
--   correlate signal shifts with candidate causes. The lag between an event
--   date and a signal change is itself a signal.
--
--   zip_forecast stores 12/24/36mo projections per ZIP — deterministic v1
--   uses peer cohort scoring. Upgrades to learned embeddings later.
--
--   zip_anomalies stores auto-detected divergences and the questions they
--   generate. "ZIP 32081 has 340% more multifamily permits than peer cohort
--   median — what's driving this?" These become consultation hooks.
--
--   zip_reports is the consultation artifact — structured JSON report
--   covering past trend, current state, and projected futures. The $500-$5k
--   deliverable lives here.
-- =============================================================================


-- =============================================================================
-- 1. ZIP_SIGNALS — current state, one row per ZIP, all sources
-- =============================================================================
-- Workers upsert their columns here after writing to their own tables.
-- Column naming convention: {source}_{metric}
--   Sources: acs_, cbp_, zbp_, bps_, irs_, lodes_, fcc_, osm_, sjc_, sunbiz_
--   Metrics: snake_case, units in column comment
--
-- All columns nullable — a ZIP may have partial coverage.
-- updated_at per source column tracks freshness independently.
-- =============================================================================

CREATE TABLE IF NOT EXISTS zip_signals (
  zip               TEXT PRIMARY KEY,
  state             TEXT,
  county            TEXT,
  city              TEXT,

  -- ── Geometry / geography ──────────────────────────────────────────────────
  lat               NUMERIC(9,6),
  lon               NUMERIC(9,6),
  area_sqmi         NUMERIC(8,2),       -- ZIP area in square miles

  -- ── ACS Demographics (source: acsWorker) ─────────────────────────────────
  acs_population          INT,          -- total population
  acs_households          INT,          -- total households
  acs_median_hhi          INT,          -- median household income ($)
  acs_median_age          NUMERIC(4,1), -- median age
  acs_owner_occ_pct       NUMERIC(5,2), -- % owner-occupied housing units
  acs_family_pct          NUMERIC(5,2), -- % family households
  acs_college_pct         NUMERIC(5,2), -- % population 25+ with bachelor's+
  acs_poverty_pct         NUMERIC(5,2), -- % below poverty line
  acs_foreign_born_pct    NUMERIC(5,2), -- % foreign-born population
  acs_commute_time_min    NUMERIC(5,1), -- mean commute time (minutes)
  acs_housing_units       INT,          -- total housing units
  acs_vacancy_pct         NUMERIC(5,2), -- % vacant housing units
  acs_vintage             TEXT,         -- ACS data vintage (e.g. '2022 5-year')
  acs_updated_at          TIMESTAMPTZ,

  -- ── IRS SOI Income (source: irsSoiWorker) ────────────────────────────────
  irs_agi_median          INT,          -- median AGI ($)
  irs_returns             INT,          -- number of returns filed
  irs_wage_share          NUMERIC(5,2), -- wages as % of total income
  irs_updated_at          TIMESTAMPTZ,

  -- ── IRS Migration SOI (source: irsMigrationWorker — NEW) ─────────────────
  irs_mig_in_returns      INT,          -- returns that moved INTO this county
  irs_mig_out_returns     INT,          -- returns that moved OUT of this county
  irs_mig_in_agi          BIGINT,       -- AGI carried in ($000s)
  irs_mig_out_agi         BIGINT,       -- AGI carried out ($000s)
  irs_mig_net_returns     INT,          -- net (in - out)
  irs_mig_net_agi         BIGINT,       -- net AGI flow ($000s)
  irs_mig_top_origin      TEXT,         -- top origin county for inbound
  irs_mig_top_dest        TEXT,         -- top destination county for outbound
  irs_mig_vintage         TEXT,         -- e.g. '2021-2022'
  irs_mig_updated_at      TIMESTAMPTZ,

  -- ── Census County Business Patterns (source: censusLayerWorker) ──────────
  cbp_total_establishments  INT,        -- total business establishments (county-level, ZIP-apportioned)
  cbp_total_employees       INT,        -- total employees
  cbp_total_payroll_k       INT,        -- total annual payroll ($000s)
  cbp_dominant_sector       TEXT,       -- NAICS 2-digit sector with most establishments
  cbp_updated_at            TIMESTAMPTZ,

  -- ── ZIP Code Business Patterns (source: zbpWorker — NEW) ─────────────────
  zbp_total_establishments  INT,        -- actual ZIP-level business count (more accurate than CBP)
  zbp_total_employees       INT,        -- ZIP-level employees
  zbp_sector_json           JSONB,      -- {naics2: {estabs, employees}} per sector
  zbp_updated_at            TIMESTAMPTZ,

  -- ── Census Building Permits Survey (source: permitWorker) ────────────────
  bps_res_1unit_annual      INT,        -- single-family permits, full year
  bps_res_multifam_annual   INT,        -- 5+ unit permits, full year
  bps_total_units_annual    INT,        -- all residential units permitted, full year
  bps_total_value_annual    BIGINT,     -- dollar value of all permits, full year
  bps_res_1unit_mo          INT,        -- single-family permits, most recent month
  bps_res_multifam_mo       INT,        -- 5+ unit permits, most recent month
  bps_total_units_mo        INT,        -- all units, most recent month
  bps_period_mo             TEXT,       -- period key for monthly (e.g. '202503')
  bps_commercial_mo         INT,        -- commercial permits (ArcGIS sources)
  bps_updated_at            TIMESTAMPTZ,

  -- ── LODES / LEHD Job Flows (source: lodesWorker — NEW) ───────────────────
  lodes_jobs_here           INT,        -- jobs located in this ZIP
  lodes_workers_living_here INT,        -- workers who live in this ZIP
  lodes_net_flow            INT,        -- jobs_here - workers_living_here (+ = job importer)
  lodes_top_inflow_zip      TEXT,       -- ZIP sending most workers here
  lodes_top_outflow_zip     TEXT,       -- ZIP receiving most residents who work elsewhere
  lodes_retail_jobs         INT,        -- retail trade jobs in ZIP
  lodes_food_jobs           INT,        -- food service jobs in ZIP
  lodes_updated_at          TIMESTAMPTZ,

  -- ── FCC Broadband (source: fccBroadbandWorker — NEW) ─────────────────────
  fcc_has_25_3              BOOLEAN,    -- has 25/3 Mbps coverage (FCC min standard)
  fcc_has_100_20            BOOLEAN,    -- has 100/20 Mbps coverage
  fcc_has_gigabit           BOOLEAN,    -- has 1Gbps+ coverage
  fcc_providers_cnt         INT,        -- number of ISPs serving ZIP
  fcc_max_down_mbps         INT,        -- fastest advertised download speed
  fcc_fiber_available       BOOLEAN,    -- fiber optic available
  fcc_updated_at            TIMESTAMPTZ,

  -- ── OSM Business Intelligence (source: overpassWorker) ───────────────────
  osm_biz_count             INT,        -- total OSM-indexed businesses
  osm_with_phone_pct        NUMERIC(5,2), -- % with phone number
  osm_with_website_pct      NUMERIC(5,2), -- % with website
  osm_with_hours_pct        NUMERIC(5,2), -- % with opening_hours
  osm_food_count            INT,        -- food/restaurant businesses
  osm_retail_count          INT,        -- retail businesses
  osm_worship_count         INT,        -- places of worship (churches etc)
  osm_education_count       INT,        -- schools, colleges
  osm_healthcare_count      INT,        -- medical, dental, pharmacy
  osm_updated_at            TIMESTAMPTZ,

  -- ── Sunbiz Entity Activity (source: sunbizWorker) ────────────────────────
  sunbiz_active_entities    INT,        -- active FL registered entities in ZIP
  sunbiz_new_12mo           INT,        -- new entity registrations last 12 months
  sunbiz_dissolved_12mo     INT,        -- dissolved/inactive last 12 months
  sunbiz_net_12mo           INT,        -- net (new - dissolved)
  sunbiz_corp_pct           NUMERIC(5,2), -- % that are corporations (vs LLC)
  sunbiz_updated_at         TIMESTAMPTZ,

  -- ── Computed / Derived Signals ────────────────────────────────────────────
  -- These are calculated from the raw signals above. Refreshed by worldModelWorker.
  sig_biz_density_per_1k    NUMERIC(8,3), -- businesses per 1,000 residents
  sig_permit_velocity       NUMERIC(8,3), -- permits per 1,000 residents (monthly)
  sig_job_capture_ratio     NUMERIC(8,3), -- jobs_here / workers_living_here
  sig_income_tier           TEXT,         -- 'low' | 'moderate' | 'high' | 'affluent'
  sig_growth_score          INT,          -- 0-100 composite growth signal
  sig_opportunity_score     INT,          -- 0-100 composite opportunity signal
  sig_risk_score            INT,          -- 0-100 composite risk signal
  sig_peer_cohort           TEXT,         -- assigned peer cohort label
  sig_market_maturity       TEXT,         -- 'emerging' | 'growing' | 'established' | 'mature' | 'declining'
  sig_updated_at            TIMESTAMPTZ,

  -- ── Metadata ──────────────────────────────────────────────────────────────
  first_seen_at             TIMESTAMPTZ DEFAULT NOW(),
  last_updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for world model queries (peer cohort comparisons, regional aggregates)
CREATE INDEX IF NOT EXISTS idx_zs_county      ON zip_signals (county);
CREATE INDEX IF NOT EXISTS idx_zs_state       ON zip_signals (state);
CREATE INDEX IF NOT EXISTS idx_zs_cohort      ON zip_signals (sig_peer_cohort);
CREATE INDEX IF NOT EXISTS idx_zs_maturity    ON zip_signals (sig_market_maturity);
CREATE INDEX IF NOT EXISTS idx_zs_growth      ON zip_signals (sig_growth_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_zs_opportunity ON zip_signals (sig_opportunity_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_zs_income_tier ON zip_signals (sig_income_tier);
CREATE INDEX IF NOT EXISTS idx_zs_pop         ON zip_signals (acs_population DESC NULLS LAST);


-- =============================================================================
-- 2. ZIP_SIGNALS_HISTORY — append-only daily snapshots (training data)
-- =============================================================================
-- Never updated, only inserted. One row per ZIP per snapshot_date.
-- This is how we build the temporal dataset for:
--   - "Was this ZIP growing or declining 18 months ago?"
--   - "How did permits change after the 2024 tax change?"
--   - Trend lines, acceleration/deceleration detection
--   - Eventually: sequence models over time series
-- =============================================================================

CREATE TABLE IF NOT EXISTS zip_signals_history (
  id              BIGSERIAL PRIMARY KEY,
  zip             TEXT NOT NULL,
  snapshot_date   DATE NOT NULL,
  snapshot_source TEXT DEFAULT 'daily_job',  -- 'daily_job' | 'manual' | 'event_triggered'

  -- Core signals snapshotted (subset of zip_signals — high-change fields only)
  acs_population        INT,
  acs_median_hhi        INT,
  cbp_total_establishments INT,
  zbp_total_establishments INT,
  bps_res_1unit_mo      INT,
  bps_total_units_mo    INT,
  bps_commercial_mo     INT,
  lodes_net_flow        INT,
  sunbiz_new_12mo       INT,
  sunbiz_dissolved_12mo INT,
  sunbiz_net_12mo       INT,
  osm_biz_count         INT,
  irs_mig_net_returns   INT,
  irs_mig_net_agi       BIGINT,

  -- Computed signals at snapshot time
  sig_growth_score      INT,
  sig_opportunity_score INT,
  sig_risk_score        INT,
  sig_market_maturity   TEXT,

  created_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (zip, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_zsh_zip_date  ON zip_signals_history (zip, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_zsh_date      ON zip_signals_history (snapshot_date DESC);


-- =============================================================================
-- 3. ZIP_CAUSAL_EVENTS — dated external events for correlation
-- =============================================================================
-- The insight: a signal shift alone tells you something changed.
-- A dated external event near the shift tells you WHY it changed.
-- The lag between event_date and signal shift is itself a signal
-- (policy → behavior lag, infrastructure announcement → permit lag, etc.)
--
-- Examples:
--   - Florida eliminated intangibles tax (2007-01-01)
--   - I-95 SR-9B interchange approved (2024-03-15, construction 2025-Q2)
--   - Hurricane Ian landfall (2022-09-28)
--   - Duval school district rezoning effective (2023-08-01)
--   - SpaceX Starship launch complex expansion announced (2024-11-01)
-- =============================================================================

CREATE TABLE IF NOT EXISTS zip_causal_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Geographic scope (null = statewide/national)
  zip             TEXT,          -- specific ZIP affected (null if county/state/national)
  county          TEXT,          -- county affected
  state           TEXT DEFAULT 'FL',

  -- Event classification
  event_type      TEXT NOT NULL, -- see taxonomy below
  event_category  TEXT,          -- 'infrastructure' | 'policy' | 'economic' | 'climate' | 'social'
  severity        TEXT,          -- 'minor' | 'moderate' | 'major' | 'transformative'

  -- The critical dates — all optional, fill what you know
  announced_date  DATE,          -- when was this publicly announced?
  decided_date    DATE,          -- when was the decision/vote/signing?
  effective_date  DATE,          -- when does/did it take effect?
  start_date      DATE,          -- when did implementation/construction begin?
  completion_date DATE,          -- when was it completed? (may be future estimate)
  review_date     DATE,          -- scheduled review or expiration date

  -- Description
  title           TEXT NOT NULL,
  description     TEXT,
  source_url      TEXT,          -- link to primary source
  source_name     TEXT,          -- e.g. 'FDOT', 'Florida Legislature', 'FEMA'

  -- Impact model (filled by worldModelWorker after correlation)
  affected_signals  TEXT[],      -- which zip_signals columns this event likely affected
  observed_lag_days INT,         -- days between effective_date and first detectable signal change
  confidence        NUMERIC(4,2), -- 0-1 confidence that this event caused the observed shift

  -- Metadata
  added_by        TEXT DEFAULT 'system',  -- 'system' | 'analyst' | 'auto_detected'
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Event type taxonomy (open-ended TEXT, but document standard values):
-- Infrastructure: 'highway_project', 'broadband_expansion', 'utility_extension',
--                 'transit_line', 'airport_expansion', 'port_expansion', 'school_built'
-- Policy:         'tax_change', 'zoning_change', 'regulation_change', 'subsidy_program',
--                 'enterprise_zone', 'opportunity_zone', 'school_district_change'
-- Economic:       'major_employer_arrival', 'major_employer_departure', 'HQ_relocation',
--                 'military_base_change', 'university_expansion', 'hospital_opening'
-- Climate:        'hurricane', 'flood', 'fema_remap', 'sea_level_event', 'wildfire'
-- Social:         'demographic_shift', 'migration_wave', 'gentrification_signal'

CREATE INDEX IF NOT EXISTS idx_ce_zip           ON zip_causal_events (zip);
CREATE INDEX IF NOT EXISTS idx_ce_county        ON zip_causal_events (county);
CREATE INDEX IF NOT EXISTS idx_ce_effective     ON zip_causal_events (effective_date);
CREATE INDEX IF NOT EXISTS idx_ce_type          ON zip_causal_events (event_type);
CREATE INDEX IF NOT EXISTS idx_ce_category      ON zip_causal_events (event_category);


-- =============================================================================
-- 4. ZIP_FORECAST — world model output, 12/24/36 month projections
-- =============================================================================
-- One row per ZIP per model run. model_version tracks which scoring
-- logic produced it so we can compare v1 (deterministic) vs future
-- (learned) outputs side by side.
-- =============================================================================

CREATE TABLE IF NOT EXISTS zip_forecast (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zip               TEXT NOT NULL,
  model_version     TEXT NOT NULL,        -- e.g. 'v1-deterministic', 'v2-cohort'
  generated_at      TIMESTAMPTZ DEFAULT NOW(),

  -- Peer cohort this ZIP was compared against
  peer_cohort       TEXT,
  peer_zip_count    INT,

  -- 12-month projections
  proj_12mo_growth_score    INT,          -- predicted growth score in 12 months
  proj_12mo_opportunity     INT,          -- predicted opportunity score
  proj_12mo_biz_delta_pct   NUMERIC(7,2), -- predicted % change in business count
  proj_12mo_maturity        TEXT,         -- predicted market maturity state
  proj_12mo_confidence      NUMERIC(4,2), -- 0-1 model confidence

  -- 24-month projections
  proj_24mo_growth_score    INT,
  proj_24mo_opportunity     INT,
  proj_24mo_biz_delta_pct   NUMERIC(7,2),
  proj_24mo_maturity        TEXT,
  proj_24mo_confidence      NUMERIC(4,2),

  -- 36-month projections
  proj_36mo_growth_score    INT,
  proj_36mo_opportunity     INT,
  proj_36mo_biz_delta_pct   NUMERIC(7,2),
  proj_36mo_maturity        TEXT,
  proj_36mo_confidence      NUMERIC(4,2),

  -- Key signals that drove the projection (for explainability)
  driver_signals    JSONB,               -- [{signal, value, weight, direction}]
  risk_factors      JSONB,               -- [{factor, severity, description}]
  opportunity_gaps  JSONB,               -- [{sector, gap_score, rationale}]

  -- Narrative (generated by world model, plain English)
  summary_12mo      TEXT,
  summary_36mo      TEXT,

  -- Causal events factored in
  causal_event_ids  UUID[],              -- zip_causal_events IDs considered
  UNIQUE (zip, model_version, generated_at)
);

CREATE INDEX IF NOT EXISTS idx_zf_zip         ON zip_forecast (zip);
CREATE INDEX IF NOT EXISTS idx_zf_generated   ON zip_forecast (generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_zf_version     ON zip_forecast (model_version);


-- =============================================================================
-- 5. ZIP_ANOMALIES — auto-detected signal divergences + generated questions
-- =============================================================================
-- The "questions we don't know to ask" layer.
-- worldModelWorker scans zip_signals, computes expected values from peer
-- cohorts, flags statistically unexpected divergences, and generates
-- a plain-English question + candidate explanations.
-- These become consultation hooks and self-improvement signals.
-- =============================================================================

CREATE TABLE IF NOT EXISTS zip_anomalies (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zip               TEXT NOT NULL,
  detected_at       TIMESTAMPTZ DEFAULT NOW(),
  resolved_at       TIMESTAMPTZ,         -- null = still anomalous

  -- What's anomalous
  signal_name       TEXT NOT NULL,       -- e.g. 'bps_res_multifam_mo'
  actual_value      NUMERIC,
  expected_value    NUMERIC,             -- peer cohort median
  z_score           NUMERIC(6,2),        -- standard deviations from cohort mean
  direction         TEXT,               -- 'above' | 'below'
  severity          TEXT,               -- 'notable' (>2σ) | 'significant' (>3σ) | 'extreme' (>4σ)

  -- The auto-generated question
  question          TEXT NOT NULL,       -- "Why does ZIP X have 340% more multifamily permits than peers?"
  candidate_causes  JSONB,              -- [{cause, plausibility, data_needed_to_confirm}]
  causal_event_ids  UUID[],             -- matching zip_causal_events if found

  -- Resolution
  resolution_note   TEXT,
  resolved_by       TEXT,               -- 'world_model' | 'analyst' | 'causal_event'

  status            TEXT DEFAULT 'open', -- 'open' | 'explained' | 'monitoring' | 'closed'
  UNIQUE (zip, signal_name, detected_at::DATE)
);

CREATE INDEX IF NOT EXISTS idx_za_zip       ON zip_anomalies (zip);
CREATE INDEX IF NOT EXISTS idx_za_status    ON zip_anomalies (status);
CREATE INDEX IF NOT EXISTS idx_za_signal    ON zip_anomalies (signal_name);
CREATE INDEX IF NOT EXISTS idx_za_detected  ON zip_anomalies (detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_za_severity  ON zip_anomalies (severity);


-- =============================================================================
-- 6. ZIP_REPORTS — consultation report artifacts
-- =============================================================================
-- The $500-$5k deliverable. Structured JSON covering:
--   past_trend (12-36 months of history)
--   current_state (zip_signals snapshot)
--   projections (from zip_forecast)
--   anomalies (from zip_anomalies)
--   sector_gaps (opportunity analysis)
--   causal_narrative (what events shaped this market)
--   risk_factors
--   recommendations
--
-- report_json is the full artifact. report_html is pre-rendered for delivery.
-- Linked to consultation_leads so we know which report serves which client.
-- =============================================================================

CREATE TABLE IF NOT EXISTS zip_reports (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zip               TEXT NOT NULL,
  generated_at      TIMESTAMPTZ DEFAULT NOW(),
  model_version     TEXT,
  report_type       TEXT DEFAULT 'full', -- 'full' | 'sector' | 'comparison' | 'teaser'

  -- Linked intake
  lead_id           UUID REFERENCES consultation_leads(id) ON DELETE SET NULL,

  -- Report scope
  focus_sectors     TEXT[],             -- if sector-specific report
  comparison_zips   TEXT[],             -- if multi-ZIP comparison
  horizon_months    INT DEFAULT 36,     -- projection horizon

  -- The artifact
  report_json       JSONB NOT NULL,     -- full structured report
  report_html       TEXT,               -- pre-rendered HTML (optional)
  report_pdf_url    TEXT,               -- S3/storage URL if PDF generated

  -- Delivery
  delivered_at      TIMESTAMPTZ,
  delivered_to      TEXT,               -- email address
  access_token      TEXT UNIQUE DEFAULT gen_random_uuid()::TEXT, -- shareable link token

  -- Quality
  data_completeness NUMERIC(4,2),       -- 0-1, % of zip_signals columns populated
  confidence_score  NUMERIC(4,2),       -- 0-1 overall model confidence

  status            TEXT DEFAULT 'draft' -- 'draft' | 'ready' | 'delivered' | 'archived'
);

CREATE INDEX IF NOT EXISTS idx_zr_zip         ON zip_reports (zip);
CREATE INDEX IF NOT EXISTS idx_zr_generated   ON zip_reports (generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_zr_lead        ON zip_reports (lead_id);
CREATE INDEX IF NOT EXISTS idx_zr_token       ON zip_reports (access_token);
CREATE INDEX IF NOT EXISTS idx_zr_status      ON zip_reports (status);


-- =============================================================================
-- 7. SIGNAL_REGISTRY — self-documentation of every signal column
-- =============================================================================
-- The system that knows what it knows — and what it doesn't know yet.
-- Every column in zip_signals has an entry here describing:
--   - what it measures
--   - where it comes from
--   - how fresh it typically is
--   - what other signals it correlates with
--   - what questions it helps answer
-- This enables the anomaly detector and report generator to reason
-- about signals without hardcoded logic.
-- =============================================================================

CREATE TABLE IF NOT EXISTS signal_registry (
  signal_name       TEXT PRIMARY KEY,   -- matches column name in zip_signals
  display_name      TEXT NOT NULL,
  category          TEXT NOT NULL,      -- 'demographic' | 'economic' | 'infrastructure' | 'growth' | 'social'
  source_worker     TEXT,              -- worker that populates this
  source_dataset    TEXT,              -- e.g. 'ACS 5-year', 'Census BPS', 'FCC Form 477'
  source_url        TEXT,
  unit              TEXT,              -- e.g. 'count', 'percent', 'dollars', 'mbps'
  update_frequency  TEXT,             -- 'daily' | 'monthly' | 'annual' | 'quinquennial'
  typical_lag_days  INT,              -- how stale is this data typically?
  coverage_pct      NUMERIC(5,2),     -- % of FL ZIPs this signal covers
  description       TEXT,
  correlates_with   TEXT[],           -- other signal_names that tend to move together
  leading_indicator_for TEXT[],       -- signals this tends to predict
  questions_answered TEXT[],          -- plain-English questions this helps answer
  added_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Seed signal registry with known signals
INSERT INTO signal_registry (signal_name, display_name, category, source_worker, source_dataset, unit, update_frequency, typical_lag_days, description, questions_answered)
VALUES
  ('acs_population',        'Total Population',           'demographic',     'acsWorker',        'ACS 5-year',         'count',   'annual',  365, 'Total population in ZIP code', ARRAY['How large is this market?','What is the addressable population?']),
  ('acs_median_hhi',        'Median Household Income',    'demographic',     'acsWorker',        'ACS 5-year',         'dollars', 'annual',  365, 'Median household income in dollars', ARRAY['What is the purchasing power of this market?','Is this a premium or value market?']),
  ('acs_college_pct',       'College Education Rate',     'demographic',     'acsWorker',        'ACS 5-year',         'percent', 'annual',  365, '% of adults 25+ with bachelor''s degree or higher', ARRAY['How educated is the workforce?','AI/tech adoption proxy']),
  ('bps_res_1unit_mo',      'Single-Family Permits (mo)', 'growth',          'permitWorker',     'Census BPS Monthly', 'count',   'monthly', 60,  'Single-family residential building permits, most recent month', ARRAY['Is this area adding housing?','Is population expected to grow?']),
  ('bps_commercial_mo',     'Commercial Permits (mo)',    'growth',          'permitWorker',     'ArcGIS County',      'count',   'monthly', 30,  'Commercial building permits, most recent month', ARRAY['Is business investment happening here?','Is supply about to increase?']),
  ('lodes_net_flow',        'Job Flow (net)',              'economic',        'lodesWorker',      'LEHD LODES',         'count',   'annual',  548, 'Net job flow: jobs in ZIP minus residents working elsewhere. Positive = job importer (daytime demand > residential)', ARRAY['Is there daytime demand from workers?','Should I target commuters vs residents?']),
  ('fcc_has_gigabit',       'Gigabit Internet Available', 'infrastructure',  'fccBroadbandWorker','FCC Form 477',      'boolean', 'annual',  365, 'Whether gigabit fiber is available in this ZIP', ARRAY['Can this ZIP attract tech companies?','Is this a high-growth infrastructure environment?']),
  ('osm_worship_count',     'Places of Worship',          'social',          'overpassWorker',   'OpenStreetMap',      'count',   'monthly', 30,  'Number of churches, mosques, temples, synagogues in ZIP', ARRAY['How socially conservative is this area?','What is the community cohesion signal?']),
  ('sunbiz_net_12mo',       'Business Net Formation (12mo)','growth',        'sunbizWorker',     'Florida Sunbiz',     'count',   'monthly', 30,  'New entity registrations minus dissolutions, last 12 months', ARRAY['Is the business ecosystem growing or shrinking?','Is this ZIP attracting entrepreneurs?']),
  ('irs_mig_net_agi',       'Net Migration AGI ($000s)',  'demographic',     'irsMigrationWorker','IRS SOI Migration',  'dollars', 'annual',  548, 'Net AGI carried by households moving in vs out of county ($000s). Positive = wealth importing county', ARRAY['Is wealth flowing into or out of this area?','What is the California/NY→FL migration signal?']),
  ('zbp_total_establishments','Business Count (ZIP-level)','economic',       'zbpWorker',        'Census ZBP',         'count',   'annual',  365, 'Actual ZIP-level business establishment count from Census ZBP (more accurate than county-apportioned CBP)', ARRAY['How many businesses are actually here?','What is the true business density?']),
  ('sig_permit_velocity',   'Permit Velocity',            'growth',          'worldModelWorker', 'Derived',            'per_1k',  'monthly', 0,   'Building permits per 1,000 residents per month. Leading indicator of 12-24mo supply and population growth', ARRAY['How fast is this area growing?','Will supply outpace demand?']),
  ('sig_job_capture_ratio', 'Job Capture Ratio',          'economic',        'worldModelWorker', 'Derived',            'ratio',   'annual',  0,   'Jobs in ZIP / residents who work. >1 = job importer (retail/food opportunity). <0.5 = bedroom community', ARRAY['Is this a commercial or residential ZIP?','What type of business benefits here?'])
ON CONFLICT (signal_name) DO NOTHING;


-- =============================================================================
-- 8. BOOTSTRAP zip_signals from existing tables
-- =============================================================================
-- Populate zip_signals with data we already have so the world model
-- has something to work with immediately after migration.
-- Workers will keep it fresh going forward.
-- =============================================================================

INSERT INTO zip_signals (zip, state, county, lat, lon,
  acs_population, acs_households, acs_median_hhi, acs_owner_occ_pct,
  acs_vacancy_pct, acs_vintage, acs_updated_at,
  cbp_dominant_sector, cbp_updated_at,
  osm_biz_count, osm_updated_at,
  last_updated_at)
SELECT
  zi.zip,
  'FL'                        AS state,
  zi.county,
  zi.lat,
  zi.lon,
  zi.population               AS acs_population,
  zi.households               AS acs_households,
  zi.median_hhi               AS acs_median_hhi,
  NULL                        AS acs_owner_occ_pct,
  NULL                        AS acs_vacancy_pct,
  '2022 5-year'               AS acs_vintage,
  zi.updated_at               AS acs_updated_at,
  zi.dominant_sector          AS cbp_dominant_sector,
  zi.updated_at               AS cbp_updated_at,
  (SELECT COUNT(*) FROM businesses b WHERE b.zip = zi.zip AND b.status = 'active') AS osm_biz_count,
  NOW()                       AS osm_updated_at,
  NOW()                       AS last_updated_at
FROM zip_intelligence zi
WHERE zi.zip IS NOT NULL
  AND zi.zip != ''
ON CONFLICT (zip) DO UPDATE SET
  county          = EXCLUDED.county,
  lat             = EXCLUDED.lat,
  lon             = EXCLUDED.lon,
  acs_population  = COALESCE(EXCLUDED.acs_population, zip_signals.acs_population),
  acs_households  = COALESCE(EXCLUDED.acs_households, zip_signals.acs_households),
  acs_median_hhi  = COALESCE(EXCLUDED.acs_median_hhi, zip_signals.acs_median_hhi),
  acs_vintage     = COALESCE(EXCLUDED.acs_vintage, zip_signals.acs_vintage),
  osm_biz_count   = COALESCE(EXCLUDED.osm_biz_count, zip_signals.osm_biz_count),
  last_updated_at = NOW();
