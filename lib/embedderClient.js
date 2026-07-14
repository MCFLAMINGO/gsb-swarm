'use strict';
/**
 * lib/embedderClient.js
 * Client for the nomic-embed-text sidecar (Railway: eloquent-energy).
 *
 * Always returns null on failure — semantic search is optional, never required.
 * Caller must handle null gracefully.
 */

/** Production sidecar — override with EMBEDDING_SERVICE_URL when needed. */
const DEFAULT_EMBEDDER_URL = 'https://eloquent-energy-production.up.railway.app';

function getEmbedderUrl() {
  const explicit = (process.env.EMBEDDING_SERVICE_URL || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  // On Railway (or when explicitly opted in), default to the live sidecar so
  // semantic search works without a manual env var on every redeploy.
  if (process.env.RAILWAY_ENVIRONMENT || process.env.EMBEDDING_USE_DEFAULT === 'true') {
    return DEFAULT_EMBEDDER_URL;
  }
  return null;
}

async function embedText(text) {
  const EMBEDDER_URL = getEmbedderUrl();
  if (!EMBEDDER_URL) {
    console.warn('[embedder] EMBEDDING_SERVICE_URL not set — semantic search disabled');
    return null;
  }
  try {
    const res = await fetch(`${EMBEDDER_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5000), // 5s timeout — never block search
    });
    if (!res.ok) throw new Error(`embedder HTTP ${res.status}`);
    const { vector } = await res.json();
    if (!Array.isArray(vector) || vector.length !== 768) {
      throw new Error(`unexpected vector shape: ${vector?.length}`);
    }
    return vector;
  } catch (err) {
    console.error('[embedder] embedText failed:', err.message);
    return null;
  }
}

async function embedBatch(texts) {
  const EMBEDDER_URL = getEmbedderUrl();
  if (!EMBEDDER_URL) return null;
  try {
    const res = await fetch(`${EMBEDDER_URL}/embed-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`embedder HTTP ${res.status}`);
    const { vectors } = await res.json();
    return vectors;
  } catch (err) {
    console.error('[embedder] embedBatch failed:', err.message);
    return null;
  }
}

function isEmbedderConfigured() {
  return !!getEmbedderUrl();
}

module.exports = {
  embedText,
  embedBatch,
  getEmbedderUrl,
  isEmbedderConfigured,
  DEFAULT_EMBEDDER_URL,
};
