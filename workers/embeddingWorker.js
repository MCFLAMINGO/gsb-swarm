'use strict';
/**
 * embeddingWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Builds semantic vector embeddings for every business record using
 * all-MiniLM-L6-v2 — an 80MB local model, zero API cost, runs forever.
 *
 * What this enables:
 *   - "health food restaurant" finds the right businesses via cosine similarity
 *     even if the word "health" doesn't appear in the record
 *   - Semantic search replaces keyword scoring in local_intel_search
 *   - New businesses get embedded automatically after enrichment runs
 *
 * Architecture:
 *   - Node worker spawns a Python sidecar (embed_server.py) on port 8765
 *   - Python runs sentence-transformers locally (no internet after first download)
 *   - Node sends batches of business text → Python returns float32 vectors
 *   - Vectors stored in data/embeddings/{zip}.bin (Float32Array, compact)
 *   - Index file data/embeddings/_index.json maps vector position → business id
 *
 * Cycle: startup (build missing), then every 6 hours (pick up new businesses)
 * Skips ZIPs whose embedding file is newer than the zip data file.
 *
 * Python sidecar: workers/embed_server.py (started automatically by this worker)
 */

const fs     = require('fs');
const path   = require('path');
const http   = require('http');
const { spawn } = require('child_process');

const BASE_DIR    = path.join(__dirname, '..');
const ZIPS_DIR    = path.join(BASE_DIR, 'data', 'zips');
const EMB_DIR     = path.join(BASE_DIR, 'data', 'embeddings');
const SIDECAR     = path.join(__dirname, 'embed_server.py');

const EMBED_PORT  = 8765;
const BATCH_SIZE  = 64;
const CYCLE_MS    = 6 * 60 * 60 * 1000;
const STAGGER_MS  = 8 * 60 * 1000; // wait 8 min — let briefs build first

let sidecarProc   = null;
let sidecarReady  = false;

// ── Start Python sidecar ──────────────────────────────────────────────────────
function startSidecar() {
  return new Promise((resolve) => {
    console.log('[embedding] Starting Python embedding sidecar on port', EMBED_PORT);

    // Install sentence-transformers if needed (Railway container)
    const install = spawn('pip3', ['install', '--quiet', '--break-system-packages',
      'sentence-transformers', 'flask'], { stdio: 'pipe' });

    install.on('close', (code) => {
      if (code !== 0) {
        console.warn('[embedding] pip install may have had issues — trying anyway');
      }

      sidecarProc = spawn('python3', [SIDECAR, String(EMBED_PORT)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      sidecarProc.stdout.on('data', d => {
        const msg = d.toString().trim();
        console.log('[embedding-py]', msg);
        if (msg.includes('ready') || msg.includes('Running on')) {
          sidecarReady = true;
          resolve(true);
        }
      });

      sidecarProc.stderr.on('data', d => {
        const msg = d.toString().trim();
        if (msg && !msg.includes('WARNING') && !msg.includes('UserWarning')) {
          console.warn('[embedding-py]', msg.slice(0, 200));
        }
        // Flask startup message comes on stderr
        if (msg.includes('Running on') || msg.includes('ready')) {
          sidecarReady = true;
          resolve(true);
        }
      });

      sidecarProc.on('exit', (code) => {
        console.warn('[embedding] Sidecar exited with code', code);
        sidecarReady = false;
      });

      // Timeout — if no ready signal in 90s, try anyway
      setTimeout(() => resolve(false), 90000);
    });
  });
}

// ── Ping sidecar ──────────────────────────────────────────────────────────────
async function pingSidecar() {
  return new Promise((resolve) => {
    const req = http.request({ host: 'localhost', port: EMBED_PORT, path: '/health', method: 'GET' }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

// ── Embed a batch of texts ────────────────────────────────────────────────────
function embedBatch(texts) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ texts });
    const opts = {
      host: 'localhost', port: EMBED_PORT, path: '/embed',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = http.request(opts, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(e); }
      });
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('embed timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Build text representation of a business ───────────────────────────────────
// What an LLM would "read" to understand this business
function businessToText(b) {
  const parts = [
    b.name || '',
    b.category || '',
    b.address || '',
    b.hours ? `hours: ${b.hours}` : '',
    b.phone || '',
  ].filter(Boolean);
  return parts.join(' · ');
}

// ── Embedding file paths ──────────────────────────────────────────────────────
function embPath(zip)   { return path.join(EMB_DIR, `${zip}.bin`); }
function idxPath(zip)   { return path.join(EMB_DIR, `${zip}_index.json`); }

function needsEmbed(zip) {
  const zipFile = path.join(ZIPS_DIR, `${zip}.json`);
  const emb     = embPath(zip);
  if (!fs.existsSync(emb)) return true;
  try {
    return fs.statSync(zipFile).mtimeMs > fs.statSync(emb).mtimeMs;
  } catch { return true; }
}

// ── Embed one ZIP ─────────────────────────────────────────────────────────────
async function embedZip(zip) {
  let businesses;
  if (process.env.LOCAL_INTEL_DB_URL) {
    try {
      const { getBusinessesByZip } = require('../lib/pgStore');
      businesses = await getBusinessesByZip(zip);
    } catch (e) {
      console.warn(`[embedding] Postgres read failed for ${zip}:`, e.message);
    }
  }
  if (!businesses) {
    try { businesses = JSON.parse(fs.readFileSync(path.join(ZIPS_DIR, `${zip}.json`), 'utf8')); }
    catch (_) { return; }
  }
  if (!Array.isArray(businesses) || !businesses.length) return;

  const texts = businesses.map(businessToText);
  const allVectors = [];

  // Process in batches
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const result = await embedBatch(batch);
    if (!result.vectors) throw new Error('No vectors returned');
    allVectors.push(...result.vectors);
  }

  // Pack into binary Float32 buffer (compact storage)
  const dim    = allVectors[0].length;  // 384 for MiniLM
  const buf    = Buffer.allocUnsafe(allVectors.length * dim * 4);
  for (let i = 0; i < allVectors.length; i++) {
    for (let j = 0; j < dim; j++) {
      buf.writeFloatLE(allVectors[i][j], (i * dim + j) * 4);
    }
  }

  // Write binary embeddings + index
  fs.mkdirSync(EMB_DIR, { recursive: true });
  fs.writeFileSync(embPath(zip), buf);
  const index = {
    zip, dim, count: businesses.length,
    businesses: businesses.map((b, i) => ({
      i, name: b.name, category: b.category, zip: b.zip, address: b.address,
    })),
    generated_at: new Date().toISOString(),
  };
  fs.writeFileSync(idxPath(zip), JSON.stringify(index));
}

// ── Cosine similarity search (used by local_intel_search when embeddings exist) ──
// Exported so localIntelMCP.js can use it directly
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

async function semanticSearch(queryText, zip, topK = 20) {
  if (!sidecarReady) return null;
  try {
    const { vectors: [qVec] } = await embedBatch([queryText]);
    const idx = JSON.parse(fs.readFileSync(idxPath(zip), 'utf8'));
    const buf = fs.readFileSync(embPath(zip));
    const dim = idx.dim;

    const scores = idx.businesses.map((b, i) => {
      const vec = [];
      for (let j = 0; j < dim; j++) {
        vec.push(buf.readFloatLE((i * dim + j) * 4));
      }
      return { ...b, score: cosineSimilarity(qVec, vec) };
    });

    return scores.sort((a, b) => b.score - a.score).slice(0, topK);
  } catch { return null; }
}

// ── Main pass ─────────────────────────────────────────────────────────────────
async function runEmbedPass() {
  if (!fs.existsSync(ZIPS_DIR)) return;

  const alive = await pingSidecar();
  if (!alive) {
    console.log('[embedding] Sidecar not ready — skipping pass');
    return;
  }

  // ZIP discovery: Postgres first, flat file fallback
  let allZips = [];
  if (process.env.LOCAL_INTEL_DB_URL) {
    try {
      const { getDistinctZips } = require('../lib/pgStore');
      allZips = await getDistinctZips();
      if (allZips.length > 0) console.log(`[embedding] ZIP discovery: ${allZips.length} ZIPs from Postgres`);
    } catch (e) {
      console.warn('[embedding] Postgres ZIP discovery failed, falling back:', e.message);
    }
  }
  if (allZips.length === 0) {
    try { allZips = fs.readdirSync(ZIPS_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')); }
    catch (_) {}
  }
  let built = 0, skipped = 0;

  for (const zip of allZips) {
    if (!needsEmbed(zip)) { skipped++; continue; }
    try {
      await embedZip(zip);
      built++;
      if (built % 10 === 0) console.log(`[embedding] Embedded ${built} ZIPs`);
    } catch (err) {
      console.warn(`[embedding] Failed ${zip}:`, err.message);
    }
  }

  console.log(`[embedding] Pass complete — built:${built} skipped:${skipped}`);
}

// ── Daemon ────────────────────────────────────────────────────────────────────
(async function main() {
  console.log('[embedding] Embedding worker started — all-MiniLM-L6-v2, zero API cost');
  await new Promise(r => setTimeout(r, STAGGER_MS));

  const ready = await startSidecar();
  if (!ready) {
    console.warn('[embedding] Sidecar failed to start — embedding disabled this session');
    return;
  }

  // Wait for sidecar to be truly ready
  await new Promise(r => setTimeout(r, 5000));

  while (true) {
    try { await runEmbedPass(); } catch (e) { console.error('[embedding]', e.message); }
    await new Promise(r => setTimeout(r, CYCLE_MS));
  }
})();

module.exports = { semanticSearch, businessToText };
