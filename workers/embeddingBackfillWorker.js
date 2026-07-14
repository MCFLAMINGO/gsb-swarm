'use strict';
/**
 * embeddingBackfillWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Selective pgvector backfill for businesses that matter to search demos:
 *   claimed · showcase · wallet · rich description · NE-FL seed ZIPs
 *
 * Does NOT embed the entire statewide Sunbiz dump (that blew a 1.2GB unused index).
 *
 * Contract:
 *   START → resolve embedder URL → count pending selective rows
 *   WORK  → batches of 50, skip already-embedded (unless FULL_REFRESH=true)
 *   END   → CREATE INDEX IF NOT EXISTS on rows with embedding (lists = sqrt(n))
 *
 * Fire-and-forget on startup. Never blocks server boot.
 */

const db = require('../lib/db');
const { embedBatch, isEmbedderConfigured, getEmbedderUrl } = require('../lib/embedderClient');

const BATCH_SIZE   = 50;
const FULL_REFRESH = process.env.FULL_REFRESH === 'true';
const STAGGER_MS   = 60 * 1000;
const MAX_ROWS     = Number(process.env.EMBEDDING_BACKFILL_MAX || 8000);

/** NE-FL seed ZIPs — high-value demo graph (Ponte Vedra / Jax Beaches / SJC). */
const NE_FL_ZIPS = [
  '32082', '32081', '32250', '32266', '32233', '32259', '32034', '32092', '32084',
  '32202', '32207', '32216', '32244', '32256', '32073',
];

const SELECTIVE_WHERE = `
  status != 'inactive'
  AND (
    claimed_at IS NOT NULL
    OR COALESCE(is_showcase, FALSE) = TRUE
    OR wallet IS NOT NULL
    OR (description IS NOT NULL AND length(trim(description)) >= 40)
    OR zip = ANY($1::text[])
  )
`;

async function runEmbeddingBackfill() {
  console.log('[embeddingBackfill] START — FULL_REFRESH:', FULL_REFRESH, 'url:', getEmbedderUrl());

  if (!isEmbedderConfigured()) {
    console.warn('[embeddingBackfill] embedder not configured — skipping');
    return;
  }

  const countRows = await db.query(
    FULL_REFRESH
      ? `SELECT COUNT(*) AS cnt FROM businesses WHERE ${SELECTIVE_WHERE}`
      : `SELECT COUNT(*) AS cnt FROM businesses WHERE embedding IS NULL AND ${SELECTIVE_WHERE}`,
    [NE_FL_ZIPS]
  );
  const pending = Number(countRows[0]?.cnt ?? 0);
  const total = Math.min(pending, MAX_ROWS);
  console.log(`[embeddingBackfill] ${pending} selective pending (capping at ${MAX_ROWS} → ${total})`);

  if (total === 0) {
    console.log('[embeddingBackfill] Nothing to do');
    await ensureIndex();
    return;
  }

  let embedded = 0;
  let lastId = '00000000-0000-0000-0000-000000000000';

  while (embedded < MAX_ROWS) {
    const rows = await db.query(
      FULL_REFRESH
        ? `SELECT business_id, name, description, cuisine, category
             FROM businesses
            WHERE business_id > $2 AND ${SELECTIVE_WHERE}
            ORDER BY business_id
            LIMIT $3`
        : `SELECT business_id, name, description, cuisine, category
             FROM businesses
            WHERE business_id > $2 AND embedding IS NULL AND ${SELECTIVE_WHERE}
            ORDER BY business_id
            LIMIT $3`,
      [NE_FL_ZIPS, lastId, BATCH_SIZE]
    );

    if (!rows.length) break;

    const texts = rows.map(b =>
      [b.name, b.description, b.cuisine, b.category]
        .filter(Boolean)
        .join(' | ')
    );

    const vectors = await embedBatch(texts);
    if (!vectors) {
      console.error('[embeddingBackfill] embedBatch returned null — embedder may be loading, retrying in 10s');
      await new Promise(r => setTimeout(r, 10000));
      continue;
    }

    for (let i = 0; i < rows.length; i++) {
      if (!vectors[i]) continue;
      try {
        await db.query(
          `UPDATE businesses SET embedding = $1::vector WHERE business_id = $2`,
          [`[${vectors[i].join(',')}]`, rows[i].business_id]
        );
        embedded++;
      } catch (err) {
        console.error(`[embeddingBackfill] failed to update ${rows[i].business_id}:`, err.message);
      }
    }

    lastId = rows[rows.length - 1].business_id;
    console.log(`[embeddingBackfill] ${embedded}/${total} embedded`);

    if (rows.length < BATCH_SIZE) break;
  }

  await ensureIndex();
  console.log(`[embeddingBackfill] END — ${embedded} businesses embedded`);
}

async function ensureIndex() {
  const cntRows = await db.query(
    `SELECT COUNT(*) AS cnt FROM businesses WHERE embedding IS NOT NULL`
  );
  const n = Number(cntRows[0]?.cnt ?? 0);
  if (n < 50) {
    console.log(`[embeddingBackfill] skip ivfflat — only ${n} embedded rows`);
    return;
  }
  const lists = Math.max(1, Math.floor(Math.sqrt(n)));
  try {
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_businesses_embedding
         ON businesses USING ivfflat (embedding vector_cosine_ops)
         WITH (lists = ${lists})`
    );
    console.log(`[embeddingBackfill] ivfflat index ok lists=${lists} rows=${n}`);
  } catch (err) {
    console.error('[embeddingBackfill] index creation failed (non-fatal):', err.message);
  }
}

(async function main() {
  if (require.main !== module) return;
  console.log('[embeddingBackfill] Worker started');

  await new Promise(r => setTimeout(r, STAGGER_MS));

  try {
    await runEmbeddingBackfill();
  } catch (e) {
    console.error('[embeddingBackfill] Run failed:', e.message);
  }

  console.log('[embeddingBackfill] Run-once complete — staying alive idle');
  setInterval(() => {}, 1 << 30);
})();

module.exports = { runEmbeddingBackfill, NE_FL_ZIPS, SELECTIVE_WHERE };
