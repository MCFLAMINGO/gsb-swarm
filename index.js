/**
 * GSB INTELLIGENCE SWARM — Master Entry Point
 * Starts all 4 workers as child processes.
 */

require('dotenv').config();
const { fork } = require('child_process');
const path = require('path');
const express = require('express');

const workers = [
  { name: 'Token Analyst',   file: 'tokenAnalyst.js' },
  { name: 'Wallet Profiler', file: 'walletProfiler.js' },
  { name: 'Alpha Scanner',   file: 'alphaScanner.js' },
  { name: 'Thread Writer',   file: 'threadWriter.js' },
];

console.log(`
╔══════════════════════════════════════════════════════════╗
║         GSB INTELLIGENCE SWARM — ACTIVATING             ║
║         Agent Gas Bible · ACP Provider Network          ║
║         Thou shalt never run out of GAS                 ║
╚══════════════════════════════════════════════════════════╝
`);

const processes = [];

workers.forEach(({ name, file }) => {
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
});

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.json({
  status: 'ONLINE',
  swarm: 'GSB Intelligence Swarm',
  workers: workers.map((w) => w.name),
  uptime_seconds: Math.floor(process.uptime()),
  message: 'Thou shalt never run out of GAS',
}));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`\n[SWARM] Health check running on port ${PORT}`);
  console.log(`[SWARM] All ${workers.length} workers active. Swarm is LIVE.\n`);
});

process.on('SIGTERM', () => {
  console.log('[SWARM] Shutting down gracefully...');
  processes.forEach((p) => p.kill());
  process.exit(0);
});
