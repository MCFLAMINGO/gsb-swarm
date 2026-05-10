-- Migration 021: CES (State & Metro Employment) + AI Investment signals
-- CES: BLS Current Employment Statistics by supersector, MSA-level → fan-out to ZIPs
-- AI Exposure: sector-level automation risk score computed from CES sector mix
-- Investment Score: composite labor market opportunity score

ALTER TABLE zip_signals
  -- ── CES: Current Employment Statistics (BLS SM series, monthly) ──────────────
  ADD COLUMN IF NOT EXISTS ces_msa_code              text,       -- CBSA MSA code (e.g. "27260" = Jacksonville)
  ADD COLUMN IF NOT EXISTS ces_msa_name              text,       -- Human-readable MSA name
  ADD COLUMN IF NOT EXISTS ces_total_nonfarm         numeric,    -- Total nonfarm employment (thousands)
  ADD COLUMN IF NOT EXISTS ces_total_mom_pct         numeric,    -- Total nonfarm MoM % change
  ADD COLUMN IF NOT EXISTS ces_total_yoy_pct         numeric,    -- Total nonfarm YoY % change
  ADD COLUMN IF NOT EXISTS ces_healthcare_emp        numeric,    -- Education & Health Services (supersector 65, thousands)
  ADD COLUMN IF NOT EXISTS ces_healthcare_yoy_pct    numeric,    -- Healthcare YoY %
  ADD COLUMN IF NOT EXISTS ces_professional_emp      numeric,    -- Professional & Business Services (supersector 60, thousands)
  ADD COLUMN IF NOT EXISTS ces_professional_yoy_pct  numeric,    -- Professional YoY %
  ADD COLUMN IF NOT EXISTS ces_leisure_emp           numeric,    -- Leisure & Hospitality (supersector 70, thousands)
  ADD COLUMN IF NOT EXISTS ces_leisure_yoy_pct       numeric,    -- Leisure YoY %
  ADD COLUMN IF NOT EXISTS ces_construction_emp      numeric,    -- Construction (supersector 20, thousands)
  ADD COLUMN IF NOT EXISTS ces_construction_yoy_pct  numeric,    -- Construction YoY %
  ADD COLUMN IF NOT EXISTS ces_retail_emp            numeric,    -- Retail Trade (supersector 42, thousands)
  ADD COLUMN IF NOT EXISTS ces_retail_yoy_pct        numeric,    -- Retail YoY %
  ADD COLUMN IF NOT EXISTS ces_financial_emp         numeric,    -- Financial Activities (supersector 55, thousands)
  ADD COLUMN IF NOT EXISTS ces_financial_yoy_pct     numeric,    -- Financial YoY %
  ADD COLUMN IF NOT EXISTS ces_government_emp        numeric,    -- Government (supersector 90, thousands)
  ADD COLUMN IF NOT EXISTS ces_government_yoy_pct    numeric,    -- Government YoY %
  ADD COLUMN IF NOT EXISTS ces_dominant_sector       text,       -- Sector with highest YoY growth
  ADD COLUMN IF NOT EXISTS ces_vintage               text,       -- e.g. "2025-12" (YYYY-MM)
  ADD COLUMN IF NOT EXISTS ces_updated_at            timestamptz,

  -- ── AI Investment scores (derived from CES sector mix) ───────────────────────
  ADD COLUMN IF NOT EXISTS ai_displacement_risk      numeric,    -- 0–100: % of MSA employment in high-AI-exposure sectors
  ADD COLUMN IF NOT EXISTS investment_opportunity_score numeric,  -- 0–100: composite labor market attractiveness
  ADD COLUMN IF NOT EXISTS investment_tier           text,       -- A/B/C/D classification
  ADD COLUMN IF NOT EXISTS labor_market_momentum     numeric,    -- weighted avg YoY employment growth across sectors
  ADD COLUMN IF NOT EXISTS dominant_growth_sector    text,       -- sector with strongest YoY growth
  ADD COLUMN IF NOT EXISTS ai_scores_updated_at      timestamptz;

-- Register CES signals
INSERT INTO signal_registry (signal_name, display_name, category, source_worker, source_dataset, source_url, unit, update_frequency, typical_lag_days, coverage_pct, description, questions_answered)
VALUES
  ('ces_total_nonfarm', 'Total Nonfarm Employment (CES)', 'economic', 'cesWorker', 'BLS Current Employment Statistics',
   'https://www.bls.gov/ces/', 'thousands', 'monthly', 30, 85,
   'Total nonfarm employment from BLS State & Metro CES program (SMU series), MSA-level denormalized to ZIP. Covers 21 FL MSAs.',
   ARRAY['How many people are employed in this metro?','Is total employment growing month-over-month?','How does this market compare to FL average employment growth?']),

  ('ces_healthcare_emp', 'Healthcare & Education Employment (CES)', 'economic', 'cesWorker', 'BLS Current Employment Statistics',
   'https://www.bls.gov/ces/', 'thousands', 'monthly', 30, 85,
   'Education & Health Services supersector employment from BLS CES, MSA-level. Supersector 65. Key growth indicator for recession-resistant markets.',
   ARRAY['Is healthcare hiring in this market?','What share of employment is in education/health?','Is this a healthcare-heavy economy?']),

  ('ai_displacement_risk', 'AI Displacement Risk Score', 'derived', 'cesWorker', 'Derived from CES sector mix',
   'https://www.bls.gov/ces/', 'score_0_100', 'monthly', 30, 85,
   'Sector-weighted AI automation exposure score. High score = large share of employment in high-AI-exposure sectors (retail, financial, professional). Low = construction, healthcare, government (harder to automate at scale).',
   ARRAY['How exposed is this labor market to AI automation?','What % of workers are in automatable jobs?','Is this a resilient or vulnerable labor market for AI disruption?','Where should investors look for AI-resilient workforce?']),

  ('investment_opportunity_score', 'Investment Opportunity Score', 'derived', 'cesWorker', 'Derived: CES + QCEW + FRED',
   'https://www.bls.gov/ces/', 'score_0_100', 'monthly', 30, 85,
   'Composite labor market investment attractiveness. Weights: healthcare growth (high), wage growth (high), total employment momentum, low AI displacement risk, low unemployment. A=80+, B=60-79, C=40-59, D=<40.',
   ARRAY['Is this a good market to open a business?','Is this labor market growing or declining?','Where should I invest in FL right now?','Which ZIP codes have the best labor market conditions?','What is the investment grade of this market?'])
ON CONFLICT DO NOTHING;
