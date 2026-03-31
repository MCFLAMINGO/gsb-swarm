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

// ── Config ──────────────────────────────────────────────────────────────────
const CEO_ENTITY_ID         = 2;
const CEO_WALLET_ADDRESS    = '0xf0d4832A4c2D33Faa1F655cd4dE5e7c551a0fE45';
const PRIVATE_KEY           = process.env.AGENT_WALLET_PRIVATE_KEY;

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

// ── Provider: waitForTransaction ────────────────────────────────────────────
async function waitForTransaction(client, jobId, maxWaitMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const fresh = await client.getJobById(jobId);
    if (fresh && fresh.phase === 2) return fresh;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`Job ${jobId} did not reach TRANSACTION phase within ${maxWaitMs}ms`);
}

// ── Provider: handle incoming jobs on CEO offerings ─────────────────────────
async function handleProviderJob(client, job, offeringName) {
  const rawContent = extractContent(job.requirement) || extractContent(job.memos?.[0]?.content) || '';

  // Accept the request
  await job.respond(true, 'Processing...');
  console.log(`[CEO-provider] Job ${job.id} accepted. Waiting for TRANSACTION phase...`);

  // Wait for buyer to pay
  let freshJob = job;
  if (job.phase === 2) {
    console.log(`[CEO-provider] Job ${job.id} already in TRANSACTION phase.`);
  } else {
    freshJob = await waitForTransaction(client, job.id);
    console.log(`[CEO-provider] Job ${job.id} in TRANSACTION phase. Generating deliverable...`);
  }

  let briefText;
  const ts = new Date().toISOString();

  try {
    if (offeringName === 'swarm_heartbeat_report') {
      // Fire a real scan_trending job at Alpha Scanner for live market data
      let alphaData = null;
      try {
        console.log(`[CEO-provider] Firing Alpha Scanner scan_trending for heartbeat...`);
        alphaData = await dispatchToWorker(client, 'alpha_scanner', null, 'scan_trending', {});
      } catch (err) {
        console.warn(`[CEO-provider] Alpha Scanner failed for heartbeat: ${err.message}`);
      }

      // Build market snapshot and opportunities from alpha data
      let marketContext = '';
      if (alphaData && !alphaData.error) {
        marketContext = `Alpha scanner data: ${JSON.stringify(alphaData)}`;
      } else {
        marketContext = `Alpha scanner unavailable. Timestamp: ${ts}. All 4 swarm agents are online and operational on Base chain.`;
      }

      // Synthesize with Claude
      const synthesis = await ceoSynthesize(
        `You are the GSB CEO intelligence agent. Write a concise swarm heartbeat report.\n\nSwarm status: All 4 agents ONLINE (Token Analyst, Wallet Profiler, Alpha Scanner, Thread Writer) on Base chain via ACP.\nTimestamp: ${ts}\n\n${marketContext}\n\nWrite a 2-3 sentence market snapshot summarizing current Base market conditions, then list top opportunities if any. Be specific with numbers. End with a 1-sentence GSB swarm status summary.`
      );

      const agents = [
        'Token Analyst — ONLINE (token analysis, $0.25)',
        'Wallet Profiler — ONLINE (wallet profiling, $0.50)',
        'Alpha Scanner — ONLINE (alpha signals, $0.10)',
        'Thread Writer — ONLINE (content, $0.15)',
      ];

      briefText = formatCeoBrief(
        `SWARM HEARTBEAT REPORT\nStatus: ONLINE\n\nAgents:\n${agents.map(a => `  • ${a}`).join('\n')}\n\n${synthesis}`,
        ts
      );

    } else if (offeringName === 'strategy_task_assignment') {
      let goal = rawContent;
      try { const p = JSON.parse(rawContent); goal = p.goal || rawContent; } catch {}

      const workerKey = routeGoalToWorker(goal);
      const worker = WORKER_CONFIGS[workerKey];
      const requirement = buildWorkerRequirement(workerKey, goal);

      if (!requirement) {
        const errorBrief = formatCeoBrief(
          `STRATEGY TASK ASSIGNMENT\n\nUnable to process: please include a wallet address (0x...) in your goal so the Wallet Profiler can execute.`,
          ts
        );
        await freshJob.deliver({ type: 'text', value: errorBrief });
        console.log(`[CEO-provider] Job ${job.id} rejected — missing wallet address.`);

        // Post error brief to dashboard
        const DASHBOARD_URL_ERR = process.env.RAILWAY_STATIC_URL
          ? `https://${process.env.RAILWAY_STATIC_URL}`
          : 'http://localhost:8080';
        try {
          const fetch = (await import('node-fetch')).default;
          await fetch(`${DASHBOARD_URL_ERR}/api/brief`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ brief: errorBrief, source: 'ceobuyer', timestamp: new Date().toISOString() }),
          });
          console.log('[ceo] Error brief posted to dashboard');
        } catch (e) {
          console.warn('[ceo] Could not post error brief to dashboard:', e.message);
        }
        return;
      }

      // Dispatch to the routed worker
      const addressMatch = goal.match(/0x[a-fA-F0-9]{40}/);
      let workerResult;
      if (workerKey === 'alpha_scanner') {
        console.log(`[CEO-provider] Routing to ${worker.name} via skill: scan_trending`);
        workerResult = await dispatchToWorker(client, workerKey, null, 'scan_trending', {});
      } else if (workerKey === 'token_analyst' && addressMatch) {
        console.log(`[CEO-provider] Routing to ${worker.name} via skill: analyze_token`);
        workerResult = await dispatchToWorker(client, workerKey, null, 'analyze_token', { address: addressMatch[0] });
      } else {
        console.log(`[CEO-provider] Routing to ${worker.name}: "${requirement}"`);
        workerResult = await dispatchToWorker(client, workerKey, requirement);
      }

      // Always pass through Claude for a clean natural-language recommendation
      const workerDataStr = typeof workerResult === 'string' ? workerResult : JSON.stringify(workerResult, null, 2);
      const synthesis = await ceoSynthesize(
        `You are the GSB CEO intelligence agent. A user requested: "${goal}"\n\nThe ${worker.name} worker returned this data:\n${workerDataStr}\n\nWrite a clear, actionable strategic recommendation in 3-5 sentences. Reference specific numbers and findings from the worker data. Be direct and crypto-native.`
      );

      briefText = formatCeoBrief(
        `STRATEGY TASK ASSIGNMENT\nGoal: ${goal}\nAssigned to: ${worker.name}\n\n${synthesis}`,
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

      // Dispatch to Alpha Scanner for market context
      console.log(`[CEO-provider] Dispatching Alpha Scanner for escalation context...`);
      let alphaResult;
      try {
        alphaResult = await dispatchToWorker(client, 'alpha_scanner', 'Scan for trending tokens and risk signals on Base');
      } catch (err) {
        console.error(`[CEO-provider] Alpha Scanner dispatch failed: ${err.message}`);
        alphaResult = null;
      }

      const alphaContext = alphaResult && !alphaResult.error
        ? JSON.stringify(alphaResult, null, 2)
        : 'Alpha scanner data unavailable.';

      // Pass through Claude for strategic recommendation
      const synthesis = await ceoSynthesize(
        `Escalation situation: ${situation}. Urgency: ${urgency}. Alpha context: ${alphaContext}. Provide a 3-5 sentence strategic recommendation as the GSB CEO intelligence agent. Be specific, reference data points where available, and give clear actionable next steps.`
      );

      briefText = formatCeoBrief(
        `ESCALATION DECISION SUPPORT\nSituation: ${situation}\nUrgency: ${urgency.toUpperCase()}\n\n${synthesis}`,
        ts
      );
    }

    await freshJob.deliver({ type: 'text', value: briefText });
    console.log(`[CEO-provider] Job ${job.id} delivered (${offeringName}).`);

    // Post provider brief to dashboard
    const DASHBOARD_URL = process.env.RAILWAY_STATIC_URL
      ? `https://${process.env.RAILWAY_STATIC_URL}`
      : 'http://localhost:8080';
    try {
      const fetch = (await import('node-fetch')).default;
      await fetch(`${DASHBOARD_URL}/api/brief`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief: briefText, source: 'ceobuyer', timestamp: new Date().toISOString() }),
      });
      console.log('[ceo] Provider brief posted to dashboard');
    } catch (e) {
      console.warn('[ceo] Could not post provider brief to dashboard:', e.message);
    }
  } catch (err) {
    console.error(`[CEO-provider] Job ${job.id} delivery error:`, err.message);
    try {
      await job.rejectPayable(`Internal error: ${err.message}. Your payment will be refunded.`);
    } catch (rejectErr) {
      console.error(`[CEO-provider] Job ${job.id} rejectPayable error:`, rejectErr.message);
    }
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

  console.log('[ceo] Building ACP client for CEO (entity', CEO_ENTITY_ID, ')...');
  const contractClient = await AcpContractClientV2.build(
    PRIVATE_KEY, CEO_ENTITY_ID, CEO_WALLET_ADDRESS, baseAcpConfigV2
  );

  const client = new AcpClient({
    acpContractClient: contractClient,

    onNewTask: async (job, memo) => {
      // ── PROVIDER side — incoming jobs to the CEO's offerings ──
      if (job.phase === 0) {
        let offeringName = job.serviceName || job.serviceOffering || '';
        const rawContent = extractContent(job.requirement) || extractContent(job.memos?.[0]?.content) || '';

        // Keyword fallback when serviceName/serviceOffering are empty or unknown
        if (!offeringName || !OFFERING_SCHEMAS[offeringName]) {
          const lower = (rawContent || job.requirement || job.content || '').toLowerCase();
          if (/heartbeat|status|swarm/.test(lower)) {
            offeringName = 'swarm_heartbeat_report';
          } else if (/escalat|risk|situation|urgent|decision/.test(lower)) {
            offeringName = 'escalation_decision_support';
          } else if (/strateg|task|assign|alpha|scan|trend|token|wallet|thread|write/.test(lower)) {
            offeringName = 'strategy_task_assignment';
          } else {
            offeringName = 'swarm_heartbeat_report';
          }
        }

        if (OFFERING_SCHEMAS[offeringName]) {
          console.log(`[CEO-provider] Incoming job ${job.id} for offering: ${offeringName}`);
          const check = validateProviderInput(offeringName, rawContent);
          if (!check.valid) {
            console.log(`[CEO-provider] Rejecting job ${job.id}: ${check.reason}`);
            await job.reject(check.reason);
            return;
          }
          handleProviderJob(client, job, offeringName).catch(err => {
            console.error(`[CEO-provider] Job ${job.id} error:`, err.message);
          });
          return;
        }
      }

      // ── BUYER side — existing acceptRequirement logic ──
      if (memo) {
        console.log(`[ceo] onNewTask job ${job.id} phase=${job.phase} memo=${memo.id} nextPhase=${memo.nextPhase}`);
        queueAccept(job, memo);
      } else {
        console.log(`[ceo] onNewTask job ${job.id} phase=${job.phase} — no memo.`);
      }
    },

    onEvaluate: async (job) => {
      console.log(`[ceo] Evaluating job ${job.id}...`);
      await sleep(2000);

      try {
        // ── Read the deliverable ──────────────────────────────────────────
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

          // Store for brief (always overwrite — last delivery is freshest)
          briefResults[worker.role] = parsed;
        } else {
          console.log(`[ceo] Job ${job.id} — no deliverable parsed (worker=${worker?.name}, memos=${memos.length})`);
        }

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

            // Post to dashboard
            const DASHBOARD_URL = process.env.RAILWAY_STATIC_URL
              ? `https://${process.env.RAILWAY_STATIC_URL}`
              : 'http://localhost:8080';
            try {
              const fetch = (await import('node-fetch')).default;
              await fetch(`${DASHBOARD_URL}/api/brief`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ brief, source: 'ceobuyer', timestamp: new Date().toISOString() }),
              });
              console.log('[ceo] Brief posted to dashboard');
            } catch (e) {
              console.warn('[ceo] Could not post brief to dashboard:', e.message);
            }
          }
        }
      } catch (err) {
        console.error(`[ceo] Evaluate error job ${job.id}:`, err.message);
        // Still approve so job completes
        try { await job.evaluate(true, 'Approved.'); } catch (_) {}
      }
    },
  });

  console.log('[ceo] Ready. Firing jobs at all 4 workers.\n');

  // ── Fire all jobs ────────────────────────────────────────────────────────
  for (const worker of WORKERS) {
    console.log(`\n── Hiring ${worker.name} (${JOBS_PER_WORKER} × $${worker.price} USDC) ──`);
    for (let i = 1; i <= JOBS_PER_WORKER; i++) {
      try {
        console.log(`  [${i}/${JOBS_PER_WORKER}] → ${worker.address}...`);
        const jobId = await client.initiateJob(
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

    // Post to dashboard
    const DASHBOARD_URL = process.env.RAILWAY_STATIC_URL
      ? `https://${process.env.RAILWAY_STATIC_URL}`
      : 'http://localhost:8080';
    try {
      const fetch = (await import('node-fetch')).default;
      await fetch(`${DASHBOARD_URL}/api/brief`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief, source: 'ceobuyer', timestamp: new Date().toISOString() }),
      });
      console.log('[ceo] Final brief posted to dashboard');
    } catch (e) {
      console.warn('[ceo] Could not post final brief to dashboard:', e.message);
    }
  }

  console.log('[ceo] Done.');
}

main().catch(err => { console.error('[ceo] Fatal:', err); process.exit(1); });
