require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { buildAcpClient } = require('./acp');

const AGENT_NAME = 'GSB Token Analyst';

// ── Skill Registry ───────────────────────────────────────────────────────────
function loadSkills(workerName) {
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(__dirname, 'skills.json'), 'utf8'));
    return registry[workerName] || [];
  } catch (e) {
    console.warn('[skills] Could not load skills.json, using defaults');
    return [];
  }
}

function parseJobRequirement(requirement) {
  try {
    const parsed = JSON.parse(requirement);
    if (parsed.skillId) return parsed;
  } catch {}
  if (typeof requirement === 'string' && requirement.includes('skillId:')) {
    const parts = requirement.split(/\s+/);
    const result = {};
    parts.forEach(part => {
      const [key, ...rest] = part.split(':');
      if (key && rest.length) result[key] = rest.join(':');
    });
    if (result.skillId) return { skillId: result.skillId, params: result };
  }
  return { skillId: null, params: {}, rawText: requirement };
}

function executeSkillInstruction(skill, params) {
  let instruction = skill.instruction;
  Object.entries(params).forEach(([key, val]) => {
    instruction = instruction.replace(new RegExp(`\\{${key}\\}`, 'g'), val);
  });
  return instruction;
}
const JOB_PRICE  = 0.25;

// ── Virtuals Protocol sell wall addresses ─────────────────────────────────────
// These are Automated Capital Formation addresses — must NOT be flagged as
// team/insider holders. Whitelisted per Virtuals graduation requirements.
const VIRTUALS_SELL_WALL = new Set([
  '0xe2890629ef31b32132003c02b29a50a025deee8a',
  '0xf8dd39c71a278fe9f4377d009d7627ef140f809e',
]);

// ── Job requirements JSON schema ──────────────────────────────────────────────
// Defines the structured input this agent accepts.
// Buyers must provide a contractAddress (0x... on Base).
const REQUIREMENTS_SCHEMA = {
  type: 'object',
  properties: {
    contractAddress: {
      type: 'string',
      description: 'EVM contract address of the token to analyze (0x... format, Base network)',
    },
  },
  required: ['contractAddress'],
};

// ── Input validation ──────────────────────────────────────────────────────────
function validateInput(raw) {
  // Block non-Base / obviously wrong requests
  if (/solana|bitcoin|bsc|polygon|avalanche|arbitrum|optimism/i.test(raw)) {
    return { valid: false, reason: 'This agent only analyzes tokens on the Base network. Please provide a Base token contract address.' };
  }

  // Block NSFW / harmful requests
  if (/scam|rug|hack|steal|exploit|launder|pump.?and.?dump/i.test(raw)) {
    return { valid: false, reason: 'This request cannot be processed. Please submit a legitimate token analysis request.' };
  }

  // Try to extract a 0x address from JSON or plain text
  const match = raw.match(/0x[a-fA-F0-9]{40}/);
  if (match) {
    return { valid: true, address: match[0] };
  }

  // No address found — not necessarily invalid; caller may have a ticker symbol
  return { valid: false, reason: 'No valid contract address found. Please provide a Base token contract address in 0x format.' };
}

const handledJobs = new Set();

async function waitForTransaction(client, jobId, maxWaitMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const fresh = await client.getJobById(jobId);
    if (fresh && fresh.phase === 2) return fresh;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`Job ${jobId} did not reach TRANSACTION phase within ${maxWaitMs}ms`);
}

function extractContent(req) {
  if (!req) return '';
  if (typeof req === 'string') {
    try { req = JSON.parse(req); } catch { return req; }
  }
  if (typeof req === 'object') {
    return req.contractAddress || req.topic || req.requirement || req.content || JSON.stringify(req);
  }
  return String(req);
}

async function analyzeToken(contractAddress) {
  try {
    const dexRes = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`,
      { timeout: 8000 }
    );
    const pairs = dexRes.data?.pairs;
    if (!pairs || pairs.length === 0) return { error: 'No trading pairs found for this contract on Base.' };

    const pair = pairs
      .filter(p => p.chainId === 'base')
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]
      || pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

    const liq     = pair.liquidity?.usd  || 0;
    const vol24h  = pair.volume?.h24     || 0;
    const change24h = pair.priceChange?.h24 || 0;

    let verdict = 'NEUTRAL — Average activity.';
    if (liq > 100000 && vol24h > 50000 && change24h > 10) verdict = 'BULLISH — Strong liquidity, high volume, upward momentum.';
    else if (liq > 50000 && vol24h > 10000)               verdict = 'WATCH — Decent setup. Monitor for breakout.';
    else if (liq < 5000)                                   verdict = 'RISKY — Low liquidity. High rug potential.';

    // Build holder concentration — exclude known sell wall addresses
    const sellWallNote = VIRTUALS_SELL_WALL.has(contractAddress.toLowerCase())
      ? 'Note: This contract includes Virtuals Protocol ACF (Automated Capital Formation) addresses which are excluded from insider/team holder metrics.'
      : null;

    return {
      token: {
        name:    pair.baseToken?.name,
        symbol:  pair.baseToken?.symbol,
        address: contractAddress,
        chain:   pair.chainId || 'base',
      },
      price: {
        usd:       pair.priceUsd,
        change_24h: change24h,
        high_24h:  pair.priceChange?.h24 || null,
      },
      liquidity_usd:   liq,
      volume_24h:      vol24h,
      market_cap:      pair.marketCap || pair.fdv || 0,
      dexscreener_url: `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`,
      gsb_verdict:     verdict,
      sell_wall_note:  sellWallNote,
      analyzed_at:     new Date().toISOString(),
      powered_by:      'GSB Intelligence Swarm',
    };
  } catch (err) {
    return { error: `Analysis failed: ${err.message}` };
  }
}

async function start() {
  console.log(`[${AGENT_NAME}] Starting ACP provider...`);
  const client = await buildAcpClient({
    privateKey:         process.env.AGENT_WALLET_PRIVATE_KEY,
    entityId:           parseInt(process.env.TOKEN_ANALYST_ENTITY_ID),
    agentWalletAddress: process.env.TOKEN_ANALYST_WALLET_ADDRESS,

    onNewTask: async (job) => {
      console.log(`[${AGENT_NAME}] New job: ${job.id} | phase=${job.phase}`);

      if (handledJobs.has(job.id)) {
        console.log(`[${AGENT_NAME}] Job ${job.id} already in progress — skipping.`);
        return;
      }
      handledJobs.add(job.id);

      try {
        let rawContent = extractContent(job.requirement)
          || extractContent(job.memos?.[0]?.content)
          || '';
        console.log(`[${AGENT_NAME}] Job ${job.id} content: ${rawContent.slice(0, 120)}`);

        // ── Skill registry routing ───────────────────────────────────────────
        const parsed = parseJobRequirement(rawContent);
        const skills = loadSkills(AGENT_NAME);
        if (parsed.skillId) {
          const skillDef = skills.find(s => s.skillId === parsed.skillId);
          if (skillDef) {
            const instruction = executeSkillInstruction(skillDef, parsed.params || {});
            console.log(`[${AGENT_NAME}] Skill ${parsed.skillId} → "${instruction.slice(0, 100)}"`);
            rawContent = instruction;
          }
        }

        // ── Extract address from JSON params or plain text ──────────────────
        let contractAddress;
        if (parsed.skillId && parsed.params?.address) {
          contractAddress = parsed.params.address;
        } else if (parsed.params?.contractAddress) {
          contractAddress = parsed.params.contractAddress;
        } else {
          const addrMatch = rawContent.match(/0x[0-9a-fA-F]{40}/i);
          contractAddress = addrMatch ? addrMatch[0] : null;
        }

        // ── Validate BEFORE accepting ────────────────────────────────────────
        const check = validateInput(rawContent);
        // Use extracted address if validateInput didn't find one (e.g. from JSON params)
        if (!check.valid && contractAddress) {
          check.valid = true;
          check.address = contractAddress;
        }
        if (!check.valid) {
          console.log(`[${AGENT_NAME}] Job ${job.id} REJECTED: ${check.reason}`);
          await job.reject(check.reason);
          handledJobs.delete(job.id);
          return;
        }
        // Prefer the directly extracted address
        if (contractAddress) check.address = contractAddress;

        let freshJob = job;
        if (job.phase === 2) {
          console.log(`[${AGENT_NAME}] Job ${job.id} already in TRANSACTION phase.`);
        } else {
          await job.respond(true, 'Analyzing token on Base now...');
          console.log(`[${AGENT_NAME}] Job ${job.id} accepted. Waiting for TRANSACTION phase...`);
          freshJob = await waitForTransaction(client, job.id);
          console.log(`[${AGENT_NAME}] Job ${job.id} in TRANSACTION phase.`);
        }

        const report = await analyzeToken(check.address);
        await freshJob.deliver({ type: 'text', value: JSON.stringify(report, null, 2) });
        console.log(`[${AGENT_NAME}] Job ${job.id} delivered.`);
      } catch (err) {
        console.error(`[${AGENT_NAME}] Job ${job.id} error:`, err.message);
        // If we're past the REQUEST phase, use rejectPayable so the buyer is refunded
        try {
          await job.rejectPayable(`Internal error: ${err.message}. Your payment will be refunded.`);
          console.log(`[${AGENT_NAME}] Job ${job.id} rejectPayable issued — buyer will be refunded.`);
        } catch (_) {}
        handledJobs.delete(job.id);
      }
    },

    onEvaluate: async (job) => {
      try { await job.evaluate(true, 'Delivered successfully.'); } catch (_) {}
    },
  });
  console.log(`[${AGENT_NAME}] Online. Schema: ${JSON.stringify(REQUIREMENTS_SCHEMA)}. Listening at $${JOB_PRICE} USDC/job.`);
}

start().catch(console.error);
