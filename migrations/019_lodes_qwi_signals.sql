-- Migration 019: LEHD LODES + QWI workforce signals
-- LODES: ZIP-level job counts from WAC (workplace) + RAC (residence) bulk CSV files
-- QWI: county-level employment/earnings/turnover from Census QWI API

ALTER TABLE zip_signals
  -- LODES WAC (Workplace Area Characteristics — jobs located IN this ZIP)
  ADD COLUMN IF NOT EXISTS lodes_jobs_here          integer,   -- total jobs with workplace here
  ADD COLUMN IF NOT EXISTS lodes_retail_jobs        integer,   -- CNS07: retail trade jobs
  ADD COLUMN IF NOT EXISTS lodes_food_jobs          integer,   -- CNS12: accommodation & food service jobs
  ADD COLUMN IF NOT EXISTS lodes_healthcare_jobs    integer,   -- CNS18: healthcare & social assistance
  ADD COLUMN IF NOT EXISTS lodes_tech_jobs          integer,   -- CNS10: information sector
  ADD COLUMN IF NOT EXISTS lodes_high_earn_pct      numeric,   -- % jobs >$3333/mo (CE03/C000)
  ADD COLUMN IF NOT EXISTS lodes_low_earn_pct       numeric,   -- % jobs <$1250/mo (CE01/C000)

  -- LODES RAC (Residence Area Characteristics — workers living IN this ZIP)
  ADD COLUMN IF NOT EXISTS lodes_workers_live_here  integer,   -- total workers living here
  ADD COLUMN IF NOT EXISTS lodes_live_retail        integer,   -- retail workers living here
  ADD COLUMN IF NOT EXISTS lodes_live_food          integer,   -- food/hospitality workers living here
  ADD COLUMN IF NOT EXISTS lodes_live_healthcare    integer,   -- healthcare workers living here
  ADD COLUMN IF NOT EXISTS lodes_net_flow           integer,   -- jobs_here minus workers_live_here (+ = job importer, - = bedroom community)
  ADD COLUMN IF NOT EXISTS lodes_vintage            text,      -- e.g. "2022"
  ADD COLUMN IF NOT EXISTS lodes_updated_at         timestamptz,

  -- QWI (Quarterly Workforce Indicators — county level, denormalized to ZIP)
  ADD COLUMN IF NOT EXISTS qwi_employment           integer,   -- beginning-of-quarter employment count
  ADD COLUMN IF NOT EXISTS qwi_avg_monthly_earn     integer,   -- average monthly earnings ($)
  ADD COLUMN IF NOT EXISTS qwi_hires_qtr            integer,   -- all hires in quarter
  ADD COLUMN IF NOT EXISTS qwi_seps_qtr             integer,   -- all separations in quarter
  ADD COLUMN IF NOT EXISTS qwi_turnover_rate        numeric,   -- (hires + seps) / (2 * emp) — annualized indicator
  ADD COLUMN IF NOT EXISTS qwi_vintage              text,      -- e.g. "2023-Q3"
  ADD COLUMN IF NOT EXISTS qwi_updated_at           timestamptz;

-- Register signals
INSERT INTO signal_registry (signal_name, display_name, category, source_worker, source_dataset, source_url, unit, update_frequency, typical_lag_days, coverage_pct, description, questions_answered)
VALUES
  ('lodes_jobs_here', 'Jobs Located Here (LODES WAC)', 'economic', 'lodesWorker', 'LEHD LODES8 WAC',
   'https://lehd.ces.census.gov/data/lodes/', 'count', 'annual', 270, 100,
   'Total jobs with workplace in this ZIP from LODES Workplace Area Characteristics (Census block aggregation)',
   ARRAY['How many jobs are in this ZIP?','What is the job density?','What sectors employ the most people here?','What % of workers earn above $3333/mo?']),

  ('qwi_employment', 'Employment Count (QWI)', 'economic', 'qwiWorker', 'Census QWI API',
   'https://api.census.gov/data/timeseries/qwi/', 'count', 'quarterly', 90, 100,
   'Beginning-of-quarter employment from Census Quarterly Workforce Indicators, county-level denormalized to ZIP',
   ARRAY['How many people work in this county?','Is employment growing or shrinking?','What is the average wage here?','What is worker turnover like?'])
ON CONFLICT DO NOTHING;
