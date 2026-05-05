'use strict';
/**
 * lib/embedderClient.js
 * Client for the nomic-embed-text sidecar service.
 *
 * Always returns null on failure — semantic search is optional, never required.
 * Caller must handle null gracefully.
 */

const EMBEDDER_URL = process.env.EMBEDDING_SERVICE_URL;

async function embedText(text) {
  if (!EMBEDDER_URL) {
    console.warn('[embedder] EMBEDDING_SERVICE_URL not set — semantic search disabled');
    return null;
  }
  try {
    const res = await fetch(`${EMBEDDER_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5000) // 5s timeout — never block search
    });
    if (!res.ok) throw new Error(`embedder HTTP ${res.status}`);
    const { vector } = await res.json();
    if (!Array.isArray(vector) || vector.length !== 768) {
      throw new Error(`unexpected vector shape: ${vector?.length}`);
    }
    return vector;
  } catch (err) {
    console.error('[embedder] embedText failed:', err.message);
    return null; // always return null on failure — caller handles gracefully
  }
}

async function embedBatch(texts) {
  if (!EMBEDDER_URL) return null;
  try {
    const res = await fetch(`${EMBEDDER_URL}/embed-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts }),
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) throw new Error(`embedder HTTP ${res.status}`);
    const { vectors } = await res.json();
    return vectors;
  } catch (err) {
    console.error('[embedder] embedBatch failed:', err.message);
    return null;
  }
}

module.exports = { embedText, embedBatch };
