/**
 * GSB INTELLIGENCE SWARM — Master Entry Point
 * Starts all 4 workers as child processes.
 */

require('dotenv').config();
const { fork } = require('child_process');
const path = require('path');
const express = require('express');
const { registerResources } = require('./acpResources');
const { registerOfferings } = require('./acpOfferings');
const { getSkillReport, resetSkill } = require('./skillFeedback');

const workers = [
  // ── Virtuals GSB agents — gated on their ENTITY_ID env vars ────────────────────────
  // These report to the CEO agent and connect to the Virtuals protocol network.
  // When ENTITY_IDs are not set (Virtuals offline), do NOT spawn — they have no
  // fallback and will spin/crash consuming connections and restart budget.
  ...(process.env.TOKEN_ANALYST_ENTITY_ID
    ? [{ name: 'Token Analyst',   file: 'tokenAnalyst.js' }]
    : []),
  ...(process.env.WALLET_PROFILER_ENTITY_ID
    ? [{ name: 'Wallet Profiler', file: 'walletProfiler.js' }]
    : []),
  ...(process.env.ALPHA_SCANNER_ENTITY_ID
    ? [{ name: 'Alpha Scanner',   file: 'alphaScanner.js' }]
    : []),
  ...(process.env.THREAD_WRITER_ENTITY_ID
    ? [{ name: 'Thread Writer',   file: 'threadWriter.js' }]
    : []),
  // localIntelWorker.js — REMOVED: pre-Postgres legacy, wrote to data/localIntel.json flat file, 2-ZIP scope
  // dataIngestWorker.js   — REMOVED: pre-Postgres legacy, wrote to data/localIntel.json flat file, SJC-only ZIP filter
  // localIntelMCP spawned separately below with DB_POOL_MAX=2 (HTTP server needs concurrency)
  // ── Workers below are spawned by dashboard-server.js LOCAL_INTEL_WORKERS ────────────────
  // Do NOT add them here — they already run under DB_POOL_MAX=1 + NODE_OPTIONS=512MB there.
  // Duplicating here causes double-spawn restart storms (was root cause of 1475x censusLayer starts).
  //
  // Moved to dashboard-server: zipCoordinatorWorker, acpBroadcaster, routerLearningWorker,
  //   promptEvolutionWorker, overpassWorker, sunbizWorker, businessMergeWorker,
  //   irsSoiWorker, censusLayerWorker, fccBroadbandWorker, permitWorker, mcpProbeWorker
  //
  // ── GSB-only workers (NOT in dashboard-server) ────────────────────────────
  { name: 'Chamber Scraper',      file: 'workers/chamberScraper.js' },
  ...(process.env.FINANCIAL_ANALYST_ENTITY_ID
    ? [{ name: 'Financial Analyst', file: 'financialAnalyst.js' }]
    : []),
  // ── LocalIntel source workers (index.js-only) ─────────────────────────────
  { name: 'Yellow Pages',         file: 'workers/yellowPagesScraper.js' },
  // { name: 'SunBiz Match',         file: 'workers/sunbizMatchWorker.js' },
  // MANUAL TRIGGER ONLY (B120) — gated on SUNBIZ_MATCH_MANUAL_TRIGGER=true
  // ── LocalIntel intelligence layers (index.js-only) ────────────────────────
  { name: 'Census Macro',         file: 'workers/censusMacroWorker.js' },
  { name: 'Trade Signals',        file: 'workers/tradeSignalWorker.js'  },
  { name: 'SJC ArcGIS',          file: 'workers/sjcArcGisWorker.js' },
];

console.log(`
╔══════════════════════════════════════════════════════════╗
║         GSB INTELLIGENCE SWARM — ACTIVATING             ║
║         Agent Gas Bible · ACP Provider Network          ║
║         Thou shalt never run out of GAS                 ║
╚══════════════════════════════════════════════════════════╝
`);

const processes = [];
const STAGGER_DELAY_MS = 15000; // 15s between index.js workers — spreads boot burst
const BOOT_DELAY_MS    = 20000; // 20s head-start for main server pool before first worker

function spawnWorker({ name, file }) {
  const workerPath = path.join(__dirname, file);
  const workerEnv  = {
    ...process.env,
    DB_POOL_MAX: '1',
    // Limit each worker to 512MB — prevents one OOM worker from crashing the parent
    NODE_OPTIONS: '--max-old-space-size=512',
  };

  const child = fork(workerPath, [], {
    silent: false,
    env: workerEnv,
    // Worker crash is isolated — parent catches the exit event and restarts
  });

  child.on('error', (err) => {
    // IPC or spawn error — log and do NOT crash parent
    console.error(`[${name}] spawn/IPC error: ${err.message}`);
  });

  child.on('exit', (code, signal) => {
    if (signal === 'SIGKILL') {
      console.error(`[${name}] OOM killed (SIGKILL). Restarting in 30s with memory cap enforced.`);
    } else {
      console.log(`[${name}] exited (code=${code}). Restarting in 10s...`);
    }
    const delay = signal === 'SIGKILL' ? 30000 : 10000;
    setTimeout(() => {
      const newChild = fork(workerPath, [], { silent: false, env: workerEnv });
      newChild.on('error', (err) => console.error(`[${name}] spawn/IPC error: ${err.message}`));
      newChild.on('exit', (c, s) => console.log(`[${name}] restarted child exited (code=${c} signal=${s})`));
      processes.push(newChild);
    }, delay);
  });

  processes.push(child);
  console.log(`[${name}] Worker started (PID: ${child.pid})`);
}

(async () => {
  // ── Boot: connection budget enforcement ──────────────────────────────
  // Count worker processes × DB_POOL_MAX to ensure we stay under Railway cap.
  // If math fails, log loudly and continue — do NOT silently proceed.
  const RAILWAY_PG_CAP   = 200; // PgBouncer DEFAULT_POOL_SIZE=200 on Railway Pro (500 max connections)
  const WORKER_POOL      = 1;  // DB_POOL_MAX per data worker
  const MCP_POOL         = 1;  // localIntelMCP (shares main process pool)
  const DASHBOARD_POOL   = 0;  // dashboard-server (shares main process pool)
  const MAIN_POOL        = 6;  // main process pool (search/MCP/routing/admin — raised from 4 after timeout)
  // Count DB workers across BOTH index.js list AND dashboard-server LOCAL_INTEL_WORKERS.
  // Deduplicate by file path — a worker file only runs once even if listed in both.
  // Exclude localIntelMCP.js (counted separately as MCP_POOL).
  const usesDb = (file) => {
    try {
      const src = require('fs').readFileSync(require('path').join(__dirname, file), 'utf8');
      return src.includes("require('../lib/db')") || src.includes('require("../lib/db")') ||
             src.includes("require('./lib/db')") || src.includes('require("./lib/db")');
    } catch (_) { return true; }
  };
  // Parse dashboard-server LOCAL_INTEL_WORKERS list
  let dashWorkerFiles = [];
  try {
    const dashSrc = require('fs').readFileSync(require('path').join(__dirname, 'dashboard-server.js'), 'utf8');
    const match = dashSrc.match(/const LOCAL_INTEL_WORKERS\s*=\s*\[([\s\S]*?)\];/);
    if (match) {
      // Only count uncommented worker entries
      const activeLines = match[1].split('\n').filter(l => !l.trim().startsWith('//'));
      const lines = activeLines.join('\n').match(/\{\s*name:[^}]+file:\s*'([^']+)'/g) || [];
      dashWorkerFiles = lines.map(l => { const m = l.match(/file:\s*'([^']+)'/); return m ? m[1] : null; }).filter(Boolean);
    }
  } catch (_) {}
  // Merge both lists, deduplicate, exclude MCP (counted separately)
  const allWorkerFiles = [...new Set([
    ...workers.map(w => w.file),
    ...dashWorkerFiles,
  ])].filter(f => f !== 'localIntelMCP.js');
  const DB_WORKERS = allWorkerFiles.filter(usesDb).length;
  const TOTAL_CONNS = DB_WORKERS * WORKER_POOL + MCP_POOL + DASHBOARD_POOL + MAIN_POOL;
  if (TOTAL_CONNS > RAILWAY_PG_CAP) {
    console.warn(`[SWARM] ⚠️  CONNECTION BUDGET WARNING: estimated ${TOTAL_CONNS} conns > cap ${RAILWAY_PG_CAP} — monitor for pool timeouts`);
  } else {
    console.log(`[SWARM] ✅ Connection budget: ${DB_WORKERS} DB workers×${WORKER_POOL} + MCP×${MCP_POOL} + dash×${DASHBOARD_POOL} + main×${MAIN_POOL} = ${TOTAL_CONNS}/${RAILWAY_PG_CAP}`);
  }

  // ── Boot: run DB migrations FIRST — before dashboard/workers spawn ─────────
  // Migrations must run before anything else touches the DB. Running from the
  // dashboard child process (old approach) caused race conditions where all boot
  // processes hammered the pool simultaneously and migration timed out.
  // Retry up to 5×5s = 25s to handle cold-start DB warmup.
  try {
    const { runMigration } = require('./lib/dbMigrate');
    let migOk = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        migOk = await runMigration();
        if (migOk !== false) break;
      } catch (e) {
        console.warn(`[SWARM] Migration attempt ${attempt}/5 failed: ${e.message}`);
      }
      if (attempt < 5) await new Promise(r => setTimeout(r, 5000));
    }
    if (!migOk) console.warn('[SWARM] Migrations did not complete — DB may be unavailable at boot');
  } catch (e) {
    console.warn('[SWARM] Migration runner failed (non-fatal):', e.message);
  }

  // ── Boot: rescore all flat-file confidence scores (deterministic, <1s) ──────
  try {
    require('./scripts/enrichConfidence');
    console.log('[SWARM] Confidence enrichment pass complete');
  } catch (e) {
    console.warn('[SWARM] Confidence enrichment pass failed (non-fatal):', e.message);
  }

  // ── Boot: backfill flat-file businesses → Postgres (idempotent) ─────────────
  // Runs async in background — workers launch immediately, backfill streams in.
  try {
    require('./scripts/backfillBusinesses');
    console.log('[SWARM] Backfill started (async)');
  } catch (e) {
    console.warn('[SWARM] Backfill failed to start (non-fatal):', e.message);
  }


  // ── Boot: preload ZIP neighbor map for nearby-search expansion ────────────
  // Builds haversine 15-mile neighbor map from fl_zip_geo (all 1,473 FL ZIPs).
  // One-time ~2s build, cached in memory. getNearbyZips(zip) resolves instantly.
  try {
    const { loadNeighborMap } = require('./lib/geoExpand');
    loadNeighborMap().catch(e => console.warn('[SWARM] Neighbor map load error (non-fatal):', e.message));
  } catch (e) {
    console.warn('[SWARM] Neighbor map failed to start (non-fatal):', e.message);
  }

  // ── Boot: notification dispatcher — drains notification_queue every 30s ───────────
  // Email via Resend. Free tier: 50 emails/month/business at no cost.
  // Beyond that: wallet required. SMS: always wallet-gated (Twilio).
  try {
    const { start: startNotifyDispatch } = require('./workers/notificationDispatchWorker');
    startNotifyDispatch();
  } catch (e) {
    console.warn('[SWARM] notificationDispatch failed to start (non-fatal):', e.message);
  }

  // ── Boot: seed order_form for all businesses (idempotent, skips already-seeded) ──
  // Adds column if missing, then populates category-template forms for every business.
  // Per-unit write pattern — safe to redeploy mid-run.
  try {
    const { run: seedOrderForms } = require('./workers/orderFormSeedWorker');
    seedOrderForms().catch(e => console.warn('[SWARM] orderFormSeed error (non-fatal):', e.message));

    // Surge split audit — backfills missing split_address on existing Surge merchants, runs weekly
    const { scheduleWeeklyAudit } = require('./workers/surgeAuditWorker');
    scheduleWeeklyAudit();

    // Daily rail report — 8am Eastern email summary of fees + rail distribution
    const { scheduleDailyReport } = require('./workers/railReportWorker');
    scheduleDailyReport();
  } catch (e) {
    console.warn('[SWARM] orderFormSeed failed to start (non-fatal):', e.message);
  }

  // ── Boot: patch ACS columns in zip_intelligence from spendingZones.json ──────────────
  // Reads spendingZones.json (source of truth) → patches wfh_pct, affluence_pct,
  // retiree_index, new_build_pct, vacancy_rate_pct, median_home_value in PG.
  // Runs in <1s, idempotent, fixes any deploy where oracle_json had zeros.
  try {
    const { patchAcsFromZones } = require('./scripts/patchAcsFromZones');
    patchAcsFromZones().catch(e => console.warn('[SWARM] ACS patch error (non-fatal):', e.message));
    console.log('[SWARM] ACS patch from spendingZones started');
  } catch (e) {
    console.warn('[SWARM] ACS patch failed to start (non-fatal):', e.message);
  }

  // Wait for main server pool to stabilize before spawning any worker
  console.log(`[SWARM] Waiting ${BOOT_DELAY_MS / 1000}s for DB pool to settle before spawning workers…`);
  await new Promise((r) => setTimeout(r, BOOT_DELAY_MS));

  for (let i = 0; i < workers.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, STAGGER_DELAY_MS));
    spawnWorker(workers[i]);
  }
})();

// ── Dashboard server ──────────────────────────────────────────────────────────
// Spawn as a child process so it gets Railway's PORT env var for public access
function spawnDashboard() {
  const dashPath = path.join(__dirname, 'dashboard-server.js');
  const proc = fork(dashPath, [], {
    env: { ...process.env, PORT: '8080', DB_POOL_MAX: '2' },  // dashboard reads only; PgBouncer pool=200 handles all concurrent slots
    stdio: 'inherit',
  });
  proc.on('exit', (code) => {
    console.error(`[dashboard] Process exited with code ${code}, restarting in 3s...`);
    setTimeout(() => { dashProc = spawnDashboard(); }, 3000);
  });
  console.log('[SWARM] Dashboard server started');
  return proc;
}

let dashProc = spawnDashboard();

// ── LocalIntel MCP server ───────────────────────────────────────────────
// HTTP server — needs DB_POOL_MAX=2 for concurrent MCP tool calls
// Budget: 21 data workers×1 + MCP×2 + dashboard×2 + main×2 ≪ 200 PgBouncer pool cap
function spawnMCP() {
  const mcpPath = path.join(__dirname, 'localIntelMCP.js');
  const proc = fork(mcpPath, [], {
    silent: false,
    env: { ...process.env, DB_POOL_MAX: '2' },
  });
  proc.on('exit', (code) => {
    console.error(`[MCP] Process exited with code ${code}, restarting in 3s...`);
    setTimeout(() => spawnMCP(), 3000);
  });
  console.log('[SWARM] LocalIntel MCP server started');
  return proc;
}
spawnMCP();

// ── Internal health-check server (fixed port, not Railway's PORT) ─────────────
const app = express();
const HEALTH_PORT = 3001;

// Raiders routes
const raidersRouter = require('./routes/raiders');
app.use('/api/raiders', raidersRouter);

// Local Intel agent routes
// Cap the main-process pool to 3 — admin endpoints (run-trade-signals, reset-heartbeat) do
// multiple sequential queries; pool=2 caused timeouts under any concurrency.
// MUST be set before require() so lib/db.js picks it up at pool creation time.
if (!process.env.DB_POOL_MAX) process.env.DB_POOL_MAX = '2'; // main process: 2 slots (down from 3) to reserve more for search traffic
const localIntelRouter = require('./localIntelAgent');
app.use('/api/local-intel', localIntelRouter);

// Merchant portal alias — same router, exposes /api/merchant/request-link
// and /api/merchant/dashboard/:token at the documented merchant URL.
app.use('/api/merchant', (req, res, next) => {
  // Re-route /api/merchant/* → /api/local-intel/merchant/* so the existing
  // router matches without duplicating handlers.
  req.url = '/merchant' + (req.url === '/' ? '' : req.url);
  return localIntelRouter(req, res, next);
});

app.get('/', (req, res) => res.json({
  status: 'ONLINE',
  swarm: 'GSB Intelligence Swarm',
  workers: workers.map((w) => w.name),
  uptime_seconds: Math.floor(process.uptime()),
  message: 'Thou shalt never run out of GAS',
}));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Skill Feedback API ────────────────────────────────────────────────────────
app.get('/api/skill-report', (req, res) => {
  const report = getSkillReport();
  const filtered = req.query.agent
    ? report.filter(r => r.agentName.toLowerCase().includes(req.query.agent.toLowerCase()))
    : report;
  res.json({ ok: true, skills: filtered, generatedAt: Date.now() });
});

app.post('/api/skill-reset', express.json(), (req, res) => {
  const { agentName, skillId, secret } = req.body || {};
  if (secret !== process.env.OPERATOR_SECRET) return res.status(403).json({ error: 'forbidden' });
  if (!agentName || !skillId) return res.status(400).json({ error: 'agentName + skillId required' });
  resetSkill(agentName, skillId);
  res.json({ ok: true, message: `Reset ${agentName}::${skillId}` });
});

// ── ACP Sync — on-demand endpoint ───────────────────────────────────────────
// Called by the swarm dashboard "Sync ACP" button.
// Also runs automatically on the 1st of every month at 06:00 UTC.
let acpSyncRunning = false;

async function runAcpSync() {
  if (acpSyncRunning) return { ok: false, error: 'Sync already in progress' };
  acpSyncRunning = true;
  const started = Date.now();
  try {
    console.log('[acpSync] Starting ACP sync...');
    await registerResources();
    await registerOfferings();
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`[acpSync] Done in ${elapsed}s`);
    return { ok: true, elapsed: `${elapsed}s`, ranAt: new Date().toISOString() };
  } catch (e) {
    console.warn('[acpSync] Error:', e.message);
    return { ok: false, error: e.message };
  } finally {
    acpSyncRunning = false;
  }
}

app.post('/api/acp-sync', express.json(), async (req, res) => {
  const { secret } = req.body || {};
  if (secret !== process.env.OPERATOR_SECRET) return res.status(403).json({ error: 'forbidden' });
  const result = await runAcpSync();
  res.status(result.ok ? 200 : 500).json(result);
});

// ── Monthly cron — 1st of month, 06:00 UTC ───────────────────────────────────
function scheduleMonthlySync() {
  function msUntilNextSync() {
    const now = new Date();
    const next = new Date(Date.UTC(
      now.getUTCMonth() === 11 ? now.getUTCFullYear() + 1 : now.getUTCFullYear(),
      now.getUTCMonth() === 11 ? 0 : now.getUTCMonth() + 1,
      1, 6, 0, 0, 0
    ));
    return next.getTime() - now.getTime();
  }
  const ms = msUntilNextSync();
  // Cap at 2^31-1 ms (~24.8 days) to avoid Node.js 32-bit signed int overflow
  // which would clamp the value to 1ms and create an infinite tight loop.
  // scheduleMonthlySync re-arms itself, so if the cap fires early (ms > 24.8d)
  // it will simply re-calculate and wait again — correctness is preserved.
  const MAX_TIMEOUT = 2147483647; // 2^31 - 1
  const safems = Math.min(ms, MAX_TIMEOUT);
  const days = (ms / 86400000).toFixed(1);
  console.log(`[acpSync] Monthly sync scheduled — next run in ${days} days`);
  setTimeout(() => {
    if (ms > MAX_TIMEOUT) {
      // Fired early due to 32-bit cap — re-arm, don't run sync yet
      scheduleMonthlySync();
      return;
    }
    runAcpSync().catch(e => console.warn('[acpSync monthly]', e.message));
    scheduleMonthlySync(); // re-arm for next month
  }, safems);
}
scheduleMonthlySync();

// ── Agent Card / Well-Known ──────────────────────────────────────────────────
const AGENT_CARD = {
  schema_version: 'v1',
  name: 'LocalIntel Data Services',
  description: 'Hyperlocal business intelligence for AI agents. ZIP-level business data covering Florida and expanding across the Sunbelt. Phone, hours, foot traffic proxy, categories, confidence scores. Pay-per-query via pathUSD.',
  url: 'https://gsb-swarm-production.up.railway.app',
  mcp_endpoint: 'https://gsb-swarm-production.up.railway.app/api/local-intel/mcp',
  a2a_endpoint: 'https://gsb-swarm-production.up.railway.app/api/local-intel/mcp',
  skills: ['nearby_businesses', 'corridor_data', 'zip_stats', 'zone_context', 'business_search', 'change_detection'],
  pricing: { per_call: '$0.01-0.05', currency: 'pathUSD', subscription: '$49-499/month' },
  coverage: { current: 'Florida SJC zips + expanding', target: 'Florida 983 zips, then full Sunbelt' },
  contact: 'localintel@mcflamingo.com',
  provider: 'LocalIntel Data Services / MCFL Restaurant Holdings LLC',
};

app.get('/.well-known/agent.json', (req, res) => {
  res.json(AGENT_CARD);
});

app.listen(HEALTH_PORT, () => {
  console.log(`\n[SWARM] Health check running on port ${HEALTH_PORT}`);
  console.log(`[SWARM] All ${workers.length} workers active. Swarm is LIVE.\n`);

  // ── Intelligence layer: nightly aggregation at 2am Eastern ──────────────
  // Rolls task_events → task_patterns + business_responsiveness
  try {
    const { scheduleNightly } = require('./workers/intelligenceAggWorker');
    scheduleNightly();
  } catch (e) {
    console.error('[SWARM] intelligenceAggWorker schedule failed (non-fatal):', e.message);
  }
});

process.on('SIGTERM', () => {
  console.log('[SWARM] Shutting down gracefully...');
  processes.forEach((p) => p.kill());
  dashProc && dashProc.kill();
  process.exit(0);
});
