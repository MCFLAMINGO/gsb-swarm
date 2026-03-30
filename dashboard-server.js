// GSB Intelligence Dashboard Server
// Express 4 + WebSocket + ACP SDK for live job firing
require('dotenv').config();

const express  = require('express');
const http     = require('http');
const path     = require('path');
const { WebSocketServer } = require('ws');
const cors     = require('cors');

// ── ACP SDK ──────────────────────────────────────────────────────────────────
const {
  AcpContractClient,
  baseAcpConfig,
  FareAmount,
  default: AcpClient,
} = require('@virtuals-protocol/acp-node');

// Patch Virtuals RPC
const VIRTUALS_RPC = baseAcpConfig.alchemyRpcUrl;
if (!baseAcpConfig.chain.rpcUrls.alchemy) {
  baseAcpConfig.chain.rpcUrls.alchemy = { http: [VIRTUALS_RPC] };
} else {
  baseAcpConfig.chain.rpcUrls.alchemy.http = [VIRTUALS_RPC];
}
baseAcpConfig.chain.rpcUrls.default.http = [VIRTUALS_RPC];

// ── Config ───────────────────────────────────────────────────────────────────
const PRIVATE_KEY        = process.env.AGENT_WALLET_PRIVATE_KEY;
const CEO_ENTITY_ID      = 2;
const CEO_WALLET_ADDRESS = '0xf0d4832A4c2D33Faa1F655cd4dE5e7c551a0fE45';
const PORT               = process.env.PORT || 8080;

const WORKER_CATALOG = {
  'GSB Token Analyst': {
    address: '0xBF56F4EC74cC1aE19c48197Eb32066c8a85dEfda',
    price: 0.25,
    role: 'token_analysis',
    defaultReq: 'Analyze token 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 on Base',
  },
  'GSB Wallet Profiler': {
    address: '0x730e371ff3E2277c36060748dd5207CEAF50701d',
    price: 0.50,
    role: 'wallet_profile',
    defaultReq: 'Profile wallet 0x6dA1A9793Ebe96975c240501A633ab8B3c83D14A on Base',
  },
  'GSB Alpha Scanner': {
    address: '0x2c87651012bFA0247Fe741448DEbBF06c1b5c906',
    price: 0.10,
    role: 'alpha_signals',
    defaultReq: 'Scan Base chain for alpha signals now',
  },
  'GSB Thread Writer': {
    address: '0x4ab8320491A1FD8396F7F23c212cd6fC978C8Ad0',
    price: 0.15,
    role: 'thread',
    defaultReq: 'Write a crypto Twitter thread about $GSB Agent Gas Bible tokenized agent on Virtuals Protocol',
  },
};

// ── State ────────────────────────────────────────────────────────────────────
let acpClient        = null;
let latestBrief      = null;
const jobHistory     = [];     // { jobId, worker, event, status, ts }
const jobWorkerMap   = new Map(); // jobId → worker name
const briefResults   = {};     // role → parsed data
let   acpReady       = false;
let   acceptQueue    = Promise.resolve();
let   evaluatedCount = 0;

// ── Express + WS ─────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── WebSocket broadcast ──────────────────────────────────────────────────────
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(ws => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

wss.on('connection', ws => {
  console.log('[ws] client connected');
  // Send current state on connect
  ws.send(JSON.stringify({ type: 'acp_status', data: { ready: acpReady }, ts: Date.now() }));
  if (latestBrief) ws.send(JSON.stringify({ type: 'brief', data: latestBrief, ts: Date.now() }));
  if (jobHistory.length) ws.send(JSON.stringify({ type: 'history', data: jobHistory, ts: Date.now() }));
  ws.on('close', () => console.log('[ws] client disconnected'));
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function makeFare(p) { return new FareAmount(p, baseAcpConfig.baseFare); }

function logJob(jobId, workerName, event, status) {
  const entry = { jobId, worker: workerName, event, status, ts: Date.now() };
  jobHistory.unshift(entry);
  if (jobHistory.length > 200) jobHistory.length = 200;
  broadcast('job-event', entry);
}

function parseDeliverable(rawValue) {
  if (!rawValue) return null;
  if (typeof rawValue === 'object') return rawValue;
  try { return JSON.parse(rawValue); } catch { return { raw: rawValue }; }
}

function buildBriefSnapshot() {
  return { results: { ...briefResults }, ts: Date.now() };
}

function queueAccept(job, memo) {
  acceptQueue = acceptQueue.then(async () => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        console.log(`[ceo] acceptRequirement job ${job.id} attempt ${attempt}`);
        await job.acceptRequirement(memo, 'Requirement accepted. Proceed.');
        console.log(`[ceo] ✓ Job ${job.id} → TRANSACTION`);
        logJob(job.id, jobWorkerMap.get(job.id) || '?', 'accepted', 'accepted');
        break;
      } catch (err) {
        console.error(`[ceo] accept error job ${job.id} attempt ${attempt}:`, err.message);
        if (attempt < 4) await sleep(attempt * 8000);
        else logJob(job.id, jobWorkerMap.get(job.id) || '?', 'accept_failed', 'error');
      }
    }
    await sleep(5000);
  });
}

// ── Boot ACP client ──────────────────────────────────────────────────────────
async function initAcp() {
  if (!PRIVATE_KEY) {
    console.warn('[acp] No AGENT_WALLET_PRIVATE_KEY — fire-job disabled');
    return;
  }
  try {
    console.log('[acp] Initializing CEO client...');
    const contractClient = await AcpContractClient.build(
      PRIVATE_KEY, CEO_ENTITY_ID, CEO_WALLET_ADDRESS
    );

    acpClient = new AcpClient({
      acpContractClient: contractClient,

      onNewTask: async (job, memo) => {
        if (memo) {
          console.log(`[ceo] onNewTask job ${job.id} phase=${job.phase} memo=${memo.id}`);
          queueAccept(job, memo);
        }
      },

      onEvaluate: async (job) => {
        console.log(`[ceo] evaluating job ${job.id}`);
        await sleep(2000);
        try {
          const workerName = jobWorkerMap.get(job.id);
          const worker     = workerName ? WORKER_CATALOG[workerName] : null;
          const memos      = job.memos || [];
          const deliverMemo = memos.find(m => m.nextPhase === 3 || m.nextPhase === 'EVALUATION')
                           || memos[memos.length - 1];
          const parsed = parseDeliverable(deliverMemo?.content);

          if (worker && parsed) {
            briefResults[worker.role] = parsed;
            console.log(`[ceo] ✓ Deliverable from ${workerName} stored (role: ${worker.role})`);

            // Print key info
            if (parsed.gsb_verdict)  console.log(`  → Verdict: ${parsed.gsb_verdict}`);
            if (parsed.gsb_signal)   console.log(`  → Signal: ${parsed.gsb_signal}`);
            if (parsed.thread)       console.log(`  → Thread: ${parsed.thread.slice(0,80)}…`);
            if (parsed.classification) console.log(`  → Wallet: ${parsed.classification}`);
          }

          await job.evaluate(true, 'Intelligence received.');
          logJob(job.id, workerName || '?', 'delivered', 'delivered');
          evaluatedCount++;

          // Push brief after every 4th evaluation (one full round)
          if (evaluatedCount % 4 === 0 && Object.keys(briefResults).length > 0) {
            latestBrief = buildBriefSnapshot();
            broadcast('brief', latestBrief);
            console.log('[ceo] Brief pushed to dashboard');
          } else {
            // Push partial brief immediately so dashboard updates as each worker delivers
            latestBrief = buildBriefSnapshot();
            broadcast('brief', latestBrief);
          }
        } catch (err) {
          console.error(`[ceo] evaluate error job ${job.id}:`, err.message);
          try { await job.evaluate(true, 'Approved.'); } catch (_) {}
        }
      },
    });

    acpReady = true;
    broadcast('acp_status', { ready: true });
    console.log('[acp] CEO client ready — fire-job enabled');
  } catch (err) {
    console.error('[acp] Init failed:', err.message);
    broadcast('acp_status', { ready: false, error: err.message });
  }
}

// ── POST /api/fire-job ────────────────────────────────────────────────────────
app.post('/api/fire-job', async (req, res) => {
  const { worker: workerName, requirement } = req.body || {};

  if (!workerName || !requirement) {
    return res.status(400).json({ error: 'Missing worker or requirement' });
  }
  const worker = WORKER_CATALOG[workerName];
  if (!worker) {
    return res.status(400).json({ error: `Unknown worker: ${workerName}` });
  }
  if (!acpClient || !acpReady) {
    return res.status(503).json({ error: 'ACP client not ready — check AGENT_WALLET_PRIVATE_KEY' });
  }

  try {
    console.log(`[api] Firing job → ${workerName}: "${requirement}"`);
    const jobId = await acpClient.initiateJob(
      worker.address,
      requirement,
      makeFare(worker.price),
      null,
      new Date(Date.now() + 1000 * 60 * 30),
    );
    jobWorkerMap.set(jobId, workerName);
    logJob(jobId, workerName, 'fired', 'fired');
    console.log(`[api] ✓ Job fired: ${jobId}`);
    res.json({ ok: true, jobId });
  } catch (err) {
    console.error('[api] fire-job error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/brief (from external ceobuyer.js) ───────────────────────────────
app.post('/api/brief', (req, res) => {
  const brief = req.body;
  if (!brief?.results) return res.status(400).json({ error: 'Missing results' });
  // Merge into briefResults
  Object.assign(briefResults, brief.results);
  latestBrief = buildBriefSnapshot();
  broadcast('brief', latestBrief);
  console.log('[api] External brief received, pushed to dashboard');
  res.json({ ok: true });
});

// ── POST /api/job-event (from external ceobuyer.js) ──────────────────────────
app.post('/api/job-event', (req, res) => {
  const ev = req.body;
  if (!ev) return res.status(400).json({ error: 'Missing event' });
  ev.ts = ev.ts || Date.now();
  jobHistory.unshift(ev);
  if (jobHistory.length > 200) jobHistory.length = 200;
  broadcast('job-event', ev);
  res.json({ ok: true });
});

// ── GET /api/state ────────────────────────────────────────────────────────────
app.get('/api/state', (req, res) => {
  res.json({ brief: latestBrief, history: jobHistory, acpReady });
});

// ── GET /api/workers ──────────────────────────────────────────────────────────
app.get('/api/workers', (req, res) => {
  res.json(Object.entries(WORKER_CATALOG).map(([name, w]) => ({
    name,
    price: w.price,
    role: w.role,
    defaultReq: w.defaultReq,
  })));
});

// ── Catch-all → index.html ────────────────────────────────────────────────────
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`[gsb-dashboard] Listening on port ${PORT}`);
  await initAcp();
});
