-- Migration 020: BLS QCEW (Quarterly Census of Employment and Wages) signals
-- County-level establishments, employment, avg weekly wages, YoY growth
-- Source: BLS Public Data API  ENU{FIPS5}10010/10540/10410
-- Grain: county → fan-out to all ZIPs in county (same pattern as FRED/BEA)

ALTER TABLE zip_signals
  ADD COLUMN IF NOT EXISTS qcew_establishments      integer,    -- total private establishments in county
  ADD COLUMN IF NOT EXISTS qcew_employment          integer,    -- total private employment (all workers)
  ADD COLUMN IF NOT EXISTS qcew_avg_weekly_wages    integer,    -- average weekly wages ($)
  ADD COLUMN IF NOT EXISTS qcew_emp_yoy_pct         numeric,    -- YoY employment change (%)
  ADD COLUMN IF NOT EXISTS qcew_wage_yoy_pct        numeric,    -- YoY avg weekly wage change (%)
  ADD COLUMN IF NOT EXISTS qcew_vintage             text,       -- e.g. "2025-Q3"
  ADD COLUMN IF NOT EXISTS qcew_updated_at          timestamptz;

-- Register signals in signal_registry
INSERT INTO signal_registry (signal_name, display_name, category, source_worker, source_dataset, source_url, unit, update_frequency, typical_lag_days, coverage_pct, description, questions_answered)
VALUES
  ('qcew_employment', 'QCEW Employment (BLS)', 'economic', 'qcewWorker', 'BLS QCEW Public Data API',
   'https://api.bls.gov/publicAPI/v2/timeseries/data/', 'count', 'quarterly', 180, 100,
   'Total private-sector employment from BLS Quarterly Census of Employment and Wages, county-level denormalized to ZIP. ~6mo lag from current quarter.',
   ARRAY['How many people are employed in this county?','Are jobs growing or contracting YoY?','What is the typical weekly wage?','How do wages compare YoY?','What is the establishment count trend?']),

  ('qcew_avg_weekly_wages', 'QCEW Avg Weekly Wages (BLS)', 'economic', 'qcewWorker', 'BLS QCEW Public Data API',
   'https://api.bls.gov/publicAPI/v2/timeseries/data/', 'dollars', 'quarterly', 180, 100,
   'Average weekly wages per worker from BLS QCEW, county-level. Fastest available wage series (monthly FRED LAUS has no wage data; QWI monthly earnings are a supplement).',
   ARRAY['What is the average weekly wage here?','Are wages rising faster than FL average?','What is the annualized wage growth rate?'])
ON CONFLICT DO NOTHING;
