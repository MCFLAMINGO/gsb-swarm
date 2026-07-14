'use strict';
/**
 * DEPRECATED — do not run or extend.
 *
 * File-based MiniLM embeddings (`data/embeddings/*.bin` + embed_server.py) were a
 * parallel semantic build. Canonical path is Postgres pgvector + Railway
 * `eloquent-energy` (nomic-embed-text-v1):
 *
 *   lib/embedderClient.js
 *   lib/semanticSearch.js
 *   workers/embeddingBackfillWorker.js
 *
 * Search chain (one system, upgraded in place):
 *   ILIKE / category → tsvector → pgvector → RFQ/dispatch
 *
 * See docs/DEPRECATIONS.md and docs/SYSTEM_MAP.md.
 */

console.error(
  '[embeddingWorker] DEPRECATED — refused to start. Use eloquent-energy + ' +
  'embeddingBackfillWorker / lib/semanticSearch.js (pgvector).'
);
process.exit(1);

module.exports = {
  semanticSearch: async () => {
    throw new Error('embeddingWorker.semanticSearch removed — use lib/semanticSearch.js');
  },
  businessToText: () => {
    throw new Error('embeddingWorker.businessToText removed — use embeddingBackfillWorker text join');
  },
};
