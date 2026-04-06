// GSB Intelligence Dashboard Server
// Express 4 + WebSocket + ACP SDK for live job firing
require('dotenv').config();

// ── Resend (bleeding.cash email delivery) ────────────────────────────────────
let resendClient = null;
if (process.env.RESEND_API_KEY) {
  try {
    const { Resend } = require('resend');
    resendClient = new Resend(process.env.RESEND_API_KEY);
    console.log('[resend] Client initialized — sending from reports@bleeding.cash');
  } catch (e) {
    console.warn('[resend] Could not initialize:', e.message);
  }
} else {
  console.warn('[resend] No RESEND_API_KEY — email delivery disabled.');
}

const https = require('https');

const fs       = require('fs');
const os       = require('os');
const express  = require('express');
const http     = require('http');
const path     = require('path');
const { WebSocketServer } = require('ws');
const cors     = require('cors');
const multer   = require('multer');
const { execSync } = require('child_process');
const crypto   = require('crypto');
const axios    = require('axios');
const { CHAIN_CONFIG, CHAIN_ALIASES, resolveChain, SUPPORTED_CHAINS } = require('./chains');

// ── ACP SDK (V2) ─────────────────────────────────────────────────────────────
let AcpContractClientV2, baseAcpConfigV2, AcpClient;
try {
  const acpModule = require('@virtuals-protocol/acp-node');
  AcpContractClientV2 = acpModule.AcpContractClientV2;
  baseAcpConfigV2 = acpModule.baseAcpConfigV2;
  AcpClient = acpModule.default;

  // Override RPC to avoid rate limits
  const RPC_URL = process.env.BASE_RPC_URL || 'https://base.drpc.org';
  if (baseAcpConfigV2) {
    baseAcpConfigV2.rpcEndpoint = RPC_URL;
    if (baseAcpConfigV2.chain?.rpcUrls?.default?.http) {
      baseAcpConfigV2.chain.rpcUrls.default.http = [RPC_URL];
    }
  }
  console.log('[dashboard] ACP SDK loaded');
} catch (e) {
  console.warn('[dashboard] ACP SDK load failed — fire-job disabled:', e.message);
}

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
const PORT               = 8080; // Fixed — Railway domain set to 8080
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || null;

// ── Auth — operator session tokens ──────────────────────────────────────────
const validTokens = new Set();

// ── Rate limiting ───────────────────────────────────────────────────────────
const instantRateMap = new Map(); // ip -> { count, resetAt }
const INSTANT_LIMIT  = 10; // per hour per IP

let dailyJobCount    = 0;
let dailyJobResetAt  = Date.now() + 86400000;
const MAX_DAILY_JOBS = 20;

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
}

function checkInstantRate(ip) {
  const now = Date.now();
  let entry = instantRateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 3600000 };
    instantRateMap.set(ip, entry);
  }
  if (entry.count >= INSTANT_LIMIT) {
    const minsLeft = Math.ceil((entry.resetAt - now) / 60000);
    return `Rate limit: ${INSTANT_LIMIT} instant queries/hour. Try again in ${minsLeft}m`;
  }
  entry.count++;
  return null;
}

function checkDailyJobLimit() {
  if (Date.now() > dailyJobResetAt) {
    dailyJobCount = 0;
    dailyJobResetAt = Date.now() + 86400000;
  }
  if (dailyJobCount >= MAX_DAILY_JOBS) {
    return `Daily job limit reached (${MAX_DAILY_JOBS}/day). Resets in ${Math.ceil((dailyJobResetAt - Date.now()) / 3600000)}h`;
  }
  dailyJobCount++;
  return null;
}

function requireOperator(req, res, next) {
  if (!DASHBOARD_PASSWORD) {
    return res.status(403).json({ error: 'Operator mode not configured' });
  }
  const token = req.headers['x-gsb-token']
    || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
  if (!token || !validTokens.has(token)) {
    return res.status(401).json({ error: 'Operator authentication required' });
  }
  next();
}

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

// ── CEO Intelligence Cache (dashboard-side) ─────────────────────────────────
const ceoDashCache = {
  lastAlphaScan: null,   // { data, fetchedAt }
  totalJobsServed: 0,
  bankStatus: 'ONLINE',
};

function refreshDashboardCache() {
  const url = 'https://api.geckoterminal.com/api/v2/networks/base/trending_pools?page=1';
  const req = https.get(url, { headers: { 'User-Agent': 'GSB-Dashboard/1.0', Accept: 'application/json' } }, res => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        ceoDashCache.lastAlphaScan = { data: data?.data || data, fetchedAt: Date.now() };
        console.log('[dash-cache] Alpha scan refreshed');
      } catch (e) { console.warn('[dash-cache] Parse error:', e.message); }
    });
  });
  req.on('error', e => console.warn('[dash-cache] Refresh failed:', e.message));
  req.setTimeout(10000, () => req.destroy());
}

// Start cache refresh (every 5 min)
refreshDashboardCache();
setInterval(refreshDashboardCache, 5 * 60 * 1000);

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

function makeFare(usdcAmount) {
  return BigInt(Math.round(usdcAmount * 1e6));
}

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
  if (!AcpContractClientV2 || !baseAcpConfigV2 || !AcpClient) {
    console.warn('[acp] ACP SDK not loaded — fire-job disabled');
    return;
  }
  try {
    console.log('[acp] Initializing CEO client (V2)...');
    const contractClient = await AcpContractClientV2.build(
      PRIVATE_KEY, CEO_ENTITY_ID, CEO_WALLET_ADDRESS, baseAcpConfigV2
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

// ── POST /api/auth — password login → token ─────────────────────────────────
app.post('/api/auth', (req, res) => {
  if (!DASHBOARD_PASSWORD) {
    return res.status(404).json({ error: 'Operator mode not configured' });
  }
  const { password } = req.body || {};
  if (!password || password !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  const token = 'gsb_' + crypto.randomBytes(16).toString('hex');
  validTokens.add(token);
  console.log('[auth] Operator token issued');
  res.json({ ok: true, token });
});

// ── GET /api/auth/verify — check if token is valid ──────────────────────────
app.get('/api/auth/verify', (req, res) => {
  const token = req.headers['x-gsb-token']
    || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
  if (token && validTokens.has(token)) {
    return res.json({ ok: true, operator: true });
  }
  res.status(401).json({ ok: false });
});

// ── GET /api/auth/status — public: is password configured? ──────────────────
app.get('/api/auth/status', (req, res) => {
  res.json({ passwordConfigured: !!DASHBOARD_PASSWORD });
});

// ── POST /api/fire-job — OPERATOR ONLY ───────────────────────────────────────
app.post('/api/fire-job', requireOperator, async (req, res) => {
  const { worker: workerName, requirement, direct } = req.body || {};

  if (!workerName || !requirement) {
    return res.status(400).json({ error: 'Missing worker or requirement' });
  }
  const worker = WORKER_CATALOG[workerName];
  if (!worker) {
    return res.status(400).json({ error: `Unknown worker: ${workerName}` });
  }

  // ── DIRECT MODE: bypass ACP, call Claude directly ──────────────────────────
  if (direct || !acpClient || !acpReady) {
    try {
      console.log(`[api] Direct fire → ${workerName}: "${requirement}"`);
      const jobId = 'direct_' + Date.now();
      setWorkerStatus(workerName, 'working', jobId);
      logJob(jobId, workerName, 'fired', 'direct');

      // Build prompt based on worker role
      const rolePrompt = {
        'GSB Thread Writer': `You are the GSB Thread Writer. Write a crypto Twitter/X thread. Format as numbered tweets separated by blank lines. Each tweet max 280 chars.\n\nIMPORTANT FACTS — use these exactly, never invent handles or URLs:\n- Virtuals Protocol Twitter: @virtuals_io\n- GSB token page: app.virtuals.io/virtuals/68291\n- GSB ticker: $GSB\n- Chain: Base\n- Treasury wallet: 0x8E223841aA396d36a6727EfcEAFC61d691692a37\n\nRequirement: ${requirement}`,
        'GSB Token Analyst': `You are the GSB Token Analyst. Analyze the requested token and provide a detailed report with BUY/HOLD/AVOID recommendation.\n\nRequirement: ${requirement}`,
        'GSB Wallet Profiler': `You are the GSB Wallet Profiler. Profile the requested wallet — classify as whale/degen/institutional, describe activity patterns.\n\nRequirement: ${requirement}`,
        'GSB Alpha Scanner': `You are the GSB Alpha Scanner. Scan for alpha signals on Base chain. Return top opportunities with risk/reward assessment.\n\nRequirement: ${requirement}`,
      }[workerName] || `You are ${workerName}. Complete this task:\n\nRequirement: ${requirement}`;

      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        messages: [{ role: 'user', content: rolePrompt }],
      });
      const result = msg.content[0]?.text || '';

      // If Thread Writer + X keys configured, attempt to post
      let threadUrl = null;
      if (workerName === 'GSB Thread Writer' && process.env.X_API_KEY && process.env.X_ACCESS_TOKEN) {
        try {
          const tweets = result.split('\n\n')
            .map(t => t.trim())
            .filter(t => t.length > 0 && t.length <= 280);
          console.log(`[api] Thread Writer: ${tweets.length} tweets to post`);
          if (tweets.length > 0) {
            // Inline tweet posting to avoid module cache issues
            const _crypto = require('crypto');
            const _axios = require('axios');
            const X_API_KEY = process.env.X_API_KEY;
            const X_API_SECRET = process.env.X_API_SECRET;
            const X_ACCESS_TOKEN = process.env.X_ACCESS_TOKEN;
            const X_ACCESS_TOKEN_SECRET = process.env.X_ACCESS_TOKEN_SECRET;

            const _pctEnc = s => encodeURIComponent(String(s));
            const _signOAuth = (method, url) => {
              const op = {
                oauth_consumer_key: X_API_KEY,
                oauth_nonce: _crypto.randomBytes(16).toString('hex'),
                oauth_signature_method: 'HMAC-SHA1',
                oauth_timestamp: Math.floor(Date.now()/1000).toString(),
                oauth_token: X_ACCESS_TOKEN,
                oauth_version: '1.0',
              };
              const paramStr = Object.keys(op).sort().map(k => `${_pctEnc(k)}=${_pctEnc(op[k])}`).join('&');
              const base = [method.toUpperCase(), _pctEnc(url), _pctEnc(paramStr)].join('&');
              const key = `${_pctEnc(X_API_SECRET)}&${_pctEnc(X_ACCESS_TOKEN_SECRET)}`;
              op.oauth_signature = _crypto.createHmac('sha1', key).update(base).digest('base64');
              return 'OAuth ' + Object.keys(op).sort().map(k => `${_pctEnc(k)}="${_pctEnc(op[k])}"`).join(', ');
            };
            const _postTweet = async (text, replyId) => {
              const url = 'https://api.twitter.com/2/tweets';
              const body = replyId ? { text, reply: { in_reply_to_tweet_id: replyId } } : { text };
              const res = await _axios.post(url, body, {
                headers: { 'Authorization': _signOAuth('POST', url), 'Content-Type': 'application/json' },
              });
              return res.data.data.id;
            };
            let lastId = null, firstId = null;
            for (const tweet of tweets) {
              console.log(`[api] Posting tweet (${tweet.length} chars): ${tweet.slice(0,60)}...`);
              const id = await _postTweet(tweet, lastId);
              if (!firstId) firstId = id;
              lastId = id;
              await new Promise(r => setTimeout(r, 1500));
            }
            threadUrl = `https://x.com/ErikOsol43597/status/${firstId}`;
            console.log(`[api] Thread posted: ${threadUrl}`);
          }
        } catch (xErr) {
          console.warn('[api] X posting failed:', xErr.message,
            JSON.stringify(xErr.response?.data || xErr.response?.status || ''));
        }
      }

      setWorkerStatus(workerName, 'idle');
      logJob(jobId, workerName, 'completed', 'direct');
      broadcast('job-result', { jobId, worker: workerName, result, threadUrl });
      return res.json({ ok: true, jobId, result, threadUrl });
    } catch (err) {
      setWorkerStatus(workerName, 'idle');
      console.error('[api] direct fire error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }
  // ── ACP MODE ───────────────────────────────────────────────────────────────

  const jobErr = checkDailyJobLimit();
  if (jobErr) return res.status(429).json({ error: jobErr });

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
  if (!brief?.results) {
    // Accept plain-text briefs from ceobuyer provider-side deliveries
    if (brief?.brief && typeof brief.brief === 'string') {
      global.latestCeoBrief = brief.brief;
      global.latestCeoBriefAt = brief.timestamp || new Date().toISOString();
      console.log('[api] Plain-text brief stored for resource endpoint');
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: 'Missing results' });
  }
  // Merge into briefResults
  Object.assign(briefResults, brief.results);
  latestBrief = buildBriefSnapshot();
  latestBrief.ceoSynthesis = await ceoSynthesize(briefResults);
  broadcast('brief', latestBrief);
  broadcast('cmd-synthesis', latestBrief.ceoSynthesis);
  // Update global brief for resource endpoint
  global.latestCeoBrief = latestBrief.ceoSynthesis?.summary || JSON.stringify(latestBrief.ceoSynthesis);
  global.latestCeoBriefAt = new Date().toISOString();
  console.log('[api] External brief received, pushed to dashboard');

  // ── AUTO-TRADE: if brief contains a BULLISH token verdict, fire copy trader ──
  try {
    const briefText = JSON.stringify(brief).toUpperCase();
    const isBullish = briefText.includes('BULLISH') || briefText.includes('STRONG BUY');
    const isNew = briefText.includes('NEW LAUNCH') || briefText.includes('RECENT LAUNCH') || briefText.includes('143.4') || briefText.includes('45.5');

    // Extract pool/token address from brief if present
    const addrMatch = JSON.stringify(brief).match(/0x[a-fA-F0-9]{40}/);
    const tokenAddr = addrMatch ? addrMatch[0] : null;

    if ((isBullish || isNew) && tokenAddr && !copyTraderProcess) {
      console.log(`[auto-trade] BULLISH signal detected from ACP brief — token: ${tokenAddr}`);
      tgAlert(
        `🤖 *ACP Auto-Trade Signal*\n\n` +
        `Token: \`${tokenAddr}\`\n` +
        `Signal: ${isBullish ? 'BULLISH' : 'NEW LAUNCH'}\n` +
        `Copy trader will attempt entry if wallet has funds.\n\n` +
        `Check copy-trader dashboard for status.`
      );
      // Store signal for dashboard display
      global.latestTradeSignal = {
        token: tokenAddr,
        signal: isBullish ? 'BULLISH' : 'NEW_LAUNCH',
        source: 'acp_brief',
        receivedAt: new Date().toISOString(),
        briefSnippet: JSON.stringify(brief).slice(0, 300),
      };
      broadcast('trade-signal', global.latestTradeSignal);
    }
  } catch (sigErr) {
    console.warn('[auto-trade] Signal parse error:', sigErr.message);
  }

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

// ── GET /api/public — limited info for unauthenticated visitors ──────────────
// ── MASTER CONTEXT PROVIDER (MCP) ──────────────────────────────────────────────────
// Centralized key-value store. All agents (Railway + Vercel) read from here.
// Keys prefixed with env: auto-resolve to process.env
// Persisted to /tmp/gsb-mcp.json across restarts.

const MCP_FILE = path.join(os.tmpdir(), 'gsb-mcp.json');
const mcpStore = (() => {
  try {
    if (fs.existsSync(MCP_FILE)) return JSON.parse(fs.readFileSync(MCP_FILE, 'utf8'));
  } catch(e) {}
  return {};
})();

function mcpSave() {
  try { fs.writeFileSync(MCP_FILE, JSON.stringify(mcpStore, null, 2)); } catch(e) {}
}

function mcpGet(key) {
  // env: prefix pulls from process.env first
  if (key.startsWith('env:')) {
    const envKey = key.slice(4);
    return process.env[envKey] ?? mcpStore[key] ?? null;
  }
  return mcpStore[key] ?? null;
}

// Seed env vars into MCP on startup (so agents can fetch them)
const MCP_ENV_SEEDS = [
  'ANTHROPIC_API_KEY', 'X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN',
  'X_ACCESS_TOKEN_SECRET', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHANNEL_ID',
  'RESEND_API_KEY', 'BASALT_API_KEY', 'DISPATCH_SECRET'
];
MCP_ENV_SEEDS.forEach(k => { if (process.env[k]) mcpStore[`env:${k}`] = process.env[k]; });
mcpSave();
console.log('[mcp] Initialized with', Object.keys(mcpStore).length, 'keys');

// GET /api/mcp — read one or all keys
// Auth: public keys readable without auth, secret keys (env:*) require operator
app.get('/api/mcp', (req, res) => {
  const { key, secret } = req.query;
  const isOperator = validTokens.has(req.headers['x-gsb-token']);
  const mcpSecret = process.env.MCP_SECRET || 'gsb-mcp-2026';
  const hasSecret = secret === mcpSecret || isOperator;

  if (key) {
    // Single key lookup
    const isEnvKey = key.startsWith('env:');
    if (isEnvKey && !hasSecret) return res.status(401).json({ error: 'Secret required for env keys' });
    return res.json({ key, value: mcpGet(key) });
  }

  // Return all — filter env keys for unauthenticated
  const result = {};
  for (const [k, v] of Object.entries(mcpStore)) {
    if (k.startsWith('env:') && !hasSecret) continue;
    result[k] = v;
  }
  res.json({ keys: Object.keys(result).length, data: result });
});

// POST /api/mcp — write a key (operator or MCP_SECRET required)
app.post('/api/mcp', express.json(), (req, res) => {
  const { key, value, secret } = req.body || {};
  const isOperator = validTokens.has(req.headers['x-gsb-token']);
  const mcpSecret = process.env.MCP_SECRET || 'gsb-mcp-2026';
  if (secret !== mcpSecret && !isOperator) return res.status(401).json({ error: 'Unauthorized' });
  if (!key) return res.status(400).json({ error: 'key required' });
  mcpStore[key] = value;
  mcpSave();
  console.log(`[mcp] Set ${key}`);
  res.json({ ok: true, key, value });
});

// DELETE /api/mcp?key=X — remove a key
app.delete('/api/mcp', (req, res) => {
  const { key, secret } = req.query;
  const isOperator = validTokens.has(req.headers['x-gsb-token']);
  const mcpSecret = process.env.MCP_SECRET || 'gsb-mcp-2026';
  if (secret !== mcpSecret && !isOperator) return res.status(401).json({ error: 'Unauthorized' });
  delete mcpStore[key];
  mcpSave();
  res.json({ ok: true, deleted: key });
});

app.get('/api/public', (req, res) => {
  res.json({
    name: 'GSB Intelligence Swarm',
    status: 'live',
    agentCount: Object.keys(WORKER_CATALOG).length + 1, // workers + CEO
    message: 'GSB Intelligence Swarm is live',
    hireCeo: 'https://app.virtuals.io/acp/agents/itrtj5b95z14av53qoubqwcu',
  });
});

// ── GET /api/resource/:name — Public resource endpoint for ACP/Butler reads ──
app.get('/api/resource/:name', (req, res) => {
  const { name } = req.params;

  if (name === 'market_snapshot') {
    const pools = ceoDashCache.lastAlphaScan?.data ?? [];
    // Extract top 5 trending tokens
    const top5 = pools.slice(0, 5).map(p => {
      const attrs = p.attributes || p;
      return {
        name: attrs.name || attrs.symbol || 'Unknown',
        price_usd: attrs.base_token_price_usd || null,
        volume_24h: attrs.volume_usd?.h24 || attrs.volume_24h || null,
        price_change_24h: attrs.price_change_percentage?.h24 || null,
      };
    });
    return res.json({
      resource: 'market_snapshot',
      data: top5,
      updatedAt: ceoDashCache.lastAlphaScan?.fetchedAt
        ? new Date(ceoDashCache.lastAlphaScan.fetchedAt).toISOString()
        : null,
      description: 'Top trending Base tokens — refreshed every 5 minutes',
    });
  }

  if (name === 'swarm_status') {
    const workers = Object.entries(WORKER_CATALOG).map(([wName, w]) => ({
      name: wName,
      status: workerStatus[wName]?.status || 'idle',
      price: w.price,
      jobsCompleted: workerStatus[wName]?.jobsCompleted || 0,
    }));
    return res.json({
      resource: 'swarm_status',
      status: acpReady ? 'ONLINE' : 'OFFLINE',
      agents: workers,
      totalJobsServed: ceoDashCache.totalJobsServed,
      updatedAt: new Date().toISOString(),
    });
  }

  if (name === 'latest_brief') {
    return res.json({
      resource: 'latest_brief',
      brief: global.latestCeoBrief || 'GSB Intelligence Swarm is online and processing. Hire the CEO for a full report.',
      updatedAt: global.latestCeoBriefAt || null,
    });
  }

  if (name === 'top_alpha') {
    const pools = ceoDashCache.lastAlphaScan?.data ?? [];
    const top3 = pools.slice(0, 3).map(p => ({
      symbol: p.attributes?.name ?? 'Unknown',
      price_usd: p.attributes?.base_token_price_usd ?? '0',
      volume_24h: p.attributes?.volume_usd?.h24 ?? '0',
      change_24h: p.attributes?.price_change_percentage?.h24 ?? '0',
      fdv: p.attributes?.fdv_usd ?? '0',
      address: p.relationships?.base_token?.data?.id ?? '',
    }));
    return res.json({
      resource: 'top_alpha',
      opportunities: top3,
      narrative: top3.length > 0
        ? `Top opportunity: ${top3[0]?.symbol} with $${Number(top3[0]?.volume_24h ?? 0).toLocaleString()} 24h volume`
        : 'Cache warming — check back in 60 seconds',
      updatedAt: ceoDashCache.lastAlphaScan?.fetchedAt ?? null,
      chain: 'Base',
    });
  }

  if (name === 'gsb_offerings') {
    return res.json({
      resource: 'gsb_offerings',
      agent: 'GSB CEO Agent',
      agentId: 40779,
      description: 'GSB CEO orchestrates a full intelligence swarm on Base. Hire for instant alpha, deep token analysis, wallet profiling, social coordination, and strategic briefs.',
      offerings: [
        { name: 'swarm_heartbeat_report', price_usdc: 0.10, description: 'Instant swarm status + live Base market snapshot from cache. Response in <5 seconds.' },
        { name: 'strategy_task_assignment', price_usdc: 0.25, description: 'CEO routes your goal to the best worker(s) and synthesizes results. Alpha scans, token analysis, thread writing.' },
        { name: 'escalation_decision_support', price_usdc: 0.35, description: 'High-urgency situation analysis — CEO + Alpha Scanner assess risk and give strategic recommendation.' },
        { name: 'token_deep_dive', price_usdc: 0.35, description: 'Full token intelligence — Token Analyst + Wallet Profiler running in parallel. Price, liquidity, whale holders, smart money score.' },
        { name: 'daily_brief', price_usdc: 0.50, description: 'Full swarm morning report — all 4 workers run in parallel, CEO synthesizes into one actionable brief. Best value.' },
        { name: 'social_blast', price_usdc: 0.35, description: 'Alpha scan + viral X thread + Telegram raid message + bot amplification plan. Full social coordination.' },
        { name: 'bank_status_report', price_usdc: 0.05, description: 'Instant GSB bank status — worker load, jobs served, swarm health. Cheapest offering.' },
      ],
      hire_url: 'https://app.virtuals.io/acp/agents/itrtj5b95z14av53qoubqwcu',
      updatedAt: new Date().toISOString(),
    });
  }

  if (name === 'whale_activity') {
    // Pull top pools by volume as proxy for whale activity
    const pools = ceoDashCache.lastAlphaScan?.data ?? [];
    const whaleSignals = pools.slice(0, 5).map(p => ({
      token: p.attributes?.name ?? 'Unknown',
      volume_1h: p.attributes?.volume_usd?.h1 ?? '0',
      volume_24h: p.attributes?.volume_usd?.h24 ?? '0',
      change_1h: p.attributes?.price_change_percentage?.h1 ?? '0',
      signal: Number(p.attributes?.volume_usd?.h1 ?? 0) > 50000 ? 'HIGH_ACTIVITY' :
              Number(p.attributes?.volume_usd?.h1 ?? 0) > 10000 ? 'MODERATE' : 'LOW',
      address: p.relationships?.base_token?.data?.id?.replace('base_', '') ?? '',
    }));
    return res.json({
      resource: 'whale_activity',
      signals: whaleSignals,
      summary: `${whaleSignals.filter(s => s.signal === 'HIGH_ACTIVITY').length} tokens showing high whale activity on Base in the last hour`,
      updatedAt: ceoDashCache.lastAlphaScan?.fetchedAt ?? null,
      chain: 'Base',
      note: 'Volume-based whale proxy — hire CEO strategy_task_assignment for full wallet profiling',
    });
  }

  return res.status(404).json({ error: 'Unknown resource', available: ['market_snapshot', 'swarm_status', 'latest_brief', 'top_alpha', 'gsb_offerings', 'whale_activity'] });
});

// ── GET /api/state ────────────────────────────────────────────────────────────
app.get('/api/state', requireOperator, (req, res) => {
  res.json({ brief: latestBrief, history: jobHistory, acpReady });
});

// ── GET /api/swarm-status ────────────────────────────────────────────────────
app.get('/api/swarm-status', requireOperator, (req, res) => {
  res.json({ workers: Object.values(workerStatus) });
});

// ── GET /api/workers ──────────────────────────────────────────────────────────
app.get('/api/workers', requireOperator, (req, res) => {
  res.json(Object.entries(WORKER_CATALOG).map(([name, w]) => ({
    name,
    price: w.price,
    role: w.role,
    defaultReq: w.defaultReq,
  })));
});

// ── Skill Registry API ──────────────────────────────────────────────────────
app.get('/api/skills', requireOperator, (req, res) => {
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(__dirname, 'skills.json'), 'utf8'));
    res.json(registry);
  } catch (e) {
    res.json({});
  }
});

app.post('/api/skills', requireOperator, (req, res) => {
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

app.delete('/api/skills/:workerName/:skillId', requireOperator, (req, res) => {
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

// ── Token symbol → contract address resolver (DexScreener) ──────────────────
async function resolveTokenAddress(ticker, preferredChain = 'base') {
  try {
    const data = await httpGet(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(ticker)}`);
    const pairs = data.pairs || [];
    // Prefer requested chain matches, then any chain with matching symbol, then first result
    const match = pairs.find(p =>
      p.chainId === preferredChain &&
      p.baseToken?.symbol?.toUpperCase() === ticker.toUpperCase()
    ) || pairs.find(p =>
      p.baseToken?.symbol?.toUpperCase() === ticker.toUpperCase()
    ) || pairs[0];

    if (match?.baseToken?.address) {
      console.log(`[cmd] Resolved $${ticker} → ${match.baseToken.address} (${match.chainId})`);
      return { address: match.baseToken.address, chain: match.chainId, name: match.baseToken.name };
    }
  } catch (e) {
    console.warn(`[cmd] Symbol lookup failed for $${ticker}:`, e.message);
  }
  return null;
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
      // Try preferred chain first, then any chain
      let pairs = (ds.pairs || []).filter(p => p.chainId === 'base').slice(0, 3);
      if (!pairs.length) pairs = (ds.pairs || []).slice(0, 3);
      if (pairs.length) {
        const p = pairs[0];
        const price     = parseFloat(p.priceUsd || 0);
        const change24h = parseFloat(p.priceChange?.h24 || 0);
        const vol24h    = p.volume?.h24;
        const liq       = p.liquidity?.usd;
        const name      = p.baseToken?.name || searchSym.toUpperCase();
        const sym       = p.baseToken?.symbol || searchSym.toUpperCase();
        const pChainName = CHAIN_CONFIG[p.chainId]?.name || p.chainId;

        const lines = [
          buildInsight(name, sym, price, change24h, vol24h, null, null),
          `Liquidity: ${formatBigNum(liq)} · Pair: ${p.pairAddress?.slice(0,10)}… on ${pChainName}`,
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

  // ── Instant cache lane: status/heartbeat/bank queries → answer from cache ──
  if (/\b(status|heartbeat|what.?s happening|bank|how.?s the swarm|swarm status)\b/.test(cmd)) {
    const ip = getClientIp(req);
    const rateErr = checkInstantRate(ip);
    if (rateErr) return res.status(429).json({ error: rateErr });

    const cacheAge = ceoDashCache.lastAlphaScan
      ? Math.round((Date.now() - ceoDashCache.lastAlphaScan.fetchedAt) / 60000)
      : null;
    const workers = Object.values(workerStatus);
    const activeWorkers = workers.filter(w => w.status === 'working').length;
    const totalCompleted = workers.reduce((sum, w) => sum + (w.jobsCompleted || 0), 0);
    const topPools = ceoDashCache.lastAlphaScan?.data?.slice?.(0, 3) ?? [];

    const lines = [
      `GSB Intelligence Swarm — ONLINE`,
      `Workers: ${workers.length} registered, ${activeWorkers} active, ${workers.length - activeWorkers} idle`,
      `Jobs completed: ${totalCompleted}`,
      `ACP status: ${acpReady ? 'READY' : 'OFFLINE'}`,
    ];
    if (topPools.length > 0) {
      lines.push(`\nTop Base pools (${cacheAge != null ? cacheAge + 'min ago' : 'cached'}):`);
      topPools.forEach((p, i) => {
        const attrs = p.attributes || p;
        const name = attrs.name || attrs.symbol || `Pool ${i + 1}`;
        const vol = attrs.volume_usd?.h24 || attrs.volume_24h || '—';
        lines.push(`  ${i + 1}. ${name} — Vol: $${Number(vol).toLocaleString()}`);
      });
    }

    broadcast('cmd-status', { type: 'instant', message: lines.join('\n') });
    broadcast('cmd-status', { type: 'hint', message: 'Instant status from cache. No ACP jobs fired.' });
    ceoDashCache.totalJobsServed++;
    return res.json({ ok: true, lane: 'instant-cache' });
  }

  // ── Fast lane: instant response for price/market queries ─────────────────
  // Public users can use this — rate limited by IP. No auth required.
  const DEEP_KEYWORDS = /thread|tweet|post|write|profile|wallet|address|full brief|run all|swarm|everything/;
  const isDeepWork = DEEP_KEYWORDS.test(cmd);

  if (!isDeepWork) {
    try {
      const instant = await instantQuery(command);
      if (instant) {
        // Rate limit instant queries per IP
        const ip = getClientIp(req);
        const rateErr = checkInstantRate(ip);
        if (rateErr) {
          return res.status(429).json({ error: rateErr });
        }
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

  // ── Agent lane: deep work that needs the swarm — OPERATOR ONLY ────────────
  // Check operator auth for ACP jobs
  const opToken = req.headers['x-gsb-token']
    || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
  if (DASHBOARD_PASSWORD && (!opToken || !validTokens.has(opToken))) {
    return res.status(401).json({ error: 'Operator authentication required to deploy agents' });
  }

  // Check daily job limit
  const jobLimitErr = checkDailyJobLimit();
  if (jobLimitErr) return res.status(429).json({ error: jobLimitErr });

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

  // Extract chain from command — "analyze $MCFL on Arbitrum", "scan Solana for alpha"
  const chainMatch = cmd.match(/\b(base|ethereum|eth|arbitrum|arb|polygon|matic|solana|sol|bsc|bnb|avalanche|avax|optimism|op)\b/i);
  const requestedChain = chainMatch ? resolveChain(chainMatch[1]) : 'base';
  const chainName = CHAIN_CONFIG[requestedChain]?.name || requestedChain;

  const intents = [];

  // Token analysis — also catches crypto tickers like bitcoin, ethereum, solana
  if (/token|analyz|price|liquidity|market|dex|mcap|\$|bitcoin|btc|ethereum|eth|solana|sol|crypto|coin|chart|up|down|pump|dump|rally|crash/.test(cmd)) {
    let requirement;
    if (customAddr) {
      requirement = `Analyze token ${customAddr} on ${chainName}`;
    } else if (ticker && ticker !== 'GSB') {
      // Resolve ticker symbol to contract address via DexScreener
      broadcast('cmd-status', { type: 'info', message: `Looking up $${ticker} on DexScreener (${chainName})…` });
      const resolved = await resolveTokenAddress(ticker, requestedChain);
      if (resolved) {
        requirement = `Analyze token ${resolved.address} on ${resolved.chain}`;
        broadcast('cmd-status', { type: 'info', message: `Found $${ticker} → ${resolved.address} on ${resolved.chain}` });
      } else {
        requirement = `Analyze ${ticker} — check DexScreener and provide price, 24h change, liquidity, and market sentiment`;
      }
    } else {
      requirement = WORKER_CATALOG['GSB Token Analyst'].defaultReq;
    }
    intents.push({ worker: 'GSB Token Analyst', requirement });
  }

  // Wallet profiling
  if (/wallet|profile|who is|address|holder|tx|transaction/.test(cmd)) {
    const requirement = customAddr
      ? `Profile wallet ${customAddr} on ${chainName}`
      : WORKER_CATALOG['GSB Wallet Profiler'].defaultReq;
    intents.push({ worker: 'GSB Wallet Profiler', requirement });
  }

  // Alpha scanning — catches "what's hot", "what should I watch", "any plays"
  if (/alpha|scan|signal|mover|gainer|trending|opportunity|what.s moving|what.s hot|what should|any play|top token|best token|watch/.test(cmd)) {
    const alphaReq = requestedChain !== 'base'
      ? `Scan ${chainName} chain for alpha signals now`
      : WORKER_CATALOG['GSB Alpha Scanner'].defaultReq;
    intents.push({ worker: 'GSB Alpha Scanner', requirement: alphaReq });
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

// ── BasaltSurge Payment Integration ──────────────────────────────────────────
const BASALT_BASE    = 'https://surge.basalthq.com';
// Pay URL comes from order response as portalLink — no hardcoded path needed
const BASALT_API_KEY = process.env.BASALT_API_KEY || '';

// In-memory stores for pending orders and upload tokens
const pendingOrders = new Map(); // receiptId → { projectName, period, email, status, createdAt }
const uploadTokens  = new Map(); // uploadToken → receiptId

// Clean up orders older than 24h every 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [receiptId, order] of pendingOrders) {
    if (order.createdAt < cutoff) {
      pendingOrders.delete(receiptId);
      console.log(`[basalt] Order ${receiptId} expired and cleaned up.`);
    }
  }
  for (const [token, receiptId] of uploadTokens) {
    if (!pendingOrders.has(receiptId)) {
      uploadTokens.delete(token);
    }
  }
}, 30 * 60 * 1000);

// Ensure BasaltSurge inventory items exist (fire-and-forget on startup)
if (BASALT_API_KEY) {
  // SKUs must match what's actually created in the Basalt admin dashboard
  const ensureItems = [
    { sku: '4GVZVPZG7',  name: 'Triage Report',            priceUsd: 24.95,  description: 'Full financial analysis + vendor credit letter + bank loan letter. 3 PDFs + Excel delivered via secure token.' },
    { sku: 'JKUPMTSQU', name: 'Triage 3 day trial Pro',    priceUsd: 24.95,  description: '3-day trial of bleeding.cash Pro consultant portal. Unlimited client reports during trial, then $149/mo.' },
    { sku: 'L8XUWC8ZF', name: 'Monthly Pro Plan',          priceUsd: 149.00, description: 'bleeding.cash Pro monthly subscription. Unlimited restaurant financial triage reports for consultants.' },
  ];
  ensureItems.forEach(item => {
    axios.post(`${BASALT_BASE}/api/inventory`, item, {
      headers: { 'Ocp-Apim-Subscription-Key': BASALT_API_KEY },
    }).then(() => console.log(`[basalt] Inventory item ${item.sku} ensured.`))
      .catch(err => console.log(`[basalt] Inventory setup ${item.sku} (may already exist):`, err.response?.status || err.message));
  });
} else {
  console.warn('[basalt] No BASALT_API_KEY — payment endpoints will fail.');
}

// ── POST /api/pro/create-order — create Basalt order for pro signup/renewal ────────────
app.post('/api/pro/create-order', express.json(), async (req, res) => {
  try {
    const { email, firmName, type } = req.body || {};
    if (!email || !firmName) return res.status(400).json({ error: 'email and firmName required' });
    const sku = type === 'monthly' ? 'L8XUWC8ZF' : 'JKUPMTSQU';
    if (!BASALT_API_KEY) return res.status(503).json({ error: 'Payment not configured' });

    const orderRes = await axios.post(`${BASALT_BASE}/api/orders`, {
      items: [{ sku, qty: 1 }],
    }, { headers: { 'Ocp-Apim-Subscription-Key': BASALT_API_KEY } });

    const { receipt, portalLink } = orderRes.data;
    const receiptId = receipt.receiptId;
    // portalLink comes from Basalt as the correct payment UI URL
    const paymentUrl = (portalLink || '').split(', ').pop().trim() || `https://surge.basalthq.com/portal/${receiptId}?recipient=0x6e1d0e78b2577c0106ae5935ea0e40464690bd3b`;

    // Store pending pro order
    pendingOrders.set(receiptId, {
      email: email.trim().toLowerCase(),
      firmName: firmName.trim(),
      type: type || 'trial',
      status: 'pending',
      createdAt: Date.now(),
    });

    console.log(`[pro] Order ${receiptId} created for ${email} (${type || 'trial'})`);
    res.json({ receiptId, paymentUrl });
  } catch (err) {
    console.error('[pro] Create order error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create payment order' });
  }
});

// ── GET /api/pro/check-payment?receiptId=xxx — poll until paid, then activate account ────
app.get('/api/pro/check-payment', async (req, res) => {
  try {
    const { receiptId } = req.query;
    if (!receiptId) return res.status(400).json({ error: 'receiptId required' });

    const order = pendingOrders.get(receiptId);
    if (!order || !order.email) return res.status(404).json({ error: 'Order not found' });

    // Already activated?
    if (order.status === 'paid') {
      const account = proAccounts[order.email];
      return res.json({ paid: true, token: account?.token || null, firmName: order.firmName });
    }

    // Check Basalt
    const statusRes = await axios.get(`${BASALT_BASE}/api/receipts/status`, {
      params: { receiptId },
      headers: { 'Ocp-Apim-Subscription-Key': BASALT_API_KEY },
    });
    const payStatus = statusRes.data.status;
    const paidStatuses = ['completed', 'tx_mined', 'recipient_validated', 'paid'];

    if (paidStatuses.includes(payStatus)) {
      order.status = 'paid';

      // Activate or extend the pro account
      const email = order.email;
      let account = proAccounts[email];
      if (!account) {
        // Should not happen (signup creates account) but handle gracefully
        const token = generateProToken();
        proAccounts[email] = {
          firmName: order.firmName,
          email,
          passwordHash: '',  // no password — they'll need to set one via reset
          token,
          plan: order.type === 'monthly' ? 'pro' : 'trial',
          trialStart: Date.now(),
          paidMonthly: order.type === 'monthly',
          runsUsed: 0,
          runs: [],
          createdAt: new Date().toISOString(),
        };
        account = proAccounts[email];
      } else {
        // Upgrade existing account
        if (order.type === 'monthly') {
          account.plan = 'pro';
          account.paidMonthly = true;
          account.monthlyRenewAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
        } else {
          // Trial payment confirmed
          account.plan = 'trial';
          account.trialStart = Date.now();
          account.paidTrial = true;
        }
        account.token = generateProToken(); // refresh token on payment
      }
      saveProAccounts();
      console.log(`[pro] Account activated: ${email} (${order.type})`);
      return res.json({ paid: true, token: account.token, firmName: account.firmName });
    }

    res.json({ paid: false, status: payStatus });
  } catch (err) {
    console.error('[pro] Check payment error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to check payment' });
  }
});

// GET /api/test-token — generate a free test upload token (no payment required)
// Only works when TEST_MODE=true in env
// ── Phase 2: Generate bank forms from personal financial data ──────────────
// Called from bleeding.cash/my-forms after Phase 1 triage is complete
// Receives personal_info JSON, generates all selected PFS forms, emails ZIP, wipes data
app.post('/api/generate-forms', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const { accessToken, personalInfo, selectedForms, signatureData, signerName } = req.body || {};

    if (!accessToken) return res.status(400).json({ error: 'accessToken required' });

    // Look up email from original triage job
    const job = triageJobStore.get(accessToken);
    const clientEmail = job?.email || null;

    // Build context for generate_all_forms
    let piObj = {};
    try { piObj = typeof personalInfo === 'string' ? JSON.parse(personalInfo) : (personalInfo || {}); } catch(e) {}

    const contextObj = {
      personal_info: piObj.personal_info || piObj,
      assets: piObj.assets || {},
      liabilities: piObj.liabilities || {},
      income: piObj.income || {},
      notes_payable_list: piObj.notes_payable_list || [],
      real_estate_list: piObj.real_estate_list || [],
      stocks_list: piObj.stocks_list || [],
      selected_forms: typeof selectedForms === 'string' ? selectedForms.split(',').map(s => s.trim()).filter(Boolean) : (selectedForms || null),
    };

    if (signatureData) {
      contextObj.signature_data = {
        signer_name: signerName || piObj.personal_info?.full_name || '',
        date: new Date().toLocaleDateString('en-US', {month:'2-digit',day:'2-digit',year:'numeric'}),
        ip_address: req.ip || 'N/A',
        timestamp: new Date().toISOString(),
        ...(typeof signatureData === 'string' && signatureData.startsWith('typed:')
          ? { typed_name: signatureData.slice(6).trim(), image_base64: '' }
          : { image_base64: typeof signatureData === 'string' ? signatureData : '' })
      };
    }

    // Generate forms via analyze.py --mode forms
    const outputDir = path.join(os.tmpdir(), `forms_${accessToken}_${Date.now()}`);
    fs.mkdirSync(outputDir, { recursive: true });

    const slug = (contextObj.personal_info?.full_name || 'client').replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 20);
    const ym = new Date().toISOString().slice(0, 7).replace('-', '');
    const contextArg = ` --context '${JSON.stringify(contextObj).replace(/'/g, "'\"'\"'")}'`;
    const scriptPath = path.join(__dirname, 'scripts', 'analyze.py');
    const cmd = `python3 ${scriptPath} --mode forms --project-name "${slug}" --output-dir "${outputDir}" --period "Current"${contextArg}`;

    console.log('[generate-forms] Running:', cmd.slice(0, 120) + '...');
    execSync(cmd, { stdio: 'pipe', timeout: 120000 });

    // Collect generated PDFs
    const pdfFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.pdf'));
    const pdfs = pdfFiles.map(name => ({
      name,
      data: fs.readFileSync(path.join(outputDir, name)).toString('base64'),
      size: fs.statSync(path.join(outputDir, name)).size,
    }));

    // Store for download
    const dlToken = accessToken + '-forms';
    triageJobStore.set(dlToken, {
      pdfs,
      createdAt: Date.now(),
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      email: clientEmail,
    });
    saveJobStore(); // persist to disk immediately

    // Wipe output dir immediately
    try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch(e) {}

    // Send email if we have address
    if (resendClient && clientEmail) {
      const formNames = pdfFiles.map(f => f.replace(slug + '-', '').replace(`-${ym}.pdf`, '').replace(/-/g,' ')).join(', ');
      const dlLink = `https://www.bleeding.cash/download?token=${dlToken}`;
      resendClient.emails.send({
        from: 'bleeding.cash Reports <reports@bleeding.cash>',
        to: clientEmail,
        subject: `Your Bank Forms Are Ready — ${pdfFiles.length} forms generated`,
        html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F7F6F2;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;"><tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;">
<tr><td style="background:#1B474D;padding:28px 40px;"><p style="margin:0;color:#BCE2E7;font-size:12px;font-weight:600;letter-spacing:2px;text-transform:uppercase;">bleeding.cash</p>
<h1 style="margin:6px 0 0;color:#fff;font-size:22px;">Your Bank Forms Are Ready</h1></td></tr>
<tr><td style="padding:32px 40px;">
<p style="color:#28251D;font-size:15px;">${pdfFiles.length} pre-filled forms are ready for download: <strong>${formNames}</strong>.</p>
<p style="color:#7A7974;font-size:13px;">SSN fields are intentionally blank — hand-write them before submitting to any lender.</p>
<table cellpadding="0" cellspacing="0" style="margin:20px 0;">
<tr><td style="background:#1B474D;border-radius:6px;"><a href="${dlLink}" style="display:inline-block;padding:12px 28px;color:#fff;font-size:15px;font-weight:600;text-decoration:none;">Download My Forms &rarr;</a></td></tr></table>
<p style="color:#7A7974;font-size:12px;">Your personal financial data has been wiped from our servers. This link expires in 24 hours.</p>
</td></tr></table></td></tr></table></body></html>`,
      }).then(r => console.log(`[generate-forms] Email sent — ${r.data?.id}`))
        .catch(e => console.warn('[generate-forms] Email failed:', e.message));
    }

    const forms = pdfFiles.map(f => f.replace(slug + '-', '').replace(`-${ym}.pdf`, '').replace(/-/g,' '));
    res.json({ ok: true, forms, downloadToken: dlToken, emailSent: !!(resendClient && clientEmail) });

  } catch (err) {
    console.error('[generate-forms] Error:', err.message);
    res.status(500).json({ error: `Form generation failed: ${err.message}` });
  }
});

app.get('/api/test-token', async (req, res) => {
  if (process.env.TEST_MODE !== 'true') {
    return res.status(403).json({ error: 'Test mode not enabled' });
  }
  const testToken = 'TEST-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const testReceiptId = 'test-' + Date.now();
  uploadTokens.set(testToken, testReceiptId);
  console.log('[test] Free test token generated:', testToken);
  return res.json({ 
    ok: true, 
    uploadToken: testToken, 
    receiptId: testReceiptId,
    message: 'Free test token — skips payment. Use this uploadToken to test /api/financial-triage'
  });
});

// POST /api/create-triage-order — create a BasaltSurge order
app.post('/api/create-triage-order', express.json(), async (req, res) => {
  try {
    const { projectName, period, email, mode } = req.body || {};
    const triageMode = (mode === 'personal') ? 'personal' : 'restaurant';
    if (!projectName || !email) {
      return res.status(400).json({ error: 'projectName and email are required' });
    }

    const orderRes = await axios.post(`${BASALT_BASE}/api/orders`, {
      items: [{ sku: '4GVZVPZG7', qty: 1 }],
    }, {
      headers: { 'Ocp-Apim-Subscription-Key': BASALT_API_KEY },
    });

    const { receipt, portalLink } = orderRes.data;
    const receiptId = receipt.receiptId;
    // portalLink comes from Basalt as the correct payment UI URL
    const paymentUrl = (portalLink || '').split(', ').pop().trim() || `https://surge.basalthq.com/portal/${receiptId}?recipient=0x6e1d0e78b2577c0106ae5935ea0e40464690bd3b`;

    pendingOrders.set(receiptId, {
      projectName: projectName.trim(),
      period: period || '',
      email: email.trim(),
      mode: triageMode,
      status: 'pending',
      createdAt: Date.now(),
    });

    console.log(`[basalt] Order created: ${receiptId} for ${projectName}`);
    res.json({ receiptId, paymentUrl, orderId: receiptId });
  } catch (err) {
    console.error('[basalt] Create order error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create payment order' });
  }
});

// GET /api/check-payment?receiptId=xxx — poll BasaltSurge payment status
app.get('/api/check-payment', async (req, res) => {
  try {
    const { receiptId } = req.query;
    if (!receiptId) {
      return res.status(400).json({ error: 'receiptId is required' });
    }

    const order = pendingOrders.get(receiptId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // If already marked paid, return the stored upload token
    if (order.status === 'paid') {
      const existingToken = [...uploadTokens.entries()].find(([, rid]) => rid === receiptId)?.[0];
      return res.json({ paid: true, receiptId, uploadToken: existingToken });
    }

    const statusRes = await axios.get(`${BASALT_BASE}/api/receipts/status`, {
      params: { receiptId },
      headers: { 'Ocp-Apim-Subscription-Key': BASALT_API_KEY },
    });

    const payStatus = statusRes.data.status;
    const paidStatuses = ['completed', 'tx_mined', 'recipient_validated'];

    if (paidStatuses.includes(payStatus)) {
      order.status = 'paid';
      const uploadToken = crypto.randomBytes(6).toString('hex'); // 12-char hex token
      uploadTokens.set(uploadToken, receiptId);
      console.log(`[basalt] Payment confirmed for ${receiptId}. Upload token: ${uploadToken}`);
      return res.json({ paid: true, receiptId, uploadToken });
    }

    res.json({ paid: false, status: payStatus });
  } catch (err) {
    console.error('[basalt] Check payment error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to check payment status' });
  }
});

// ── Financial Triage API ─────────────────────────────────────────────────────
const triageUpload = multer({ dest: '/tmp/triage-uploads/' });
// ── Persistent triage job store ──────────────────────────────────────────────────
// Survives Railway restarts by writing to /tmp/triage-jobs.json
const JOBS_FILE    = path.join(os.tmpdir(), 'bleeding-cash-jobs.json');
const FAILURE_FILE = path.join(os.tmpdir(), 'bleeding-cash-failures.json');
const PRO_ACCOUNTS_FILE = path.join(os.tmpdir(), 'bleeding-cash-pro-accounts.json');

// ── Pro Account Store ───────────────────────────────────────────────────────────
let proAccounts = {}; // email → { firmName, passwordHash, token, plan, trialStart, runsUsed, runs[] }
try {
  if (fs.existsSync(PRO_ACCOUNTS_FILE)) {
    proAccounts = JSON.parse(fs.readFileSync(PRO_ACCOUNTS_FILE, 'utf8'));
    console.log(`[pro] Loaded ${Object.keys(proAccounts).length} pro accounts`);
  }
} catch (e) { console.warn('[pro] Could not load accounts:', e.message); }

function saveProAccounts() {
  try { fs.writeFileSync(PRO_ACCOUNTS_FILE, JSON.stringify(proAccounts, null, 2)); } catch (e) {}
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw + 'bcash-pro-2026').digest('hex');
}

function generateProToken() {
  return 'PRO-' + crypto.randomBytes(20).toString('hex');
}

function getProAccountByToken(token) {
  return Object.values(proAccounts).find(a => a.token === token) || null;
}

function requirePro(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Pro authentication required' });
  const account = getProAccountByToken(token);
  if (!account) return res.status(401).json({ error: 'Invalid or expired pro token' });
  // Check trial/plan status
  if (account.plan === 'trial') {
    const daysSinceStart = (Date.now() - account.trialStart) / (1000 * 60 * 60 * 24);
    if (daysSinceStart > 3 && !account.paidMonthly) {
      return res.status(402).json({ error: 'Trial expired. Please upgrade to Pro ($149/month).' });
    }
  }
  req.proAccount = account;
  next();
}

// ── POST /api/pro/signup ────────────────────────────────────────────────────
app.post('/api/pro/signup', express.json(), (req, res) => {
  const { firmName, email, password, respAccepted } = req.body || {};
  if (!firmName || !email || !password) return res.status(400).json({ error: 'firmName, email, and password are required' });
  if (!respAccepted) return res.status(400).json({ error: 'Must accept responsibility statement' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (proAccounts[email.toLowerCase()]) return res.status(409).json({ error: 'An account with this email already exists' });

  const token = generateProToken();
  proAccounts[email.toLowerCase()] = {
    firmName,
    email: email.toLowerCase(),
    passwordHash: hashPassword(password),
    token,
    plan: 'trial',
    trialStart: Date.now(),
    paidMonthly: false,
    respAcceptedAt: new Date().toISOString(),
    runsUsed: 0,
    runs: [],
    createdAt: new Date().toISOString(),
  };
  saveProAccounts();
  console.log(`[pro] New account: ${email} (${firmName})`);
  res.json({ ok: true, token, firmName, plan: 'trial' });
});

// ── POST /api/pro/login ─────────────────────────────────────────────────────
app.post('/api/pro/login', express.json(), (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const account = proAccounts[email.toLowerCase()];
  if (!account || account.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  // Refresh token on each login
  account.token = generateProToken();
  saveProAccounts();
  res.json({ ok: true, token: account.token, firmName: account.firmName, plan: account.plan });
});

// ── GET /api/pro/account ────────────────────────────────────────────────────
app.get('/api/pro/account', requirePro, (req, res) => {
  const a = req.proAccount;
  const daysSinceStart = (Date.now() - a.trialStart) / (1000 * 60 * 60 * 24);
  const trialDaysLeft = Math.max(0, Math.ceil(3 - daysSinceStart));
  res.json({
    firmName:      a.firmName,
    email:         a.email,
    plan:          a.plan,
    trialDaysLeft: a.plan === 'trial' ? trialDaysLeft : null,
    runsUsed:      a.runsUsed || 0,
  });
});

// ── GET /api/pro/run-token ──────────────────────────────────────────────────
app.get('/api/pro/run-token', requirePro, (req, res) => {
  // Generate an upload token for a pro triage run (bypasses payment)
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let uploadToken = 'PRO-';
  for (let i = 0; i < 8; i++) uploadToken += chars.charAt(Math.floor(Math.random() * chars.length));
  const receiptId = `pro-run-${Date.now()}`;
  uploadTokens.set(uploadToken, receiptId);
  // Mark as pro run in pending orders so it's recognized
  pendingOrders.set(receiptId, { status: 'paid', mode: 'restaurant', proEmail: req.proAccount.email });
  res.json({ ok: true, uploadToken, receiptId });
});

// ── GET /api/pro/history ───────────────────────────────────────────────────
app.get('/api/pro/history', requirePro, (req, res) => {
  const a = req.proAccount;
  const runs = (a.runs || []).map(r => ({
    token:       r.token,
    clientLabel: r.clientLabel,
    projectName: r.projectName,
    period:      r.period,
    createdAt:   r.createdAt,
    files:       r.fileCount || 0,
    expired:     Date.now() > (r.expiresAt || 0),
  })).reverse(); // newest first
  res.json({ runs });
});

// Hook: after a successful triage run, if it was a pro run, log it to the account
// This is called from inside the financial-triage endpoint after reports are generated
function recordProRun(proEmail, token, clientLabel, projectName, period, fileCount, expiresAt) {
  const account = proAccounts[proEmail?.toLowerCase()];
  if (!account) return;
  if (!account.runs) account.runs = [];
  account.runs.push({ token, clientLabel, projectName, period, fileCount, expiresAt, createdAt: new Date().toISOString() });
  account.runsUsed = (account.runsUsed || 0) + 1;
  // Keep last 200 runs per account
  if (account.runs.length > 200) account.runs = account.runs.slice(-200);
  saveProAccounts();
}

// ── Failure store ─────────────────────────────────────────────────────────────
let failedJobs = {};
try {
  if (fs.existsSync(FAILURE_FILE)) {
    failedJobs = JSON.parse(fs.readFileSync(FAILURE_FILE, 'utf8'));
    console.log(`[failures] Loaded ${Object.keys(failedJobs).length} past failures`);
  }
} catch (e) { console.warn('[failures] Could not load failure store:', e.message); }

function saveFailure(token, data) {
  failedJobs[token] = { ...data, savedAt: new Date().toISOString() };
  // Keep last 200 failures
  const keys = Object.keys(failedJobs);
  if (keys.length > 200) delete failedJobs[keys[0]];
  try { fs.writeFileSync(FAILURE_FILE, JSON.stringify(failedJobs, null, 2)); } catch (e) {}
}

function tgAlert(msg) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat  = process.env.TELEGRAM_CHANNEL_ID;
  if (!token || !chat) return;
  const data = JSON.stringify({ chat_id: chat, text: msg, parse_mode: 'Markdown' });
  const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: data };
  const https = require('https');
  try {
    const u = new URL(`https://api.telegram.org/bot${token}/sendMessage`);
    const req = https.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    req.write(data); req.end();
  } catch (e) { console.warn('[tg-alert]', e.message); }
}

function loadJobStore() {
  try {
    if (fs.existsSync(JOBS_FILE)) {
      const data = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
      const map = new Map();
      const now = Date.now();
      for (const [k, v] of Object.entries(data)) {
        if (v.expiresAt > now) map.set(k, v); // skip expired
      }
      console.log(`[jobs] Loaded ${map.size} active jobs from disk`);
      return map;
    }
  } catch (e) {
    console.warn('[jobs] Could not load job store:', e.message);
  }
  return new Map();
}

function saveJobStore() {
  try {
    const obj = {};
    for (const [k, v] of triageJobStore) {
      // Convert Buffers to base64 for JSON serialization
      obj[k] = {
        ...v,
        pdfs: (v.pdfs || []).map(p => ({
          name: p.name,
          data: p.buffer ? p.buffer.toString('base64') : (p.data || ''),
        })),
      };
    }
    fs.writeFileSync(JOBS_FILE, JSON.stringify(obj));
  } catch (e) {
    console.warn('[jobs] Could not save job store:', e.message);
  }
}

const triageJobStore = loadJobStore();

// Clean expired tokens every 30 minutes + save to disk
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of triageJobStore) {
    if (now > entry.expiresAt) {
      triageJobStore.delete(token);
      console.log(`[triage] Token ${token} expired and cleaned up.`);
    }
  }
  saveJobStore();
}, 30 * 60 * 1000);

app.post('/api/financial-triage', triageUpload.fields([
  { name: 'bankFile', maxCount: 1 },
  { name: 'posFile', maxCount: 1 },
]), async (req, res) => {
  try {
    const { projectName, period, tier, agreedToTos, uploadToken, mode, personalInfo, signatureData, selectedForms, signerName } = req.body || {};

    // Validate payment via uploadToken
    if (!uploadToken || !uploadTokens.has(uploadToken)) {
      return res.status(402).json({ error: 'Payment required. Please complete payment before uploading files.' });
    }
    const paidReceiptId = uploadTokens.get(uploadToken);
    const isTestToken = uploadToken.startsWith('TEST-');
    const paidOrder = pendingOrders.get(paidReceiptId);
    // Test tokens (TEST-XXXX) bypass payment check — real tokens require paid order
    if (!isTestToken && (!paidOrder || paidOrder.status !== 'paid')) {
      return res.status(402).json({ error: 'Payment not confirmed. Please complete payment first.' });
    }

    if (agreedToTos !== 'true') {
      return res.status(400).json({ error: 'Must agree to Terms of Service' });
    }
    if (!projectName || !projectName.trim()) {
      return res.status(400).json({ error: 'projectName is required' });
    }
    if (!req.files?.bankFile?.[0]) {
      return res.status(400).json({ error: 'bankFile is required' });
    }

    const jobId = `ftriage_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let accessToken = 'TKN-';
    for (let i = 0; i < 6; i++) accessToken += chars.charAt(Math.floor(Math.random() * chars.length));

    const tmpDir = `/tmp/${jobId}`;
    const outputDir = `${tmpDir}/output`;
    fs.mkdirSync(outputDir, { recursive: true });

    // Move uploaded files into job dir
    const bankFile = req.files.bankFile[0];
    const bankExt = path.extname(bankFile.originalname) || '.xlsx';
    const bankPath = `${tmpDir}/bank${bankExt}`;
    fs.renameSync(bankFile.path, bankPath);

    let posArg = '';
    if (req.files?.posFile?.[0]) {
      const posFile = req.files.posFile[0];
      const posExt = path.extname(posFile.originalname) || '.xlsx';
      const posPath = `${tmpDir}/pos${posExt}`;
      fs.renameSync(posFile.path, posPath);
      posArg = ` --pos "${posPath}"`;
    }

    // Resolve triage mode from form data or stored order
    const triageMode = (mode === 'personal' || paidOrder?.mode === 'personal') ? 'personal' : 'restaurant';
    const modeArg = ` --mode ${triageMode}`;

    // Build context JSON — includes personalInfo if provided
    const contextObj = {};
    if (personalInfo) {
      try {
        const pi = typeof personalInfo === 'string' ? JSON.parse(personalInfo) : personalInfo;
        // personal_info triggers SBA 413 + Truist PFS generation
        contextObj.personal_info = pi.personal_info || pi;
        if (pi.assets) contextObj.assets = pi.assets;
        if (pi.liabilities) contextObj.liabilities = pi.liabilities;
        if (pi.income) contextObj.income = pi.income;
        if (pi.notes_payable_list) contextObj.notes_payable_list = pi.notes_payable_list;
        if (pi.real_estate_list) contextObj.real_estate_list = pi.real_estate_list;
        if (pi.stocks_list) contextObj.stocks_list = pi.stocks_list;
        if (pi.sections) contextObj.sections = pi.sections;
        console.log('[triage] personal_info provided — will generate SBA 413 + Truist PFS');
      } catch (e) {
        console.warn('[triage] Could not parse personalInfo JSON:', e.message);
      }
    }

    // Signature data — draw (base64 PNG) or typed (typed:Name)
    if (signatureData) {
      const sigObj = {
        signer_name: signerName || projectName || '',
        date: new Date().toLocaleDateString('en-US', {month:'2-digit',day:'2-digit',year:'numeric'}),
        ip_address: req.ip || req.connection?.remoteAddress || 'N/A',
        timestamp: new Date().toISOString(),
      };
      if (typeof signatureData === 'string' && signatureData.startsWith('typed:')) {
        sigObj.typed_name = signatureData.slice(6).trim();
        sigObj.image_base64 = '';  // backend renders typed sig via signature_engine.render_typed_signature
      } else {
        sigObj.image_base64 = typeof signatureData === 'string' ? signatureData : '';
      }
      contextObj.signature_data = sigObj;
      console.log('[triage] Signature provided — will embed in all forms');
    }

    // Selected forms
    if (selectedForms) {
      contextObj.selected_forms = typeof selectedForms === 'string'
        ? selectedForms.split(',').map(s => s.trim()).filter(Boolean)
        : selectedForms;
      console.log('[triage] Selected forms:', contextObj.selected_forms);
    }

    const contextArg = ` --context '${JSON.stringify(contextObj).replace(/'/g, "'\"'\"'")}'`;

    // ── Send immediate confirmation email before analysis starts ──
    const confirmEmail = req.body?.email || null;
    if (resendClient && confirmEmail) {
      resendClient.emails.send({
        from: 'bleeding.cash Reports <reports@bleeding.cash>',
        to: confirmEmail,
        subject: 'Your reports are being generated — bleeding.cash',
        html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F7F6F2;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;"><tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;">
<tr><td style="background:#1B474D;padding:28px 40px;">
  <p style="margin:0;color:#BCE2E7;font-size:12px;font-weight:600;letter-spacing:2px;text-transform:uppercase;">bleeding.cash</p>
  <h1 style="margin:6px 0 0;color:#fff;font-size:22px;font-weight:700;">We received your files ✓</h1>
</td></tr>
<tr><td style="padding:32px 40px;">
  <p style="color:#28251D;font-size:15px;line-height:1.6;margin:0 0 16px;">Your financial triage is in progress. Analysis usually takes under 60 seconds.</p>
  <p style="color:#28251D;font-size:15px;line-height:1.6;margin:0 0 24px;">We\'ll send your reports in a second email as PDF attachments the moment they\'re ready.</p>
  <p style="color:#7A7974;font-size:13px;margin:0;">Questions? Reply to this email or contact <a href="mailto:support@bleeding.cash" style="color:#01696F;">support@bleeding.cash</a></p>
</td></tr>
<tr><td style="background:#F7F6F2;padding:20px 40px;border-top:1px solid #D4D1CA;">
  <p style="margin:0;color:#7A7974;font-size:11px;line-height:1.6;">bleeding.cash is operated by MCFL Restaurant Holdings LLC. Informational purposes only. Not financial, legal, or accounting advice.</p>
</td></tr></table></td></tr></table></body></html>`,
      }).catch(e => console.warn('[resend] Confirmation email failed:', e.message));
      console.log(`[triage] Confirmation email sent to ${confirmEmail}`);
    }

    // Run analyze.py
    const scriptPath = path.join(__dirname, 'scripts', 'analyze.py');
    const cmd = `python3 ${scriptPath} --project-name "${projectName.replace(/"/g, '')}" --bank "${bankPath}" --period "${(period || 'Current').replace(/"/g, '')}" --output-dir "${outputDir}"${posArg}${modeArg}${contextArg}`;
    console.log(`[triage] Running: ${cmd}`);

    let analyzeOutput = '';
    try {
      analyzeOutput = execSync(cmd, { stdio: 'pipe', timeout: 180000 }).toString();
    } catch (analyzeErr) {
      // ── FAILURE CAPTURE ────────────────────────────────────────────────────
      const stderr   = (analyzeErr.stderr || '').toString().slice(0, 2000);
      const stdout   = (analyzeErr.stdout || '').toString().slice(0, 2000);
      const errMsg   = analyzeErr.message || 'Unknown error';

      // Sniff file metadata without reading full content
      let fileMeta = {};
      try {
        const bankExt  = path.extname(bankPath).toLowerCase();
        const bankSize = fs.existsSync(bankPath) ? fs.statSync(bankPath).size : 0;
        fileMeta.bankExt  = bankExt;
        fileMeta.bankSize = bankSize;
        // Try to read first 3 lines for format sniffing (no PII — just headers)
        if (['.csv','.tsv'].includes(bankExt)) {
          const firstLines = fs.readFileSync(bankPath, 'utf8').split('\n').slice(0,3).join(' | ');
          fileMeta.bankHeaders = firstLines.replace(/[\d]{4,}/g, 'XXXX').slice(0, 300);
        }
      } catch (e) { fileMeta.sniffError = e.message; }

      // Save to failure store
      const failToken = accessToken;
      saveFailure(failToken, {
        token:       failToken,
        email:       req.body?.email || null,
        projectName,
        period:      period || 'Current',
        mode:        triageMode,
        error:       errMsg,
        stderr:      stderr,
        stdout:      stdout,
        fileMeta,
        bankPath,   // Keep path so re-run can use it if file still exists
        posPath:     req.files?.posFile?.[0]?.path || null,
        cmd:         cmd.replace(/--bank "[^"]+"/, '--bank "[REDACTED]"'),
        outputDir,
      });

      // Send Telegram alert
      tgAlert(
        `⚠️ *bleeding.cash FAILED JOB*\n\n` +
        `Token: \`${failToken}\`\n` +
        `Email: ${req.body?.email || 'none'}\n` +
        `File: ${fileMeta.bankExt || 'unknown'} (${Math.round((fileMeta.bankSize||0)/1024)}KB)\n` +
        `Headers: \`${(fileMeta.bankHeaders || 'N/A').slice(0,150)}\`\n\n` +
        `Error: \`${errMsg.slice(0,300)}\`\n` +
        `Stderr: \`${stderr.slice(0,400)}\`\n\n` +
        `Re-run after fix:\n` +
        `POST /api/rerun-job \`{"token":"${failToken}"}\``
      );

      // Send failure email to customer
      if (resendClient && req.body?.email) {
        resendClient.emails.send({
          from: 'bleeding.cash Reports <reports@bleeding.cash>',
          to: req.body.email,
          subject: 'Your report hit an issue — we\'re on it',
          html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F7F6F2;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;"><tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;">
<tr><td style="background:#1B474D;padding:28px 40px;">
  <p style="margin:0;color:#BCE2E7;font-size:12px;font-weight:600;letter-spacing:2px;text-transform:uppercase;">bleeding.cash</p>
  <h1 style="margin:6px 0 0;color:#fff;font-size:22px;font-weight:700;">We hit an issue with your file</h1>
</td></tr>
<tr><td style="padding:32px 40px;">
  <p style="color:#28251D;font-size:15px;line-height:1.6;margin:0 0 16px;">Your file format wasn't one we recognized automatically. Our team has been alerted and we'll process your report manually within 24 hours.</p>
  <p style="color:#28251D;font-size:15px;line-height:1.6;margin:0 0 16px;">Your access token: <strong style="font-family:monospace;">${failToken}</strong></p>
  <p style="color:#7A7974;font-size:13px;margin:0;">Questions? Reply to this email or contact <a href="mailto:support@bleeding.cash" style="color:#01696F;">support@bleeding.cash</a></p>
</td></tr>
<tr><td style="background:#F7F6F2;padding:20px 40px;border-top:1px solid #D4D1CA;">
  <p style="margin:0;color:#7A7974;font-size:11px;">bleeding.cash is operated by MCFL Restaurant Holdings LLC. Informational purposes only.</p>
</td></tr></table></td></tr></table></body></html>`,
        }).catch(e => console.warn('[resend] Failure email error:', e.message));
      }

      console.error('[triage] analyze.py FAILED:', errMsg);
      return res.status(500).json({
        error: 'Analysis failed — your file format may not be supported yet. Support has been notified.',
        token: failToken,
        support: 'support@bleeding.cash',
      });
    }

    // Read PDFs + Excel into memory
    const allFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.pdf') || f.endsWith('.xlsx'));
    const pdfs = allFiles.map(name => ({
      name,
      buffer: fs.readFileSync(path.join(outputDir, name)),
    }));
    const pdfFiles = allFiles.filter(f => f.endsWith('.pdf')); // for logging

    // Clean up temp files
    fs.rmSync(tmpDir, { recursive: true, force: true });

    const now = Date.now();
    const expiresAt = now + 24 * 60 * 60 * 1000;
    const clientEmail = req.body?.email || null;

    triageJobStore.set(accessToken, {
      pdfs,
      email: clientEmail,
      createdAt: now,
      expiresAt,
    });
    saveJobStore(); // persist to disk immediately

    // Invalidate upload token after successful use
    uploadTokens.delete(uploadToken);

    console.log(`[triage] Job ${jobId} complete. Token: ${accessToken}. Files: ${pdfs.length}`);

    // Record pro run if this came from a pro account
    const proOrderRecord = pendingOrders.get(paidReceiptId);
    if (proOrderRecord?.proEmail) {
      const clientLabel = req.body?.clientLabel || projectName;
      recordProRun(proOrderRecord.proEmail, accessToken, clientLabel, projectName, period || 'Current', pdfs.length, expiresAt);
    }

    // ── Send delivery email via Resend ──
    if (resendClient && clientEmail) {
      const downloadLink = `https://www.bleeding.cash/download?token=${accessToken}`;
      const expiryDate = new Date(expiresAt).toLocaleDateString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
      });
      // Build PDF attachments — pdfs stored as Buffer objects
      const attachments = pdfs.map(pdf => ({
        filename: pdf.name,
        content: pdf.buffer || Buffer.from(pdf.data || '', 'base64'),
      }));

      const formsLink = `https://www.bleeding.cash/my-forms?token=${accessToken}`;

      resendClient.emails.send({
        from: 'bleeding.cash Reports <reports@bleeding.cash>',
        to: clientEmail,
        subject: `Your Financial Reports — ${pdfs.length} files attached (PDF + Excel)`,
        attachments,
        html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F7F6F2;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F6F2;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr><td style="background:#1B474D;padding:32px 40px;">
          <p style="margin:0;color:#BCE2E7;font-size:12px;font-weight:600;letter-spacing:2px;text-transform:uppercase;">bleeding.cash</p>
          <h1 style="margin:8px 0 0;color:#ffffff;font-size:24px;font-weight:700;">Your Reports Are Attached</h1>
        </td></tr>
        <tr><td style="padding:40px;">
          <p style="margin:0 0 16px;color:#28251D;font-size:15px;line-height:1.6;">Your financial triage is complete. <strong>${pdfs.length} PDF${pdfs.length > 1 ? 's are' : ' is'} attached</strong> to this email — open them directly.</p>
          <ul style="margin:0 0 24px;padding-left:20px;color:#28251D;font-size:14px;line-height:2;">
            ${pdfs.map(p => `<li>${p.name.replace(/-[a-z0-9]{4,}-/i, ' ').replace('.pdf','').replace(/-/g,' ')}</li>`).join('')}
          </ul>
          <div style="background:#F7F6F2;border-radius:6px;padding:14px 18px;margin:0 0 16px;border-left:3px solid #1B474D;">
            <p style="margin:0 0 4px;color:#28251D;font-size:14px;font-weight:600;">Want your bank forms pre-filled?</p>
            <p style="margin:0 0 8px;color:#7A7974;font-size:13px;">Generate pre-filled PFS forms for Chase, BofA, Wells Fargo, Truist, SBA 413, and more using your access token.</p>
            <a href="${formsLink}" style="color:#01696F;font-size:13px;font-weight:600;">Get My Bank Forms &rarr;</a>
          </div>
          <p style="margin:0;color:#7A7974;font-size:12px;">Access token: <strong style="font-family:monospace;">${accessToken}</strong> (save this for the bank forms link)</p>
        </td></tr>
        <tr><td style="background:#F7F6F2;padding:24px 40px;border-top:1px solid #D4D1CA;">
          <p style="margin:0;color:#7A7974;font-size:11px;line-height:1.6;">bleeding.cash is a financial triage service operated by MCFL Restaurant Holdings LLC. This report is for informational purposes only and does not constitute financial, legal, or tax advice. Always consult a licensed professional before making financial decisions.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
      }).then(r => {
        if (r.error) {
          console.warn(`[resend] Email error: ${JSON.stringify(r.error)}`);
        } else {
          console.log(`[resend] Email sent to ${clientEmail} with ${attachments.length} PDFs — id: ${r.data?.id}`);
        }
      }).catch(e => console.warn(`[resend] Email failed: ${e.message} | ${e.statusCode || ''}`, e.response || ''));
    } else if (!clientEmail) {
      console.log('[resend] No email address provided — skipping delivery email.');
    }

    res.json({
      jobId,
      accessToken,
      status: 'complete',
      downloadUrl: `/api/financial-triage/download/${accessToken}`,
      expiresAt: new Date(expiresAt).toISOString(),
      emailSent: !!(resendClient && clientEmail),
    });
  } catch (err) {
    console.error('[triage] Error:', err.message);
    res.status(500).json({ error: `Triage failed: ${err.message}` });
  }
});

app.get('/api/financial-triage/download/:token', (req, res) => {
  const entry = triageJobStore.get(req.params.token);
  if (!entry || Date.now() > entry.expiresAt) {
    return res.status(404).json({ error: 'Token not found or expired' });
  }
  res.json({
    files: entry.pdfs.map((pdf, i) => ({
      name: pdf.name,
      downloadPath: `/api/financial-triage/file/${req.params.token}/${i}`,
    })),
  });
});

app.get('/api/financial-triage/file/:token/:index', (req, res) => {
  const entry = triageJobStore.get(req.params.token);
  if (!entry || Date.now() > entry.expiresAt) {
    return res.status(404).json({ error: 'Token not found or expired' });
  }
  const idx = parseInt(req.params.index);
  if (isNaN(idx) || idx < 0 || idx >= entry.pdfs.length) {
    return res.status(404).json({ error: 'File not found' });
  }
  const pdf = entry.pdfs[idx];
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${pdf.name}"`);
  res.send(pdf.buffer);
});

// ── /api/failures — view all captured failures (operator only) ───────────────────
app.get('/api/failures', requireOperator, (req, res) => {
  const list = Object.values(failedJobs)
    .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt))
    .map(f => ({
      token:       f.token,
      email:       f.email,
      savedAt:     f.savedAt,
      mode:        f.mode,
      fileExt:     f.fileMeta?.bankExt,
      fileSize:    f.fileMeta?.bankSize,
      headers:     f.fileMeta?.bankHeaders,
      error:       f.error?.slice(0, 300),
      stderr:      f.stderr?.slice(0, 500),
      canRerun:    !!f.bankPath && fs.existsSync(f.bankPath),
    }));
  res.json({ count: list.length, failures: list });
});

// ── /api/rerun-job — retrigger a failed job after parser fix ───────────────────
app.post('/api/rerun-job', requireOperator, express.json(), async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token required' });

  const failed = failedJobs[token];
  if (!failed) return res.status(404).json({ error: 'No failed job found for that token' });

  const bankPath = failed.bankPath;
  if (!bankPath || !fs.existsSync(bankPath)) {
    return res.status(400).json({
      error: 'Original file no longer available — customer must resubmit',
      token,
      email: failed.email,
    });
  }

  // Reconstruct the output dir
  const rerunJobId  = `rerun_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
  const outputDir   = `/tmp/${rerunJobId}/output`;
  fs.mkdirSync(outputDir, { recursive: true });

  const scriptPath  = path.join(__dirname, 'scripts', 'analyze.py');
  const posArg      = failed.posPath && fs.existsSync(failed.posPath) ? ` --pos "${failed.posPath}"` : '';
  const modeArg     = ` --mode ${failed.mode || 'restaurant'}`;
  const cmd = `python3 ${scriptPath} --project-name "${(failed.projectName || 'Project').replace(/"/g,'')}" --bank "${bankPath}" --period "${(failed.period || 'Current').replace(/"/g,'')}" --output-dir "${outputDir}"${posArg}${modeArg}`;

  console.log(`[rerun] Re-running failed job ${token}:`, cmd);

  try {
    execSync(cmd, { stdio: 'pipe', timeout: 180000 });
  } catch (rerunErr) {
    const stderr = (rerunErr.stderr || '').toString().slice(0, 1000);
    console.error('[rerun] Still failing:', rerunErr.message);
    // Update failure record with new error
    saveFailure(token, { ...failed, error: rerunErr.message, stderr, reruns: (failed.reruns || 0) + 1 });
    return res.status(500).json({ error: 'Re-run still failing', stderr, message: rerunErr.message });
  }

  // Success — read output files
  const allFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.pdf') || f.endsWith('.xlsx'));
  const pdfs = allFiles.map(name => ({
    name,
    buffer: fs.readFileSync(path.join(outputDir, name)),
  }));

  // Store in job store under original token so customer download link works
  const now       = Date.now();
  const expiresAt = now + 24 * 60 * 60 * 1000;
  triageJobStore.set(token, { pdfs, email: failed.email, createdAt: now, expiresAt });
  saveJobStore();

  // Clean up rerun dir
  fs.rmSync(`/tmp/${rerunJobId}`, { recursive: true, force: true });

  // Remove from failures
  delete failedJobs[token];
  try { fs.writeFileSync(FAILURE_FILE, JSON.stringify(failedJobs, null, 2)); } catch (e) {}

  // Send delivery email if we have the customer email
  if (resendClient && failed.email) {
    const attachments = pdfs.map(p => ({ filename: p.name, content: p.buffer }));
    resendClient.emails.send({
      from: 'bleeding.cash Reports <reports@bleeding.cash>',
      to: failed.email,
      subject: `Your Financial Reports Are Ready — ${pdfs.length} files attached`,
      attachments,
      html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F7F6F2;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;"><tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;">
<tr><td style="background:#1B474D;padding:28px 40px;">
  <p style="margin:0;color:#BCE2E7;font-size:12px;font-weight:600;letter-spacing:2px;text-transform:uppercase;">bleeding.cash</p>
  <h1 style="margin:6px 0 0;color:#fff;font-size:22px;font-weight:700;">Your reports are attached — sorry for the wait</h1>
</td></tr>
<tr><td style="padding:32px 40px;">
  <p style="color:#28251D;font-size:15px;line-height:1.6;margin:0 0 16px;">We processed your file manually and your <strong>${pdfs.length} reports</strong> are now attached to this email.</p>
  <p style="color:#28251D;font-size:15px;line-height:1.6;margin:0 0 16px;">Access token: <strong style="font-family:monospace;">${token}</strong></p>
  <p style="color:#7A7974;font-size:13px;margin:0;">Thank you for your patience. Contact <a href="mailto:support@bleeding.cash" style="color:#01696F;">support@bleeding.cash</a> with any questions.</p>
</td></tr>
<tr><td style="background:#F7F6F2;padding:20px 40px;border-top:1px solid #D4D1CA;">
  <p style="margin:0;color:#7A7974;font-size:11px;">bleeding.cash is operated by MCFL Restaurant Holdings LLC. Informational purposes only.</p>
</td></tr></table></td></tr></table></body></html>`,
    }).catch(e => console.warn('[resend] Rerun delivery error:', e.message));
  }

  tgAlert(`✅ *Re-run SUCCESS* \`${token}\`\n${pdfs.length} files delivered to ${failed.email || 'no email'}`);

  res.json({
    ok: true,
    token,
    files: pdfs.length,
    emailSent: !!(resendClient && failed.email),
    message: 'Re-run complete. Reports delivered.',
  });
});

// ── /api/create-order — consumer triage payment (public) ──────────────────────────
app.post('/api/create-order', express.json(), async (req, res) => {
  try {
    const { projectName, email, period } = req.body || {};
    if (!projectName || !email) return res.status(400).json({ error: 'projectName and email required' });
    if (!BASALT_API_KEY) return res.status(503).json({ error: 'Payment not configured' });

    const orderRes = await axios.post(`${BASALT_BASE}/api/orders`, {
      items: [{ sku: '4GVZVPZG7', qty: 1 }],
    }, { headers: { 'Ocp-Apim-Subscription-Key': BASALT_API_KEY } });

    const { receipt, portalLink } = orderRes.data;
    const receiptId = receipt?.receiptId;
    if (!receiptId) return res.status(500).json({ error: 'Order creation failed', detail: orderRes.data });

    // portalLink from Basalt is the correct payment page URL
    const paymentUrl = (portalLink || '').split(', ').pop().trim() || `https://surge.basalthq.com/portal/${receiptId}?recipient=0x6e1d0e78b2577c0106ae5935ea0e40464690bd3b`;

    // Store pending order
    pendingOrders.set(receiptId, {
      projectName: projectName.trim(),
      period: period || '',
      email: email.trim(),
      mode: 'restaurant',
      status: 'pending',
      createdAt: Date.now(),
    });

    console.log(`[create-order] ${receiptId} for ${email} — ${projectName}`);

    // Send instant confirmation email with receipt ID and recovery link
    if (resendClient && email) {
      resendClient.emails.send({
        from: 'bleeding.cash <support@bleeding.cash>',
        to: email,
        subject: 'Complete your bleeding.cash order — save your receipt',
        html: `
          <!DOCTYPE html><html><body style="margin:0;padding:0;background:#F7F6F2;font-family:Arial,sans-serif;">
          <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;"><tr><td align="center">
          <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;">
          <tr><td style="background:#1B474D;padding:28px 40px;">
            <p style="margin:0;color:#BCE2E7;font-size:12px;font-weight:600;letter-spacing:2px;text-transform:uppercase;">bleeding.cash</p>
            <h1 style="margin:6px 0 0;color:#fff;font-size:22px;font-weight:700;">Your order is ready for payment</h1>
          </td></tr>
          <tr><td style="padding:32px 40px;">
            <p style="color:#28251D;font-size:15px;line-height:1.6;">Hi, you started a financial triage order for <strong>${projectName}</strong>.</p>
            <p style="color:#28251D;font-size:15px;line-height:1.6;">Your receipt ID is: <strong style="font-family:monospace;font-size:16px;">${receiptId}</strong></p>
            <p style="color:#28251D;font-size:15px;line-height:1.6;"><strong>Save this email.</strong> If anything goes wrong after payment, visit:</p>
            <p style="text-align:center;margin:24px 0;">
              <a href="https://www.bleeding.cash/recover" style="background:#c0392b;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;">bleeding.cash/recover</a>
            </p>
            <p style="color:#28251D;font-size:15px;line-height:1.6;">Enter your receipt ID <strong>${receiptId}</strong> and email address and we'll deliver your reports.</p>
            <p style="color:#7A7974;font-size:13px;">Questions? Reply to this email or contact support@bleeding.cash</p>
          </td></tr>
          <tr><td style="background:#F7F6F2;padding:20px 40px;border-top:1px solid #D4D1CA;">
            <p style="margin:0;color:#7A7974;font-size:11px;">bleeding.cash is operated by MCFL Restaurant Holdings LLC. Informational purposes only.</p>
          </td></tr></table></td></tr></table></body></html>
        `,
      }).catch(e => console.warn('[create-order] Email error:', e.message));
    }

    res.json({ ok: true, receiptId, paymentUrl });
  } catch (err) {
    console.error('[create-order]', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create order', detail: err.message });
  }
});

// ── /api/check-payment — poll Basalt for payment status, return uploadToken when paid ──
app.get('/api/check-payment', async (req, res) => {
  try {
    const { receiptId } = req.query;
    if (!receiptId) return res.status(400).json({ error: 'receiptId required' });

    const order = pendingOrders.get(receiptId) || {};

    // Already confirmed in memory?
    if (order.status === 'paid' && order.uploadToken) {
      return res.json({ paid: true, uploadToken: order.uploadToken });
    }

    // Check Basalt receipt status (source of truth)
    const statusRes = await axios.get(`${BASALT_BASE}/api/receipts/status`, {
      params: { receiptId },
      headers: { 'Ocp-Apim-Subscription-Key': BASALT_API_KEY },
    });
    const payStatus = statusRes.data?.status || statusRes.data?.state || '';
    const paidStatuses = ['completed', 'tx_mined', 'recipient_validated', 'paid', 'PAID', 'COMPLETED'];
    const isPaid = paidStatuses.some(s => payStatus.toLowerCase().includes(s.toLowerCase()));

    if (isPaid) {
      // Generate upload token
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let uploadToken = 'TKN-';
      for (let i = 0; i < 8; i++) uploadToken += chars[Math.floor(Math.random() * chars.length)];
      const receiptIdInternal = `paid-${Date.now()}`;

      uploadTokens.set(uploadToken, receiptIdInternal);
      pendingOrders.set(receiptIdInternal, { ...order, status: 'paid' });
      order.status = 'paid';
      order.uploadToken = uploadToken;

      console.log(`[check-payment] ${receiptId} PAID → token ${uploadToken}`);
      return res.json({ paid: true, uploadToken });
    }

    res.json({ paid: false, status: payStatus });
  } catch (err) {
    console.error('[check-payment]', err.response?.data || err.message);
    res.status(500).json({ error: 'Payment check failed', detail: err.message });
  }
});

// ── /api/recover — customer self-serve recovery by receipt ID ──────────────────────
app.post('/api/recover', express.json(), async (req, res) => {
  const { receiptId, email, projectName } = req.body || {};
  if (!receiptId || !email) return res.status(400).json({ error: 'receiptId and email required' });

  try {
    // Verify payment with Basalt
    const statusRes = await axios.get(`${BASALT_BASE}/api/receipts/status`, {
      params: { receiptId },
      headers: { 'Ocp-Apim-Subscription-Key': BASALT_API_KEY },
    });
    const payStatus = (statusRes.data?.status || '').toLowerCase();
    const isPaid = ['paid','completed','tx_mined','recipient_validated'].some(s => payStatus.includes(s));

    if (!isPaid) {
      return res.status(402).json({
        error: `Payment not confirmed. Receipt ${receiptId} status: ${payStatus || 'unknown'}. If you paid, please wait 5 minutes and try again.`
      });
    }

    // Check if we have reports stored for this receipt
    const existingJob = [...triageJobStore.entries()].find(([, job]) => job.receiptId === receiptId);
    if (existingJob) {
      const [token, job] = existingJob;
      if (resendClient && job.pdfs?.length) {
        const attachments = job.pdfs.map(p => ({ filename: p.name, content: p.buffer }));
        await resendClient.emails.send({
          from: 'bleeding.cash Reports <reports@bleeding.cash>',
          to: email,
          subject: `Your Financial Reports — Recovery Delivery`,
          attachments,
          html: `<p>Here are your recovered reports. Access token: <strong>${token}</strong></p>`,
        });
        return res.json({ ok: true, reportsDelivered: true, message: `Reports re-sent to ${email}.` });
      }
    }

    // Payment confirmed but files not in memory — issue a new upload token
    // Customer can re-upload files right on the recovery page
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let uploadToken = 'TKN-';
    for (let i = 0; i < 8; i++) uploadToken += chars[Math.floor(Math.random() * chars.length)];
    const rcpId = `recovery-${Date.now()}`;
    uploadTokens.set(uploadToken, rcpId);
    pendingOrders.set(rcpId, {
      projectName: projectName || 'Your Restaurant',
      period: '',
      email,
      mode: 'restaurant',
      status: 'paid',
      receiptId,
      createdAt: Date.now(),
    });

    // Send confirmation email
    if (resendClient) {
      resendClient.emails.send({
        from: 'bleeding.cash Support <support@bleeding.cash>',
        to: email,
        subject: 'Action required — re-upload your files at bleeding.cash/recover',
        html: `
          <p>Hi,</p>
          <p>We confirmed your payment for receipt <strong>${receiptId}</strong>.</p>
          <p>We need you to re-upload your bank statement to generate your reports.</p>
          <p style="text-align:center;margin:24px 0;">
            <a href="https://www.bleeding.cash/recover" style="background:#c0392b;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;">Re-upload at bleeding.cash/recover</a>
          </p>
          <p>Enter receipt <strong>${receiptId}</strong> and your email to re-upload and get your reports instantly.</p>
          <p>bleeding.cash — operated by MCFL Restaurant Holdings LLC</p>
        `,
      }).catch(() => {});
    }

    res.json({
      ok: true,
      needsFiles: true,
      uploadToken,
      message: `Payment confirmed for receipt ${receiptId}. Please re-upload your files below.`,
    });
  } catch (err) {
    console.error('[recover]', err.message);
    res.status(500).json({ error: 'Recovery failed. Email support@bleeding.cash with receipt: ' + receiptId });
  }
});

// ── /api/recover-by-email — find orders by email ────────────────────────────────
app.post('/api/recover-by-email', express.json(), async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });

  // Search job store for matching email
  const matches = [...triageJobStore.entries()]
    .filter(([, job]) => job.email?.toLowerCase() === email.toLowerCase())
    .sort(([, a], [, b]) => b.createdAt - a.createdAt);

  if (!matches.length) {
    // Search pending orders too
    const pendingMatch = [...pendingOrders.entries()]
      .find(([, o]) => o.email?.toLowerCase() === email.toLowerCase() && o.status === 'paid');

    if (!pendingMatch) {
      return res.status(404).json({ error: 'No paid orders found for that email. Try your Basalt receipt ID instead.' });
    }
    // Found pending order but no reports
    tgAlert(`⚠️ *Email Recovery*\n\n${email} found in pending orders but no reports stored. Manual action needed.`);
    return res.json({ ok: true, message: 'Order found. Reports will be emailed within 30 minutes.' });
  }

  // Found job with reports — re-send
  const [token, job] = matches[0];
  if (resendClient && job.pdfs?.length) {
    const attachments = job.pdfs.map(p => ({ filename: p.name, content: p.buffer }));
    await resendClient.emails.send({
      from: 'bleeding.cash Reports <reports@bleeding.cash>',
      to: email,
      subject: 'Your Financial Reports — Re-sent',
      attachments,
      html: `<p>Your reports have been re-sent. Access token: <strong>${token}</strong></p><p><a href="https://www.bleeding.cash/my-forms?token=${token}">Get your bank forms →</a></p>`,
    });
    return res.json({ ok: true, message: `Reports re-sent to ${email}. Check your inbox.` });
  }

  res.json({ ok: true, message: `Order found (token: ${token}). Processing re-delivery.` });
});

// ── /api/gflop-scan — fire Alpha Scanner + Token Analyst with compute signal mission ──────
// Scans for compute tokens (AKT/RNDR/IO) momentum AND correlates with Base DEX activity
// Returns GFLOP signal: which tokens on Base are moving when compute demand is high
app.post('/api/gflop-scan', requireOperator, async (req, res) => {
  if (!acpClient) return res.status(503).json({ error: 'ACP client not ready' });

  // Fetch real compute token data first
  let computeData = '';
  try {
    const cgRes = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=akash-network,render-token,io&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true',
      { timeout: 8000 }
    );
    const d = cgRes.data;
    const akt  = d['akash-network'];
    const rndr = d['render-token'];
    const io   = d['io'];
    const lines = [
      akt  && `AKT (Akash):  $${akt.usd?.toFixed(4)}  ${akt.usd_24h_change?.toFixed(2)}%  vol $${Number(akt.usd_24h_vol||0).toLocaleString()}`,
      rndr && `RNDR (Render): $${rndr.usd?.toFixed(4)}  ${rndr.usd_24h_change?.toFixed(2)}%  vol $${Number(rndr.usd_24h_vol||0).toLocaleString()}`,
      io   && `IO (io.net):   $${io.usd?.toFixed(4)}  ${io.usd_24h_change?.toFixed(2)}%  vol $${Number(io.usd_24h_vol||0).toLocaleString()}`,
    ].filter(Boolean);
    computeData = lines.join('\n');
  } catch (e) {
    computeData = 'Compute token data unavailable';
  }

  const gflopRequirement = `GFLOP COMPUTE SIGNAL SCAN

Real-time compute token prices:
${computeData}

Your mission:
1. Based on these compute token prices, determine if compute demand is rising or falling
2. Scan Base chain DEX for tokens that correlate with compute/AI demand (look for tokens with "AI", "AGENT", "COMPUTE", "GPU" themes or tokens in the Virtuals Protocol ecosystem)
3. Find any recent launches or volume spikes on Base that align with the compute signal
4. Rate each opportunity: STRONG BUY / BUY / NEUTRAL / AVOID
5. For STRONG BUY signals include the token contract address on Base

Focus on actionable signals. If compute tokens are up = look for AI/agent token momentum on Base. If down = flag caution.`;

  // Reuse /api/fire-job internal logic — same code path that works
  try {
    const alphaWorker = WORKER_CATALOG['GSB Alpha Scanner'];
    if (!acpClient) return res.status(503).json({ error: 'ACP client not ready — Railway may be starting up' });

    const jobId = await acpClient.initiateJob(
      alphaWorker.address,
      gflopRequirement,
      makeFare(alphaWorker.price),
      null,
      new Date(Date.now() + 1000 * 60 * 30),
    );
    jobWorkerMap.set(jobId, 'GSB Alpha Scanner');
    setWorkerStatus('GSB Alpha Scanner', 'working', jobId);
    logJob(jobId, 'GSB Alpha Scanner', 'gflop-scan', 'fired');
    console.log(`[gflop-scan] Job fired: ${jobId}`);
    res.json({ ok: true, jobId, computeData, message: 'GFLOP scan fired to Alpha Scanner' });
  } catch (err) {
    const msg = err.message || String(err);
    console.error('[gflop-scan] Error:', msg);
    // If ACP client issue, return helpful message
    if (msg.includes('contractAddress') || msg.includes('undefined')) {
      return res.status(503).json({
        error: 'ACP contract client not initialized — the CEO wallet may need to be funded or Railway restarted',
        detail: msg,
      });
    }
    res.status(500).json({ error: msg });
  }
});

// ── /api/copy-trader/buy-signal — execute a direct buy from CEO alpha signal ──────────
app.post('/api/copy-trader/buy-signal', requireOperator, express.json(), async (req, res) => {
  const { tokenAddress, tokenName, usdAmount } = req.body || {};
  if (!tokenAddress) return res.status(400).json({ error: 'tokenAddress required' });

  const amount = Math.min(parseFloat(usdAmount) || 2.5, copyTraderState.budget || 10);
  const PRIVATE_KEY_TRADE = process.env.AGENT_WALLET_PRIVATE_KEY;
  if (!PRIVATE_KEY_TRADE) return res.status(503).json({ error: 'No wallet key configured' });

  console.log(`[buy-signal] Buying ${tokenName || tokenAddress} with $${amount}`);

  // Multi-hop: USDC → WETH → token via Uniswap v3 SwapRouter
  const WETH_BASE = '0x4200000000000000000000000000000000000006';
  const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const ROUTER   = '0x2626664c2603336E57B271c5C0b26F421741e481';
  const BASE_RPC  = process.env.BASE_RPC_URL || 'https://base.drpc.org';

  const script = `
const { createWalletClient, createPublicClient, http, parseUnits, maxUint256, encodeFunctionData } = require('viem');
const { base } = require('viem/chains');
const { privateKeyToAccount } = require('viem/accounts');

const ERC20_ABI = [
  { name:'approve', type:'function', inputs:[{name:'spender',type:'address'},{name:'amount',type:'uint256'}], outputs:[{name:'',type:'bool'}] },
  { name:'allowance', type:'function', inputs:[{name:'owner',type:'address'},{name:'spender',type:'address'}], outputs:[{name:'',type:'uint256'}] },
];

const MULTIHOP_ABI = [{
  name: 'exactInput',
  type: 'function',
  inputs: [{ name: 'params', type: 'tuple', components: [
    {name:'path',type:'bytes'},
    {name:'recipient',type:'address'},
    {name:'amountIn',type:'uint256'},
    {name:'amountOutMinimum',type:'uint256'},
  ]}],
  outputs: [{name:'amountOut',type:'uint256'}],
}];

async function buyToken() {
  const account = privateKeyToAccount('${PRIVATE_KEY_TRADE}');
  const walletClient = createWalletClient({ account, chain: base, transport: http('${BASE_RPC}') });
  const publicClient = createPublicClient({ chain: base, transport: http('${BASE_RPC}') });

  const USDC   = '${USDC_BASE}';
  const WETH   = '${WETH_BASE}';
  const TOKEN  = '${tokenAddress}';
  const ROUTER = '${ROUTER}';
  const amountIn = parseUnits('${amount.toFixed(6)}', 6);

  // Approve USDC if needed
  const allowance = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, ROUTER] });
  if (allowance < amountIn) {
    const approveTx = await walletClient.writeContract({ address: USDC, abi: ERC20_ABI, functionName: 'approve', args: [ROUTER, maxUint256] });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    console.log('APPROVED:' + approveTx);
  }

  // Encode path: USDC (fee 500) -> WETH (fee 3000) -> TOKEN
  // Path encoding: token0 + fee + token1 + fee + token2
  const encodePath = (tokens, fees) => {
    let encoded = tokens[0].slice(2).toLowerCase();
    for (let i = 0; i < fees.length; i++) {
      encoded += fees[i].toString(16).padStart(6, '0');
      encoded += tokens[i+1].slice(2).toLowerCase();
    }
    return '0x' + encoded;
  };
  const path = encodePath([USDC, WETH, TOKEN], [500, 3000]);

  const hash = await walletClient.writeContract({
    address: ROUTER,
    abi: MULTIHOP_ABI,
    functionName: 'exactInput',
    args: [{ path, recipient: account.address, amountIn, amountOutMinimum: 0n }],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log('TX_HASH:' + hash);
  console.log('GAS_USED:' + receipt.gasUsed.toString());
}
buyToken().catch(e => console.error('BUY_ERROR:' + e.message));
`;

  try {
    const { execSync } = require('child_process');
    const tmpFile = path.join(__dirname, `buy_signal_${Date.now()}.js`);
    require('fs').writeFileSync(tmpFile, script);
    const output = execSync(`node ${tmpFile}`, { timeout: 60000, env: process.env, cwd: __dirname }).toString();
    require('fs').unlinkSync(tmpFile);

    const txLine = output.split('\n').find(l => l.startsWith('TX_HASH:'));
    const txHash = txLine?.replace('TX_HASH:', '').trim();
    const buyError = output.split('\n').find(l => l.startsWith('BUY_ERROR:'));

    if (buyError) {
      const errMsg = buyError.replace('BUY_ERROR:', '');
      console.error('[buy-signal] Failed:', errMsg);
      return res.status(500).json({ ok: false, error: errMsg });
    }

    if (txHash) {
      const explorerUrl = `https://basescan.org/tx/${txHash}`;
      console.log(`[buy-signal] ✅ Bought ${tokenName} tx: ${txHash}`);

      // Get current price for position tracking
      let buyPrice = 0;
      try {
        const priceRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
        const pairs = priceRes.data?.pairs || [];
        pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
        buyPrice = parseFloat(pairs[0]?.priceUsd || '0');
      } catch (_) {}

      // Save position for exit monitor
      const posId = `${tokenAddress.slice(0,10)}_${Date.now()}`;
      savePosition(posId, {
        posId,
        tokenAddress,
        tokenName: tokenName || tokenAddress.slice(0,10),
        buyPrice,
        amountUsd: amount,
        buyTimestamp: Date.now(),
        buyTx: txHash,
        status: 'open',
        createdAt: new Date().toISOString(),
      });

      // Start exit monitor if not already running
      startExitMonitor();

      tgAlert(
        `✅ *CEO Signal Trade Executed*\n\n` +
        `Bought: ${tokenName || tokenAddress.slice(0,10)}\n` +
        `Amount: $${amount}\n` +
        `Entry price: $${buyPrice.toFixed(8)}\n` +
        `Stop loss: -20% → $${(buyPrice * 0.80).toFixed(8)}\n` +
        `Take profit: +50% → $${(buyPrice * 1.50).toFixed(8)}\n` +
        `Time stop: 4 hours\n` +
        `GFLOP exit: if AKT+RNDR both drop >3%\n\n` +
        `Tx: ${explorerUrl}`
      );

      // Track in copy trader state log
      copyTraderState.log.push(`[CEO-signal] Bought ${tokenName} $${amount} @ $${buyPrice.toFixed(8)} | exit monitor active`);
      if (copyTraderState.log.length > 200) copyTraderState.log.shift();

      return res.json({ ok: true, txHash, explorerUrl, token: tokenName, amount, buyPrice, posId });
    }

    return res.status(500).json({ ok: false, error: 'No tx hash returned', output: output.slice(0, 300) });
  } catch (err) {
    console.error('[buy-signal] Exec error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── /api/analyze — public token analysis (Ethy-compatible output) ─────────────────
app.get('/api/analyze', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'token query param required. e.g. /api/analyze?token=FETCHR' });
  try {
    const scriptPath = path.join(__dirname, 'scripts', 'token_analysis.js');
    const output = execSync(`node ${scriptPath} "${token.replace(/"/g, '')}"`, {
      cwd: __dirname,
      env: { ...process.env },
      timeout: 30000,
    }).toString();
    const line = output.split('\n').find(l => l.startsWith('ANALYSIS_RESULT:'));
    if (line) return res.json(JSON.parse(line.replace('ANALYSIS_RESULT:', '')));
    return res.status(500).json({ error: 'Analysis failed', output: output.slice(0, 300) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── /api/trade-signal — latest ACP-generated trade signal ──────────────────────
app.get('/api/trade-signal', requireOperator, (req, res) => {
  res.json(global.latestTradeSignal || { signal: null, message: 'No signal yet' });
});

// ── /api/tweet — post a single tweet via Railway X credentials ──────────────────
app.post('/api/tweet', express.json(), async (req, res) => {
  // Light auth — same secret as dispatch
  const token = req.headers['x-gsb-token'] || req.headers['authorization']?.replace('Bearer ','');
  if (token !== 'gsb-dispatch-2026' && token !== process.env.DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });

  const X_API_KEY    = process.env.X_API_KEY;
  const X_API_SECRET = process.env.X_API_SECRET;
  const X_ACC_TOKEN  = process.env.X_ACCESS_TOKEN;
  const X_ACC_SECRET = process.env.X_ACCESS_TOKEN_SECRET;

  if (!X_API_KEY || !X_ACC_TOKEN) {
    return res.status(503).json({ error: 'X credentials not configured' });
  }

  try {
    const crypto = require('crypto');
    const tweetUrl = 'https://api.twitter.com/2/tweets';
    const nonce = crypto.randomBytes(16).toString('hex');
    const ts    = Math.floor(Date.now() / 1000).toString();

    const oauthParams = {
      oauth_consumer_key:     X_API_KEY,
      oauth_nonce:            nonce,
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp:        ts,
      oauth_token:            X_ACC_TOKEN,
      oauth_version:          '1.0',
    };

    const sortedStr = Object.keys(oauthParams).sort()
      .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(oauthParams[k])}`)
      .join('&');
    const baseString  = `POST&${encodeURIComponent(tweetUrl)}&${encodeURIComponent(sortedStr)}`;
    const signingKey  = `${encodeURIComponent(X_API_SECRET)}&${encodeURIComponent(X_ACC_SECRET)}`;
    const signature   = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
    const authHeader  = 'OAuth ' + Object.keys({ ...oauthParams, oauth_signature: signature })
      .sort()
      .map(k => `${k}="${encodeURIComponent({ ...oauthParams, oauth_signature: signature }[k])}"`)
      .join(', ');

    const xRes = await axios.post(tweetUrl,
      { text: text.slice(0, 280) },
      { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } }
    );

    const tweetId = xRes.data?.data?.id;
    const url = tweetId ? `https://x.com/ErikOsol43597/status/${tweetId}` : null;
    console.log('[tweet] Posted:', url);
    res.json({ ok: true, id: tweetId, url });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('[tweet] Failed:', detail);
    res.status(500).json({ error: 'Tweet failed', detail });
  }
});

// ── Position tracker + exit monitor ───────────────────────────────────────────────
const POSITIONS_FILE = '/tmp/gsb-open-positions.json';
let exitMonitorProcess = null;

function loadPositions() {
  try { return JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8')); } catch { return {}; }
}

function savePosition(posId, posData) {
  const positions = loadPositions();
  positions[posId] = posData;
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

function startExitMonitor() {
  if (exitMonitorProcess) return; // already running
  const monitorPath = path.join(__dirname, 'scripts', 'exit_monitor.js');
  if (!fs.existsSync(monitorPath)) {
    console.warn('[exit-monitor] Script not found:', monitorPath);
    return;
  }
  exitMonitorProcess = spawn('node', [monitorPath, POSITIONS_FILE], {
    cwd: __dirname,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  exitMonitorProcess.stdout.on('data', d => {
    d.toString().split('\n').filter(Boolean).forEach(l => {
      console.log('[exit-monitor]', l);
      copyTraderState.log.push('[exit] ' + l.trim());
      if (copyTraderState.log.length > 200) copyTraderState.log.shift();
    });
  });
  exitMonitorProcess.stderr.on('data', d => console.error('[exit-monitor]', d.toString().trim()));
  exitMonitorProcess.on('close', (code) => {
    console.log('[exit-monitor] Exited:', code);
    exitMonitorProcess = null;
  });
  console.log('[exit-monitor] Started PID:', exitMonitorProcess.pid);
}

// GET /api/copy-trader/positions — all open/closed positions
app.get('/api/copy-trader/positions', requireOperator, (req, res) => {
  res.json({ positions: loadPositions() });
});

// ── /api/copy-trader — start / stop / status ─────────────────────────────────
let copyTraderProcess = null;
let copyTraderState = { running: false, log: [], startedAt: null, budget: 0 };

app.post('/api/copy-trader/start', requireOperator, express.json(), async (req, res) => {
  if (copyTraderProcess) {
    return res.json({ ok: false, error: 'Already running' });
  }
  const budget = parseFloat(req.body.budget) || 10;
  const wallet = req.body.wallet || null;
  copyTraderState = { running: true, log: [], startedAt: new Date().toISOString(), budget };

  const args = ['scripts/copy_trader.py', '--budget', String(budget)];
  if (wallet) args.push('--wallet', wallet);
  else args.push('--hunt');

  const { spawn } = require('child_process');
  copyTraderProcess = spawn('python3', args, { cwd: __dirname, env: { ...process.env } });

  copyTraderProcess.stdout.on('data', d => {
    const line = d.toString().trim();
    copyTraderState.log.push(line);
    if (copyTraderState.log.length > 200) copyTraderState.log.shift();
    console.log('[copy-trader]', line);
  });
  copyTraderProcess.stderr.on('data', d => {
    const line = '[ERR] ' + d.toString().trim();
    copyTraderState.log.push(line);
    if (copyTraderState.log.length > 200) copyTraderState.log.shift();
  });
  copyTraderProcess.on('close', code => {
    copyTraderState.running = false;
    copyTraderState.log.push(`[process exited code ${code}]`);
    copyTraderProcess = null;
  });

  res.json({ ok: true, budget, wallet: wallet || 'hunt mode', pid: copyTraderProcess.pid });
});

app.post('/api/copy-trader/stop', requireOperator, (req, res) => {
  if (!copyTraderProcess) return res.json({ ok: false, error: 'Not running' });
  copyTraderProcess.kill('SIGTERM');
  copyTraderProcess = null;
  copyTraderState.running = false;
  res.json({ ok: true, message: 'Copy trader stopped' });
});

// POST /api/copy-trader/approve — one-time USDC approval for Uniswap router
app.post('/api/copy-trader/approve', requireOperator, async (req, res) => {
  const { execSync } = require('child_process');
  try {
    const output = execSync('node scripts/approve_usdc.js', {
      cwd: __dirname,
      env: { ...process.env },
      timeout: 30000,
    }).toString();
    const approved = output.includes('APPROVED') || output.includes('Already approved');
    res.json({ ok: approved, output: output.trim().slice(0, 500) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, output: (err.stdout || '').toString().slice(0, 300) });
  }
});

// POST /api/copy-trader/rehunt — fresh wallet scan
app.post('/api/copy-trader/rehunt', requireOperator, (req, res) => {
  const budget = req.body?.budget || copyTraderState.budget || 10;

  // Gracefully stop existing process
  if (copyTraderProcess) {
    try { copyTraderProcess.kill('SIGTERM'); } catch (_) {}
    copyTraderProcess = null;
  }

  // Clear state file
  try { fs.unlinkSync('/tmp/gsb-copy-trader-state.json'); } catch (_) {}

  copyTraderState = {
    running: true,
    log: ['[rehunt] Scanning Base chain for active wallets...'],
    startedAt: new Date().toISOString(),
    budget,
  };

  const scriptPath = path.join(__dirname, 'scripts', 'copy_trader.py');
  const args = ['scripts/copy_trader.py', '--budget', String(budget), '--hunt'];

  copyTraderProcess = spawn('python3', args, {
    cwd: __dirname,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  copyTraderProcess.stdout.on('data', d => {
    d.toString().split('\n').filter(Boolean).forEach(line => {
      copyTraderState.log.push(line.trim());
      if (copyTraderState.log.length > 200) copyTraderState.log.shift();
      console.log('[rehunt]', line.trim());
    });
  });
  copyTraderProcess.stderr.on('data', d => {
    d.toString().split('\n').filter(Boolean).forEach(line => {
      const l = '[ERR] ' + line.trim();
      copyTraderState.log.push(l);
      console.error('[rehunt]', l);
    });
  });
  copyTraderProcess.on('close', (code, signal) => {
    const msg = signal ? `[process killed by ${signal}]` : `[process exited code ${code}]`;
    copyTraderState.log.push(msg);
    copyTraderState.running = false;
    copyTraderProcess = null;
    console.log('[rehunt] Process ended:', msg);
  });
  copyTraderProcess.on('error', err => {
    copyTraderState.log.push('[spawn error] ' + err.message);
    copyTraderState.running = false;
    copyTraderProcess = null;
  });

  res.json({ ok: true, message: 'Fresh wallet scan started', pid: copyTraderProcess.pid, budget });
});

app.get('/api/copy-trader/status', requireOperator, (req, res) => {
  // Also try to read state file for position/P&L data
  let positions = {};
  let pnl = 0;
  try {
    const fs = require('fs');
    const raw = fs.readFileSync('/tmp/gsb-copy-trader-state.json', 'utf8');
    const s = JSON.parse(raw);
    positions = s.positions || {};
    pnl = s.total_pnl || 0;
    copyTraderState.budget = s.budget_usd || copyTraderState.budget;
    copyTraderState.cashRemaining = s.cash_remaining || 0;
    copyTraderState.targets = s.targets || [];
  } catch (_) {}
  res.json({
    running: copyTraderState.running,
    startedAt: copyTraderState.startedAt,
    budget: copyTraderState.budget,
    cashRemaining: copyTraderState.cashRemaining || 0,
    totalPnl: pnl,
    openPositions: Object.values(positions).filter(p => p.status === 'open').length,
    closedPositions: Object.values(positions).filter(p => p.status !== 'open').length,
    targets: copyTraderState.targets || [],
    recentLog: copyTraderState.log.slice(-30),
  });
});

// ── Catch-all → index.html ────────────────────────────────────────────────────
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard-ui', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`[gsb-dashboard] Listening on port ${PORT}`);

  // Start Telegram bot as background process
  if (process.env.TELEGRAM_SWAP_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN) {
    try {
      const botPath = path.join(__dirname, 'scripts', 'telegram_bot.js');
      if (fs.existsSync(botPath)) {
        const botProc = spawn('node', [botPath], {
          cwd: __dirname,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
        });
        botProc.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => console.log('[tg-bot]', l.trim())));
        botProc.stderr.on('data', d => console.error('[tg-bot-err]', d.toString().trim()));
        botProc.on('close', code => console.log('[tg-bot] Exited:', code));
        console.log('[tg-bot] GSB Swap Bot started PID:', botProc.pid);
      }
    } catch (e) {
      console.warn('[tg-bot] Failed to start:', e.message);
    }
  } else {
    console.warn('[tg-bot] No TELEGRAM_BOT_TOKEN — bot disabled');
  }

  try {
    await initAcp();
  } catch (err) {
    console.error('[acp] initAcp crashed — dashboard still running, fire-job disabled:', err.message);
  }
});
