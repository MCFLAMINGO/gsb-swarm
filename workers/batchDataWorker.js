'use strict';
/**
 * batchDataWorker.js — Sequential macro data runner
 *
 * Runs 10 infrequent macro data workers one at a time using child_process.fork().
 * Each worker gets its own forked process so process.exit() inside any worker
 * only kills that child, not this runner. Workers run serially — only one holds
 * a DB connection at a time, keeping the total connection cost at 1 active slot.
 *
 * After all workers complete, sleeps BATCH_INTERVAL_MS then repeats.
 *
 * Connection budget: DB_POOL_MAX=1 (set by spawnLocalIntelWorker in dashboard-server.js)
 * Cycle interval: 6 hours (macro data doesn't change faster than this)
 */

const { fork } = require('child_process');
const path = require('path');

const BATCH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const WORKER_TIMEOUT_MS = 20 * 60 * 1000;      // 20 min max per worker (safety valve)

// Macro workers in run order — census/ACS first (worldModel depends on them)
const MACRO_WORKERS = [
  { name: 'Census Layer',       file: 'censusLayerWorker.js' },
  { name: 'ACS Worker',         file: 'acsWorker.js' },
  { name: 'BEA Worker',         file: 'beaWorker.js' },
  { name: 'FRED Worker',        file: 'fredWorker.js' },
  { name: 'LODES Worker',       file: 'lodesWorker.js' },
  { name: 'IRS SOI Worker',     file: 'irsSoiWorker.js' },
  { name: 'IRS Migration',      file: 'irsMigrationWorker.js' },
  { name: 'FCC Broadband',      file: 'fccBroadbandWorker.js' },
  { name: 'School Enrollment',  file: 'schoolEnrollmentWorker.js' },
  { name: 'World Model',        file: 'worldModelWorker.js' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function runWorkerChild(w) {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, w.file);
    const child = fork(workerPath, [], {
      silent: false,
      env: {
        ...process.env,
        DB_POOL_MAX: '1',
        NODE_OPTIONS: '--max-old-space-size=512',
      },
    });

    const timeout = setTimeout(() => {
      console.warn(`[batch-data] ${w.name} timed out after ${WORKER_TIMEOUT_MS / 60000}m — killing`);
      child.kill('SIGTERM');
      reject(new Error('timeout'));
    }, WORKER_TIMEOUT_MS);

    child.on('error', err => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 || code === null) {
        resolve();
      } else {
        reject(new Error(`exited with code ${code} signal ${signal}`));
      }
    });
  });
}

async function runBatch() {
  console.log(`[batch-data] Starting macro data cycle — ${MACRO_WORKERS.length} workers`);
  const start = Date.now();

  for (const w of MACRO_WORKERS) {
    const wStart = Date.now();
    try {
      console.log(`[batch-data] → Running ${w.name}...`);
      await runWorkerChild(w);
      const elapsed = ((Date.now() - wStart) / 1000).toFixed(1);
      console.log(`[batch-data] ✓ ${w.name} done in ${elapsed}s`);
    } catch (err) {
      console.error(`[batch-data] ✗ ${w.name} failed: ${err.message} — continuing`);
    }

    // 3s gap between workers — let the previous connection fully release
    await sleep(3000);
  }

  const totalMin = ((Date.now() - start) / 60000).toFixed(1);
  console.log(`[batch-data] Cycle complete in ${totalMin}m — sleeping ${BATCH_INTERVAL_MS / 3600000}h`);
}

(async () => {
  // Wait 10 minutes after boot before first run — lets high-priority workers
  // (zipCoordinator, enrichment, permits) establish their connections first
  console.log('[batch-data] Macro data batch runner online — first cycle in 10m');
  await sleep(10 * 60 * 1000);

  while (true) {
    await runBatch();
    await sleep(BATCH_INTERVAL_MS);
  }
})();
