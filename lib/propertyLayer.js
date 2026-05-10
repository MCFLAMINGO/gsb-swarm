'use strict';
/**
 * lib/propertyLayer.js
 * Live ArcGIS parcel lookups for Duval (CO_NO=26) and St. Johns (CO_NO=65) counties.
 * Source: FloridaGIO Florida Statewide Parcel Centroid Version (FDOR Cadastral 2025)
 *   URL: https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Parcel_Centroid_Version/FeatureServer/0
 *
 * Architecture:
 *   - Cache-first: check property_parcels (30-day TTL) before hitting ArcGIS
 *   - Live fetch on cache miss: ArcGIS GET → filter supported counties → upsert to Postgres
 *   - No npm packages — uses Node built-in https module
 *   - No LLM calls — pure FDOR public data
 *   - Zero cost — Florida public records, no API key required
 *
 * Limitations:
 *   - Beds/baths NOT in FDOR NAL — fields reserved null for future CAMA enrichment
 *   - PHY_ZIPCD is numeric in ArcGIS — stored as text padded to 5 chars
 *   - CO_NO is DOR county number (NOT FIPS): Duval=26, St.Johns=65
 */

const https = require('https');
const db = require('./db');

const ARCGIS_BASE = 'https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Parcel_Centroid_Version/FeatureServer/0/query';

const ARCGIS_OUT_FIELDS = [
  'PARCEL_ID', 'OWN_NAME', 'JV', 'AV_SD', 'TV_SD', 'LND_VAL', 'LND_SQFOOT',
  'TOT_LVG_AR', 'EFF_YR_BLT', 'ACT_YR_BLT', 'NO_BULDNG', 'NO_RES_UNT',
  'PHY_ADDR1', 'PHY_ADDR2', 'PHY_CITY', 'PHY_ZIPCD', 'CO_NO', 'DOR_UC',
  'SALE_PRC1', 'SALE_YR1', 'SALE_MO1', 'SALE_PRC2', 'SALE_YR2', 'SALE_MO2',
].join(',');

// DOR county numbers for supported counties
const SUPPORTED_CO_NOS = new Set([26, 65]);

const CO_NO_NAMES = {
  26: 'duval',
  65: 'st_johns',
};

// DOR use code labels (residential + common commercial)
const DOR_UC_LABELS = {
  '001': 'Single Family Residential',
  '002': 'Mobile Home',
  '003': 'Multi-Family < 10 Units',
  '004': 'Condominium',
  '005': 'Cooperative',
  '006': 'Retirement Home',
  '007': 'Miscellaneous Residential',
  '008': 'Multi-Family 10+ Units',
  '009': 'Undefined Residential',
  '010': 'Vacant Residential',
  '011': 'Stores, 1 Story',
  '012': 'Mixed Use',
  '020': 'Airports, Marinas',
  '025': 'Offices',
  '030': 'Florist Shops',
  '040': 'Vacant Industrial',
  '069': 'Qualified Agricultural',
  '091': 'Utility',
  '099': 'Acreage Not Agriculture',
};

const CACHE_DAYS = 30;

/**
 * Fetch from ArcGIS REST — GET request using Node https
 */
function arcgisGet(whereClause, resultRecordCount = 200) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      where: whereClause,
      outFields: ARCGIS_OUT_FIELDS,
      resultRecordCount: String(resultRecordCount),
      orderByFields: 'JV DESC',
      f: 'json',
    });
    const url = `${ARCGIS_BASE}?${params.toString()}`;

    const req = https.get(url, { timeout: 20000 }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error(`ArcGIS JSON parse error: ${e.message} — raw: ${raw.slice(0, 200)}`));
        }
      });
    });

    req.on('error', (err) => reject(new Error(`ArcGIS request error: ${err.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('ArcGIS request timed out (20s)'));
    });
  });
}

/**
 * Map ArcGIS feature attributes to our DB schema
 */
function mapFeature(attr) {
  const coNo = parseInt(attr.CO_NO, 10);
  const zipNum = attr.PHY_ZIPCD ? Math.round(Number(attr.PHY_ZIPCD)) : null;

  return {
    parcel_id:   String(attr.PARCEL_ID || '').trim(),
    co_no:       coNo,
    county_name: CO_NO_NAMES[coNo] || 'unknown',
    phy_addr1:   attr.PHY_ADDR1 || null,
    phy_addr2:   attr.PHY_ADDR2 || null,
    phy_city:    attr.PHY_CITY  || null,
    phy_zipcd:   zipNum ? String(zipNum).padStart(5, '0') : null,
    own_name:    attr.OWN_NAME  || null,
    jv:          attr.JV        || null,
    av_sd:       attr.AV_SD     || null,
    tv_sd:       attr.TV_SD     || null,
    lnd_val:     attr.LND_VAL   || null,
    lnd_sqfoot:  attr.LND_SQFOOT || null,
    tot_lvg_ar:  attr.TOT_LVG_AR || null,
    eff_yr_blt:  attr.EFF_YR_BLT || null,
    act_yr_blt:  attr.ACT_YR_BLT || null,
    no_buldng:   attr.NO_BULDNG  || null,
    no_res_unt:  attr.NO_RES_UNT || null,
    dor_uc:      attr.DOR_UC     || null,
    sale_prc1:   attr.SALE_PRC1  || null,
    sale_yr1:    attr.SALE_YR1   || null,
    sale_mo1:    attr.SALE_MO1   || null,
    sale_prc2:   attr.SALE_PRC2  || null,
    sale_yr2:    attr.SALE_YR2   || null,
    sale_mo2:    attr.SALE_MO2   || null,
    beds:        null,  // not in FDOR NAL
    baths:       null,  // not in FDOR NAL
  };
}

/**
 * Format a DB row for API response
 */
function formatParcel(row) {
  const parts = [row.phy_addr1, row.phy_addr2, row.phy_city, `FL ${row.phy_zipcd}`].filter(Boolean);
  return {
    parcel_id:      row.parcel_id,
    county:         row.county_name,
    address:        parts.join(', '),
    zip:            row.phy_zipcd,
    owner:          row.own_name,
    use_code:       row.dor_uc,
    use_label:      DOR_UC_LABELS[String(row.dor_uc || '').padStart(3, '0')] || null,
    market_value:   row.jv    ? Number(row.jv)    : null,
    assessed_value: row.av_sd ? Number(row.av_sd) : null,
    taxable_value:  row.tv_sd ? Number(row.tv_sd) : null,
    land_value:     row.lnd_val   ? Number(row.lnd_val)   : null,
    land_sqft:      row.lnd_sqfoot ? Number(row.lnd_sqfoot) : null,
    living_sqft:    row.tot_lvg_ar ? Number(row.tot_lvg_ar) : null,
    year_built:     row.eff_yr_blt || row.act_yr_blt || null,
    buildings:      row.no_buldng  || null,
    units:          row.no_res_unt || null,
    beds:           null,
    baths:          null,
    last_sale: (row.sale_prc1 && row.sale_yr1) ? {
      price: Number(row.sale_prc1),
      year:  row.sale_yr1,
      month: row.sale_mo1 || null,
    } : null,
    prior_sale: (row.sale_prc2 && row.sale_yr2) ? {
      price: Number(row.sale_prc2),
      year:  row.sale_yr2,
      month: row.sale_mo2 || null,
    } : null,
    data_note: 'Beds/baths not available in FDOR public NAL data. Source: FloridaGIO FDOR Cadastral Centroids 2025.',
    cached_at: row.fetched_at,
  };
}

/**
 * Upsert a batch of parcels to Postgres (ON CONFLICT parcel_id DO UPDATE)
 */
async function upsertParcels(parcels) {
  for (const p of parcels) {
    if (!p.parcel_id) continue;
    await db.query(`
      INSERT INTO property_parcels (
        parcel_id, co_no, county_name,
        phy_addr1, phy_addr2, phy_city, phy_zipcd,
        own_name, jv, av_sd, tv_sd, lnd_val, lnd_sqfoot,
        tot_lvg_ar, eff_yr_blt, act_yr_blt, no_buldng, no_res_unt, dor_uc,
        sale_prc1, sale_yr1, sale_mo1, sale_prc2, sale_yr2, sale_mo2,
        beds, baths, fetched_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
        $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,NOW()
      )
      ON CONFLICT (parcel_id) DO UPDATE SET
        own_name   = EXCLUDED.own_name,
        jv         = EXCLUDED.jv,
        av_sd      = EXCLUDED.av_sd,
        tv_sd      = EXCLUDED.tv_sd,
        sale_prc1  = EXCLUDED.sale_prc1,
        sale_yr1   = EXCLUDED.sale_yr1,
        sale_mo1   = EXCLUDED.sale_mo1,
        fetched_at = NOW()
    `, [
      p.parcel_id, p.co_no, p.county_name,
      p.phy_addr1, p.phy_addr2, p.phy_city, p.phy_zipcd,
      p.own_name, p.jv, p.av_sd, p.tv_sd, p.lnd_val, p.lnd_sqfoot,
      p.tot_lvg_ar, p.eff_yr_blt, p.act_yr_blt, p.no_buldng, p.no_res_unt, p.dor_uc,
      p.sale_prc1, p.sale_yr1, p.sale_mo1, p.sale_prc2, p.sale_yr2, p.sale_mo2,
      p.beds, p.baths,
    ]);
  }
}

/**
 * searchByZip — cache-first parcel lookup by ZIP code
 * Only Duval (32xxx) and St. Johns (32xxx) ZIPs are supported.
 */
async function searchByZip(zip, limit = 20) {
  const zipStr = String(zip).trim().padStart(5, '0');
  const safeLimit = Math.min(parseInt(limit, 10) || 20, 100);

  // 1. Cache check
  const cached = await db.query(`
    SELECT * FROM property_parcels
    WHERE phy_zipcd = $1
      AND fetched_at > NOW() - INTERVAL '${CACHE_DAYS} days'
    ORDER BY jv DESC NULLS LAST
    LIMIT $2
  `, [zipStr, safeLimit]);

  if (cached.length > 0) {
    return { source: 'cache', total_fetched: cached.length, parcels: cached.map(formatParcel) };
  }

  // 2. Live ArcGIS fetch — PHY_ZIPCD is numeric in ArcGIS, query as integer
  const zipNum = parseInt(zipStr, 10);
  const data = await arcgisGet(`PHY_ZIPCD=${zipNum}`, Math.min(safeLimit * 5, 500));

  if (data.error) {
    throw new Error(`ArcGIS error ${data.error.code}: ${data.error.message}`);
  }

  const features = (data.features || []);
  const mapped = features
    .map(f => mapFeature(f.attributes))
    .filter(p => p.parcel_id && SUPPORTED_CO_NOS.has(p.co_no));

  if (mapped.length > 0) {
    await upsertParcels(mapped);
  }

  const result = mapped.slice(0, safeLimit);
  return { source: 'live', total_fetched: mapped.length, parcels: result.map(formatParcel) };
}

/**
 * getByParcelId — cache-first lookup by FDOR PARCEL_ID
 */
async function getByParcelId(parcelId) {
  const pid = String(parcelId).trim();

  // 1. Cache check
  const cached = await db.query(`
    SELECT * FROM property_parcels
    WHERE parcel_id = $1
      AND fetched_at > NOW() - INTERVAL '${CACHE_DAYS} days'
  `, [pid]);

  if (cached.length > 0) {
    return { source: 'cache', parcel: formatParcel(cached[0]) };
  }

  // 2. Live ArcGIS fetch — escape single quotes in parcel ID
  const safePid = pid.replace(/'/g, "''");
  const data = await arcgisGet(`PARCEL_ID='${safePid}'`, 1);

  if (data.error) {
    throw new Error(`ArcGIS error ${data.error.code}: ${data.error.message}`);
  }

  if (!data.features || data.features.length === 0) {
    return { source: 'live', parcel: null };
  }

  const mapped = mapFeature(data.features[0].attributes);

  if (!SUPPORTED_CO_NOS.has(mapped.co_no)) {
    throw new Error(`Parcel ${pid} is in unsupported county CO_NO=${mapped.co_no}. Only Duval (26) and St. Johns (65) are supported.`);
  }

  await upsertParcels([mapped]);
  return { source: 'live', parcel: formatParcel(mapped) };
}

module.exports = { searchByZip, getByParcelId };
