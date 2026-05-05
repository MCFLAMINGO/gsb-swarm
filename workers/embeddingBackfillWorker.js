'use strict';
/**
 * embeddingBackfillWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * pgvector Session B — populates 768-d `embedding` column on businesses by
 * sending name + description + cuisine + category to the embedder sidecar.
 *
 * Contract:
 *   START → check EMBEDDING_SERVICE_URL set → count pending rows
 *   WORK  → batches of 50, skip already-embedded (unless FULL_REFRESH=true),
 *           write vectors back to Postgres
 *   END   → CREATE INDEX IF NOT EXISTS idx_businesses_embedding
 *           USING ivfflat WITH (lists = floor(sqrt(total)))
 *
 * Fire-and-forget on startup. Never blocks server boot. Embedder failures
 * trigger 10s sleep + retry (model may still be loading).
 */

const db = require('../lib/db');
const { embedBatch } = require('../lib/embedderClient');

const BATCH_SIZE   = 50;
const FULL_REFRESH = process.env.FULL_REFRESH === 'true';
const STAGGER_MS   = 60 * 1000;

async function runEmbeddingBackfill() {
  console.log('[embeddingBackfill] START — FULL_REFRESH:', FULL_REFRESH);

  if (!process.env.EMBEDDING_SERVICE_URL) {
    console.warn('[embeddingBackfill] EMBEDDING_SERVICE_URL not set — skipping');
    return;
  }

  // Count pending
  const countRows = await db.query(
    FULL_REFRESH
      ? 'SELECT COUNT(*) AS cnt FROM businesses'
      : 'SELECT COUNT(*) AS cnt FROM businesses WHERE embedding IS NULL'
  );
  const total = Number(countRows[0]?.cnt ?? 0);
  console.log(`[embeddingBackfill] ${total} businesses to embed`);

  if (total === 0) {
    console.log('[embeddingBackfill] Nothing to do');
    return;
  }

  let embedded = 0;
  let lastId = '00000000-0000-0000-0000-000000000000';

  while (true) {
    const rows = await db.query(
      FULL_REFRESH
        ? `SELECT business_id, name, description, cuisine, category
             FROM businesses
            WHERE business_id > $1
            ORDER BY business_id
            LIMIT $2`
        : `SELECT business_id, name, description, cuisine, category
             FROM businesses
            WHERE business_id > $1 AND embedding IS NULL
            ORDER BY business_id
            LIMIT $2`,
      [lastId, BATCH_SIZE]
    );

    if (!rows.length) break;

    // Build text for each business — combine fields for richer embedding
    const texts = rows.map(b =>
      [b.name, b.description, b.cuisine, b.category]
        .filter(Boolean)
        .join(' | ')
    );

    const vectors = await embedBatch(texts);
    if (!vectors) {
      console.error('[embeddingBackfill] embedBatch returned null — embedder may be loading, retrying in 10s');
      await new Promise(r => setTimeout(r, 10000));
      continue; // retry same batch (lastId not advanced)
    }

    // Write vectors back to Postgres
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

  // After backfill — create ivfflat index if it doesn't exist.
  // lists = max(1, floor(sqrt(total))) — Railway Postgres supports ivfflat via pgvector.
  const lists = Math.max(1, Math.floor(Math.sqrt(total)));
  try {
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_businesses_embedding
         ON businesses USING ivfflat (embedding vector_cosine_ops)
         WITH (lists = ${lists})`
    );
    console.log(`[embeddingBackfill] ivfflat index created with lists=${lists}`);
  } catch (err) {
    console.error('[embeddingBackfill] index creation failed (non-fatal):', err.message);
  }

  console.log(`[embeddingBackfill] END — ${embedded} businesses embedded`);
}

// Self-running entry — same shape as searchVectorBackfillWorker
(async function main() {
  if (require.main !== module) return; // imported, not forked
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

module.exports = { runEmbeddingBackfill };
