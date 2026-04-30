/**
 * ZipCoordinatorWorker.js
 * 
 * Autonomous coordinator that maintains a priority queue of ZIP codes,
 * spawns ZipAgent runs, tracks coverage, and drives the Florida/Sunbelt
 * expansion without any human involvement.
 * 
 * Port: 3006
 * Priority: highest-population ZIPs first
 * Coverage file: data/zipCoverage.json
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { ALL_SUNBELT_ZIPS, getZipsByPhase, getSummary: getSunbeltSummary } = require('./sunbeltZipRegistry');

const PORT = 3006;
const DATA_DIR = path.join(__dirname, '../data');
const ZIPS_DIR = path.join(DATA_DIR, 'zips');
const COVERAGE_FILE = path.join(DATA_DIR, 'zipCoverage.json');
const QUEUE_FILE = path.join(DATA_DIR, 'zipQueue.json');
const LEDGER_FILE = path.join(DATA_DIR, 'usageLedger.json');

// FL priority seeds — SJC + major metro anchors only.
// Full 1013-ZIP FL list is loaded from flZipRegistry.js at runtime.
// Non-FL states live in sunbeltZipRegistry.js and are phase-gated.
const FL_ZIPS_PRIORITY = [
  { zip: '32082', region: 'SJC', priority: 100, lat: 30.1893, lon: -81.3815, name: 'Ponte Vedra Beach' },
  { zip: '32081', region: 'SJC', priority: 100, lat: 30.1100, lon: -81.4175, name: 'Nocatee' },
  { zip: '32084', region: 'SJC', priority:  90, lat: 29.8957, lon: -81.3153, name: 'St. Augustine' },
  { zip: '32086', region: 'SJC', priority:  90, lat: 29.8360, lon: -81.2760, name: 'St. Augustine South' },
  { zip: '32092', region: 'SJC', priority:  85, lat: 30.0579, lon: -81.5279, name: 'World Golf Village' },
  { zip: '32095', region: 'SJC', priority:  80, lat: 30.1579, lon: -81.4140, name: 'St. Johns North' },
  { zip: '32080', region: 'SJC', priority:  80, lat: 29.8643, lon: -81.2682, name: 'St. Augustine Beach' },
  { zip: '32259', region: 'SJC', priority:  75, lat: 30.0830, lon: -81.5557, name: 'Switzerland' },
  // Jacksonville metro
  { zip: '32256', region: 'JAX', priority:  88, lat: 30.1983, lon: -81.5548, name: 'Jacksonville SE' },
  { zip: '32258', region: 'JAX', priority:  85, lat: 30.1396, lon: -81.5523, name: 'Jacksonville SW' },
  { zip: '32223', region: 'JAX', priority:  83, lat: 30.1512, lon: -81.6398, name: 'Mandarin' },
  { zip: '32225', region: 'JAX', priority:  82, lat: 30.3512, lon: -81.4762, name: 'Jacksonville NE' },
  { zip: '32246', region: 'JAX', priority:  80, lat: 30.2768, lon: -81.4987, name: 'Jacksonville E' },
  // Tampa metro
  { zip: '33629', region: 'TPA', priority:  87, lat: 27.9212, lon: -82.5148, name: 'South Tampa' },
  { zip: '33618', region: 'TPA', priority:  85, lat: 28.0512, lon: -82.5148, name: 'Carrollwood' },
  { zip: '33647', region: 'TPA', priority:  83, lat: 28.1412, lon: -82.3748, name: 'New Tampa' },
  { zip: '34202', region: 'TPA', priority:  81, lat: 27.4512, lon: -82.4548, name: 'Lakewood Ranch' },
  { zip: '33626', region: 'TPA', priority:  79, lat: 28.0612, lon: -82.6148, name: 'Westchase' },
  // Orlando metro
  { zip: '32828', region: 'ORL', priority:  86, lat: 28.5212, lon: -81.1748, name: 'East Orlando' },
  { zip: '32836', region: 'ORL', priority:  84, lat: 28.3912, lon: -81.5148, name: 'Dr. Phillips' },
  { zip: '34786', region: 'ORL', priority:  82, lat: 28.4512, lon: -81.5948, name: 'Windermere' },
  { zip: '32771', region: 'ORL', priority:  80, lat: 28.8012, lon: -81.3148, name: 'Sanford' },
  { zip: '34711', region: 'ORL', priority:  78, lat: 28.5612, lon: -81.7748, name: 'Clermont' },
  // South Florida
  { zip: '33458', region: 'SFL', priority:  85, lat: 26.9212, lon: -80.1048, name: 'Jupiter' },
  { zip: '33496', region: 'SFL', priority:  83, lat: 26.3812, lon: -80.1448, name: 'Boca Raton N' },
  { zip: '33433', region: 'SFL', priority:  81, lat: 26.3512, lon: -80.1648, name: 'Boca Raton' },
  { zip: '33076', region: 'SFL', priority:  79, lat: 26.3612, lon: -80.2648, name: 'Parkland' },
  { zip: '33326', region: 'SFL', priority:  77, lat: 26.1312, lon: -80.3648, name: 'Weston' },
];

// ── Phase gate ────────────────────────────────────────────────────────────────
// FL must reach FL_PHASE_GATE_PCT% before non-FL ZIPs are added to the queue.
// Non-FL ZIPs are registered in sunbeltZipRegistry.js but never queued until unlocked.
const FL_PHASE_GATE_PCT = 95; // percent of FL ZIPs complete to unlock Phase 2

// ── Budget Gate ──────────────────────────────────────────────────────────────

let revenue7d = 0;
let gateStatus = 'zero_revenue';

function checkBudgetGate() {
  if (!fs.existsSync(LEDGER_FILE)) {
    CONCURRENT_AGENTS = 2;
    revenue7d = 0;
    gateStatus = 'no_ledger';
    console.log('[ZipCoordinator] Budget gate: no ledger found — defaulting to 2 agents (conservative start)');
    return;
  }

  let ledger = [];
  try {
    ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  } catch (e) {
    CONCURRENT_AGENTS = 2;
    revenue7d = 0;
    gateStatus = 'ledger_parse_error';
    console.log('[ZipCoordinator] Budget gate: ledger parse error — defaulting to 2 agents');
    return;
  }

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  revenue7d = ledger
    .filter(entry => entry.timestamp && new Date(entry.timestamp).getTime() >= sevenDaysAgo)
    .reduce((sum, entry) => sum + (entry.amount || 0), 0);

  if (revenue7d === 0) {
    CONCURRENT_AGENTS = 6; // Pre-revenue: run full FL expansion — data is the asset
    gateStatus = 'zero_revenue';
    console.log('[ZipCoordinator] Budget gate: zero revenue — running 6 agents for FL expansion (data-first mode)');
  } else if (revenue7d < 5) {
    CONCURRENT_AGENTS = 5;
    gateStatus = 'low_revenue';
    console.log(`[ZipCoordinator] Budget gate: revenue7d=$${revenue7d.toFixed(4)} — setting 5 agents`);
  } else {
    CONCURRENT_AGENTS = 10;
    gateStatus = 'full';
    console.log(`[ZipCoordinator] Budget gate: revenue7d=$${revenue7d.toFixed(4)} — setting 10 agents`);
  }
}

// ── State ─────────────────────────────────────────────────────────────────────

const pgStore = require('../lib/pgStore');

// Coverage is now Postgres-only — no flat file
// In-memory coverage cache is rebuilt from Postgres on every start
let _coverageCache = null;

async function loadCoverage() {
  if (_coverageCache) return _coverageCache;
  try {
    const pgCoverage = await pgStore.getZipCoverage();
    const coverage = { completed: {}, inProgress: {}, failed: {}, lastRun: null };
    for (const [zip, info] of Object.entries(pgCoverage)) {
      if (info.status === 'done') coverage.completed[zip] = { worker: info.worker, count: info.record_count };
    }
    _coverageCache = coverage;
    console.log(`[ZipCoordinator] Loaded ${Object.keys(coverage.completed).length} completed ZIPs from Postgres`);
    return coverage;
  } catch (e) {
    console.warn('[ZipCoordinator] Could not load coverage from Postgres:', e.message);
    return { completed: {}, inProgress: {}, failed: {}, lastRun: null };
  }
}

function saveCoverage(coverage) {
  // Update in-memory cache; Postgres is written by markZipProcessed() in zipAgent
  _coverageCache = coverage;
  const completed = coverage.completed || {};
  Object.entries(completed).forEach(([zip, info]) => {
    pgStore.markZipProcessed(zip, info?.worker || 'zipCoordinator', info?.count || 0)
      .catch(() => {});
  });
}

// No-op: kept for call-site compat — Postgres restore is now done in loadCoverage()
async function restoreCoverageFromPostgres() {
  _coverageCache = null; // force reload on next loadCoverage() call
  console.log('[ZipCoordinator] Coverage cache cleared — will reload from Postgres');
}

function getFlCoveragePct(queue) {
  const flZips = queue.filter(z => !z.state || z.state === 'FL');
  if (!flZips.length) return 0;
  const done = flZips.filter(z => z.status === 'complete').length;
  return Math.round(done / flZips.length * 100);
}

function buildFullQueue(existingQueue) {
  // ── Step 1: FL ZIPs ────────────────────────────────────────────────────────
  let registry = [];
  try {
    const { getAllZips } = require('./flZipRegistry');
    registry = getAllZips();
  } catch (e) {
    console.warn('[ZipCoordinator] flZipRegistry unavailable:', e.message);
  }

  const seen = new Set();
  const queue = [];

  // Priority FL seeds first
  FL_ZIPS_PRIORITY.forEach(z => {
    seen.add(z.zip);
    queue.push({ ...z, state: 'FL', phase: 1, status: 'pending', attempts: 0 });
  });

  // Remaining FL from registry
  registry
    .filter(z => !seen.has(z.zip) && z.lat && z.lon)
    .sort((a, b) => (b.population || 0) - (a.population || 0))
    .forEach(z => {
      seen.add(z.zip);
      queue.push({
        zip: z.zip, state: 'FL', region: 'FL', phase: 1,
        priority: Math.min(60, Math.max(1, Math.round((z.population || 1000) / 1000))),
        lat: z.lat, lon: z.lon, name: z.zip,
        status: 'pending', attempts: 0,
      });
    });

  console.log(`[ZipCoordinator] FL queue: ${queue.length} ZIPs`);

  // ── Step 2: Check phase gate — only add non-FL if FL ≥ 95% ────────────────
  const existing = existingQueue || [];
  const flPct = existing.length ? getFlCoveragePct(existing) : 0;
  const unlockedPhases = new Set([1]);

  if (flPct >= FL_PHASE_GATE_PCT) {
    unlockedPhases.add(2);
    console.log(`[ZipCoordinator] Phase gate: FL at ${flPct}% — Phase 2 (TX/AL/MS/LA) UNLOCKED`);
  } else {
    console.log(`[ZipCoordinator] Phase gate: FL at ${flPct}% — non-FL ZIPs locked until ${FL_PHASE_GATE_PCT}%`);
  }

  // Phase 3/4/5 gate: Phase 2 must be ≥95% complete
  if (unlockedPhases.has(2)) {
    const p2Zips = existing.filter(z => z.phase === 2);
    const p2Pct = p2Zips.length
      ? Math.round(p2Zips.filter(z => z.status === 'complete').length / p2Zips.length * 100)
      : 0;
    if (p2Pct >= FL_PHASE_GATE_PCT) { unlockedPhases.add(3); }
    if (unlockedPhases.has(3)) {
      const p3Zips = existing.filter(z => z.phase === 3);
      const p3Pct = p3Zips.length
        ? Math.round(p3Zips.filter(z => z.status === 'complete').length / p3Zips.length * 100)
        : 0;
      if (p3Pct >= FL_PHASE_GATE_PCT) { unlockedPhases.add(4); }
      if (unlockedPhases.has(4)) {
        const p4Zips = existing.filter(z => z.phase === 4);
        const p4Pct = p4Zips.length
          ? Math.round(p4Zips.filter(z => z.status === 'complete').length / p4Zips.length * 100)
          : 0;
        if (p4Pct >= FL_PHASE_GATE_PCT) { unlockedPhases.add(5); }
      }
    }
  }

  // ── Step 3: Add non-FL ZIPs for unlocked phases ───────────────────────────
  const statusMap = {};
  existing.forEach(z => { statusMap[z.zip] = { status: z.status, attempts: z.attempts }; });

  ALL_SUNBELT_ZIPS.forEach(z => {
    if (seen.has(z.zip)) return;
    if (!unlockedPhases.has(z.phase)) return;
    seen.add(z.zip);
    queue.push({
      ...z, status: 'pending', attempts: 0,
      ...(statusMap[z.zip] || {}),
    });
  });

  console.log(`[ZipCoordinator] Total queue: ${queue.length} ZIPs | Unlocked phases: ${[...unlockedPhases].join(',')}`);
  return queue;
}

function buildFullFlQueue() {
  // Legacy alias — called on first boot when no existing queue exists
  return buildFullQueue([]);
}

function loadQueue() {
  if (fs.existsSync(QUEUE_FILE)) {
    const existing = JSON.parse(fs.readFileSync(QUEUE_FILE));
    // Rebuild queue each load to pick up phase gate unlocks and new state ZIPs
    const fullQueue = buildFullQueue(existing);
    // Only rewrite if meaningfully different (new ZIPs added or phase unlocked)
    if (fullQueue.length !== existing.length) {
      console.log(`[ZipCoordinator] Queue expanded: ${existing.length} → ${fullQueue.length} ZIPs`);
      fs.writeFileSync(QUEUE_FILE, JSON.stringify(fullQueue, null, 2));
    }
    return fullQueue;
  }
  // First run — build full FL queue
  const queue = buildFullFlQueue();
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
  return queue;
}

function saveQueue(queue) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

// ── Coordinator Loop ──────────────────────────────────────────────────────────

let CONCURRENT_AGENTS = 2; // Controlled by checkBudgetGate() — starts conservative
let activeAgents = {};
let isRunning = false;

async function runZipAgent(zipEntry) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    console.log(`[ZipCoordinator] Spawning ZipAgent for ${zipEntry.zip} (${zipEntry.name})`);

    const agent = spawn('node', [
      path.join(__dirname, 'zipAgent.js'),
      '--zip', zipEntry.zip,
      '--lat', zipEntry.lat,
      '--lon', zipEntry.lon,
      '--region', zipEntry.region,
      '--state', zipEntry.state || 'FL',
      '--name', zipEntry.name || zipEntry.zip,
    ], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    agent.stdout.on('data', d => { stdout += d.toString(); });
    agent.stderr.on('data', d => { stderr += d.toString(); });

    agent.on('close', (code) => {
      const duration = Date.now() - startTime;
      const success = code === 0;
      console.log(`[ZipCoordinator] ${zipEntry.zip} ${success ? '✓' : '✗'} (${(duration/1000).toFixed(1)}s)`);
      if (!success) console.error(`[ZipCoordinator] ${zipEntry.zip} stderr:`, stderr.slice(0, 500));
      resolve({ success, stdout, stderr, duration });
    });

    agent.on('error', (err) => {
      console.error(`[ZipCoordinator] Failed to spawn agent for ${zipEntry.zip}:`, err.message);
      resolve({ success: false, error: err.message, duration: Date.now() - startTime });
    });

    // Timeout safety — kill after 5 minutes
    setTimeout(() => {
      try { agent.kill(); } catch(e) {}
      resolve({ success: false, error: 'timeout', duration: Date.now() - startTime });
    }, 5 * 60 * 1000);
  });
}

async function coordinatorCycle() {
  if (isRunning) return;
  isRunning = true;

  checkBudgetGate();

  const coverage = await loadCoverage();
  const queue = loadQueue();

  // Reset stuck in-progress (older than 10 mins)
  const now = Date.now();
  queue.forEach(z => {
    if (z.status === 'inProgress' && z.startedAt && (now - z.startedAt) > 10 * 60 * 1000) {
      z.status = 'pending';
      z.startedAt = null;
    }
  });

  // Get pending ZIPs sorted by priority
  const pending = queue
    .filter(z => z.status === 'pending' && z.attempts < 3)
    .sort((a, b) => b.priority - a.priority);

  if (pending.length === 0) {
    // Check if all ZIPs are complete (not just exhausted/failed)
    const allComplete = queue.every(z => z.status === 'complete' || z.status === 'failed');
    if (allComplete) {
      const lastRun = coverage.lastRun ? new Date(coverage.lastRun).getTime() : 0;
      const hoursSinceRun = (Date.now() - lastRun) / (1000 * 60 * 60);
      const REFRESH_HOURS = 6; // Re-enrich every 6 hours to keep feed live
      if (hoursSinceRun >= REFRESH_HOURS) {
        console.log(`[ZipCoordinator] Full cycle complete — resetting all ZIPs for re-enrichment (${hoursSinceRun.toFixed(1)}h since last run)`);
        queue.forEach(z => {
          z.status = 'pending';
          z.attempts = 0;
          z.startedAt = null;
        });
        coverage.lastRun = new Date().toISOString();
        saveCoverage(coverage);
        saveQueue(queue);
        isRunning = false;
        return; // next cycle will pick up the reset queue
      } else {
        console.log(`[ZipCoordinator] Coverage cycle complete. Next re-enrichment in ${(REFRESH_HOURS - hoursSinceRun).toFixed(1)}h`);
      }
    }
    coverage.lastRun = new Date().toISOString();
    saveCoverage(coverage);
    saveQueue(queue);
    isRunning = false;
    return;
  }

  const slots = CONCURRENT_AGENTS - Object.keys(activeAgents).length;
  const batch = pending.slice(0, slots);

  console.log(`[ZipCoordinator] Dispatching ${batch.length} agents (${pending.length} pending, ${Object.keys(activeAgents).length} active)`);

  // Mark as in-progress
  batch.forEach(z => {
    z.status = 'inProgress';
    z.startedAt = Date.now();
    z.attempts = (z.attempts || 0) + 1;
    activeAgents[z.zip] = true;
  });
  saveQueue(queue);

  // Run batch in parallel
  const results = await Promise.all(batch.map(z => runZipAgent(z)));

  results.forEach((result, i) => {
    const z = batch[i];
    delete activeAgents[z.zip];

    if (result.success) {
      z.status = 'complete';
      z.completedAt = new Date().toISOString();

      // Read business count from the zip file written by ZipAgent
      let bizCount = 0;
      let avgConf = 0;
      try {
        const zipFile = path.join(ZIPS_DIR, `${z.zip}.json`);
        if (fs.existsSync(zipFile)) {
          const bizs = JSON.parse(fs.readFileSync(zipFile));
          bizCount = Array.isArray(bizs) ? bizs.length : 0;
          if (bizCount > 0) {
            avgConf = Math.round(bizs.reduce((s, b) => s + (b.confidence || 0), 0) / bizCount);
          }
        }
      } catch(e) { /* non-fatal */ }

      coverage.completed[z.zip] = {
        name: z.name,
        region: z.region,
        completedAt: z.completedAt,
        duration: result.duration,
        businesses: bizCount,
        confidence: avgConf,
      };
    } else {
      z.status = z.attempts >= 3 ? 'failed' : 'pending';
      z.lastError = result.error || 'non-zero exit';
      if (z.status === 'failed') {
        coverage.failed[z.zip] = { name: z.name, error: z.lastError, attempts: z.attempts };
      }
    }
  });

  coverage.lastRun = new Date().toISOString();
  saveCoverage(coverage);
  saveQueue(queue);

  const completed = queue.filter(z => z.status === 'complete').length;
  const total = queue.length;
  console.log(`[ZipCoordinator] Progress: ${completed}/${total} ZIPs complete`);

  isRunning = false;
}

// ── Express API ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  const coverage = await loadCoverage();
  const queue = loadQueue();
  const completed = queue.filter(z => z.status === 'complete').length;
  const pending = queue.filter(z => z.status === 'pending').length;
  const failed = queue.filter(z => z.status === 'failed').length;
  const inProgress = queue.filter(z => z.status === 'inProgress').length;

  const flPct = getFlCoveragePct(queue);
  const byPhase = {};
  queue.forEach(z => {
    const p = z.phase || 1;
    if (!byPhase[p]) byPhase[p] = { total: 0, complete: 0, pending: 0 };
    byPhase[p].total++;
    if (z.status === 'complete') byPhase[p].complete++;
    else if (z.status === 'pending') byPhase[p].pending++;
  });
  res.json({
    worker: 'zipCoordinator',
    port: PORT,
    status: 'running',
    queue: { total: queue.length, completed, pending, inProgress, failed },
    activeAgents: Object.keys(activeAgents),
    lastRun: coverage.lastRun,
    coveragePercent: queue.length ? Math.round(completed / queue.length * 100) : 0,
    flCoveragePct: flPct,
    phaseGate: { fl_pct: flPct, gate_pct: FL_PHASE_GATE_PCT, phase2_locked: flPct < FL_PHASE_GATE_PCT },
    byPhase,
  });
});

app.post('/run', async (req, res) => {
  res.json({ status: 'dispatched', message: 'Coordinator cycle triggered' });
  coordinatorCycle().catch(err => console.error('[ZipCoordinator] Cycle error:', err));
});

app.post('/add-zip', (req, res) => {
  const { zip, lat, lon, region, name, priority } = req.body;
  if (!zip || !lat || !lon) return res.status(400).json({ error: 'zip, lat, lon required' });
  const queue = loadQueue();
  if (queue.find(z => z.zip === zip)) return res.json({ status: 'already_queued', zip });
  queue.push({ zip, lat, lon, region: region || 'FL', name: name || zip, priority: priority || 50, status: 'pending', attempts: 0 });
  queue.sort((a, b) => b.priority - a.priority);
  saveQueue(queue);
  res.json({ status: 'queued', zip, queueLength: queue.length });
});

app.get('/coverage', (req, res) => {
  loadCoverage().then(cov => res.json(cov)).catch(() => res.json({}));
});

app.get('/queue', (req, res) => {
  res.json(loadQueue());
});

app.get('/budget-status', (req, res) => {
  res.json({
    worker: 'zipCoordinator',
    concurrentAgents: CONCURRENT_AGENTS,
    revenue7d,
    gateStatus,
    generatedAt: new Date().toISOString(),
  });
});

// ── Auto-start loop ───────────────────────────────────────────────────────────

const CYCLE_INTERVAL_MS = 2 * 60 * 1000; // Every 2 minutes

app.listen(PORT, async () => {
  console.log(`[ZipCoordinator] Running on port ${PORT}`);
  // Ensure zips dir exists
  if (!fs.existsSync(ZIPS_DIR)) fs.mkdirSync(ZIPS_DIR, { recursive: true });
  // Restore coverage from Postgres on cold start (Railway restart wipes local files)
  await restoreCoverageFromPostgres();
  // Run first cycle immediately, then on interval
  coordinatorCycle().catch(err => console.error('[ZipCoordinator] Init cycle error:', err));
  setInterval(() => {
    coordinatorCycle().catch(err => console.error('[ZipCoordinator] Cycle error:', err));
  }, CYCLE_INTERVAL_MS);
});
