'use strict';
/**
 * lib/propertyLayer.js
 * Postgres-only parcel lookups for Duval (CO_NO=26) and St. Johns (CO_NO=65) counties.
 *
 * Data source: Pre-seeded from official County Property Appraiser bulk files
 *   Duval:     jacksonville.gov pipe-delimited TXT (March 2026, 405k parcels)
 *   St. Johns: sjcpa.us CAMAData.mdb ParcelView (171k parcels) + BldView enrichment
 *
 * Reseed: Monthly via cron — seed script in data-seed/seed_property_parcels.py
 * No live API calls, no ArcGIS, no rate limits.
 * POSTGRES IS KING.
 */

const db = require('./db');

// DOR use code labels (residential + common commercial)
const DOR_UC_LABELS = {
  '0000': 'Vacant Land',
  '0001': 'Single Family Residential',
  '0002': 'Mobile Home',
  '0003': 'Multi-Family < 10 Units',
  '0004': 'Condominium',
  '0005': 'Cooperative',
  '0006': 'Retirement Home',
  '0007': 'Miscellaneous Residential',
  '0008': 'Multi-Family 10+ Units',
  '0009': 'Undefined Residential',
  '0010': 'Vacant Residential',
  '0011': 'Stores, 1 Story',
  '0012': 'Mixed Use',
  '0020': 'Airports, Marinas',
  '0025': 'Offices',
  '0030': 'Florist Shops',
  '0040': 'Vacant Industrial',
  '0069': 'Qualified Agricultural',
  '0091': 'Utility',
  '0099': 'Acreage / Unclassified',
  '0100': 'Single Family Residential',
  '0200': 'Mobile Home',
  '0400': 'Condominium',
  '0800': 'Multi-Family 10+ Units',
  '0900': 'Undefined Residential',
  '1000': 'Vacant Commercial',
};

function dorLabel(code) {
  if (!code) return null;
  const s = String(code).trim();
  return DOR_UC_LABELS[s] || DOR_UC_LABELS[s.padStart(4, '0')] || null;
}

/**
 * Format a DB row for API response
 */
function formatParcel(row) {
  const addrParts = [row.phy_addr1, row.phy_city, row.phy_zipcd ? `FL ${row.phy_zipcd}` : null].filter(Boolean);
  return {
    parcel_id:      row.parcel_id,
    county:         row.county_name,
    address:        addrParts.join(', ') || null,
    zip:            row.phy_zipcd,
    owner:          row.own_name,
    use_code:       row.dor_uc,
    use_label:      dorLabel(row.dor_uc),
    market_value:   row.jv     ? Number(row.jv)     : null,
    assessed_value: row.av_sd  ? Number(row.av_sd)  : null,
    taxable_value:  row.tv_sd  ? Number(row.tv_sd)  : null,
    land_value:     row.lnd_val    ? Number(row.lnd_val)    : null,
    land_sqft:      row.lnd_sqfoot ? Number(row.lnd_sqfoot) : null,
    living_sqft:    row.tot_lvg_ar ? Number(row.tot_lvg_ar) : null,
    year_built_eff: row.eff_yr_blt || null,
    year_built_act: row.act_yr_blt || null,
    buildings:      row.no_buldng  ? Number(row.no_buldng)  : null,
    units:          row.no_res_unt ? Number(row.no_res_unt) : null,
    beds:           row.beds  ? Number(row.beds)  : null,
    baths:          row.baths ? Number(row.baths) : null,
    last_sale: (row.sale_prc1 && row.sale_yr1) ? {
      price: Number(row.sale_prc1),
      year:  Number(row.sale_yr1),
      month: row.sale_mo1 ? Number(row.sale_mo1) : null,
    } : null,
    cached_at: row.fetched_at,
    source: 'LocalIntel Property Layer — Duval/St.Johns County PA Bulk Data 2026',
  };
}

/**
 * searchByZip — parcel lookup by ZIP code
 * Supported: Duval (32xxx) and St. Johns ZIPs only
 */
async function searchByZip(zip, options = {}) {
  const zipStr = String(zip || '').trim().padStart(5, '0');
  const limit  = Math.min(parseInt(options.limit, 10) || 20, 100);
  const sortBy = options.sort_by || 'jv_desc';  // jv_desc | sqft_desc | year_desc

  let orderBy;
  if (sortBy === 'sqft_desc')  orderBy = 'tot_lvg_ar DESC NULLS LAST';
  else if (sortBy === 'year_desc') orderBy = 'act_yr_blt DESC NULLS LAST';
  else                          orderBy = 'jv DESC NULLS LAST';

  // Optional filters
  const filters = ['phy_zipcd = $1'];
  const params  = [zipStr];
  let idx = 2;

  if (options.min_sqft) {
    filters.push(`tot_lvg_ar >= $${idx++}`);
    params.push(Number(options.min_sqft));
  }
  if (options.max_sqft) {
    filters.push(`tot_lvg_ar <= $${idx++}`);
    params.push(Number(options.max_sqft));
  }
  if (options.min_beds) {
    filters.push(`beds >= $${idx++}`);
    params.push(Number(options.min_beds));
  }
  if (options.dor_uc) {
    filters.push(`dor_uc = $${idx++}`);
    params.push(String(options.dor_uc));
  }

  params.push(limit);
  const where = filters.join(' AND ');

  const rows = await db.query(`
    SELECT * FROM property_parcels
    WHERE ${where}
    ORDER BY ${orderBy}
    LIMIT $${idx}
  `, params);

  const total = await db.query(`
    SELECT COUNT(*) AS cnt FROM property_parcels WHERE ${where.replace(`LIMIT $${idx}`, '')}
  `, params.slice(0, -1));

  return {
    zip:     zipStr,
    total:   Number(total[0].cnt),
    count:   rows.length,
    parcels: rows.map(formatParcel),
  };
}

/**
 * getByParcelId — lookup by FDOR PARCEL_ID (exact match)
 */
async function getByParcelId(parcelId) {
  const pid = String(parcelId || '').trim();
  if (!pid) throw new Error('parcel_id is required');

  const rows = await db.query(
    'SELECT * FROM property_parcels WHERE parcel_id = $1',
    [pid]
  );

  if (rows.length === 0) {
    return { parcel: null, not_found: true };
  }
  return { parcel: formatParcel(rows[0]) };
}

/**
 * searchByAddress — fuzzy address search (ILIKE)
 */
async function searchByAddress(address, limit = 10) {
  const q = `%${String(address || '').trim().replace(/\s+/g, '%')}%`;
  const safeLimit = Math.min(parseInt(limit, 10) || 10, 50);

  const rows = await db.query(`
    SELECT * FROM property_parcels
    WHERE phy_addr1 ILIKE $1
    ORDER BY jv DESC NULLS LAST
    LIMIT $2
  `, [q, safeLimit]);

  return { count: rows.length, parcels: rows.map(formatParcel) };
}

/**
 * stats — quick aggregate stats for a county or ZIP
 */
async function stats(filter = {}) {
  const conditions = [];
  const params = [];
  let idx = 1;

  if (filter.county) {
    conditions.push(`county_name = $${idx++}`);
    params.push(filter.county);
  }
  if (filter.zip) {
    conditions.push(`phy_zipcd = $${idx++}`);
    params.push(String(filter.zip).padStart(5, '0'));
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [row] = await db.query(`
    SELECT
      COUNT(*)                                AS total_parcels,
      COUNT(CASE WHEN beds IS NOT NULL THEN 1 END) AS with_beds,
      ROUND(AVG(jv)::numeric, 0)             AS avg_market_value,
      ROUND(AVG(tot_lvg_ar)::numeric, 0)     AS avg_living_sqft,
      ROUND(AVG(beds)::numeric, 2)           AS avg_beds,
      ROUND(AVG(baths)::numeric, 2)          AS avg_baths,
      MIN(phy_zipcd)                         AS zip_min,
      MAX(phy_zipcd)                         AS zip_max,
      MAX(fetched_at)                        AS last_seeded
    FROM property_parcels ${where}
  `, params);

  return {
    filter,
    total_parcels:    Number(row.total_parcels),
    with_beds:        Number(row.with_beds),
    avg_market_value: row.avg_market_value ? Number(row.avg_market_value) : null,
    avg_living_sqft:  row.avg_living_sqft  ? Number(row.avg_living_sqft)  : null,
    avg_beds:         row.avg_beds  ? Number(row.avg_beds)  : null,
    avg_baths:        row.avg_baths ? Number(row.avg_baths) : null,
    last_seeded:      row.last_seeded,
  };
}

module.exports = { searchByZip, getByParcelId, searchByAddress, stats };
