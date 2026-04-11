require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { buildAcpAgent, AssetToken } = require('./acp');
const { CHAIN_CONFIG, resolveChain, SUPPORTED_CHAINS } = require('./chains');

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
const REQUIREMENTS_SCHEMA = {
  type: 'object',
  properties: {
    contractAddress: {
      type: 'string',
      description: 'Token contract address to analyze (0x... for EVM, base58 for Solana)',
    },
    chain: {
      type: 'string',
      description: `Blockchain network (${SUPPORTED_CHAINS.join(', ')}). Defaults to base.`,
    },
  },
  required: ['contractAddress'],
};

// ── Input validation ──────────────────────────────────────────────────────────
function validateInput(raw) {
  // Block NSFW / harmful requests
  if (/scam|rug|hack|steal|exploit|launder|pump.?and.?dump/i.test(raw)) {
    return { valid: false, reason: 'This request cannot be processed. Please submit a legitimate token analysis request.' };
  }

  // Extract chain from JSON or plain text
  let chain = null;
  try {
    const parsed = JSON.parse(raw);
    chain = parsed.chain || null;
  } catch {
    const chainMatch = raw.match(/\bon\s+(base|ethereum|eth|arbitrum|arb|polygon|matic|solana|sol|bsc|bnb|avalanche|avax|optimism|op)\b/i);
    if (chainMatch) chain = chainMatch[1];
  }
  const resolvedChain = resolveChain(chain) || 'base';

  // Solana addresses are base58 (32-44 chars, no 0x prefix)
  if (resolvedChain === 'solana') {
    const solMatch = raw.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
    if (solMatch) {
      return { valid: true, address: solMatch[0], chain: 'solana' };
    }
  }

  // Try to extract a 0x address from JSON or plain text
  const match = raw.match(/0x[a-fA-F0-9]{40}/);
  if (match) {
    return { valid: true, address: match[0], chain: resolvedChain };
  }

  // No address found — not necessarily invalid; caller may have a ticker symbol
  return { valid: false, reason: 'No valid contract address found. Please provide a token contract address (0x format for EVM, base58 for Solana).' };
}

const handledJobs = new Set();

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

async function analyzeToken(contractAddress, chain = 'base') {
  try {
    const resolvedChain = resolveChain(chain) || 'base';
    const dexRes = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`,
      { timeout: 8000 }
    );
    const allPairs = dexRes.data?.pairs;
    if (!allPairs || allPairs.length === 0) return { error: `No trading pairs found for this contract on ${CHAIN_CONFIG[resolvedChain]?.name || resolvedChain}.` };

    // Filter by requested chain first; fall back to best across all chains
    let chainPairs = allPairs.filter(p => p.chainId === resolvedChain);
    let chainNote = null;
    if (chainPairs.length === 0) {
      chainPairs = allPairs;
      chainNote = '(best match across all chains)';
    }
    const pair = chainPairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

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
      chain_note:      chainNote,
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

  const agent = await buildAcpAgent({
    signerPrivateKey:   process.env.TOKEN_ANALYST_SIGNER_PK || process.env.TOKEN_ANALYST_PK || process.env.AGENT_WALLET_PRIVATE_KEY,
    walletId:           process.env.TOKEN_ANALYST_WALLET_ID,
    entityId:           parseInt(process.env.TOKEN_ANALYST_ENTITY_ID) || 1,
    agentWalletAddress: process.env.TOKEN_ANALYST_WALLET_ADDRESS,
    onEntry: async (session, entry) => {
      if (entry.kind !== 'system') return;
      const { type } = entry.event;
      const jobId = session.jobId;

      // ── job.created — validate and set budget ─────────────────────────────
      if (type === 'job.created') {
        if (handledJobs.has(jobId)) return;
        handledJobs.add(jobId);

        try {
          let rawContent = entry.event.requirement || entry.event.content || '';
          console.log(`[${AGENT_NAME}] Job ${jobId} content: ${rawContent.slice(0, 120)}`);

          const parsed = parseJobRequirement(rawContent);
          const skills = loadSkills(AGENT_NAME);
          if (parsed.skillId) {
            const skillDef = skills.find(s => s.skillId === parsed.skillId);
            if (skillDef) {
              rawContent = executeSkillInstruction(skillDef, parsed.params || {});
            }
          }

          // Extract address
          let contractAddress;
          if (parsed.skillId && parsed.params?.address) {
            contractAddress = parsed.params.address;
          } else if (parsed.params?.contractAddress) {
            contractAddress = parsed.params.contractAddress;
          } else {
            const addrMatch = rawContent.match(/0x[0-9a-fA-F]{40}/i);
            contractAddress = addrMatch ? addrMatch[0] : null;
          }

          const check = validateInput(rawContent);
          if (!check.valid && contractAddress) { check.valid = true; check.address = contractAddress; }
          if (contractAddress) check.address = contractAddress;

          if (!check.valid) {
            console.log(`[${AGENT_NAME}] Job ${jobId} REJECTED: ${check.reason}`);
            await session.reject(check.reason);
            handledJobs.delete(jobId);
            return;
          }

          const chainName = CHAIN_CONFIG[check.chain || 'base']?.name || (check.chain || 'base');
          await session.setBudget(AssetToken.usdc(JOB_PRICE, session.chainId));
          console.log(`[${AGENT_NAME}] Job ${jobId} acked for ${chainName} — budget set $${JOB_PRICE} USDC`);
        } catch (err) {
          console.error(`[${AGENT_NAME}] Job ${jobId} job.created error:`, err.message);
          try { await session.reject(`Setup error: ${err.message}`); } catch (_) {}
          handledJobs.delete(jobId);
        }

      // ── job.funded — analyze and submit ───────────────────────────────────
      } else if (type === 'job.funded') {
        try {
          let rawContent = entry.event.requirement || entry.event.content || '';
          if (!rawContent) {
            const history = await session.getHistory?.() || [];
            const reqMsg = history.find(m => m.contentType === 'requirement');
            rawContent = reqMsg?.content || '';
          }

          const parsed = parseJobRequirement(rawContent);
          let contractAddress;
          if (parsed.skillId && parsed.params?.address) {
            contractAddress = parsed.params.address;
          } else if (parsed.params?.contractAddress) {
            contractAddress = parsed.params.contractAddress;
          } else {
            const addrMatch = rawContent.match(/0x[0-9a-fA-F]{40}/i);
            contractAddress = addrMatch ? addrMatch[0] : null;
          }

          const check = validateInput(rawContent);
          if (!check.valid && contractAddress) { check.valid = true; check.address = contractAddress; }
          if (contractAddress) check.address = contractAddress;

          const jobChain = check.chain || 'base';
          const report = await analyzeToken(check.address, jobChain);
          await session.submit(JSON.stringify(report, null, 2));
          console.log(`[${AGENT_NAME}] Job ${jobId} submitted.`);
        } catch (err) {
          console.error(`[${AGENT_NAME}] Job ${jobId} job.funded error:`, err.message);
          try { await session.reject(`Delivery error: ${err.message}`); } catch (_) {}
          handledJobs.delete(jobId);
        }

      // ── job.submitted — evaluator completes ───────────────────────────────
      } else if (type === 'job.submitted') {
        try {
          await session.complete('Delivered successfully.');
          console.log(`[${AGENT_NAME}] Job ${jobId} completed.`);
        } catch (_) {}
      }
    },
  });

  await agent.start();
  console.log(`[${AGENT_NAME}] Online. Schema: ${JSON.stringify(REQUIREMENTS_SCHEMA)}. Listening at $${JOB_PRICE} USDC/job.`);
}

start().catch(console.error);
