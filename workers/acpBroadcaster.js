'use strict';
/**
 * acpBroadcaster.js
 *
 * Actively announces LocalIntel data availability to agent registries.
 * Runs every 4 hours. Non-blocking — if a registry is down, logs and moves on.
 *
 * Broadcasts to:
 *   1. Smithery MCP registry (POST submission ping)
 *   2. PulseMCP directory ping
 *   3. Fetch.ai Agentverse (REST announce if endpoint available)
 *   4. Internal broadcast log for dashboard visibility
 *
 * Also posts "new ZIP complete" announcements when zipCoverage.json changes.
 * Port: 3008
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = 3008;
const DATA_DIR = path.join(__dirname, '../data');
const COVERAGE_FILE = path.join(DATA_DIR, 'zipCoverage.json');
const BROADCAST_LOG_FILE = path.join(DATA_DIR, 'broadcastLog.json');
const BROADCAST_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

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

// ── Broadcast log helpers ─────────────────────────────────────────────────────

function loadBroadcastLog() {
  try {
    if (fs.existsSync(BROADCAST_LOG_FILE)) {
      return JSON.parse(fs.readFileSync(BROADCAST_LOG_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return [];
}

function appendBroadcastLog(entry) {
  const log = loadBroadcastLog();
  log.push(entry);
  // Keep last 500 entries
  const trimmed = log.slice(-500);
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(BROADCAST_LOG_FILE, JSON.stringify(trimmed, null, 2));
  } catch (e) {
    console.error('[AcpBroadcaster] Failed to write broadcast log:', e.message);
  }
}

function logBroadcast({ registry, status, message, zipsCount }) {
  const entry = {
    registry,
    status,
    timestamp: new Date().toISOString(),
    zipsCount: zipsCount || 0,
    message: message || '',
  };
  appendBroadcastLog(entry);
  console.log(`[AcpBroadcaster] [${registry}] ${status} — ${message || ''}`);
  return entry;
}

// ── ZIP coverage watcher ─────────────────────────────────────────────────────

let lastCompletedCount = 0;

function getCompletedCount() {
  try {
    if (!fs.existsSync(COVERAGE_FILE)) return 0;
    const coverage = JSON.parse(fs.readFileSync(COVERAGE_FILE, 'utf8'));
    return Object.keys(coverage.completed || {}).length;
  } catch (e) {
    return 0;
  }
}

function getLatestZip() {
  try {
    if (!fs.existsSync(COVERAGE_FILE)) return null;
    const coverage = JSON.parse(fs.readFileSync(COVERAGE_FILE, 'utf8'));
    const completed = coverage.completed || {};
    const zips = Object.keys(completed);
    if (!zips.length) return null;
    // Find most recently completed
    return zips.reduce((latest, zip) => {
      const t = new Date(completed[zip].completedAt || 0).getTime();
      const lt = new Date(completed[latest].completedAt || 0).getTime();
      return t > lt ? zip : latest;
    });
  } catch (e) {
    return null;
  }
}

function checkZipCoverageChange() {
  const currentCount = getCompletedCount();
  if (currentCount > lastCompletedCount) {
    const newZip = getLatestZip();
    const msg = `New ZIP complete: ${newZip || 'unknown'} — broadcasting to registries`;
    console.log(`[AcpBroadcaster] ${msg}`);
    logBroadcast({
      registry: 'internal',
      status: 'zip_complete_event',
      message: msg,
      zipsCount: currentCount,
    });
    // Trigger a broadcast cycle on new ZIP completion
    runBroadcastCycle(currentCount).catch(e =>
      console.error('[AcpBroadcaster] Zip-triggered broadcast error:', e.message)
    );
    lastCompletedCount = currentCount;
  }
}

// ── Registry announcements ───────────────────────────────────────────────────

async function announceToSmithery(zipsCount) {
  const registry = 'smithery';
  try {
    const res = await fetch('https://smithery.ai/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ANNOUNCEMENT_PAYLOAD),
      signal: AbortSignal.timeout(10000),
    });
    const status = res.ok ? 'success' : `http_${res.status}`;
    logBroadcast({ registry, status, message: `HTTP ${res.status}`, zipsCount });
  } catch (e) {
    logBroadcast({ registry, status: 'error', message: e.message, zipsCount });
  }
}

async function announceToPulseMCP(zipsCount) {
  const registry = 'pulsemcp';
  try {
    const res = await fetch('https://www.pulsemcp.com/api/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ANNOUNCEMENT_PAYLOAD),
      signal: AbortSignal.timeout(10000),
    });
    const status = res.ok ? 'success' : `http_${res.status}`;
    logBroadcast({ registry, status, message: `HTTP ${res.status}`, zipsCount });
  } catch (e) {
    logBroadcast({ registry, status: 'error', message: e.message, zipsCount });
  }
}

async function announceToFetchAi(zipsCount) {
  const registry = 'fetchai_agentverse';
  try {
    // First check if the almanac endpoint exists
    const checkRes = await fetch('https://agentverse.ai/api/v1/almanac/agents', {
      signal: AbortSignal.timeout(8000),
    });
    if (!checkRes.ok) {
      logBroadcast({ registry, status: `check_http_${checkRes.status}`, message: 'Almanac endpoint returned non-OK', zipsCount });
      return;
    }
    // Attempt registration
    const regRes = await fetch('https://agentverse.ai/api/v1/almanac/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: 'localintel-gsb-swarm',
        endpoints: [{ url: MCP_URL, weight: 1 }],
        protocols: ['mcp'],
        metadata: {
          name: ANNOUNCEMENT_PAYLOAD.name,
          description: ANNOUNCEMENT_PAYLOAD.description,
        },
      }),
      signal: AbortSignal.timeout(10000),
    });
    const status = regRes.ok ? 'success' : `http_${regRes.status}`;
    logBroadcast({ registry, status, message: `Registration HTTP ${regRes.status}`, zipsCount });
  } catch (e) {
    logBroadcast({ registry, status: 'error', message: e.message, zipsCount });
  }
}

// ── Main broadcast cycle ─────────────────────────────────────────────────────

async function runBroadcastCycle(zipsCount) {
  if (zipsCount === undefined) zipsCount = getCompletedCount();
  console.log(`[AcpBroadcaster] Starting broadcast cycle (zips covered: ${zipsCount})`);
  logBroadcast({ registry: 'internal', status: 'cycle_start', message: 'Broadcast cycle started', zipsCount });

  // Fire all three registry announcements concurrently, non-blocking
  await Promise.allSettled([
    announceToSmithery(zipsCount),
    announceToPulseMCP(zipsCount),
    announceToFetchAi(zipsCount),
  ]);

  console.log('[AcpBroadcaster] Broadcast cycle complete');
  logBroadcast({ registry: 'internal', status: 'cycle_complete', message: 'All registry pings sent', zipsCount });
}

// ── Express API ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    worker: 'acpBroadcaster',
    port: PORT,
    status: 'running',
    lastCompletedCount,
    broadcastIntervalHours: 4,
  });
});

app.get('/broadcast-log', (req, res) => {
  const log = loadBroadcastLog();
  res.json({
    ok: true,
    count: log.length,
    log,
  });
});

// ── Boot ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[AcpBroadcaster] Running on port ${PORT}`);

  // Initialize coverage baseline
  lastCompletedCount = getCompletedCount();

  // Run immediately on boot
  runBroadcastCycle().catch(e =>
    console.error('[AcpBroadcaster] Boot broadcast error:', e.message)
  );

  // Watch for new ZIPs every 2 minutes
  setInterval(checkZipCoverageChange, 2 * 60 * 1000);

  // Re-broadcast every 4 hours
  setInterval(() => {
    runBroadcastCycle().catch(e =>
      console.error('[AcpBroadcaster] Interval broadcast error:', e.message)
    );
  }, BROADCAST_INTERVAL_MS);
});
