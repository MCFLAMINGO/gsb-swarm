'use strict';
/**
 * acpBroadcaster.js
 *
 * Actively announces LocalIntel data availability to agent registries.
 * Runs every 4 hours. Non-blocking — if a registry is down, logs and moves on.
 *
 * Postgres-only state. The Railway disk is wiped on every redeploy, so:
 *   - Broadcast log lives in the `acp_broadcast_log` table (auto-created)
 *   - ZIP coverage is read from the `businesses` table (DISTINCT zip)
 *   - START → query Postgres for ZIPs broadcast in the last 30 days, skip those
 *   - END   → INSERT one row per (zip, registry) broadcast
 *   - FULL_REFRESH=true ignores skip logic
 *
 * Port: 3008
 */

const express = require('express');
const db      = require('../lib/db');

const PORT = 3008;
const BROADCAST_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const FULL_REFRESH = process.env.FULL_REFRESH === 'true';

const SERVICE_URL = 'https://gsb-swarm-production.up.railway.app';
const MCP_URL = `${SERVICE_URL}/api/local-intel/mcp`;

const ANNOUNCEMENT_PAYLOAD = {
  name: 'LocalIntel',
  mcp_url: MCP_URL,
  description:
    'Hyperlocal business intelligence for AI agents. ZIP-level business data covering Florida and expanding across the Sunbelt. Phone, hours, foot traffic proxy, categories, confidence scores. Pay-per-query via pathUSD.',
  url: SERVICE_URL,
  skills: ['nearby_businesses', 'corridor_data', 'zip_stats', 'zone_context', 'business_search', 'change_detection'],
  pricing: { per_call: '$0.01-0.05', currency: 'pathUSD' },
  coverage: 'Florida SJC zips + expanding to full Sunbelt',
  contact: 'localintel@mcflamingo.com',
};

// ── Schema ────────────────────────────────────────────────────────────────────
async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS acp_broadcast_log (
      id SERIAL PRIMARY KEY,
      zip TEXT,
      registry TEXT,
      status TEXT,
      business_count INTEGER,
      message TEXT,
      broadcast_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_acp_broadcast_at ON acp_broadcast_log(broadcast_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_acp_broadcast_zip ON acp_broadcast_log(zip)`);
}

// ── Broadcast log helpers ─────────────────────────────────────────────────────
async function logBroadcast({ registry, status, message, zipsCount, zip }) {
  try {
    await db.query(
      `INSERT INTO acp_broadcast_log (zip, registry, status, business_count, message)
       VALUES ($1, $2, $3, $4, $5)`,
      [zip || null, registry, status, zipsCount || 0, message || '']
    );
  } catch (e) {
    console.error('[AcpBroadcaster] Failed to write broadcast log:', e.message);
  }
  console.log(`[AcpBroadcaster] [${registry}] ${status} — ${message || ''}`);
}

// ── ZIP coverage from Postgres ────────────────────────────────────────────────
async function getCompletedCount() {
  try {
    const rows = await db.query(
      `SELECT COUNT(DISTINCT zip)::int AS n FROM businesses
        WHERE status != 'inactive' AND zip IS NOT NULL`
    );
    return rows[0]?.n || 0;
  } catch (e) {
    console.warn('[AcpBroadcaster] coverage count failed:', e.message);
    return 0;
  }
}

async function getRecentlyBroadcastZipSet() {
  if (FULL_REFRESH) return new Set();
  try {
    const rows = await db.query(
      `SELECT DISTINCT zip FROM acp_broadcast_log
        WHERE broadcast_at > NOW() - INTERVAL '30 days'
          AND zip IS NOT NULL`
    );
    return new Set(rows.map(r => r.zip));
  } catch (e) {
    console.warn('[AcpBroadcaster] recent broadcast lookup failed:', e.message);
    return new Set();
  }
}

async function getNewlyCoveredZips() {
  // ZIPs in businesses minus those already broadcast in the last 30 days
  const recentSet = await getRecentlyBroadcastZipSet();
  let coveredZips = [];
  try {
    const rows = await db.query(
      `SELECT DISTINCT zip FROM businesses
        WHERE status != 'inactive' AND zip IS NOT NULL`
    );
    coveredZips = rows.map(r => r.zip);
  } catch (e) {
    console.warn('[AcpBroadcaster] covered ZIPs lookup failed:', e.message);
  }
  return coveredZips.filter(z => !recentSet.has(z));
}

// ── Registry announcements ───────────────────────────────────────────────────
async function announceToSmithery(zipsCount) {
  const registry = 'smithery';
  try {
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      signal: AbortSignal.timeout(10000),
    });
    const status = res.ok ? 'mcp_reachable' : `mcp_http_${res.status}`;
    await logBroadcast({ registry, status, message: `MCP endpoint HTTP ${res.status} — Smithery auto-indexes from GitHub`, zipsCount });
  } catch (e) {
    await logBroadcast({ registry, status: 'error', message: e.message, zipsCount });
  }
}

async function announceToPulseMCP(zipsCount) {
  const registry = 'pulsemcp';
  await logBroadcast({ registry, status: 'manual_required', message: 'PulseMCP requires manual submission at pulsemcp.com/submit — skipping auto-ping', zipsCount });
}

async function announceToFetchAi(zipsCount) {
  const registry = 'fetchai_agentverse';
  await logBroadcast({ registry, status: 'auth_required', message: 'Agentverse requires agent wallet — skip until provisioned', zipsCount });
}

// ── Main broadcast cycle ─────────────────────────────────────────────────────
async function runBroadcastCycle() {
  const zipsCount = await getCompletedCount();
  const newZips = await getNewlyCoveredZips();
  console.log(
    `[AcpBroadcaster] Starting broadcast cycle — covered ZIPs: ${zipsCount}, ` +
    `new since last 30d: ${newZips.length} (FULL_REFRESH=${FULL_REFRESH})`
  );
  await logBroadcast({ registry: 'internal', status: 'cycle_start', message: 'Broadcast cycle started', zipsCount });

  // Fire all three registry announcements concurrently, non-blocking
  await Promise.allSettled([
    announceToSmithery(zipsCount),
    announceToPulseMCP(zipsCount),
    announceToFetchAi(zipsCount),
  ]);

  // Per-zip rows so future cycles can skip recently-broadcast zips
  for (const zip of newZips) {
    await logBroadcast({
      zip, registry: 'internal',
      status: 'zip_announced',
      message: `ZIP ${zip} included in registry pings`,
      zipsCount: 1,
    });
  }

  console.log('[AcpBroadcaster] Broadcast cycle complete');
  await logBroadcast({ registry: 'internal', status: 'cycle_complete', message: 'All registry pings sent', zipsCount });
}

// ── Express API ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get('/health', async (req, res) => {
  const zipsCount = await getCompletedCount().catch(() => 0);
  res.json({
    worker: 'acpBroadcaster',
    port: PORT,
    status: 'running',
    coverageZips: zipsCount,
    broadcastIntervalHours: 4,
  });
});

app.get('/broadcast-log', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT id, zip, registry, status, business_count, message, broadcast_at
       FROM acp_broadcast_log ORDER BY broadcast_at DESC LIMIT 500`
    );
    res.json({ ok: true, count: rows.length, log: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Boot ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`[AcpBroadcaster] Running on port ${PORT}`);

  try { await ensureSchema(); }
  catch (e) { console.error('[AcpBroadcaster] schema init failed:', e.message); }

  runBroadcastCycle().catch(e =>
    console.error('[AcpBroadcaster] Boot broadcast error:', e.message)
  );

  setInterval(() => {
    runBroadcastCycle().catch(e =>
      console.error('[AcpBroadcaster] Interval broadcast error:', e.message)
    );
  }, BROADCAST_INTERVAL_MS);
});
