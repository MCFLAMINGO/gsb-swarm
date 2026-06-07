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
    // Each forked worker process gets its own pool instance — Railway cap is 25 total.
    // Workers are background jobs: DB_POOL_MAX=1 (set per-process in index.js).
    // Main server (dashboard-server, localIntelAgent, MCP): DB_POOL_MAX=10 (default).
    // 18 data workers×1 + localIntelMCP×2 + dashboard×3 = 23 max, under Railway's 25-conn hard cap.
    // Main server pool: 6 connections for search/MCP/routing responsiveness.
    // Workers are forked with DB_POOL_MAX=1. Macro batch runner uses DB_POOL_MAX=1 for all 10 workers.
    // Budget: 6 (main) + ~18 persistent workers×1 + 1 batch runner = ~25, at Railway Hobby cap.
    const poolMax = parseInt(process.env.DB_POOL_MAX || '6', 10);
    _pool = new Pool({
      connectionString: url,
      ssl: { rejectUnauthorized: false },
      max: poolMax,
      idleTimeoutMillis: 10000,  // release idle connections quickly
      connectionTimeoutMillis: 8000,
      allowExitOnIdle: true,     // let process exit cleanly, closing all connections
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
    lat, lon, confidence_score = 0, tags = [], cuisine = null, description,
    source_id, source_weight = 0, source_raw = null,
    registered_date, sunbiz_doc_number, sunbiz_entity_type,
    sunbiz_status, sunbiz_agent_name,
  } = biz;

  // Step 0: normalize city from zip_intelligence — source city field is unreliable
  // Always use Census-authoritative city name for the given ZIP
  let normalizedCity = city || null;
  if (zip) {
    try {
      const ziRow = await queryOne('SELECT city_name FROM zip_intelligence WHERE zip=$1', [zip]);
      if (ziRow?.city_name) normalizedCity = ziRow.city_name;
    } catch (_) { /* non-fatal — fall through to source city */ }
  }

  // Fix description city if it contains the template pattern with wrong city
  // e.g. "Foo is a bar in Lake Buena Vista, FL 32082" → "Foo is a bar in Ponte Vedra Beach, FL 32082"
  let normalizedDescription = biz.description || null;
  if (normalizedDescription && normalizedCity && zip) {
    normalizedDescription = normalizedDescription.replace(
      /in [^,]+, FL (\d{5})/g,
      `in ${normalizedCity}, FL $1`
    );
  }

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
          sources      = CASE WHEN NOT ($7 = ANY(sources)) THEN array_append(sources, $7) ELSE sources END,
          cuisine      = COALESCE($8, cuisine),
          tags         = (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(businesses.tags, ARRAY[]::text[]) || COALESCE($9::text[], ARRAY[]::text[])))),
          last_confirmed = NOW(),
          updated_at   = NOW()
         WHERE business_id = $1`,
        [fuzzy.business_id, name, address, phone, website, confidence_score, source_id, cuisine, tags]
      );
      await upsertEvidence(fuzzy.business_id, source_id, null, source_raw, source_weight);
      return { business_id: fuzzy.business_id, created: false };
    }
  }

  // Step 3: insert new record
  // Conflict targets:
  //   - sunbiz_doc_number UNIQUE (sunbiz rows)
  //   - idx_businesses_name_zip_unique partial index (non-sunbiz rows, WHERE sunbiz_doc_number IS NULL)
  // Both merge rather than silently drop data.
  const row = await queryOne(
    `INSERT INTO businesses (
      name, zip, address, city, phone, website, hours,
      category, category_group, status, lat, lon,
      confidence_score, tags, description, cuisine,
      sources, primary_source, last_confirmed,
      registered_date, sunbiz_doc_number, sunbiz_entity_type,
      sunbiz_status, sunbiz_agent_name
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,
      $8,$9,$10,$11,$12,
      $13,$14,$15,COALESCE($16, ''),
      ARRAY[$17],$17,NOW(),
      $18,$19,$20,
      $21,$22
    )
    ON CONFLICT (lower(trim(name)), zip) WHERE sunbiz_doc_number IS NULL
    DO UPDATE SET
      address        = COALESCE(NULLIF(EXCLUDED.address,''), businesses.address),
      phone          = COALESCE(NULLIF(EXCLUDED.phone,''), businesses.phone),
      website        = COALESCE(NULLIF(EXCLUDED.website,''), businesses.website),
      confidence_score = GREATEST(businesses.confidence_score, EXCLUDED.confidence_score),
      sources        = CASE WHEN NOT (EXCLUDED.primary_source = ANY(businesses.sources))
                            THEN array_append(businesses.sources, EXCLUDED.primary_source)
                            ELSE businesses.sources END,
      last_confirmed = NOW(),
      updated_at     = NOW()
    RETURNING business_id`,
    [
      name, zip, address, normalizedCity, phone, website, hours,
      category, category_group, status, lat, lon,
      confidence_score, tags, normalizedDescription, cuisine,
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

/**
 * disconnect — gracefully end the pool and reset so the next query reconnects fresh.
 * Call this before a long sleep (hours/days) to release the connection slot back
 * to Railway's 25-connection hard cap. The pool is lazily recreated on next use.
 */
async function disconnect() {
  if (_pool) {
    try { await _pool.end(); } catch (_) {}
    _pool = null;
  }
}

module.exports = { query, queryOne, upsertBusiness, isReady, getPool, disconnect };
// redeploy Fri Apr 24 04:15:30 UTC 2026
