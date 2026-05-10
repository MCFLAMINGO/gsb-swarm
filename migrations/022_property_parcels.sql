-- Migration 022: property_parcels table
-- Florida FDOR NAL parcel data for Duval (CO_NO=26) and St. Johns (CO_NO=65) counties.
-- Source: FloridaGIO Florida Statewide Parcel Centroid Version (FDOR Cadastral 2025)
-- Beds/baths intentionally null — not available in FDOR NAL (CAMA-only fields)

CREATE TABLE IF NOT EXISTS property_parcels (
  parcel_id        TEXT PRIMARY KEY,
  co_no            INTEGER NOT NULL,        -- DOR county number: 26=Duval, 65=St.Johns
  county_name      TEXT NOT NULL,           -- 'duval' | 'st_johns'
  phy_addr1        TEXT,
  phy_addr2        TEXT,
  phy_city         TEXT,
  phy_zipcd        TEXT,                    -- stored as zero-padded text (e.g. '32082')
  own_name         TEXT,
  jv               NUMERIC,                 -- just value / market value
  av_sd            NUMERIC,                 -- assessed value (school district)
  tv_sd            NUMERIC,                 -- taxable value (school district)
  lnd_val          NUMERIC,                 -- land value
  lnd_sqfoot       NUMERIC,                 -- land square footage
  tot_lvg_ar       NUMERIC,                 -- total living area sq ft
  eff_yr_blt       INTEGER,                 -- effective year built
  act_yr_blt       INTEGER,                 -- actual year built
  no_buldng        INTEGER,                 -- number of buildings
  no_res_unt       INTEGER,                 -- number of residential units
  dor_uc           TEXT,                    -- DOR use code (001=SFR, 004=Condo, etc)
  sale_prc1        NUMERIC,                 -- most recent sale price
  sale_yr1         INTEGER,                 -- most recent sale year
  sale_mo1         INTEGER,                 -- most recent sale month
  sale_prc2        NUMERIC,                 -- prior sale price
  sale_yr2         INTEGER,                 -- prior sale year
  sale_mo2         INTEGER,                 -- prior sale month
  beds             INTEGER DEFAULT NULL,    -- NOT in FDOR NAL — reserved for future CAMA enrichment
  baths            NUMERIC DEFAULT NULL,    -- NOT in FDOR NAL — reserved for future CAMA enrichment
  fetched_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT property_parcels_county_check CHECK (co_no IN (26, 65))
);

CREATE INDEX IF NOT EXISTS idx_property_parcels_zipcd   ON property_parcels(phy_zipcd);
CREATE INDEX IF NOT EXISTS idx_property_parcels_co_no   ON property_parcels(co_no);
CREATE INDEX IF NOT EXISTS idx_property_parcels_fetched ON property_parcels(fetched_at);
CREATE INDEX IF NOT EXISTS idx_property_parcels_jv      ON property_parcels(jv DESC NULLS LAST);
