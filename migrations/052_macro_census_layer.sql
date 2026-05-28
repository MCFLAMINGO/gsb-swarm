-- Migration 052: macro census layer
-- Source: censusMacroWorker.js
-- Datasets: BFS (Business Formation Statistics), NES (Nonemployer Statistics),
--           Economic Census 2022 (ecnbasic)
--
-- TWO storage patterns:
--   1. macro_indicators — state/county-level time-series (BFS monthly, NES annual)
--   2. zip_signals columns — ZIP-level signals derived from NES + EconCensus (annual)
--
-- Why this matters:
--   - BFS tracks new business application velocity by county → leading indicator for gap analysis
--   - NES reveals solo/gig operator density at ZIP level → true economic activity often invisible to CBP
--   - EconCensus 2022 gives most granular revenue/payroll by ZIP+NAICS ever available (5-yr vintage)
--   - All feed world model, JEPA prediction layer, and oracle scoring

-- ── Table 1: macro_indicators ─────────────────────────────────────────────────
-- Stores time-series macro data that is NOT ZIP-level (state/county/national)
-- Keyed by (source, geo_id, period) — upsert-safe
CREATE TABLE IF NOT EXISTS macro_indicators (
  id            BIGSERIAL PRIMARY KEY,
  source        TEXT NOT NULL,          -- 'bfs' | 'nes_county' | 'bps_national' | 'retail_national'
  geo_type      TEXT NOT NULL,          -- 'state' | 'county' | 'national'
  geo_id        TEXT NOT NULL,          -- state FIPS, county FIPS, or 'US'
  geo_name      TEXT,                   -- human-readable (e.g. 'Duval County, FL')
  period        TEXT NOT NULL,          -- 'YYYY-MM' for monthly, 'YYYY' for annual
  metrics       JSONB NOT NULL,         -- all metrics for this source/geo/period
  vintage       TEXT,                   -- data vintage label
  fetched_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (source, geo_id, period)
);

CREATE INDEX IF NOT EXISTS idx_macro_indicators_source  ON macro_indicators(source);
CREATE INDEX IF NOT EXISTS idx_macro_indicators_geo     ON macro_indicators(geo_id);
CREATE INDEX IF NOT EXISTS idx_macro_indicators_period  ON macro_indicators(period DESC);

-- ── Table 2: zip_macro_signals ────────────────────────────────────────────────
-- ZIP-level signals from NES + Economic Census — one row per ZIP
-- Separate from zip_signals to keep that table focused on real-time worker outputs
-- Oracle + JEPA join this table by ZIP
CREATE TABLE IF NOT EXISTS zip_macro_signals (
  zip                         TEXT PRIMARY KEY,

  -- Nonemployer Statistics (NES) — solo/gig operators, annual
  nes_total_firms             INT,          -- total nonemployer firms in ZIP
  nes_total_receipts_k        INT,          -- total receipts ($000s)
  nes_receipts_per_firm       INT,          -- avg receipts per firm ($)
  nes_food_firms              INT,          -- NAICS 72 (food/accommodation)
  nes_retail_firms            INT,          -- NAICS 44-45
  nes_health_firms            INT,          -- NAICS 62
  nes_prof_firms              INT,          -- NAICS 54 (professional/tech)
  nes_construction_firms      INT,          -- NAICS 23
  nes_vintage                 TEXT,         -- e.g. '2021'
  nes_updated_at              TIMESTAMPTZ,

  -- Economic Census 2022 (ecnbasic) — employer businesses, 5-year vintage
  ecn_total_estab             INT,          -- total employer establishments
  ecn_total_sales_k           INT,          -- total sales/receipts ($000s)
  ecn_total_payroll_k         INT,          -- total annual payroll ($000s)
  ecn_total_employees         INT,          -- total paid employees
  ecn_avg_employees_per_firm  NUMERIC(6,1), -- scale indicator
  ecn_sales_per_employee      INT,          -- productivity proxy ($)
  ecn_sector_json             JSONB,        -- {naics2: {estab, sales_k, payroll_k, emp}} full breakdown
  ecn_vintage                 TEXT,         -- '2022'
  ecn_updated_at              TIMESTAMPTZ,

  -- BFS county-level (denormalized to ZIP for oracle access)
  bfs_county_apps_total       INT,          -- total business applications this county, latest month
  bfs_county_apps_highprop    INT,          -- high-propensity apps (likely to hire)
  bfs_county_wba              INT,          -- will-be-employer applications
  bfs_county_period           TEXT,         -- 'YYYY-MM' of latest data
  bfs_updated_at              TIMESTAMPTZ,

  updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zip_macro_signals_zip ON zip_macro_signals(zip);

-- ── zip_signals: add cross-reference columns ──────────────────────────────────
-- Lightweight summary cols so oracle/JEPA don't need a JOIN for common signals
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS macro_nes_total_firms     INT;         -- mirrors zip_macro_signals.nes_total_firms
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS macro_ecn_total_sales_k   INT;         -- mirrors zip_macro_signals.ecn_total_sales_k
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS macro_bfs_apps_latest     INT;         -- county BFS apps latest month
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS macro_updated_at          TIMESTAMPTZ;
