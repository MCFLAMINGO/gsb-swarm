// CEO Buyer — orchestrates the GSB Intelligence Swarm
// Fires jobs at all 4 workers, reads their deliverables,
// synthesizes a GSB Intelligence Brief, and saves it to disk.
// Usage: node --experimental-require-module ceobuyer.js
require('dotenv').config();

const fs = require('fs');
const path = require('path');

const {
  AcpContractClientV2,
  baseAcpConfigV2,
  FareAmount,
  default: AcpClient,
} = require('@virtuals-protocol/acp-node');

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
    console.log('[CEO] No ANTHROPIC_API_KEY — using fallback synthesis');
  }
})();

// ── CEO Intelligence Cache ────────────────────────────────────────────────
const ceoCache = {
  lastAlphaScan: null,      // { data, fetchedAt }
  lastTokenData: {},        // address → { data, fetchedAt }
  workerLoad: {             // worker name → job count in flight
    'GSB Token Analyst': 0,
    'GSB Wallet Profiler': 0,
    'GSB Alpha Scanner': 0,
    'GSB Thread Writer': 0,
  },
  totalJobsServed: 0,
  bankStatus: 'ONLINE',
};

async function refreshCacheFromAlphaScanner() {
  try {
    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      const req = https.get(
        'https://api.geckoterminal.com/api/v2/networks/base/trending_pools?page=1',
        { headers: { 'User-Agent': 'GSB-CEO/1.0', Accept: 'application/json' } },
        res => {
          let body = '';
          res.on('data', d => body += d);
          res.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch (e) { reject(new Error('JSON parse: ' + e.message)); }
          });
        }
      );
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    });
    ceoCache.lastAlphaScan = { data: data?.data || data, fetchedAt: Date.now() };
    console.log('[CEO-cache] Alpha scan refreshed (' + (ceoCache.lastAlphaScan.data?.length || '?') + ' pools)');
  } catch (err) {
    console.warn('[CEO-cache] Alpha scan refresh failed:', err.message);
  }
}

// ── Config ──────────────────────────────────────────────────────────────────
const CEO_ENTITY_ID         = parseInt(process.env.CEO_ENTITY_ID) || 1;
const CEO_WALLET_ADDRESS    = process.env.CEO_WALLET_ADDRESS || '0xb165a3b019eb1922f5dcda97b83be75484b30d27';
const _RAW_KEY              = process.env.AGENT_WALLET_PRIVATE_KEY;
const PRIVATE_KEY           = _RAW_KEY && !_RAW_KEY.startsWith('0x') ? `0x${_RAW_KEY}` : _RAW_KEY;

const WORKERS = [
  {
    name: 'GSB Token Analyst',
    role: 'token_analysis',
    address: '0xBF56F4EC74cC1aE19c48197Eb32066c8a85dEfda',
    price: 0.25,
    requirement: 'Analyze token 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 on Base',
  },
  {
    name: 'GSB Wallet Profiler',
    role: 'wallet_profile',
    address: '0x730e371ff3E2277c36060748dd5207CEAF50701d',
    price: 0.50,
    requirement: 'Profile wallet 0x6dA1A9793Ebe96975c240501A633ab8B3c83D14A on Base',
  },
  {
    name: 'GSB Alpha Scanner',
    role: 'alpha_signals',
    address: '0x2c87651012bFA0247Fe741448DEbBF06c1b5c906',
    price: 0.10,
    requirement: 'Scan Base chain for alpha signals now',
  },
  {
    name: 'GSB Thread Writer',
    role: 'thread',
    address: '0x4ab8320491A1FD8396F7F23c212cd6fC978C8Ad0',
    price: 0.15,
    requirement: 'Write a crypto Twitter thread about $GSB Agent Gas Bible tokenized agent on Virtuals Protocol',
  },
];

const JOBS_PER_WORKER = 3;

// ── Worker configs for orchestration dispatch ──────────────────────────────
const WORKER_CONFIGS = {
  token_analyst:   { name: 'GSB Token Analyst',  address: '0xBF56F4EC74cC1aE19c48197Eb32066c8a85dEfda', price: 0.25 },
  wallet_profiler: { name: 'GSB Wallet Profiler', address: '0x730e371ff3E2277c36060748dd5207CEAF50701d', price: 0.50 },
  alpha_scanner:   { name: 'GSB Alpha Scanner',   address: '0x2c87651012bFA0247Fe741448DEbBF06c1b5c906', price: 0.10 },
  thread_writer:   { name: 'GSB Thread Writer',   address: '0x4ab8320491A1FD8396F7F23c212cd6fC978C8Ad0', price: 0.15 },
};

// ── Skill Registry ─────────────────────────────────────────────────────────
function loadSkillRegistry() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'skills.json'), 'utf8'));
  } catch (e) {
    return {};
  }
}

// ── CEO pricing (must exceed worker costs for margin) ──────────────────────
const CEO_PRICES = {
  swarm_heartbeat_report:      0.10,  // no worker needed, pure margin
  strategy_task_assignment:    0.25,  // routes to best worker
  escalation_decision_support: 0.35,  // alpha scanner + analysis
  token_deep_dive:             0.35,  // Token Analyst + Wallet Profiler parallel
  daily_brief:                 0.50,  // all 4 workers parallel
  financial_triage:            24.95, // restaurant financial triage — 3 PDFs via token (retail price)
};

// ── Provider offerings ─────────────────────────────────────────────────────
const OFFERING_SCHEMAS = {
  swarm_heartbeat_report: {
    description: 'Returns a live status report of the GSB Intelligence Swarm — all 4 agents online status, last job time, and a brief market summary.',
    parameters: {
      type: 'object',
      properties: {
        include_alpha: { type: 'boolean', description: 'Include latest alpha signals in the report (default true)' }
      },
      required: []
    },
    rejection_cases: ['NSFW or malicious content', 'Request for non-swarm-related data']
  },
  strategy_task_assignment: {
    description: 'Assigns a strategic task to the GSB swarm based on a user-provided goal. Returns which agent will handle it and the task parameters.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The strategic goal or question to assign (e.g. "find alpha on Base", "analyze this token")' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Task priority level' }
      },
      required: ['goal']
    },
    rejection_cases: ['Empty or missing goal', 'NSFW or malicious goal', 'Goal is pure gibberish']
  },
  escalation_decision_support: {
    description: 'Provides decision support for escalated situations — market anomalies, risk flags, or strategic pivots. Returns a structured recommendation.',
    parameters: {
      type: 'object',
      properties: {
        situation: { type: 'string', description: 'Describe the situation requiring escalation decision support' },
        urgency: { type: 'string', enum: ['low', 'medium', 'critical'], description: 'Urgency level' }
      },
      required: ['situation']
    },
    rejection_cases: ['Empty or missing situation description', 'NSFW or harmful content', 'Too short (under 10 chars)']
  },
  token_deep_dive: {
    description: 'Full token intelligence — Token Analyst + Wallet Profiler in parallel',
    price: 0.35,
    parameters: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Token contract address (0x...)' }
      },
      required: ['address']
    },
    rejection_cases: ['No token address provided', 'NSFW or malicious content']
  },
  daily_brief: {
    description: 'Full swarm morning report — all 4 workers in parallel',
    price: 0.50,
    parameters: {
      type: 'object',
      properties: {},
      required: []
    },
    rejection_cases: ['NSFW or malicious content']
  },
  financial_triage: {
    description: 'Restaurant financial triage — upload bank statement + POS export, receive Financial Analysis Report, Vendor Credit Letter, and Bank Loan Request Letter as a 24hr download token. All data anonymized under a project codename. Files deleted after processing. Operated by MCFL Restaurant Holdings LLC.',
    price: 24.95,
    parameters: {
      type: 'object',
      properties: {
        projectName:  { type: 'string', description: 'Anonymized project codename (e.g. PROJECT-FALCON)' },
        bankFileUrl:  { type: 'string', description: 'URL to bank statement file (XLS/XLSX/CSV)' },
        posFileUrl:   { type: 'string', description: 'URL to POS sales export file (XLS/XLSX/CSV) — optional' },
        period:       { type: 'string', description: 'Reporting period (e.g. Q1 2026)' },
        tier:         { type: 'string', enum: ['basic','standard','full'], description: 'Output tier — full returns all 3 PDFs' },
        agreedToTos:  { type: 'boolean', description: 'Must be true — confirms agreement to MCFL Terms of Service' }
      },
      required: ['projectName', 'bankFileUrl', 'period', 'agreedToTos']
    },
    rejection_cases: [
      'agreedToTos is false or missing',
      'No bank file URL provided',
      'Project name is empty',
      'NSFW or malicious content'
    ]
  }
};

const NSFW_RE = /hack|drain|steal|phish|scam|exploit|launder|porn|nsfw|bomb|kill/i;

function validateProviderInput(offeringName, raw) {
  if (!raw || raw.trim().length === 0) {
    return { valid: false, reason: 'Empty request. Please provide a valid input.' };
  }
  if (NSFW_RE.test(raw)) {
    return { valid: false, reason: 'Request contains disallowed content and cannot be processed.' };
  }

  if (offeringName === 'strategy_task_assignment') {
    let goal = raw;
    try { const p = JSON.parse(raw); goal = p.goal || raw; } catch {}
    if (!goal || goal.trim().length < 5) {
      return { valid: false, reason: 'Goal is too short or missing. Please provide a clear strategic goal.' };
    }
  }

  if (offeringName === 'escalation_decision_support') {
    let situation = raw;
    try { const p = JSON.parse(raw); situation = p.situation || raw; } catch {}
    if (!situation || situation.trim().length < 10) {
      return { valid: false, reason: 'Situation description is too short. Please provide at least 10 characters describing the situation.' };
    }
  }

  return { valid: true };
}

function extractContent(req) {
  if (!req) return '';
  if (typeof req === 'string') { try { req = JSON.parse(req); } catch { return req; } }
  if (typeof req === 'object') return req.goal || req.situation || req.requirement || req.content || JSON.stringify(req);
  return String(req);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function makeFare(p) {
  return new FareAmount(p, baseAcpConfigV2.baseFare);
}

// ── CEO Claude Synthesis ────────────────────────────────────────────────────
async function ceoSynthesize(prompt) {
  if (anthropic) {
    try {
      const msg = await anthropic.messages.create({
        model: 'claude-haiku-3-5',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      });
      return msg.content[0].text;
    } catch (err) {
      console.warn('[CEO] Claude synthesis failed, using fallback:', err.message);
    }
  }
  // Fallback: return a simple note so we never return empty
  return 'GSB Intelligence Swarm is online. Claude synthesis unavailable — raw data was used to compile this brief.';
}

function formatCeoBrief(content, timestamp) {
  return `🧠 GSB CEO Intelligence Brief\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${content}\n\nPowered by GSB Intelligence Swarm | ${timestamp}`;
}

// ── Provider: determine which offering a job maps to ──────────────────────
function determineOffering(job, rawContent) {
  let offeringName = job.serviceName || job.serviceOffering || '';

  // Check for skill-based dispatch (e.g. social_blast, bank_status_report, token_deep_dive, daily_brief)
  let skillRequest = null;
  try { skillRequest = JSON.parse(rawContent); } catch {}
  if (skillRequest?.skillId === 'social_blast' || skillRequest?.skillId === 'bank_status_report'
      || skillRequest?.skillId === 'token_deep_dive' || skillRequest?.skillId === 'daily_brief'
      || skillRequest?.skillId === 'financial_triage') {
    return skillRequest.skillId;
  }

  // Return early if offering is already known
  if (offeringName && (OFFERING_SCHEMAS[offeringName] || offeringName === 'social_blast' || offeringName === 'bank_status_report')) {
    return offeringName;
  }

  // Keyword fallback when serviceName/serviceOffering are empty or unknown
  const lower = (rawContent || job.requirement || job.content || '').toLowerCase();
  if (/social.?blast|raid|amplif/.test(lower)) return 'social_blast';
  if (/deep.?dive|deep.?analysis|full.?token|token.?intel|whale.?holders/.test(lower)) return 'token_deep_dive';
  if (/daily.?brief|morning.?report|full.?swarm|all.?agents|everything/.test(lower)) return 'daily_brief';
  if (/financial.?triage|restaurant.?financ|vendor.?letter|bank.?loan.?letter|burn.?rate|food.?cost|cash.?crunch|pos.?report|triage/.test(lower)) return 'financial_triage';
  if (/heartbeat|status|swarm|bank/.test(lower)) return 'swarm_heartbeat_report';
  if (/escalat|risk|situation|urgent|decision/.test(lower)) return 'escalation_decision_support';
  if (/strateg|task|assign|alpha|scan|trend|token|wallet|thread|write/.test(lower)) return 'strategy_task_assignment';
  return 'swarm_heartbeat_report'; // default
}

// ── Provider: execute the offering and deliver result ──────────────────────
async function executeAndDeliver(acpClient, job, offeringName, rawContent) {
  let briefText;
  const ts = new Date().toISOString();

  try {
    if (offeringName === 'swarm_heartbeat_report') {
      // Answer INSTANTLY from cache — no worker dispatch
      const cacheAge = ceoCache.lastAlphaScan
        ? Math.round((Date.now() - ceoCache.lastAlphaScan.fetchedAt) / 60000)
        : null;

      const prompt = `You are the GSB CEO. Give an instant swarm status report.
Current time: ${new Date().toISOString()}
Bank status: ${ceoCache.bankStatus}
Worker load: ${JSON.stringify(ceoCache.workerLoad)}
Total jobs served: ${ceoCache.totalJobsServed}
Latest alpha data (${cacheAge ? cacheAge + ' min ago' : 'not yet cached'}): ${JSON.stringify(ceoCache.lastAlphaScan?.data?.slice?.(0, 3) ?? 'warming up')}

Write a 3-5 sentence CEO briefing. Be direct and data-driven. Include: swarm status, any active worker load, top Base opportunity from cache if available. Format: plain text, no JSON.`;

      const brief = await ceoSynthesize(prompt);
      await job.deliver({ type: 'text', value: formatCeoBrief(brief, new Date().toISOString()) });
      ceoCache.totalJobsServed++;

      // Post instant brief to dashboard
      postToDashboard(formatCeoBrief(brief, new Date().toISOString()));
      console.log(`[CEO-provider] Job ${job.id} delivered instantly (heartbeat from cache).`);
      return;

    } else if (offeringName === 'strategy_task_assignment') {
      let goal = rawContent;
      try { const p = JSON.parse(rawContent); goal = p.goal || rawContent; } catch {}

      const goalLower = goal.toLowerCase();
      const addressMatch = goal.match(/0x[a-fA-F0-9]{40}/);

      // Determine if parallel dispatch is needed
      const wantsAlpha = /alpha|trending|scan|gainers|launch/.test(goalLower);
      const wantsThread = /thread|post|x\b|twitter|tweet|write/.test(goalLower);
      const wantsWallet = /wallet|address|profile|who/.test(goalLower);
      const wantsToken = /token|contract|price|analyze|ca\b/.test(goalLower);

      const dispatches = [];
      const workerNames = [];

      if (wantsAlpha && wantsThread) {
        console.log(`[CEO-provider] Parallel dispatch: Alpha Scanner + Thread Writer`);
        ceoCache.workerLoad['GSB Alpha Scanner']++;
        ceoCache.workerLoad['GSB Thread Writer']++;
        dispatches.push(
          dispatchToWorker(acpClient, 'alpha_scanner', null, 'scan_trending', {}).finally(() => { ceoCache.workerLoad['GSB Alpha Scanner']--; }),
          dispatchToWorker(acpClient, 'thread_writer', `Write a thread about Base alpha opportunities: ${goal}`, undefined).finally(() => { ceoCache.workerLoad['GSB Thread Writer']--; }),
        );
        workerNames.push('GSB Alpha Scanner', 'GSB Thread Writer');
      } else if (wantsWallet && wantsToken && addressMatch) {
        console.log(`[CEO-provider] Parallel dispatch: Wallet Profiler + Token Analyst`);
        ceoCache.workerLoad['GSB Wallet Profiler']++;
        ceoCache.workerLoad['GSB Token Analyst']++;
        dispatches.push(
          dispatchToWorker(acpClient, 'wallet_profiler', `Profile wallet ${addressMatch[0]}`, undefined).finally(() => { ceoCache.workerLoad['GSB Wallet Profiler']--; }),
          dispatchToWorker(acpClient, 'token_analyst', null, 'analyze_token', { address: addressMatch[0] }).finally(() => { ceoCache.workerLoad['GSB Token Analyst']--; }),
        );
        workerNames.push('GSB Wallet Profiler', 'GSB Token Analyst');
      } else {
        const workerKey = routeGoalToWorker(goal);
        const worker = WORKER_CONFIGS[workerKey];
        const requirement = buildWorkerRequirement(workerKey, goal);

        if (!requirement) {
          const errorBrief = formatCeoBrief(
            `STRATEGY TASK ASSIGNMENT\n\nUnable to process: please include a wallet address (0x...) in your goal so the Wallet Profiler can execute.`,
            ts
          );
          await job.deliver({ type: 'text', value: errorBrief });
          console.log(`[CEO-provider] Job ${job.id} rejected — missing wallet address.`);
          postToDashboard(errorBrief);
          return;
        }

        console.log(`[CEO-provider] Single dispatch: ${worker.name}`);
        ceoCache.workerLoad[worker.name]++;
        if (workerKey === 'alpha_scanner') {
          dispatches.push(dispatchToWorker(acpClient, workerKey, null, 'scan_trending', {}).finally(() => { ceoCache.workerLoad[worker.name]--; }));
        } else if (workerKey === 'token_analyst' && addressMatch) {
          dispatches.push(dispatchToWorker(acpClient, workerKey, null, 'analyze_token', { address: addressMatch[0] }).finally(() => { ceoCache.workerLoad[worker.name]--; }));
        } else {
          dispatches.push(dispatchToWorker(acpClient, workerKey, requirement).finally(() => { ceoCache.workerLoad[worker.name]--; }));
        }
        workerNames.push(worker.name);
      }

      const results = await Promise.all(dispatches);
      const allDataStr = results.map((r, i) => {
        const data = typeof r === 'string' ? r : JSON.stringify(r, null, 2);
        return `[${workerNames[i]}]\n${data}`;
      }).join('\n\n');

      const synthesis = await ceoSynthesize(
        `You are the GSB CEO intelligence agent. A user requested: "${goal}"\n\n${workerNames.length} workers returned data:\n${allDataStr}\n\nWrite a clear, actionable strategic recommendation in 3-5 sentences. Reference specific numbers and findings from the worker data. Be direct and crypto-native.`
      );

      ceoCache.totalJobsServed++;
      briefText = formatCeoBrief(
        `STRATEGY TASK ASSIGNMENT\nGoal: ${goal}\nAssigned to: ${workerNames.join(' + ')}\n\n${synthesis}`,
        ts
      );

    } else if (offeringName === 'escalation_decision_support') {
      let situation = rawContent;
      let urgency = 'medium';
      try {
        const p = JSON.parse(rawContent);
        situation = p.situation || rawContent;
        urgency = p.urgency || 'medium';
      } catch {}

      console.log(`[CEO-provider] Dispatching Alpha Scanner for escalation context...`);
      let alphaResult;
      try {
        alphaResult = await dispatchToWorker(acpClient, 'alpha_scanner', 'Scan for trending tokens and risk signals on Base');
      } catch (err) {
        console.error(`[CEO-provider] Alpha Scanner dispatch failed: ${err.message}`);
        alphaResult = null;
      }

      const alphaContext = alphaResult && !alphaResult.error
        ? JSON.stringify(alphaResult, null, 2)
        : 'Alpha scanner data unavailable.';

      const synthesis = await ceoSynthesize(
        `Escalation situation: ${situation}. Urgency: ${urgency}. Alpha context: ${alphaContext}. Provide a 3-5 sentence strategic recommendation as the GSB CEO intelligence agent. Be specific, reference data points where available, and give clear actionable next steps.`
      );

      briefText = formatCeoBrief(
        `ESCALATION DECISION SUPPORT\nSituation: ${situation}\nUrgency: ${urgency.toUpperCase()}\n\n${synthesis}`,
        ts
      );

    } else if (offeringName === 'social_blast') {
      let topic = rawContent;
      try { const p = JSON.parse(rawContent); topic = p.topic || p.params?.topic || rawContent; } catch {}

      console.log(`[CEO-provider] Social blast: parallel Alpha Scanner + Thread Writer for "${topic}"`);
      ceoCache.workerLoad['GSB Alpha Scanner']++;
      ceoCache.workerLoad['GSB Thread Writer']++;

      const [alphaResult, threadResult] = await Promise.all([
        dispatchToWorker(acpClient, 'alpha_scanner', null, 'scan_trending', {}).finally(() => { ceoCache.workerLoad['GSB Alpha Scanner']--; }),
        dispatchToWorker(acpClient, 'thread_writer', `Write a thread about ${topic}`, undefined).finally(() => { ceoCache.workerLoad['GSB Thread Writer']--; }),
      ]);

      const alphaStr = typeof alphaResult === 'string' ? alphaResult : JSON.stringify(alphaResult, null, 2);
      const threadStr = typeof threadResult === 'string' ? threadResult : JSON.stringify(threadResult, null, 2);

      const synthesis = await ceoSynthesize(
        `You are the GSB CEO coordinating a social blast about: "${topic}"

Alpha Scanner data:
${alphaStr}

Thread Writer output:
${threadStr}

Generate a unified social blast brief with these EXACT sections (plain text, no JSON):

X THREAD (5 tweets):
[Write a 5-tweet viral thread using the alpha data. Format: 1/ 2/ 3/ 4/ 5/]

TELEGRAM MESSAGE:
[Write a shorter, emoji-heavy raid-style Telegram message based on the same data]

AMPLIFICATION INSTRUCTIONS:
[Write specific bot/community amplification instructions like: "Reply to tweet 1 with: ...", "Like and RT tweet 2", etc.]`
      );

      ceoCache.totalJobsServed++;
      briefText = formatCeoBrief(
        `SOCIAL BLAST COORDINATION\nTopic: ${topic}\nWorkers: Alpha Scanner + Thread Writer (parallel)\n\n${synthesis}`,
        ts
      );

    } else if (offeringName === 'token_deep_dive') {
      const addressMatch = rawContent.match(/0x[a-fA-F0-9]{40}/);
      if (!addressMatch) {
        await job.deliver({ type: 'text', value: formatCeoBrief('Please include a token contract address (0x...) for a deep dive analysis.', new Date().toISOString()) });
        return;
      }
      const tokenAddress = addressMatch[0];

      // Parallel dispatch — Token Analyst + Wallet Profiler simultaneously
      console.log(`[CEO-provider] token_deep_dive: parallel Token Analyst + Wallet Profiler for ${tokenAddress}`);
      ceoCache.workerLoad['GSB Token Analyst']++;
      ceoCache.workerLoad['GSB Wallet Profiler']++;

      const [tokenResult, walletResult] = await Promise.allSettled([
        dispatchToWorker(acpClient, 'token_analyst', null, 'analyze_token', { address: tokenAddress }),
        dispatchToWorker(acpClient, 'wallet_profiler', null, 'detect_smart_money', { address: tokenAddress }),
      ]);

      ceoCache.workerLoad['GSB Token Analyst']--;
      ceoCache.workerLoad['GSB Wallet Profiler']--;

      const tokenData = tokenResult.status === 'fulfilled' ? tokenResult.value : 'Token analysis unavailable';
      const walletData = walletResult.status === 'fulfilled' ? walletResult.value : 'Smart money data unavailable';

      const prompt = `You are the GSB CEO delivering a token deep dive report.
Token Analysis: ${JSON.stringify(tokenData)}
Smart Money / Whale Data: ${JSON.stringify(walletData)}
Token Address: ${tokenAddress}

Write a comprehensive 5-7 sentence investment intelligence brief. Include: current price/liquidity verdict, smart money activity, whale concentration risk, and a clear BUY/HOLD/AVOID recommendation with reasoning. Be direct and data-driven.`;

      const brief = await ceoSynthesize(prompt);
      await job.deliver({ type: 'text', value: formatCeoBrief(brief, new Date().toISOString()) });
      ceoCache.totalJobsServed++;
      global.latestCeoBrief = brief;
      global.latestCeoBriefAt = new Date().toISOString();
      console.log(`[CEO-provider] Job ${job.id} delivered (token_deep_dive)`);
      return;

    } else if (offeringName === 'daily_brief') {
      console.log(`[CEO-provider] daily_brief: dispatching all 4 workers in parallel`);
      ceoCache.workerLoad['GSB Alpha Scanner']++;
      ceoCache.workerLoad['GSB Token Analyst']++;
      ceoCache.workerLoad['GSB Wallet Profiler']++;
      ceoCache.workerLoad['GSB Thread Writer']++;

      const [alphaResult, trendResult, whaleResult, threadResult] = await Promise.allSettled([
        dispatchToWorker(acpClient, 'alpha_scanner', null, 'scan_trending', {}),
        dispatchToWorker(acpClient, 'alpha_scanner', null, 'detect_volume_spikes', {}),
        dispatchToWorker(acpClient, 'wallet_profiler', null, 'track_wallet_activity', { address: '0x6dA1A9793Ebe96975c240501A633ab8B3c83D14A' }),
        dispatchToWorker(acpClient, 'thread_writer', null, 'write_market_update', {}),
      ]);

      ceoCache.workerLoad['GSB Alpha Scanner']--;
      ceoCache.workerLoad['GSB Token Analyst']--;
      ceoCache.workerLoad['GSB Wallet Profiler']--;
      ceoCache.workerLoad['GSB Thread Writer']--;

      const alpha = alphaResult.status === 'fulfilled' ? alphaResult.value : null;
      const trend = trendResult.status === 'fulfilled' ? trendResult.value : null;
      const thread = threadResult.status === 'fulfilled' ? threadResult.value : null;

      const prompt = `You are the GSB CEO delivering a full daily intelligence brief.
Trending tokens: ${JSON.stringify(alpha)}
Volume spikes: ${JSON.stringify(trend)}
Market narrative (Thread Writer): ${JSON.stringify(thread)}
Timestamp: ${new Date().toISOString()}

Write a complete daily brief in this format:
MARKET SENTIMENT: [one line]
TOP OPPORTUNITIES: [2-3 bullet points with token names and why]
VOLUME ALERTS: [any unusual volume from spike data]
NARRATIVE: [1-2 sentences on the dominant story today]
ACTION: [one clear recommendation for traders]

Be specific, data-driven, and under 200 words total.`;

      const brief = await ceoSynthesize(prompt);
      await job.deliver({ type: 'text', value: formatCeoBrief(brief, new Date().toISOString()) });
      ceoCache.totalJobsServed++;
      global.latestCeoBrief = brief;
      global.latestCeoBriefAt = new Date().toISOString();
      console.log(`[CEO-provider] Job ${job.id} delivered (daily_brief)`);
      return;

    } else if (offeringName === 'bank_status_report') {
      const cacheAge = ceoCache.lastAlphaScan
        ? Math.round((Date.now() - ceoCache.lastAlphaScan.fetchedAt) / 60000)
        : null;

      const prompt = `You are the GSB CEO. Give an instant bank status report.
Bank status: ${ceoCache.bankStatus}
Worker load: ${JSON.stringify(ceoCache.workerLoad)}
Total jobs served: ${ceoCache.totalJobsServed}
Cache age: ${cacheAge ? cacheAge + ' minutes' : 'not yet cached'}
Top alpha from cache: ${JSON.stringify(ceoCache.lastAlphaScan?.data?.slice?.(0, 2) ?? 'warming up')}

Write a 2-3 sentence bank status. Include worker load, jobs served, and top opportunity if cached. Plain text, no JSON.`;

      const brief = await ceoSynthesize(prompt);
      ceoCache.totalJobsServed++;
      await job.deliver({ type: 'text', value: formatCeoBrief(brief, new Date().toISOString()) });
      console.log(`[CEO-provider] Job ${job.id} delivered instantly (bank_status_report).`);
      return;
    }

    // ── financial_triage: forward to /api/financial-triage endpoint ─────────
    if (offeringName === 'financial_triage') {
      const params = input || {};
      if (!params.agreedToTos) {
        await job.rejectPayable('Must agree to MCFL Terms of Service (agreedToTos: true).');
        return;
      }
      if (!params.projectName || !params.bankFileUrl) {
        await job.rejectPayable('Missing required fields: projectName and bankFileUrl.');
        return;
      }
      console.log(`[CEO-provider] financial_triage: project=${params.projectName} period=${params.period || 'unspecified'}`);
      try {
        const fetch = (await import('node-fetch')).default;
        const baseUrl = process.env.RAILWAY_STATIC_URL
          ? `https://${process.env.RAILWAY_STATIC_URL}`
          : 'http://localhost:8080';
        const res = await fetch(`${baseUrl}/api/financial-triage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectName:  params.projectName,
            bankFileUrl:  params.bankFileUrl,
            posFileUrl:   params.posFileUrl || null,
            period:       params.period || 'Q1 2026',
            tier:         params.tier || 'full',
            agreedToTos:  'true',
          }),
        });
        const result = await res.json();
        if (result.error) throw new Error(result.error);
        const msg = [
          `Financial Triage Complete — Project: ${params.projectName}`,
          `Access Token: ${result.accessToken}`,
          `Download: ${baseUrl}/api/financial-triage/download/${result.accessToken}`,
          `Files ready: ${(result.filesGenerated || []).join(', ')}`,
          `Expires: ${result.expiresAt}`,
          '',
          'Includes: Financial Analysis Report | Vendor Credit Letter | Bank Loan Request Letter',
          'All data anonymized. Source files deleted. Operated by MCFL Restaurant Holdings LLC.',
        ].join('\n');
        ceoCache.totalJobsServed++;
        await job.deliver({ type: 'text', value: msg });
        console.log(`[CEO-provider] Job ${job.id} delivered (financial_triage) token=${result.accessToken}`);
      } catch (err) {
        await job.rejectPayable(`Financial triage failed: ${err.message}. Payment will be refunded.`);
      }
      return;
    }

    await job.deliver({ type: 'text', value: briefText });
    console.log(`[CEO-provider] Job ${job.id} delivered (${offeringName}).`);
    postToDashboard(briefText);
  } catch (err) {
    console.error(`[CEO-provider] Job ${job.id} delivery error:`, err.message);
    try {
      await job.rejectPayable(`Internal error: ${err.message}. Your payment will be refunded.`);
    } catch (rejectErr) {
      console.error(`[CEO-provider] Job ${job.id} rejectPayable error:`, rejectErr.message);
    }
  }
}

// ── Latest brief cache (for resource endpoint) ──────────────────────────────
let latestBriefText = null;
let latestBriefAt = null;

// ── Post brief to dashboard (helper) ──────────────────────────────────────
async function postToDashboard(brief) {
  // Cache the brief locally for resource endpoint awareness
  latestBriefText = typeof brief === 'string' ? brief : JSON.stringify(brief);
  latestBriefAt = new Date().toISOString();

  const DASHBOARD_URL = process.env.RAILWAY_STATIC_URL
    ? `https://${process.env.RAILWAY_STATIC_URL}`
    : 'http://localhost:8080';
  try {
    const fetch = (await import('node-fetch')).default;
    await fetch(`${DASHBOARD_URL}/api/brief`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brief, source: 'ceobuyer', timestamp: latestBriefAt }),
    });
    console.log('[CEO-provider] Brief posted to dashboard');
  } catch (e) {
    console.warn('[CEO-provider] Could not post brief to dashboard:', e.message);
  }
}

// ── Deliverable store — keyed by jobId ──────────────────────────────────────
const deliverables = new Map(); // jobId → { workerName, role, data }

// ── Serialized accept queue ──────────────────────────────────────────────────
let acceptQueue = Promise.resolve();

function queueAccept(job, memo) {
  acceptQueue = acceptQueue.then(async () => {
    const MAX_RETRIES = 4;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[ceo] acceptRequirement job ${job.id} memo ${memo.id} attempt ${attempt}...`);
        await job.acceptRequirement(memo, 'Requirement accepted. Proceed with delivery.');
        console.log(`[ceo] ✓ Job ${job.id} → TRANSACTION phase.`);
        break;
      } catch (err) {
        console.error(`\n[ceo] === ERROR job ${job.id} attempt ${attempt} ===`);
        console.error(err.stack || err.message);
        console.error(`[ceo] === END ERROR ===\n`);
        if (attempt < MAX_RETRIES) {
          await sleep(attempt * 8000);
        } else {
          console.error(`[ceo] ✗ Gave up job ${job.id}.`);
        }
      }
    }
    await sleep(5000);
  });
}

// ── Parse a worker deliverable payload ──────────────────────────────────────
function parseDeliverable(rawValue) {
  if (!rawValue) return null;
  if (typeof rawValue === 'object') return rawValue;
  try { return JSON.parse(rawValue); } catch { return { raw: rawValue }; }
}

// ── Dispatch a job to a worker and wait for the deliverable ────────────────
// Supports both legacy plain-text and skill-based dispatch:
//   dispatchToWorker(client, 'alpha_scanner', 'Scan for trending tokens')
//   dispatchToWorker(client, 'alpha_scanner', null, 'scan_trending', {})
async function dispatchToWorker(acpClient, workerKey, requirement, skillId, skillParams) {
  const worker = WORKER_CONFIGS[workerKey];

  // If skillId provided, build JSON requirement from registry
  if (skillId) {
    const registry = loadSkillRegistry();
    const workerSkills = registry[worker.name] || [];
    const skill = workerSkills.find(s => s.skillId === skillId);
    if (skill) {
      requirement = JSON.stringify({ skillId, params: skillParams || {} });
    } else if (!requirement) {
      throw new Error(`Unknown skill: ${skillId} for worker ${worker.name}`);
    }
  }

  console.log(`[CEO-dispatch] Hiring ${worker.name} for: ${requirement.slice(0, 80)}`);

  return new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Worker timeout after 3 min')), 180000);

    try {
      // Use skill price from registry if available
      let price = worker.price;
      if (skillId) {
        const registry = loadSkillRegistry();
        const skill = (registry[worker.name] || []).find(s => s.skillId === skillId);
        if (skill) price = skill.price;
      }
      const fare = new FareAmount(price, baseAcpConfigV2.baseFare);
      const expiry = new Date(Date.now() + 1000 * 60 * 30);

      const jobId = await acpClient.initiateJob(
        worker.address,
        requirement,
        fare,
        null,
        expiry
      );

      console.log(`[CEO-dispatch] Job ${jobId} fired at ${worker.name}`);

      // Poll for completion
      const start = Date.now();
      while (Date.now() - start < 180000) {
        await sleep(3000);
        try {
          const job = await acpClient.getJobById(jobId);
          if (job && job.phase === 4) { // COMPLETED
            const memos = job.memos || [];
            const deliverMemo = memos.find(m => m.nextPhase === 3 || m.nextPhase === 'EVALUATION');
            const rawValue = deliverMemo?.content ?? memos[memos.length - 1]?.content;
            clearTimeout(timeout);
            resolve(parseDeliverable(rawValue));
            return;
          }
          if (job && job.phase === 2) {
            // In transaction — wait for deliver
            continue;
          }
        } catch (e) { /* keep polling */ }
      }
      clearTimeout(timeout);
      reject(new Error('Worker did not complete in time'));
    } catch (err) {
      clearTimeout(timeout);
      reject(err);
    }
  });
}

// ── Route goal keywords to the correct worker ──────────────────────────────
function routeGoalToWorker(goal) {
  const lower = goal.toLowerCase();
  if (/token|contract|price|analyze|ca\b/.test(lower)) return 'token_analyst';
  if (/wallet|address|profile|who/.test(lower))        return 'wallet_profiler';
  if (/alpha|trending|scan|gainers|launch/.test(lower)) return 'alpha_scanner';
  if (/thread|write|tweet|content/.test(lower))         return 'thread_writer';
  return 'alpha_scanner'; // default — most useful
}

// ── Build the requirement string for a worker ──────────────────────────────
function buildWorkerRequirement(workerKey, goal) {
  const addressMatch = goal.match(/0x[a-fA-F0-9]{40}/);
  switch (workerKey) {
    case 'token_analyst':
      return `Analyze token ${addressMatch ? addressMatch[0] : '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'}`;
    case 'wallet_profiler':
      if (!addressMatch) return null; // need an address
      return `Profile wallet ${addressMatch[0]}`;
    case 'alpha_scanner':
      return `Scan for trending tokens on Base`;
    case 'thread_writer':
      return goal;
    default:
      return goal;
  }
}

// ── Build the GSB Intelligence Brief from all deliverables ──────────────────
function buildBrief(results) {
  const ts = new Date().toISOString();
  const lines = [];

  lines.push('╔══════════════════════════════════════════════════════════╗');
  lines.push('║          GSB INTELLIGENCE BRIEF                          ║');
  lines.push(`║          ${ts}          ║`);
  lines.push('╚══════════════════════════════════════════════════════════╝');
  lines.push('');

  // ── Token Analysis ──
  const tokenData = results.token_analysis;
  if (tokenData && !tokenData.error) {
    lines.push('── TOKEN ANALYSIS ─────────────────────────────────────────');
    lines.push(`  Token:       ${tokenData.token?.name} (${tokenData.token?.symbol})`);
    lines.push(`  Price:       $${tokenData.price?.usd} (${tokenData.price?.change_24h > 0 ? '+' : ''}${tokenData.price?.change_24h}% 24h)`);
    lines.push(`  Liquidity:   $${Number(tokenData.liquidity_usd).toLocaleString()}`);
    lines.push(`  Volume 24h:  $${Number(tokenData.volume_24h).toLocaleString()}`);
    lines.push(`  Market Cap:  $${Number(tokenData.market_cap).toLocaleString()}`);
    lines.push(`  Verdict:     ${tokenData.gsb_verdict}`);
    lines.push(`  DexScreener: ${tokenData.dexscreener_url}`);
  } else if (tokenData?.error) {
    lines.push('── TOKEN ANALYSIS ─────────────────────────────────────────');
    lines.push(`  Error: ${tokenData.error}`);
  }
  lines.push('');

  // ── Wallet Profile ──
  const walletData = results.wallet_profile;
  if (walletData && !walletData.error) {
    lines.push('── WALLET PROFILE ──────────────────────────────────────────');
    lines.push(`  Wallet:       ${walletData.wallet}`);
    lines.push(`  Tx Count:     ${walletData.transaction_count}`);
    lines.push(`  Class:        ${walletData.classification}`);
    if (walletData.recent_transactions?.length > 0) {
      lines.push(`  Recent txs:`);
      walletData.recent_transactions.slice(0, 3).forEach(tx => {
        lines.push(`    ${tx.hash?.slice(0,18)}…  ${tx.value_eth} ETH  (${tx.age_days}d ago)`);
      });
    }
    lines.push(`  BaseScan:     ${walletData.basescan_url}`);
  } else if (walletData?.error) {
    lines.push('── WALLET PROFILE ──────────────────────────────────────────');
    lines.push(`  Error: ${walletData.error}`);
  }
  lines.push('');

  // ── Alpha Signals ──
  const alphaData = results.alpha_signals;
  if (alphaData && !alphaData.error) {
    lines.push('── ALPHA SIGNALS ───────────────────────────────────────────');
    lines.push(`  Signal:  ${alphaData.gsb_signal}`);
    if (alphaData.top_gainers_base?.length > 0) {
      lines.push(`  Top Gainers (Base):`);
      alphaData.top_gainers_base.forEach(g => {
        lines.push(`    ${g.symbol?.padEnd(10)} ${g.change_24h?.padStart(8)}  liq ${g.liquidity}  vol ${g.volume_24h}`);
      });
    }
    if (alphaData.boosted_tokens_base?.length > 0) {
      lines.push(`  Boosted Tokens (Base):`);
      alphaData.boosted_tokens_base.slice(0, 3).forEach(b => {
        lines.push(`    ${b.address?.slice(0,18)}…  boost ${b.boostAmount}`);
      });
    }
  } else if (alphaData?.error) {
    lines.push('── ALPHA SIGNALS ───────────────────────────────────────────');
    lines.push(`  Error: ${alphaData.error}`);
  }
  lines.push('');

  // ── Thread ──
  const threadData = results.thread;
  if (threadData?.thread) {
    lines.push('── THREAD READY TO POST ────────────────────────────────────');
    lines.push('');
    lines.push(threadData.thread);
    lines.push('');
    lines.push(`  Generated: ${threadData.generated_at}`);
  }
  lines.push('');
  lines.push('── END OF BRIEF ────────────────────────────────────────────');

  return lines.join('\n');
}

async function main() {
  if (!PRIVATE_KEY) throw new Error('AGENT_WALLET_PRIVATE_KEY not set');

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   GSB CEO — Intelligence Swarm Orchestrator      ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // Track which jobId belongs to which worker
  const jobWorkerMap = new Map(); // jobId → worker
  // Track deliverable results by role (last one wins per role)
  const briefResults = {};
  // Track completed evaluations
  let evaluatedCount = 0;
  const totalJobs = WORKERS.length * JOBS_PER_WORKER;

  // ── Pending provider jobs — tracks phase 0 → phase 2 delivery ──────────
  const pendingProviderJobs = new Map(); // jobId → { offeringName, rawContent }

  // ── Build TWO separate ACP clients: provider + buyer ───────────────────
  // Buyer client reference — assigned after construction, but captured by
  // provider closure which only executes asynchronously (after both are built).
  let buyerClient = null;

  console.log('[ceo] Building PROVIDER ACP client (entity', CEO_ENTITY_ID, ')...');
  const providerContractClient = await AcpContractClientV2.build(
    PRIVATE_KEY, CEO_ENTITY_ID, CEO_WALLET_ADDRESS, baseAcpConfigV2
  );

  const providerClient = new AcpClient({
    acpContractClient: providerContractClient,

    // ── PROVIDER onNewTask — handles incoming jobs to CEO offerings ──
    onNewTask: async (job, memo) => {
      const rawContent = extractContent(job.requirement) || extractContent(memo?.content) || '';

      if (job.phase === 0 && memo) {
        // Phase 0: REQUEST — determine offering, validate, accept
        const offeringName = determineOffering(job, rawContent);

        if (!OFFERING_SCHEMAS[offeringName] && offeringName !== 'social_blast' && offeringName !== 'bank_status_report') {
          console.log(`[CEO-provider] Unknown offering for job ${job.id}, ignoring.`);
          return;
        }

        console.log(`[CEO-provider] Incoming job ${job.id} → ${offeringName}`);
        const check = validateProviderInput(offeringName, rawContent);
        if (!check.valid) {
          console.log(`[CEO-provider] Rejecting job ${job.id}: ${check.reason}`);
          try { await job.reject(check.reason); } catch (e) { console.error(`[CEO-provider] Reject failed: ${e.message}`); }
          return;
        }

        // Store pending job details for phase 2 delivery
        pendingProviderJobs.set(job.id, { offeringName, rawContent });

        try {
          await job.respond(true, 'GSB CEO accepting. Brief incoming.');
          console.log(`[CEO-provider] Job ${job.id} accepted → awaiting payment`);
        } catch (e) {
          console.error(`[CEO-provider] Accept failed job ${job.id}: ${e.message}`);
          pendingProviderJobs.delete(job.id);
        }
        return;
      }

      if (job.phase === 2) {
        // Phase 2: TRANSACTION — payment confirmed, deliver now
        const pending = pendingProviderJobs.get(job.id);
        if (pending) {
          pendingProviderJobs.delete(job.id);
          console.log(`[CEO-provider] Payment confirmed job ${job.id} → delivering ${pending.offeringName}`);
          // Use buyerClient for worker dispatch (CEO buying from workers)
          const dispatchClient = buyerClient || providerClient;
          executeAndDeliver(dispatchClient, job, pending.offeringName, pending.rawContent).catch(err => {
            console.error(`[CEO-provider] Job ${job.id} delivery error:`, err.message);
          });
        } else {
          console.log(`[CEO-provider] Phase 2 job ${job.id} — no pending record (may be buyer-side job).`);
        }
        return;
      }

      console.log(`[CEO-provider] Unhandled phase ${job.phase} for job ${job.id}`);
    },

    // ── PROVIDER onEvaluate — auto-approve CEO's own delivered work ──
    onEvaluate: async (job) => {
      console.log(`[CEO-provider] Evaluating own delivery for job ${job.id}...`);
      try {
        await job.evaluate(true, 'Report delivered successfully.');
        console.log(`[CEO-provider] Job ${job.id} evaluation approved.`);
      } catch (err) {
        console.error(`[CEO-provider] Evaluate error job ${job.id}:`, err.message);
        try { await job.evaluate(true, 'Approved.'); } catch (_) {}
      }
    },
  });

  console.log('[ceo] Building BUYER ACP client (entity', CEO_ENTITY_ID, ')...');
  const buyerContractClient = await AcpContractClientV2.build(
    PRIVATE_KEY, CEO_ENTITY_ID, CEO_WALLET_ADDRESS, baseAcpConfigV2
  );

  buyerClient = new AcpClient({
    acpContractClient: buyerContractClient,

    // ── BUYER onNewTask — accept worker deliverables ──
    onNewTask: async (job, memo) => {
      if (memo) {
        console.log(`[ceo] onNewTask job ${job.id} phase=${job.phase} memo=${memo.id} nextPhase=${memo.nextPhase}`);
        // Track worker load when dispatching
        const dispatchedWorker = jobWorkerMap.get(job.id);
        if (dispatchedWorker && ceoCache.workerLoad[dispatchedWorker.name] !== undefined) {
          ceoCache.workerLoad[dispatchedWorker.name]++;
        }
        queueAccept(job, memo);
      } else {
        console.log(`[ceo] onNewTask job ${job.id} phase=${job.phase} — no memo.`);
      }
    },

    // ── BUYER onEvaluate — evaluate worker results, build brief ──
    onEvaluate: async (job) => {
      console.log(`[ceo] Evaluating job ${job.id}...`);
      await sleep(2000);

      try {
        const worker = jobWorkerMap.get(job.id);
        const memos = job.memos || [];

        // Find the DELIVER memo (nextPhase = EVALUATION = 3)
        const deliverMemo = memos.find(m => m.nextPhase === 3 || m.nextPhase === 'EVALUATION');
        const rawValue = deliverMemo?.content ?? memos[memos.length - 1]?.content;
        const parsed = parseDeliverable(rawValue);

        if (worker && parsed) {
          console.log(`\n[ceo] ── Deliverable from ${worker.name} (job ${job.id}) ──`);
          if (parsed.raw) {
            console.log(parsed.raw.slice(0, 400));
          } else {
            console.log(JSON.stringify(parsed, null, 2).slice(0, 800));
          }
          console.log('[ceo] ──────────────────────────────────────────────────\n');

          briefResults[worker.role] = parsed;
        } else {
          console.log(`[ceo] Job ${job.id} — no deliverable parsed (worker=${worker?.name}, memos=${memos.length})`);
        }

        // Track worker load — decrement on completion
        if (worker && ceoCache.workerLoad[worker.name] !== undefined) {
          ceoCache.workerLoad[worker.name] = Math.max(0, ceoCache.workerLoad[worker.name] - 1);
        }
        ceoCache.totalJobsServed++;

        await job.evaluate(true, 'Intelligence received. Brief updated.');
        console.log(`[ceo] ✓ Job ${job.id} approved.`);
        evaluatedCount++;

        // ── Print + save brief after the last job of each round ──────────
        if (evaluatedCount % WORKERS.length === 0) {
          const filledRoles = Object.keys(briefResults).length;
          if (filledRoles > 0) {
            const brief = buildBrief(briefResults);
            console.log('\n' + brief + '\n');

            // Save to disk
            const outDir = path.join(__dirname, 'briefs');
            if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
            const filename = `brief-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
            const filepath = path.join(outDir, filename);
            fs.writeFileSync(filepath, brief, 'utf8');
            console.log(`[ceo] Brief saved → ${filepath}\n`);

            postToDashboard(brief);
          }
        }
      } catch (err) {
        console.error(`[ceo] Evaluate error job ${job.id}:`, err.message);
        try { await job.evaluate(true, 'Approved.'); } catch (_) {}
      }
    },
  });

  // ── Start background cache refresh (every 5 minutes) ────────────────────
  refreshCacheFromAlphaScanner(); // initial fetch
  setInterval(refreshCacheFromAlphaScanner, 5 * 60 * 1000);
  console.log('[ceo] Cache refresh started (every 5 min)');

  // ── Log public resource URLs for ACP/Butler reads ───────────────────────
  const RESOURCE_BASE = process.env.RAILWAY_STATIC_URL
    ? `https://${process.env.RAILWAY_STATIC_URL}`
    : 'https://gsb-swarm-production.up.railway.app';
  console.log(`[CEO] ═══ Public Resources ═══`);
  console.log(`[CEO]   market_snapshot  → ${RESOURCE_BASE}/api/resource/market_snapshot`);
  console.log(`[CEO]   swarm_status     → ${RESOURCE_BASE}/api/resource/swarm_status`);
  console.log(`[CEO]   latest_brief     → ${RESOURCE_BASE}/api/resource/latest_brief`);
  console.log(`[CEO]   top_alpha        → ${RESOURCE_BASE}/api/resource/top_alpha`);
  console.log(`[CEO]   gsb_offerings    → ${RESOURCE_BASE}/api/resource/gsb_offerings`);
  console.log(`[CEO]   whale_activity   → ${RESOURCE_BASE}/api/resource/whale_activity`);
  console.log(`[CEO] ════════════════════════`);
  console.log(`[CEO] Register these in Virtuals ACP → CEO Agent → Resources`);

  console.log('[ceo] Provider + Buyer clients ready. Firing jobs at all 4 workers.\n');

  // ── Fire all jobs via BUYER client ──────────────────────────────────────
  for (const worker of WORKERS) {
    console.log(`\n── Hiring ${worker.name} (${JOBS_PER_WORKER} × $${worker.price} USDC) ──`);
    for (let i = 1; i <= JOBS_PER_WORKER; i++) {
      try {
        console.log(`  [${i}/${JOBS_PER_WORKER}] → ${worker.address}...`);
        const jobId = await buyerClient.initiateJob(
          worker.address, worker.requirement,
          makeFare(worker.price), null,
          new Date(Date.now() + 1000 * 60 * 30),
        );
        jobWorkerMap.set(jobId, worker);
        console.log(`  [${i}/${JOBS_PER_WORKER}] ✓ Job: ${jobId}`);
        await sleep(3000);
      } catch (err) {
        console.error(`  [${i}/${JOBS_PER_WORKER}] ✗`, err.message);
      }
    }
    await sleep(5000);
  }

  console.log('\n[ceo] All fired. Draining acceptRequirement queue...');
  await acceptQueue;
  console.log('\n[ceo] Queue done. Waiting 15 min for deliveries + evaluations...\n');
  await sleep(1000 * 60 * 15);

  // ── Final brief if anything came in ─────────────────────────────────────
  if (Object.keys(briefResults).length > 0) {
    const brief = buildBrief(briefResults);
    console.log('\n══ FINAL GSB INTELLIGENCE BRIEF ══\n');
    console.log(brief);
    const outDir = path.join(__dirname, 'briefs');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const filename = `brief-final-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    fs.writeFileSync(path.join(outDir, filename), brief, 'utf8');
    console.log(`[ceo] Final brief saved → briefs/${filename}`);
    postToDashboard(brief);
  }

  console.log('[ceo] Done.');
}

main().catch(err => { console.error('[ceo] Fatal:', err); process.exit(1); });
