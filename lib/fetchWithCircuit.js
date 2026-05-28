'use strict';
/**
 * lib/fetchWithCircuit.js
 *
 * Wraps HTTPS GET calls with:
 *   - Configurable timeout (default 15s)
 *   - Automatic retry with exponential backoff (default 2 retries)
 *   - Circuit breaker: after FAIL_THRESHOLD consecutive failures, trips the
 *     worker's circuit in Postgres for SKIP_DURATION_MS (default 6h)
 *
 * Usage:
 *   const { fetchJson } = require('../lib/fetchWithCircuit');
 *   const data = await fetchJson(url, { workerName: 'acsWorker', timeoutMs: 10000 });
 *
 * If the circuit is open, fetchJson throws immediately with message:
 *   "Circuit open for <workerName> — skipping until <time>"
 *
 * Workers should wrap calls in try/catch and call pingError() on failure.
 */

const https  = require('https');
const http   = require('http');
const hb     = require('./workerHeartbeat');

const FAIL_THRESHOLD   = 3;               // consecutive fails before circuit trips
const SKIP_DURATION_MS = 6 * 3600 * 1000; // 6 hours

/**
 * Core fetch — single attempt with timeout.
 */
function fetchRaw(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'LocalIntel/2.0 (thelocalintel.com)' } }, res => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchRaw(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume(); // drain
        return reject(new Error(`HTTP ${res.statusCode} — ${url.slice(0, 80)}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Timeout after ${timeoutMs}ms — ${url.slice(0, 80)}`));
    });
    req.on('error', reject);
  });
}

/**
 * Fetch JSON with circuit breaker + retry.
 *
 * @param {string} url
 * @param {object} opts
 *   workerName   {string}  — used for circuit breaker state in Postgres
 *   timeoutMs    {number}  — per-attempt timeout (default 15000)
 *   retries      {number}  — max retries after first failure (default 2)
 *   skipCircuit  {boolean} — skip circuit check (default false)
 */
async function fetchJson(url, opts = {}) {
  const {
    workerName    = null,
    timeoutMs     = 15000,
    retries       = 2,
    skipCircuit   = false,
  } = opts;

  // Circuit breaker check
  if (workerName && !skipCircuit) {
    const open = await hb.isCircuitOpen(workerName);
    if (open) {
      throw new Error(`Circuit open for ${workerName} — skipping external call`);
    }
  }

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (attempt > 0) {
        // Exponential backoff: 1s, 2s
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
      const body = await fetchRaw(url, timeoutMs);
      try {
        return JSON.parse(body);
      } catch (_) {
        throw new Error(`JSON parse failed: ${body.slice(0, 80)}`);
      }
    } catch (err) {
      lastErr = err;
    }
  }

  // All attempts failed — record error and maybe trip circuit
  if (workerName) {
    await hb.pingError(workerName, lastErr.message);
    // Check if we've hit the threshold
    const status = await hb.getStatus(workerName);
    if (status && (status.consecutive_fails || 0) >= FAIL_THRESHOLD) {
      await hb.tripCircuit(workerName, SKIP_DURATION_MS);
    }
  }

  throw lastErr;
}

/**
 * Fetch raw text (CSV, HTML, etc.) with circuit breaker + retry.
 */
async function fetchText(url, opts = {}) {
  const {
    workerName  = null,
    timeoutMs   = 15000,
    retries     = 2,
    skipCircuit = false,
  } = opts;

  if (workerName && !skipCircuit) {
    const open = await hb.isCircuitOpen(workerName);
    if (open) throw new Error(`Circuit open for ${workerName} — skipping external call`);
  }

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * attempt));
      return await fetchRaw(url, timeoutMs);
    } catch (err) {
      lastErr = err;
    }
  }

  if (workerName) {
    await hb.pingError(workerName, lastErr.message);
    const status = await hb.getStatus(workerName);
    if (status && (status.consecutive_fails || 0) >= FAIL_THRESHOLD) {
      await hb.tripCircuit(workerName, SKIP_DURATION_MS);
    }
  }

  throw lastErr;
}

module.exports = { fetchJson, fetchText };
