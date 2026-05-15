// On-demand worker runner.
//
// Spawns workers as detached child processes. Mirrors the dashboard-server.js
// LOCAL_INTEL_WORKERS launcher pattern so behavior is consistent between
// daemon launch (boot-time fork) and ad-hoc trigger (admin HTTP POST).
//
// Exposes:
//   runWorker(workerName)  → { workerName, pid, status: 'started' | 'already_running' | 'error' }
//   runGroup(groupName)    → [{ workerName, ... }]
//   listGroups()           → group → [worker, ...]
//   isRunning(workerName)  → bool

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORKERS_DIR = path.join(__dirname, '..', 'workers');

// Daemon workers from dashboard-server.js LOCAL_INTEL_WORKERS — used for
// status reporting so callers see which workers are already running as
// background daemons vs available on-demand.
const DAEMON_WORKERS = [
  'zipCoordinatorWorker',
  'enrichmentAgent',
  'acpBroadcaster',
  'bedrockWorker',
  'oracleWorker',
  'oceanFloorWorker',
  'surfaceCurrentWorker',
  'waveSurfaceWorker',
  'verticalAgentWorker',
  'censusLayerWorker',
  'overpassWorker',
  'localIntelAcpCycle',
  'routerLearningWorker',
  'enrichmentFillWorker',
  'taskSeedWorker',
  'businessMergeWorker',
  'zipBriefWorker',
  'hoursParseWorker',
  'acsWorker',
  'searchVectorBackfillWorker',
  'categoryReclassWorker',
  'permitWorker',
  'fdotWorker',
];

const DISABLED_WORKERS = [
  'btrWorker',
  'promptEvolutionWorker',
  'irsSoiWorker',
  'irsMigrationWorker',
  'fccBroadbandWorker',
  'worldModelWorker',
];

const WORKER_GROUPS = {
  search_quality:    ['searchVectorBackfillWorker', 'routerLearningWorker'],
  enrichment:        ['enrichmentFillWorker', 'hoursParseWorker', 'bbbScraper', 'yellowPagesScraper', 'chamberScraper'],
  world_model:       ['worldModelWorker', 'irsSoiWorker', 'irsMigrationWorker', 'fccBroadbandWorker'],
  real_estate:       ['btrWorker', 'sjcArcGisWorker', 'permitWorker'],
  self_improvement:  ['promptEvolutionWorker'],
  data_ingestion:    ['overpassWorker', 'acsWorker', 'censusLayerWorker', 'oceanFloorWorker', 'fdotWorker'],
  infrastructure:    ['zipBriefWorker', 'zipCoordinatorWorker', 'waveSurfaceWorker', 'surfaceCurrentWorker', 'oracleWorker'],
};

// In-memory registry of workers spawned by this runner. Prevents double-spawn
// of the same on-demand worker. Cleared when the entry exits.
const runningRegistry = new Map(); // workerName → { pid, startedAt }

function isRunning(workerName) {
  return runningRegistry.has(workerName);
}

function runWorker(workerName) {
  if (!workerName || typeof workerName !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(workerName)) {
    return Promise.resolve({ workerName, status: 'error', error: 'invalid worker name' });
  }

  if (isRunning(workerName)) {
    const entry = runningRegistry.get(workerName);
    return Promise.resolve({ workerName, pid: entry.pid, status: 'already_running' });
  }

  const workerPath = path.join(WORKERS_DIR, workerName + '.js');
  if (!fs.existsSync(workerPath)) {
    return Promise.resolve({ workerName, status: 'error', error: `worker file not found: workers/${workerName}.js` });
  }

  try {
    const child = spawn('node', [workerPath], {
      detached: true,
      stdio: 'pipe',
      env: process.env,
    });

    const pid = child.pid;
    runningRegistry.set(workerName, { pid, startedAt: Date.now() });

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        process.stdout.write(`[worker:${workerName}] ${chunk}`);
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        process.stderr.write(`[worker:${workerName}] ${chunk}`);
      });
    }

    child.on('error', (err) => {
      console.error(`[workerRunner] ${workerName} error:`, err.message);
      runningRegistry.delete(workerName);
    });
    child.on('exit', (code, signal) => {
      console.log(`[workerRunner] ${workerName} exited (code=${code}, signal=${signal})`);
      runningRegistry.delete(workerName);
    });

    // Don't keep the parent event loop tied to the child.
    child.unref();

    return Promise.resolve({ workerName, pid, status: 'started' });
  } catch (e) {
    runningRegistry.delete(workerName);
    return Promise.resolve({ workerName, status: 'error', error: e.message });
  }
}

async function runGroup(groupName) {
  const members = WORKER_GROUPS[groupName];
  if (!members) {
    return [{ workerName: null, status: 'error', error: `unknown group: ${groupName}` }];
  }
  const results = [];
  for (const w of members) {
    results.push(await runWorker(w));
  }
  return results;
}

function listGroups() {
  return WORKER_GROUPS;
}

function getCatalogue() {
  const seen = new Set();
  const groups = {};
  for (const [group, members] of Object.entries(WORKER_GROUPS)) {
    groups[group] = members.map((name) => {
      seen.add(name);
      let status;
      if (DAEMON_WORKERS.includes(name)) status = 'active_daemon';
      else if (DISABLED_WORKERS.includes(name)) status = 'disabled';
      else status = 'on_demand';
      const fileExists = fs.existsSync(path.join(WORKERS_DIR, name + '.js'));
      return {
        worker: name,
        status,
        file_exists: fileExists,
        spawned_this_session: runningRegistry.has(name),
        pid: runningRegistry.has(name) ? runningRegistry.get(name).pid : null,
      };
    });
  }
  return {
    groups,
    daemon_workers: DAEMON_WORKERS,
    disabled_workers: DISABLED_WORKERS,
    running_on_demand: Array.from(runningRegistry.entries()).map(([name, info]) => ({
      worker: name,
      pid: info.pid,
      started_at: new Date(info.startedAt).toISOString(),
      uptime_ms: Date.now() - info.startedAt,
    })),
  };
}

module.exports = {
  runWorker,
  runGroup,
  listGroups,
  getCatalogue,
  isRunning,
  WORKER_GROUPS,
  DAEMON_WORKERS,
  DISABLED_WORKERS,
};
