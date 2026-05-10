-- Migration 018: FRED + BEA county-level economic signals
-- Both are county-level, denormalized to ZIP (same ZIP in same county gets same value)
-- FRED: Bureau of Labor Statistics LAUS county unemployment (via FRED API)
-- BEA: Bureau of Economic Analysis Regional CAINC1 per capita personal income

ALTER TABLE zip_signals
  -- FRED / BLS LAUS (county unemployment, updated monthly)
  ADD COLUMN IF NOT EXISTS fred_unemployment_rate   numeric,        -- % unemployed, latest month
  ADD COLUMN IF NOT EXISTS fred_labor_force         integer,        -- total labor force count
  ADD COLUMN IF NOT EXISTS fred_employed            integer,        -- total employed count
  ADD COLUMN IF NOT EXISTS fred_unemployment_yoy    numeric,        -- % point change vs 12mo ago
  ADD COLUMN IF NOT EXISTS fred_vintage             text,           -- e.g. "2025-12"
  ADD COLUMN IF NOT EXISTS fred_updated_at          timestamptz,

  -- BEA Regional CAINC1 (county per capita personal income, updated annually)
  ADD COLUMN IF NOT EXISTS bea_per_capita_income    integer,        -- $ per capita personal income
  ADD COLUMN IF NOT EXISTS bea_total_income_k       integer,        -- total personal income $K
  ADD COLUMN IF NOT EXISTS bea_income_growth_1yr    numeric,        -- % YoY growth
  ADD COLUMN IF NOT EXISTS bea_income_growth_5yr    numeric,        -- % 5-yr CAGR
  ADD COLUMN IF NOT EXISTS bea_income_vs_fl_avg     numeric,        -- ratio vs FL state average (1.0 = at average)
  ADD COLUMN IF NOT EXISTS bea_vintage              text,           -- e.g. "2023"
  ADD COLUMN IF NOT EXISTS bea_updated_at           timestamptz;

-- Register signals
INSERT INTO signal_registry (signal_name, display_name, category, source_worker, source_dataset, source_url, unit, update_frequency, typical_lag_days, coverage_pct, description, questions_answered)
VALUES
  ('fred_unemployment_rate', 'Unemployment Rate', 'economic', 'fredWorker', 'BLS LAUS via FRED',
   'https://fred.stlouisfed.org', '%', 'monthly', 30, 100,
   'County-level unemployment rate from BLS Local Area Unemployment Statistics, delivered via FRED API',
   ARRAY['What is the unemployment rate here?','How tight is the local labor market?','Is this a high-unemployment area?']),

  ('bea_per_capita_income', 'Per Capita Personal Income', 'economic', 'beaWorker', 'BEA Regional CAINC1',
   'https://apps.bea.gov/regional/', '$', 'annual', 180, 100,
   'County per capita personal income from BEA Regional Economic Accounts',
   ARRAY['What is the average income in this area?','How wealthy is this county vs Florida average?','What is income growth trend?'])
ON CONFLICT DO NOTHING;
