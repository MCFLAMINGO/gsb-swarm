#!/usr/bin/env node
'use strict';
/**
 * Smoke checks for semantic search wiring (no DB required for unit portion).
 * Live embedder probe is best-effort.
 *
 * Run: node scripts/test-semantic-search.js
 */

const {
  getEmbedderUrl,
  isEmbedderConfigured,
  embedText,
  DEFAULT_EMBEDDER_URL,
} = require('../lib/embedderClient');
const { semanticBusinessSearch, DEFAULT_MAX_DISTANCE } = require('../lib/semanticSearch');

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error('FAIL', msg);
  } else {
    console.log('PASS', msg);
  }
}

// Unit: default URL resolution
process.env.EMBEDDING_USE_DEFAULT = 'true';
delete process.env.EMBEDDING_SERVICE_URL;
assert(getEmbedderUrl() === DEFAULT_EMBEDDER_URL, 'default URL when EMBEDDING_USE_DEFAULT');
assert(isEmbedderConfigured() === true, 'configured with default');
assert(DEFAULT_MAX_DISTANCE > 0 && DEFAULT_MAX_DISTANCE < 2, 'max distance sane');

process.env.EMBEDDING_SERVICE_URL = 'https://example.test/embedder';
assert(getEmbedderUrl() === 'https://example.test/embedder', 'explicit URL wins');

// Empty query → empty rows without calling db
(async () => {
  process.env.EMBEDDING_SERVICE_URL = DEFAULT_EMBEDDER_URL;
  process.env.EMBEDDING_USE_DEFAULT = 'true';

  let dbCalls = 0;
  const empty = await semanticBusinessSearch({
    query: '',
    zips: ['32082'],
    dbQuery: async () => { dbCalls += 1; return []; },
  });
  assert(empty.used === false && empty.rows.length === 0 && dbCalls === 0, 'empty query skips');

  const noZips = await semanticBusinessSearch({
    query: 'chicken and broccoli',
    zips: [],
    dbQuery: async () => { dbCalls += 1; return []; },
  });
  assert(noZips.used === false && dbCalls === 0, 'empty zips skips');

  // Live embedder probe (best-effort — network may be restricted)
  try {
    const vec = await embedText('fresh healthy lunch ponte vedra');
    if (vec) {
      assert(Array.isArray(vec) && vec.length === 768, `live embed dim=${vec.length}`);
      // Mock DB returning one row under threshold
      const mock = await semanticBusinessSearch({
        query: 'fresh healthy lunch',
        zips: ['32082'],
        maxDistance: 0.99,
        dbQuery: async (sql, params) => {
          assert(sql.includes('embedding <=>'), 'sql uses cosine distance');
          assert(String(params[0]).startsWith('['), 'vector param serialized');
          return [{
            business_id: '00000000-0000-0000-0000-000000000001',
            name: 'McFlamingo',
            zip: '32082',
            semantic_distance: 0.2,
            claimed_at: new Date().toISOString(),
          }];
        },
      });
      assert(mock.used === true && mock.rows[0].name === 'McFlamingo', 'mock semantic hit');
    } else {
      console.log('SKIP live embedder probe (null vector)');
    }
  } catch (e) {
    console.log('SKIP live embedder probe:', e.message);
  }

  // Tombstone: MiniLM disk worker must refuse
  const { spawnSync } = require('child_process');
  const tomb = spawnSync(process.execPath, ['workers/embeddingWorker.js'], {
    cwd: require('path').join(__dirname, '..'),
    encoding: 'utf8',
  });
  assert(tomb.status === 1, 'embeddingWorker tombstone exits 1');
  assert(/DEPRECATED/i.test(tomb.stderr || tomb.stdout || ''), 'embeddingWorker prints DEPRECATED');

  console.log(failed ? 'RESULT: FAIL' : 'RESULT: OK');
  process.exit(failed ? 1 : 0);
})();
