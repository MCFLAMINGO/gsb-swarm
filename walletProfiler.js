require('dotenv').config();
const axios = require('axios');
const { buildAcpClient } = require('./acp');

const AGENT_NAME = 'GSB Wallet Profiler';
const JOB_PRICE = 0.50;

// ── Job requirements JSON schema ──────────────────────────────────────────────
const REQUIREMENTS_SCHEMA = {
  name: 'GSB Wallet Profiler',
  description: 'Profiles a Base-network wallet address: token holdings, recent transactions, DeFi activity, risk flags.',
  parameters: {
    type: 'object',
    properties: {
      wallet_address: {
        type: 'string',
        description: 'EVM wallet address to profile (0x...)',
      },
      chain: {
        type: 'string',
        description: "Blockchain network. Must be 'base'.",
        enum: ['base'],
      },
    },
    required: ['wallet_address'],
  },
  examples: [
    { input: { wallet_address: '0x1234...abcd', chain: 'base' }, description: 'Profile a Base wallet' },
  ],
  rejection_cases: [
    'Missing or invalid wallet address (not a valid 0x EVM address)',
    'Non-Base chain specified (only Base is supported)',
    'NSFW or malicious intent detected in request',
  ],
};

// ── Input validation ──────────────────────────────────────────────────────────
const MALICIOUS_KEYWORDS = /hack|drain|steal|phish|scam|exploit|launder/i;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

function validateInput(raw) {
  if (!raw || typeof raw !== 'string' || raw.trim().length === 0) {
    return { valid: false, reason: 'Missing or invalid wallet address (not a valid 0x EVM address).' };
  }

  // Reject malicious intent
  if (MALICIOUS_KEYWORDS.test(raw)) {
    return { valid: false, reason: 'Request appears to contain malicious intent and cannot be processed.' };
  }

  // Check for Solana address (44-char base58 starting with a letter)
  const words = raw.trim().split(/\s+/);
  for (const w of words) {
    if (SOLANA_ADDRESS.test(w)) {
      return { valid: false, reason: 'Solana addresses are not supported. This agent operates on Base (EVM) only.' };
    }
  }

  // Must contain a valid 0x EVM address
  const match = raw.match(/0x[a-fA-F0-9]{40}/);
  if (!match) {
    return { valid: false, reason: 'Missing or invalid wallet address (not a valid 0x EVM address).' };
  }

  // Parse chain if present in JSON input
  let chain = null;
  try {
    const parsed = JSON.parse(raw);
    chain = parsed.chain;
  } catch {
    // not JSON — check for chain keyword in raw string
    const chainMatch = raw.match(/chain[:\s]*["']?(\w+)/i);
    if (chainMatch) chain = chainMatch[1];
  }
  if (chain && chain.toLowerCase() !== 'base') {
    return { valid: false, reason: `Only the Base network is supported. Received: ${chain}` };
  }

  return { valid: true, address: match[0] };
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
    return req.topic || req.requirement || req.content || req.walletAddress || JSON.stringify(req);
  }
  return String(req);
}

// Uses Blockscout public API — no API key required
const BLOCKSCOUT = 'https://base.blockscout.com/api';

async function profileWallet(address) {
  try {
    // 1. Transaction list (up to 50 most recent)
    const [txRes, tokenRes, ethRes] = await Promise.allSettled([
      axios.get(`${BLOCKSCOUT}?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&sort=desc`, { timeout: 10000 }),
      axios.get(`${BLOCKSCOUT}?module=account&action=tokenlist&address=${address}`, { timeout: 10000 }),
      axios.get(`${BLOCKSCOUT}?module=account&action=balance&address=${address}`, { timeout: 10000 }),
    ]);

    const txs = txRes.status === 'fulfilled' ? (txRes.value.data?.result || []) : [];
    const tokens = tokenRes.status === 'fulfilled' ? (tokenRes.value.data?.result || []) : [];
    const ethBalRaw = ethRes.status === 'fulfilled' ? (ethRes.value.data?.result || '0') : '0';

    const txCount = Array.isArray(txs) ? txs.length : 0;
    const ethBal = (parseInt(ethBalRaw) / 1e18).toFixed(6);

    const recentTxs = Array.isArray(txs) ? txs.slice(0, 5).map(t => ({
      hash: t.hash,
      value_eth: (parseInt(t.value || 0) / 1e18).toFixed(6),
      age_days: Math.floor((Date.now() / 1000 - parseInt(t.timeStamp || 0)) / 86400),
      direction: t.from?.toLowerCase() === address.toLowerCase() ? 'OUT' : 'IN',
    })) : [];

    // Token holdings — format balances with decimals
    const tokenHoldings = Array.isArray(tokens) ? tokens.slice(0, 10).map(t => {
      const decimals = parseInt(t.decimals || '18');
      const bal = (parseInt(t.balance || '0') / Math.pow(10, decimals));
      return {
        symbol: t.symbol,
        name: t.name,
        balance: bal < 0.0001 ? bal.toExponential(2) : bal.toLocaleString('en-US', { maximumFractionDigits: 4 }),
        contract: t.contractAddress,
      };
    }) : [];

    // Classification
    let classification = 'RETAIL — Standard wallet activity.';
    if (txCount > 1000)     classification = 'WHALE — Very high transaction volume.';
    else if (txCount > 200) classification = 'ACTIVE TRADER — Frequent on-chain activity.';
    else if (txCount > 20)  classification = 'REGULAR USER — Moderate on-chain history.';
    else if (txCount < 5)   classification = 'NEW WALLET — Limited history.';

    // Risk flags
    const riskFlags = [];
    if (txCount === 0 && tokenHoldings.length === 0) riskFlags.push('EMPTY — No activity detected.');
    if (tokenHoldings.length > 15) riskFlags.push('HIGH TOKEN COUNT — May include dust or spam tokens.');

    return {
      wallet: address,
      eth_balance: `${ethBal} ETH`,
      transaction_count: txCount,
      classification,
      token_holdings: tokenHoldings,
      recent_transactions: recentTxs,
      risk_flags: riskFlags,
      basescan_url: `https://basescan.org/address/${address}`,
      blockscout_url: `https://base.blockscout.com/address/${address}`,
      profiled_at: new Date().toISOString(),
      powered_by: 'GSB Intelligence Swarm',
    };
  } catch (err) {
    return { error: `Profile failed: ${err.message}` };
  }
}

async function processJob(client, job) {
  const rawContent = extractContent(job.requirement)
    || extractContent(job.memos?.[0]?.content)
    || '';
  const match = rawContent.match(/0x[a-fA-F0-9]{40}/);
  if (!match) {
    await job.deliver({ type: 'text', value: 'No wallet address found. Please provide a valid Base wallet address.' });
    return;
  }
  const profile = await profileWallet(match[0]);
  await job.deliver({ type: 'text', value: JSON.stringify(profile, null, 2) });
  console.log(`[${AGENT_NAME}] Job ${job.id} delivered.`);
}

async function start() {
  console.log(`[${AGENT_NAME}] Starting ACP provider...`);
  let client;
  client = await buildAcpClient({
    privateKey: process.env.AGENT_WALLET_PRIVATE_KEY,
    entityId: parseInt(process.env.WALLET_PROFILER_ENTITY_ID),
    agentWalletAddress: process.env.WALLET_PROFILER_WALLET_ADDRESS,
    onNewTask: async (job) => {
      console.log(`[${AGENT_NAME}] New job: ${job.id} | phase=${job.phase}`);

      if (handledJobs.has(job.id)) {
        console.log(`[${AGENT_NAME}] Job ${job.id} already in progress — skipping.`);
        return;
      }
      handledJobs.add(job.id);

      try {
        const rawContent = extractContent(job.requirement)
          || extractContent(job.memos?.[0]?.content)
          || '';
        console.log(`[${AGENT_NAME}] Job ${job.id} content: ${rawContent.slice(0, 120)}`);

        // ── Validate BEFORE accepting ────────────────────────────────────────
        const check = validateInput(rawContent);
        if (!check.valid) {
          console.log(`[${AGENT_NAME}] Job ${job.id} REJECTED: ${check.reason}`);
          await job.reject(check.reason);
          handledJobs.delete(job.id);
          return;
        }

        let freshJob = job;

        if (job.phase === 2) {
          console.log(`[${AGENT_NAME}] Job ${job.id} already in TRANSACTION phase.`);
        } else {
          await job.respond(true, 'Profiling wallet now...');
          console.log(`[${AGENT_NAME}] Job ${job.id} accepted. Waiting for TRANSACTION phase...`);
          freshJob = await waitForTransaction(client, job.id);
          console.log(`[${AGENT_NAME}] Job ${job.id} in TRANSACTION phase.`);
        }

        await processJob(client, freshJob);
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
  console.log(`[${AGENT_NAME}] Online. Listening for jobs at $${JOB_PRICE} USDC each.`);
}

start().catch(console.error);
