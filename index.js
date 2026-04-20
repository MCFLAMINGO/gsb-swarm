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
  { name: 'Token Analyst',      file: 'tokenAnalyst.js' },
  { name: 'Wallet Profiler',    file: 'walletProfiler.js' },
  { name: 'Alpha Scanner',      file: 'alphaScanner.js' },
  { name: 'Thread Writer',      file: 'threadWriter.js' },
  { name: 'Local Intel',        file: 'localIntelWorker.js' },
  ...(process.env.FINANCIAL_ANALYST_ENTITY_ID
    ? [{ name: 'Financial Analyst', file: 'financialAnalyst.js' }]
    : []),
];

console.log(`
╔══════════════════════════════════════════════════════════╗
║         GSB INTELLIGENCE SWARM — ACTIVATING             ║
║         Agent Gas Bible · ACP Provider Network          ║
║         Thou shalt never run out of GAS                 ║
╚══════════════════════════════════════════════════════════╝
`);

const processes = [];
const STAGGER_DELAY_MS = 2000; // 2s between each worker to avoid RPC rate limits

function spawnWorker({ name, file }) {
  const workerPath = path.join(__dirname, file);
  const child = fork(workerPath, [], { silent: false, env: process.env });

  child.on('error', (err) => console.error(`[${name}] ERROR: ${err.message}`));
  child.on('exit', (code) => {
    console.log(`[${name}] exited with code ${code}. Restarting in 5s...`);
    setTimeout(() => {
      const newChild = fork(workerPath, [], { silent: false, env: process.env });
      processes.push(newChild);
    }, 5000);
  });

  processes.push(child);
  console.log(`[${name}] Worker started (PID: ${child.pid})`);
}

(async () => {
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
    env: { ...process.env, PORT: '8080' },
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

// ── Internal health-check server (fixed port, not Railway's PORT) ─────────────
const app = express();
const HEALTH_PORT = 3001;

// Raiders routes
const raidersRouter = require('./routes/raiders');
app.use('/api/raiders', raidersRouter);

// Local Intel agent routes
const localIntelRouter = require('./localIntelAgent');
app.use('/api/local-intel', localIntelRouter);

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
  const days = (ms / 86400000).toFixed(1);
  console.log(`[acpSync] Monthly sync scheduled — next run in ${days} days`);
  setTimeout(() => {
    runAcpSync().catch(e => console.warn('[acpSync monthly]', e.message));
    scheduleMonthlySync(); // re-arm for next month
  }, ms);
}
scheduleMonthlySync();

app.listen(HEALTH_PORT, () => {
  console.log(`\n[SWARM] Health check running on port ${HEALTH_PORT}`);
  console.log(`[SWARM] All ${workers.length} workers active. Swarm is LIVE.\n`);
});

process.on('SIGTERM', () => {
  console.log('[SWARM] Shutting down gracefully...');
  processes.forEach((p) => p.kill());
  dashProc && dashProc.kill();
  process.exit(0);
});
