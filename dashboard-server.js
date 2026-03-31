// GSB Intelligence Dashboard Server
// Express 4 + WebSocket + ACP SDK for live job firing
require('dotenv').config();

const https = require('https');

const fs       = require('fs');
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

// ── Anthropic (Claude) — lazy async import ──────────────────────────────────
let anthropic = null;
(async () => {
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      console.log('[CEO] ✓ Claude brain online');
    } catch (e) {
      console.warn('[CEO] Anthropic SDK load failed:', e.message);
    }
  } else {
    console.log('[CEO] No ANTHROPIC_API_KEY — using rule-based synthesis');
  }
})();

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

// ── Worker Status Tracking ──────────────────────────────────────────────────
const workerStatus = {};
function initWorkerStatus() {
  const agents = ['CEO', ...Object.keys(WORKER_CATALOG)];
  agents.forEach(name => {
    workerStatus[name] = { name, status: 'idle', currentJobId: null, lastJobAt: null, jobsCompleted: 0 };
  });
}

function setWorkerStatus(name, status, jobId) {
  if (!workerStatus[name]) return;
  workerStatus[name].status = status;
  if (jobId !== undefined) workerStatus[name].currentJobId = jobId;
  if (status === 'idle') {
    workerStatus[name].currentJobId = null;
    workerStatus[name].lastJobAt = new Date().toISOString();
    workerStatus[name].jobsCompleted++;
  }
  broadcast('swarm-status', Object.values(workerStatus));
}

// ── CEO Synthesis Engine — Claude AI with rule-based fallback ───────────────

function parseClaudeResponse(text) {
  const sections = { summary: '', keyFindings: [], recommendation: '' };

  // Extract Summary
  const summaryMatch = text.match(/## Summary\s*\n([\s\S]*?)(?=\n## |$)/);
  if (summaryMatch) sections.summary = summaryMatch[1].trim();

  // Extract Key Findings
  const findingsMatch = text.match(/## Key Findings\s*\n([\s\S]*?)(?=\n## |$)/);
  if (findingsMatch) {
    sections.keyFindings = findingsMatch[1]
      .split(/\n[-•*]\s*/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  // Extract CEO Recommendation
  const recMatch = text.match(/## CEO Recommendation\s*\n([\s\S]*?)$/);
  if (recMatch) sections.recommendation = recMatch[1].trim();

  return sections;
}

async function ceoSynthesizeWithClaude(workerResults, originalCommand) {
  const prompt = `You are the GSB CEO — the orchestration hub of the GSB Intelligence Swarm, a tokenized AI agent on Virtuals Protocol (Base chain). You have just received intelligence reports from your worker agents. Synthesize them into a crisp, professional CEO brief.

ORIGINAL QUERY: ${originalCommand || 'Swarm intelligence brief'}

WORKER REPORTS:
${Object.entries(workerResults).map(([worker, data]) => `[${worker}]\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`).join('\n\n')}

Write a CEO Intelligence Brief with these exact sections:
## Summary
(2-3 sentences synthesizing ALL worker findings in CEO voice — confident, analytical, crypto-native)

## Key Findings
(5-7 bullet points — the most important facts extracted from ALL worker reports combined)

## CEO Recommendation
(1-2 sentences — one clear, specific, actionable takeaway for the user)

Be direct, specific, use numbers from the data. No fluff. Sound like a sharp DeFi analyst, not a chatbot.`;

  const msg = await anthropic.messages.create({
    model: 'claude-haiku-3-5',
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = msg.content[0].text;
  const parsed = parseClaudeResponse(text);

  // Collect worker names for metadata
  const workerNames = [];
  if (workerResults.token_analysis && !workerResults.token_analysis.error) workerNames.push('Token Analyst');
  if (workerResults.wallet_profile && !workerResults.wallet_profile.error) workerNames.push('Wallet Profiler');
  if (workerResults.alpha_signals && !workerResults.alpha_signals.error) workerNames.push('Alpha Scanner');
  if (workerResults.thread && workerResults.thread.thread) workerNames.push('Thread Writer');

  return {
    summary: parsed.summary || 'AI synthesis complete.',
    keyFindings: parsed.keyFindings,
    recommendation: parsed.recommendation || 'Review the brief above.',
    workerCount: workerNames.length,
    workers: workerNames,
    query: originalCommand || null,
    timestamp: new Date().toISOString(),
    aiPowered: true,
  };
}

function ceoSynthesizeRuleBased(workerResults, originalCommand) {
  const ts = new Date().toISOString();
  const workerNames = [];
  const keyFindings = [];
  const summaryParts = [];

  // Token Analysis
  const token = workerResults.token_analysis;
  if (token && !token.error) {
    workerNames.push('Token Analyst');
    const sym = token.token?.symbol || 'TOKEN';
    const price = token.price?.usd ? `$${parseFloat(token.price.usd).toFixed(6)}` : null;
    const chg = token.price?.change_24h;
    if (price) {
      summaryParts.push(`${sym} is trading at ${price}${chg != null ? ` (${chg > 0 ? '+' : ''}${chg.toFixed(2)}% 24h)` : ''}`);
      if (chg > 10) keyFindings.push(`${sym} showing strong bullish momentum with ${chg.toFixed(1)}% gain in 24h`);
      else if (chg > 0) keyFindings.push(`${sym} trending positive at +${chg.toFixed(1)}% over 24h`);
      else if (chg < -10) keyFindings.push(`${sym} under significant selling pressure, down ${Math.abs(chg).toFixed(1)}% in 24h`);
      else if (chg < 0) keyFindings.push(`${sym} showing mild weakness at ${chg.toFixed(1)}% over 24h`);
    }
    if (token.liquidity_usd) keyFindings.push(`Liquidity pool: $${Number(token.liquidity_usd).toLocaleString()}`);
    if (token.gsb_verdict) keyFindings.push(`Verdict: ${token.gsb_verdict}`);
  }

  // Wallet Profile
  const wallet = workerResults.wallet_profile;
  if (wallet && !wallet.error) {
    workerNames.push('Wallet Profiler');
    const cls = wallet.classification || 'Unknown';
    const txCount = wallet.transaction_count || 0;
    summaryParts.push(`Target wallet classified as "${cls}" with ${txCount} transactions`);
    keyFindings.push(`Wallet classification: ${cls} (${txCount} total transactions)`);
    if (wallet.wallet) keyFindings.push(`Address: ${wallet.wallet}`);
  }

  // Alpha Signals
  const alpha = workerResults.alpha_signals;
  if (alpha && !alpha.error) {
    workerNames.push('Alpha Scanner');
    if (alpha.gsb_signal) {
      summaryParts.push(`Alpha scanner reports: ${alpha.gsb_signal.split('.')[0]}`);
      keyFindings.push(alpha.gsb_signal);
    }
    if (alpha.top_gainers_base?.length) {
      const top = alpha.top_gainers_base.slice(0, 3);
      keyFindings.push(`Top movers on Base: ${top.map(g => `${g.symbol} (${g.change_24h})`).join(', ')}`);
    }
  }

  // Thread
  const thread = workerResults.thread;
  if (thread && thread.thread) {
    workerNames.push('Thread Writer');
    const tweetCount = (thread.thread.match(/\d+\//g) || []).length || 'multi';
    summaryParts.push(`${tweetCount}-tweet thread drafted and ready to post`);
    keyFindings.push(`Content thread generated (${tweetCount} tweets) — ready for review`);
  }

  if (workerNames.length === 0) {
    return { summary: 'No worker data available yet.', keyFindings: [], recommendation: 'Deploy workers to gather intelligence.', workerCount: 0, timestamp: ts, aiPowered: false };
  }

  // Build summary
  const summary = summaryParts.length > 0
    ? summaryParts.join('. ') + '.'
    : `Intelligence gathered from ${workerNames.length} workers.`;

  // Build recommendation
  let recommendation = 'Continue monitoring and gather more data points.';
  if (token && !token.error) {
    const chg = token.price?.change_24h;
    if (chg > 10) recommendation = 'Strong upward momentum detected. Consider taking partial profits or tightening stops if already positioned.';
    else if (chg > 0 && alpha?.gsb_signal?.toLowerCase().includes('bullish')) recommendation = 'Positive signals across multiple indicators. Favorable conditions for accumulation with proper risk management.';
    else if (chg < -10) recommendation = 'Significant drawdown in progress. Wait for stabilization before entering. Look for volume confirmation on any bounce.';
    else if (chg < 0) recommendation = 'Mild bearish pressure. Not alarming but warrant caution. Set alerts at key support levels.';
    else recommendation = 'Market in consolidation. Good time to research and prepare entries at clearly defined levels.';
  }

  return {
    summary,
    keyFindings,
    recommendation,
    workerCount: workerNames.length,
    workers: workerNames,
    query: originalCommand || null,
    timestamp: ts,
    aiPowered: false,
  };
}

async function ceoSynthesize(workerResults, originalCommand) {
  if (anthropic) {
    try {
      return await ceoSynthesizeWithClaude(workerResults, originalCommand);
    } catch (err) {
      console.warn('[CEO] Claude synthesis failed, falling back to rule-based:', err.message);
    }
  }
  return ceoSynthesizeRuleBased(workerResults, originalCommand);
}

// ── Express + WS ─────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'dashboard-ui')));

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
  if (Object.keys(workerStatus).length) ws.send(JSON.stringify({ type: 'swarm-status', data: Object.values(workerStatus), ts: Date.now() }));
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
  // Workers deliver { type: 'text', value: JSON.stringify(result) }
  // Unwrap that envelope first
  if (typeof rawValue === 'object' && rawValue.type === 'text' && rawValue.value) {
    rawValue = rawValue.value;
  }
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
  initWorkerStatus();
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

          // Update worker status to idle on delivery
          if (workerName) setWorkerStatus(workerName, 'idle', null);

          await job.evaluate(true, 'Intelligence received.');
          logJob(job.id, workerName || '?', 'delivered', 'delivered');
          evaluatedCount++;

          // Run CEO synthesis on current results
          const synthesis = await ceoSynthesize(briefResults);
          broadcast('cmd-synthesis', synthesis);

          // Push brief after every 4th evaluation (one full round)
          if (evaluatedCount % 4 === 0 && Object.keys(briefResults).length > 0) {
            latestBrief = buildBriefSnapshot();
            latestBrief.ceoSynthesis = synthesis;
            broadcast('brief', latestBrief);
            console.log('[ceo] Brief pushed to dashboard');
          } else {
            // Push partial brief immediately so dashboard updates as each worker delivers
            latestBrief = buildBriefSnapshot();
            latestBrief.ceoSynthesis = synthesis;
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
    setWorkerStatus(workerName, 'working', jobId);
    logJob(jobId, workerName, 'fired', 'fired');
    console.log(`[api] ✓ Job fired: ${jobId}`);
    res.json({ ok: true, jobId });
  } catch (err) {
    console.error('[api] fire-job error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/brief (from external ceobuyer.js) ───────────────────────────────
app.post('/api/brief', async (req, res) => {
  const brief = req.body;
  if (!brief?.results) return res.status(400).json({ error: 'Missing results' });
  // Merge into briefResults
  Object.assign(briefResults, brief.results);
  latestBrief = buildBriefSnapshot();
  latestBrief.ceoSynthesis = await ceoSynthesize(briefResults);
  broadcast('brief', latestBrief);
  broadcast('cmd-synthesis', latestBrief.ceoSynthesis);
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

// ── GET /api/swarm-status ────────────────────────────────────────────────────
app.get('/api/swarm-status', (req, res) => {
  res.json({ workers: Object.values(workerStatus) });
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

// ── Skill Registry API ──────────────────────────────────────────────────────
app.get('/api/skills', (req, res) => {
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(__dirname, 'skills.json'), 'utf8'));
    res.json(registry);
  } catch (e) {
    res.json({});
  }
});

app.post('/api/skills', (req, res) => {
  const { workerName, ...skill } = req.body;
  if (!workerName || !skill.skillId || !skill.instruction) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(__dirname, 'skills.json'), 'utf8'));
    if (!registry[workerName]) registry[workerName] = [];
    const existing = registry[workerName].findIndex(s => s.skillId === skill.skillId);
    if (existing >= 0) {
      registry[workerName][existing] = skill;
    } else {
      registry[workerName].push(skill);
    }
    fs.writeFileSync(path.join(__dirname, 'skills.json'), JSON.stringify(registry, null, 2));
    broadcast('skills-updated', { workerName, skillId: skill.skillId, action: 'added' });
    res.json({ ok: true, skill });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/skills/:workerName/:skillId', (req, res) => {
  const { workerName, skillId } = req.params;
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(__dirname, 'skills.json'), 'utf8'));
    if (registry[workerName]) {
      registry[workerName] = registry[workerName].filter(s => s.skillId !== skillId);
      fs.writeFileSync(path.join(__dirname, 'skills.json'), JSON.stringify(registry, null, 2));
      broadcast('skills-updated', { workerName, skillId, action: 'deleted' });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Instant query engine (fast lane — no ACP) ───────────────────────────────
// Returns a rich intel snapshot in ~1-2 seconds using free public APIs.
// No wallet, no on-chain tx, no waiting.

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'GSB-Dashboard/1.0' } }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Coin symbol → CoinGecko ID map for common coins
const COINGECKO_IDS = {
  btc: 'bitcoin', bitcoin: 'bitcoin',
  eth: 'ethereum', ethereum: 'ethereum',
  sol: 'solana', solana: 'solana',
  bnb: 'binancecoin',
  xrp: 'ripple',
  ada: 'cardano',
  doge: 'dogecoin',
  avax: 'avalanche-2',
  dot: 'polkadot',
  link: 'chainlink',
  matic: 'matic-network', pol: 'matic-network',
  uni: 'uniswap',
  base: 'base-protocol',
  virtual: 'virtual-protocol', virtuals: 'virtual-protocol',
  gsb: null, // not on CoinGecko, use DexScreener
};

function formatBigNum(n) {
  if (!n) return '—';
  n = parseFloat(n);
  if (n >= 1e9)  return '$' + (n / 1e9).toFixed(2)  + 'B';
  if (n >= 1e6)  return '$' + (n / 1e6).toFixed(2)  + 'M';
  if (n >= 1e3)  return '$' + (n / 1e3).toFixed(1)  + 'K';
  return '$' + n.toFixed(4);
}

function formatPrice(p) {
  if (!p) return '—';
  p = parseFloat(p);
  if (p >= 1000) return '$' + p.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (p >= 1)    return '$' + p.toFixed(4);
  return '$' + p.toPrecision(4);
}

function sentimentEmoji(pct) {
  if (pct === null || pct === undefined) return '';
  if (pct >= 10)  return '🚀';
  if (pct >= 3)   return '📈';
  if (pct >= -3)  return '➡️';
  if (pct >= -10) return '📉';
  return '🔴';
}

function buildInsight(name, symbol, price, change24h, vol24h, mcap, extra) {
  const dir = change24h > 0 ? 'up' : change24h < 0 ? 'down' : 'flat';
  const absPct = Math.abs(change24h || 0).toFixed(1);
  const emoji = sentimentEmoji(change24h);

  const lines = [
    `${emoji} ${name} (${symbol.toUpperCase()}) — ${formatPrice(price)}`,
    `24h: ${change24h > 0 ? '+' : ''}${(change24h||0).toFixed(2)}% · Vol: ${formatBigNum(vol24h)} · MCap: ${formatBigNum(mcap)}`,
  ];

  // Color commentary
  if (dir === 'up' && change24h >= 10) {
    lines.push(`Strong momentum — ${absPct}% gain. Watch for follow-through or retrace at resistance.`);
  } else if (dir === 'up') {
    lines.push(`Healthy move up ${absPct}%. Holding gains with ${formatBigNum(vol24h)} in volume.`);
  } else if (dir === 'down' && change24h <= -10) {
    lines.push(`Significant pullback — ${absPct}% down. Key support levels in play.`);
  } else if (dir === 'down') {
    lines.push(`Slight weakness, off ${absPct}%. Normal consolidation or broader market drag.`);
  } else {
    lines.push(`Tight range, consolidating. Low volatility can precede a directional break.`);
  }

  if (extra) lines.push(extra);
  return lines.join('\n');
}

async function instantQuery(command) {
  const cmd = command.toLowerCase().trim();

  // ── 1. Extract coin name / ticker ───────────────────────────────────────────
  // Match $TICKER or bare words like "bitcoin", "ethereum", "what is up with bitcoin"
  const tickerMatch  = cmd.match(/\$([a-z]{2,10})/);
  const ticker = tickerMatch ? tickerMatch[1] : null;

  // Try bare word against known coin list
  const words = cmd.split(/\s+/);
  let coinKey = null;
  if (ticker && COINGECKO_IDS.hasOwnProperty(ticker)) {
    coinKey = ticker;
  } else {
    for (const w of words) {
      if (COINGECKO_IDS.hasOwnProperty(w)) { coinKey = w; break; }
    }
  }

  // ── 2. Detect intent ─────────────────────────────────────────────────────────
  const isPrice   = /price|how much|worth|cost|what is|what'?s|up with|down|check|trading|market/.test(cmd);
  const isNews    = /news|latest|update|happen|today|recently|what.s going on|narrative/.test(cmd);
  const isMarket  = /market|crypto|overall|sentiment|fear|greed|total|cap|dominance/.test(cmd) && !coinKey;
  const isTrend   = /trending|hot|top|best|movers|gainer|winner/.test(cmd);

  // If we can't identify a coin or market intent, return null → fall through to ACP
  if (!coinKey && !isMarket && !isTrend) return null;

  const results = [];

  // ── 3. Fetch coin data ───────────────────────────────────────────────────────
  if (coinKey) {
    const cgId = COINGECKO_IDS[coinKey];

    if (cgId) {
      // CoinGecko free API — no key needed
      try {
        const data = await httpGet(
          `https://api.coingecko.com/api/v3/coins/${cgId}?localization=false&tickers=false&community_data=false&developer_data=false`
        );
        const md  = data.market_data || {};
        const price     = md.current_price?.usd;
        const change24h = md.price_change_percentage_24h;
        const vol24h    = md.total_volume?.usd;
        const mcap      = md.market_cap?.usd;
        const ath       = md.ath?.usd;
        const athPct    = md.ath_change_percentage?.usd;

        let extra = null;
        if (ath && athPct) {
          extra = `ATH: ${formatPrice(ath)} — currently ${Math.abs(athPct).toFixed(0)}% below all-time high.`;
        }

        results.push(buildInsight(data.name, data.symbol, price, change24h, vol24h, mcap, extra));

        // High/low 24h
        const hi = md.high_24h?.usd, lo = md.low_24h?.usd;
        if (hi && lo) {
          results.push(`Range 24h: ${formatPrice(lo)} – ${formatPrice(hi)}`);
        }

        // Supply pressure
        const circ = md.circulating_supply, total = md.total_supply;
        if (circ && total && total > 0) {
          const pct = ((circ / total) * 100).toFixed(1);
          results.push(`Supply: ${pct}% circulating (${(circ/1e6).toFixed(1)}M / ${(total/1e6).toFixed(1)}M)`);
        }

        return results.join('\n');
      } catch (err) {
        console.warn('[instant] CoinGecko failed:', err.message);
      }
    }

    // GSB or unknown — try DexScreener
    try {
      const searchSym = ticker || coinKey;
      const ds = await httpGet(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(searchSym)}`);
      const pairs = (ds.pairs || []).filter(p => p.chainId === 'base').slice(0, 3);
      if (pairs.length) {
        const p = pairs[0];
        const price     = parseFloat(p.priceUsd || 0);
        const change24h = parseFloat(p.priceChange?.h24 || 0);
        const vol24h    = p.volume?.h24;
        const liq       = p.liquidity?.usd;
        const name      = p.baseToken?.name || searchSym.toUpperCase();
        const sym       = p.baseToken?.symbol || searchSym.toUpperCase();

        const lines = [
          buildInsight(name, sym, price, change24h, vol24h, null, null),
          `Liquidity: ${formatBigNum(liq)} · Pair: ${p.pairAddress?.slice(0,10)}… on Base`,
          `DexScreener: ${p.url}`,
        ];
        return lines.join('\n');
      }
    } catch (err) {
      console.warn('[instant] DexScreener failed:', err.message);
    }
  }

  // ── 4. Overall market / fear & greed ─────────────────────────────────────────
  if (isMarket || isTrend) {
    const lines = [];
    try {
      const fg = await httpGet('https://api.alternative.me/fng/?limit=2');
      const now  = fg.data?.[0];
      const prev = fg.data?.[1];
      if (now) {
        const val = parseInt(now.value);
        const label = now.value_classification;
        const emoji = val >= 75 ? '🟢' : val >= 55 ? '🔵' : val >= 45 ? '⚪' : val >= 25 ? '🟡' : '🔴';
        const delta = prev ? ` (${val > parseInt(prev.value) ? '+' : ''}${val - parseInt(prev.value)} vs yesterday)` : '';
        lines.push(`${emoji} Fear & Greed Index: ${val}/100 — ${label}${delta}`);

        if (val >= 75) lines.push('Extreme greed — market is hot, watch for euphoria tops.');
        else if (val >= 55) lines.push('Greed territory — momentum favoring bulls, but not overheated.');
        else if (val >= 45) lines.push('Neutral — market undecided, range-bound action likely.');
        else if (val >= 25) lines.push('Fear — potential buying opportunity forming for patient capital.');
        else lines.push('Extreme fear — historically high-conviction entry zone for long-term holders.');
      }
    } catch (e) { console.warn('[instant] F&G failed:', e.message); }

    // Top movers from DexScreener on Base
    if (isTrend) {
      try {
        const ds = await httpGet('https://api.dexscreener.com/latest/dex/tokens/trending/base');
        const top = (ds.pairs || ds.data?.pairs || []).slice(0, 5);
        if (top.length) {
          lines.push('\nTrending on Base right now:');
          top.forEach((p, i) => {
            const sym    = p.baseToken?.symbol || '?';
            const price  = formatPrice(p.priceUsd);
            const chg    = parseFloat(p.priceChange?.h24 || 0);
            const emoji  = sentimentEmoji(chg);
            lines.push(`${i+1}. ${emoji} ${sym} ${price} · ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% 24h · Vol ${formatBigNum(p.volume?.h24)}`);
          });
        }
      } catch (e) { console.warn('[instant] DexScreener trend failed:', e.message); }
    }

    if (lines.length) return lines.join('\n');
  }

  return null; // nothing matched — let ACP handle it
}

// ── POST /api/command — CEO natural-language command line ─────────────────────
// Parses the command text and fires the right workers automatically.
// Streams status back via WebSocket under type 'cmd-status'.
app.post('/api/command', async (req, res) => {
  const { command } = req.body || {};
  if (!command || !command.trim()) {
    return res.status(400).json({ error: 'No command provided' });
  }
  const cmd = command.toLowerCase();

  // ── Fast lane: instant response for price/market queries ─────────────────
  // Skip ACP entirely for questions answerable in <2 seconds
  const DEEP_KEYWORDS = /thread|tweet|post|write|profile|wallet|address|full brief|run all|swarm|everything/;
  const isDeepWork = DEEP_KEYWORDS.test(cmd);

  if (!isDeepWork) {
    try {
      const instant = await instantQuery(command);
      if (instant) {
        // Stream the fast answer immediately via WebSocket
        broadcast('cmd-status', { type: 'instant', message: instant });
        broadcast('cmd-status', {
          type: 'hint',
          message: 'Instant intel via live APIs. Type "analyze $TOKEN" to deploy Token Analyst for a deep dive.',
        });
        return res.json({ ok: true, lane: 'instant' });
      }
    } catch (err) {
      console.warn('[cmd] instant lane error:', err.message);
      // Fall through to ACP
    }
  }

  // ── Agent lane: deep work that needs the swarm ────────────────────────────
  if (!acpClient || !acpReady) {
    broadcast('cmd-status', {
      type: 'error',
      message: 'CEO wallet not ready — cannot deploy agents. Check your .env and restart.',
    });
    return res.status(503).json({ error: 'ACP client not ready' });
  }

  // ── Intent detection ──────────────────────────────────────────────────────
  // Extract any 0x address from the command for dynamic requirements
  const addrMatch = command.match(/0x[0-9a-fA-F]{40}/i);
  const customAddr = addrMatch ? addrMatch[0] : null;

  // Extract any ticker symbol like $BTC, $ETH, $GSB etc.
  const tickerMatch = command.match(/\$([A-Z]{2,10})/i);
  const ticker = tickerMatch ? tickerMatch[1].toUpperCase() : null;

  const intents = [];

  // Token analysis — also catches crypto tickers like bitcoin, ethereum, solana
  if (/token|analyz|price|liquidity|market|dex|mcap|\$|bitcoin|btc|ethereum|eth|solana|sol|crypto|coin|chart|up|down|pump|dump|rally|crash/.test(cmd)) {
    let requirement;
    if (customAddr) {
      requirement = `Analyze token ${customAddr} on Base`;
    } else if (ticker && ticker !== 'GSB') {
      requirement = `Analyze ${ticker} — check DexScreener and provide price, 24h change, liquidity, and market sentiment`;
    } else {
      requirement = WORKER_CATALOG['GSB Token Analyst'].defaultReq;
    }
    intents.push({ worker: 'GSB Token Analyst', requirement });
  }

  // Wallet profiling
  if (/wallet|profile|who is|address|holder|tx|transaction/.test(cmd)) {
    const requirement = customAddr
      ? `Profile wallet ${customAddr} on Base`
      : WORKER_CATALOG['GSB Wallet Profiler'].defaultReq;
    intents.push({ worker: 'GSB Wallet Profiler', requirement });
  }

  // Alpha scanning — catches "what's hot", "what should I watch", "any plays"
  if (/alpha|scan|signal|mover|gainer|trending|opportunity|what.s moving|what.s hot|what should|any play|top token|best token|watch/.test(cmd)) {
    intents.push({ worker: 'GSB Alpha Scanner', requirement: WORKER_CATALOG['GSB Alpha Scanner'].defaultReq });
  }

  // Thread writing
  if (/thread|tweet|post|write|twitter|content/.test(cmd)) {
    const requirement = customAddr
      ? `Write a crypto Twitter thread about token ${customAddr}`
      : ticker && ticker !== 'GSB'
        ? `Write a crypto Twitter thread about ${ticker}`
        : WORKER_CATALOG['GSB Thread Writer'].defaultReq;
    intents.push({ worker: 'GSB Thread Writer', requirement });
  }

  // "Full brief" / "everything" / "run all" → hire all 4
  if (/full|brief|all|everything|swarm|run all/.test(cmd) && intents.length === 0) {
    Object.entries(WORKER_CATALOG).forEach(([name, w]) => {
      intents.push({ worker: name, requirement: w.defaultReq });
    });
  }

  // Fallback — route any general market/crypto question to Alpha Scanner + Token Analyst
  if (intents.length === 0) {
    broadcast('cmd-status', {
      type: 'info',
      message: `Routing "${command}" → deploying Alpha Scanner + Token Analyst for market context.`,
    });
    intents.push({ worker: 'GSB Alpha Scanner', requirement: WORKER_CATALOG['GSB Alpha Scanner'].defaultReq });
    intents.push({ worker: 'GSB Token Analyst', requirement: WORKER_CATALOG['GSB Token Analyst'].defaultReq });
  }

  // ── Acknowledge immediately, then fire async ──────────────────────────────
  setWorkerStatus('CEO', 'working', null);
  const workerNamesList = intents.map(i => i.worker).join(', ');
  broadcast('cmd-status', {
    type: 'ack',
    command,
    message: `CEO parsed intent → hiring: ${workerNamesList}`,
    workers: intents.map(i => i.worker),
  });
  res.json({ ok: true, workers: intents.map(i => i.worker) });

  // Fire jobs sequentially with a small gap to avoid nonce collisions
  for (const intent of intents) {
    try {
      broadcast('cmd-status', { type: 'firing', message: `Hiring ${intent.worker}…` });
      const jobId = await acpClient.initiateJob(
        WORKER_CATALOG[intent.worker].address,
        intent.requirement,
        makeFare(WORKER_CATALOG[intent.worker].price),
        null,
        new Date(Date.now() + 1000 * 60 * 30),
      );
      jobWorkerMap.set(jobId, intent.worker);
      setWorkerStatus(intent.worker, 'working', jobId);
      logJob(jobId, intent.worker, 'fired', 'fired');
      broadcast('cmd-status', { type: 'fired', message: `${intent.worker} hired → job ${jobId}`, jobId });
      console.log(`[cmd] ✓ ${intent.worker} → job ${jobId}`);
    } catch (err) {
      console.error(`[cmd] Error firing ${intent.worker}:`, err.message);
      broadcast('cmd-status', { type: 'error', message: `Failed to hire ${intent.worker}: ${err.message}` });
    }
    await sleep(3000);
  }

  setWorkerStatus('CEO', 'idle', null);
  broadcast('cmd-status', {
    type: 'done',
    message: `All ${intents.length} job${intents.length > 1 ? 's' : ''} fired. Watch the Jobs tab for deliveries.`,
  });
});

// ── Catch-all → index.html ────────────────────────────────────────────────────
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard-ui', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`[gsb-dashboard] Listening on port ${PORT}`);
  await initAcp();
});
