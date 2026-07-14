'use strict';
/**
 * lib/semanticSearch.js
 *
 * ONE search ladder upgrade — not a parallel search product.
 * Called from localIntelAgent GET /search and POST/SMS after ILIKE + tsvector miss.
 *
 * Embedder: Railway eloquent-energy (nomic-embed-text-v1) via lib/embedderClient.js
 * Storage:  businesses.embedding vector(768)  (pgvector)
 *
 * Always returns [] on failure — never throws. Caller decides ranking / meta.
 */

const { embedText } = require('./embedderClient');

/** Cosine distance upper bound (pgvector <=>). Lower = stricter. */
const DEFAULT_MAX_DISTANCE = Number(process.env.SEMANTIC_MAX_DISTANCE || 0.65);

const SELECT_COLS = `
  business_id, name, address, city, zip, phone, website,
  hours, hours_json, category, category_group, tags, description, cuisine,
  services_text, confidence_score, lat, lon, sunbiz_doc_number,
  claimed_at, wallet, menu_url, booking_url, order_form,
  notify_sms, notify_email, notification_phone, notification_email,
  pos_config->>'pos_type' AS pos_type,
  is_showcase,
  (embedding <=> $1::vector) AS semantic_distance
`;

/**
 * @param {object} opts
 * @param {string} opts.query
 * @param {string[]} opts.zips
 * @param {number} [opts.limit=20]
 * @param {number} [opts.maxDistance]
 * @param {Function} opts.dbQuery - db.query(sql, params) → rows[]
 * @returns {Promise<{ rows: object[], used: boolean }>}
 */
async function semanticBusinessSearch({
  query,
  zips,
  limit = 20,
  maxDistance = DEFAULT_MAX_DISTANCE,
  dbQuery,
}) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return { rows: [], used: false };
  }
  if (!Array.isArray(zips) || !zips.length || typeof dbQuery !== 'function') {
    return { rows: [], used: false };
  }

  const queryVector = await embedText(query.trim());
  if (!queryVector) return { rows: [], used: false };

  try {
    const rows = await dbQuery(
      `SELECT ${SELECT_COLS}
         FROM businesses
        WHERE zip = ANY($2::text[])
          AND embedding IS NOT NULL
          AND status != 'inactive'
          AND NOT ('likely_person_not_business' = ANY(COALESCE(quality_flags, ARRAY[]::text[])))
          AND (embedding <=> $1::vector) < $3
        ORDER BY semantic_distance ASC
        LIMIT $4`,
      [`[${queryVector.join(',')}]`, zips, maxDistance, limit]
    );
    const list = Array.isArray(rows) ? rows : [];
    return { rows: list, used: list.length > 0 };
  } catch (err) {
    console.error('[semanticSearch]', err.message);
    return { rows: [], used: false };
  }
}

module.exports = {
  semanticBusinessSearch,
  DEFAULT_MAX_DISTANCE,
};
