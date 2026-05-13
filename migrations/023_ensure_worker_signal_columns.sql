-- Migration 023: Ensure all worker signal columns exist in zip_signals
-- Belt-and-suspenders: adds every column from migrations 018-022 with IF NOT EXISTS.
-- Safe to re-run. Fixes cases where earlier migrations were silently skipped due to
-- the migrations_log rows.rows bug (now fixed in dbMigrate.js).

-- ── FRED / BLS LAUS (county unemployment) ─────────────────────────────────────
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS fred_unemployment_rate   numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS fred_labor_force         integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS fred_employed            integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS fred_unemployment_yoy    numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS fred_vintage             text;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS fred_updated_at          timestamptz;

-- ── BEA Regional CAINC1 (per capita personal income) ──────────────────────────
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS bea_per_capita_income    integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS bea_total_income_k       integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS bea_income_growth_1yr    numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS bea_income_growth_5yr    numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS bea_income_vs_fl_avg     numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS bea_vintage              text;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS bea_updated_at           timestamptz;

-- ── LEHD LODES8 WAC (jobs located in ZIP) ─────────────────────────────────────
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS lodes_jobs_here          integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS lodes_retail_jobs        integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS lodes_food_jobs          integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS lodes_healthcare_jobs    integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS lodes_tech_jobs          integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS lodes_high_earn_pct      numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS lodes_low_earn_pct       numeric;

-- ── LEHD LODES8 RAC (workers living in ZIP) ───────────────────────────────────
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS lodes_workers_live_here  integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS lodes_live_retail        integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS lodes_live_food          integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS lodes_live_healthcare    integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS lodes_net_flow           integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS lodes_vintage            text;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS lodes_updated_at         timestamptz;

-- ── Census QWI (quarterly workforce indicators) ───────────────────────────────
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS qwi_employment           integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS qwi_avg_monthly_earn     integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS qwi_hires_qtr            integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS qwi_seps_qtr             integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS qwi_turnover_rate        numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS qwi_vintage              text;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS qwi_updated_at           timestamptz;

-- ── BLS QCEW (quarterly census of employment and wages) ───────────────────────
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS qcew_employment          integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS qcew_avg_weekly_wages    integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS qcew_establishments      integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS qcew_emp_yoy_pct         numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS qcew_wage_yoy_pct        numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS qcew_vintage             text;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS qcew_updated_at          timestamptz;

-- ── BLS CES sector employment ──────────────────────────────────────────────────
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS ces_msa_name             text;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS ces_total_nonfarm        integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS ces_total_yoy_pct        numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS ces_healthcare_emp       integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS ces_healthcare_yoy_pct   numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS ces_professional_emp     integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS ces_professional_yoy_pct numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS ces_leisure_emp          integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS ces_leisure_yoy_pct      numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS ces_construction_emp     integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS ces_construction_yoy_pct numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS ces_retail_emp           integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS ces_retail_yoy_pct       numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS ces_dominant_sector      text;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS ces_vintage              text;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS ces_updated_at           timestamptz;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS ai_displacement_risk     numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS investment_opportunity_score numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS investment_tier          text;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS dominant_growth_sector   text;

-- ── IRS SOI income ─────────────────────────────────────────────────────────────
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS irs_agi_median           integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS irs_returns              integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS irs_wage_share           numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS irs_vintage              text;

-- ── IRS Migration ──────────────────────────────────────────────────────────────
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS irs_mig_net_returns      integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS irs_mig_net_agi          numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS irs_mig_in_returns       integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS irs_mig_out_returns      integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS irs_mig_top_origin       text;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS irs_mig_top_dest         text;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS irs_mig_vintage          text;

-- ── ACS demographics ───────────────────────────────────────────────────────────
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS acs_population           integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS acs_households           integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS acs_median_hhi           integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS acs_median_age           numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS acs_owner_occ_pct        numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS acs_college_pct          numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS acs_poverty_pct          numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS acs_vacancy_pct          numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS acs_commute_time_min     numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS acs_vintage              text;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS acs_updated_at           timestamptz;

-- ── FCC Broadband ──────────────────────────────────────────────────────────────
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS fcc_has_25_3             boolean;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS fcc_has_100_20           boolean;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS fcc_has_gigabit          boolean;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS fcc_fiber_available      boolean;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS fcc_providers_cnt        integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS fcc_pct_25_3             numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS fcc_pct_100_20           numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS fcc_provider_count       integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS fcc_bead_unserved_pct    numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS fcc_vintage              text;

-- ── BPS Construction permits ───────────────────────────────────────────────────
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS bps_total_units_annual   integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS bps_res_1unit_annual     integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS bps_res_multifam_annual  integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS bps_total_units_mo       integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS bps_period_mo            text;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS bps_vintage              text;

-- ── World model / composite scores ────────────────────────────────────────────
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS sig_growth_score         numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS sig_opportunity_score    numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS sig_risk_score           numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS sig_market_maturity      text;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS sig_income_tier          text;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS sig_peer_cohort          text;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS sig_biz_density_per_1k   numeric;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS sig_job_capture_ratio    numeric;

-- ── ZBP / CBP business counts ──────────────────────────────────────────────────
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS zbp_total_establishments integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS cbp_dominant_sector      text;

-- ── SunBiz entity counts ───────────────────────────────────────────────────────
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS sunbiz_active_entities   integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS sunbiz_new_12mo          integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS sunbiz_net_12mo          integer;

-- ── OSM business counts ────────────────────────────────────────────────────────
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS osm_biz_count            integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS osm_food_count           integer;
ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS osm_with_phone_pct       numeric;
