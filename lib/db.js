'use strict';
/**
 * lib/db.js — PostgreSQL client for LocalIntel
 * Uses pg (node-postgres). Connection pool shared across all workers.
 * Env var: LOCAL_INTEL_DB_URL (set in Railway)
 */

const { Pool } = require('pg');

let _pool = null;

function getPool() {
  if (!_pool) {
    const url = process.env.LOCAL_INTEL_DB_URL;
    if (!url) throw new Error('LOCAL_INTEL_DB_URL not set in environment');
    _pool = new Pool({
      connectionString: url,
      ssl: { rejectUnauthorized: false },
      max: 2,  // low — many worker processes share the same Postgres instance
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });
    _pool.on('error', (err) => {
      console.error('[db] Pool error:', err.message);
    });
  }
  return _pool;
}

/**
 * query — run a SQL query, returns rows array
 */
async function query(sql, params = []) {
  const pool = getPool();
  const result = await pool.query(sql, params);
  return result.rows;
}

/**
 * queryOne — return first row or null
 */
async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

/**
 * isReady — true if LOCAL_INTEL_DB_URL is set
 */
function isReady() {
  return Boolean(process.env.LOCAL_INTEL_DB_URL);
}

/**
 * upsertBusiness — insert or update a business record
 * Matches on (name, zip) with trigram similarity for entity resolution.
 * Returns { business_id, created: boolean }
 */
async function upsertBusiness(biz) {
  const {
    name, zip, address, city, phone, website, hours,
    category, category_group, status = 'active',
    lat, lon, confidence_score = 0, tags = [], description,
    source_id, source_weight = 0, source_raw = null,
    registered_date, sunbiz_doc_number, sunbiz_entity_type,
    sunbiz_status, sunbiz_agent_name,
  } = biz;

  // Step 1: try exact sunbiz_doc_number match first
  if (sunbiz_doc_number) {
    const existing = await queryOne(
      'SELECT business_id FROM businesses WHERE sunbiz_doc_number = $1',
      [sunbiz_doc_number]
    );
    if (existing) {
      await query(
        `UPDATE businesses SET
          name = COALESCE($2, name),
          address = COALESCE($3, address),
          confidence_score = GREATEST(confidence_score, $4),
          last_confirmed = NOW(),
          updated_at = NOW()
         WHERE business_id = $1`,
        [existing.business_id, name, address, confidence_score]
      );
      await upsertEvidence(existing.business_id, source_id, sunbiz_doc_number, source_raw, source_weight);
      return { business_id: existing.business_id, created: false };
    }
  }

  // Step 2: fuzzy name + zip match (trigram similarity > 0.7)
  if (name && zip) {
    const fuzzy = await queryOne(
      `SELECT business_id FROM businesses
       WHERE zip = $1
         AND similarity(name, $2) > 0.7
       ORDER BY similarity(name, $2) DESC
       LIMIT 1`,
      [zip, name]
    );
    if (fuzzy) {
      // Merge — add alias, boost confidence, update source
      await query(
        `UPDATE businesses SET
          name_aliases = array_append(name_aliases, $2),
          address      = COALESCE(NULLIF($3,''), address),
          phone        = COALESCE(NULLIF($4,''), phone),
          website      = COALESCE(NULLIF($5,''), website),
          confidence_score = GREATEST(confidence_score, $6),
          sources      = array_append(sources, $7),
          last_confirmed = NOW(),
          updated_at   = NOW()
         WHERE business_id = $1`,
        [fuzzy.business_id, name, address, phone, website, confidence_score, source_id]
      );
      await upsertEvidence(fuzzy.business_id, source_id, null, source_raw, source_weight);
      return { business_id: fuzzy.business_id, created: false };
    }
  }

  // Step 3: insert new record
  const row = await queryOne(
    `INSERT INTO businesses (
      name, zip, address, city, phone, website, hours,
      category, category_group, status, lat, lon,
      confidence_score, tags, description,
      sources, primary_source, last_confirmed,
      registered_date, sunbiz_doc_number, sunbiz_entity_type,
      sunbiz_status, sunbiz_agent_name
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,
      $8,$9,$10,$11,$12,
      $13,$14,$15,
      ARRAY[$16],$16,NOW(),
      $17,$18,$19,
      $20,$21
    )
    ON CONFLICT (sunbiz_doc_number) DO UPDATE
      SET updated_at = NOW()
    RETURNING business_id`,
    [
      name, zip, address, city, phone, website, hours,
      category, category_group, status, lat, lon,
      confidence_score, tags, description,
      source_id,
      registered_date, sunbiz_doc_number, sunbiz_entity_type,
      sunbiz_status, sunbiz_agent_name,
    ]
  );

  if (row && source_id) {
    await upsertEvidence(row.business_id, source_id, sunbiz_doc_number, source_raw, source_weight);
  }

  return { business_id: row?.business_id, created: true };
}

async function upsertEvidence(business_id, source_id, source_record_id, raw_data, weight) {
  if (!source_id) return;
  await query(
    `INSERT INTO source_evidence (business_id, source_id, source_record_id, raw_data, weight, fetched_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (business_id, source_id) DO UPDATE
       SET raw_data = $4, fetched_at = NOW(), weight = $5`,
    [business_id, source_id, source_record_id, raw_data ? JSON.stringify(raw_data) : null, weight]
  );
}

module.exports = { query, queryOne, upsertBusiness, isReady, getPool };
// redeploy Fri Apr 24 04:15:30 UTC 2026
