/**
 * GSB INTELLIGENCE SWARM — Master Entry Point
 * Starts all 4 workers as child processes.
 */

require('dotenv').config();
const { fork } = require('child_process');
const path = require('path');
const express = require('express');

const workers = [
  { name: 'Token Analyst',      file: 'tokenAnalyst.js' },
  { name: 'Wallet Profiler',    file: 'walletProfiler.js' },
  { name: 'Alpha Scanner',      file: 'alphaScanner.js' },
  { name: 'Thread Writer',      file: 'threadWriter.js' },
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

app.get('/', (req, res) => res.json({
  status: 'ONLINE',
  swarm: 'GSB Intelligence Swarm',
  workers: workers.map((w) => w.name),
  uptime_seconds: Math.floor(process.uptime()),
  message: 'Thou shalt never run out of GAS',
}));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

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
