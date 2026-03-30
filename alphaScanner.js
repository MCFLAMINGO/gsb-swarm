require('dotenv').config();
const axios = require('axios');
const { buildAcpClient } = require('./acp');

const AGENT_NAME = 'GSB Alpha Scanner';
const JOB_PRICE = 0.10;

// ── Job requirements JSON schema ──────────────────────────────────────────────
const REQUIREMENTS_SCHEMA = {
  name: 'GSB Alpha Scanner',
  description: 'Scans for alpha signals on Base: trending tokens, new launches, whale movements, DEX volume spikes.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: "What to scan for — e.g. 'trending tokens', 'new launches today', 'whale wallets moving'",
      },
      chain: {
        type: 'string',
        description: "Blockchain to scan. Must be 'base'.",
        enum: ['base'],
      },
      limit: {
        type: 'number',
        description: 'Max results to return (default 10, max 50)',
      },
    },
    required: ['query'],
  },
  examples: [
    { input: { query: 'trending tokens on base today' }, description: 'Scan for trending Base tokens' },
    { input: { query: 'new launches', chain: 'base', limit: 20 }, description: 'Find new token launches' },
  ],
  rejection_cases: [
    'Empty or missing query',
    'Non-Base chain specified (only Base is supported)',
    'NSFW or inappropriate query content',
  ],
};

// ── Input validation ──────────────────────────────────────────────────────────
const NSFW_KEYWORDS = /hack|drain|steal|phish|scam|exploit|launder|porn|nsfw|xxx/i;

function validateInput(raw) {
  if (!raw || typeof raw !== 'string' || raw.trim().length === 0) {
    return { valid: false, reason: 'Empty or missing query.' };
  }

  // Try to parse as JSON to extract structured fields
  let query = raw;
  let chain = null;
  let limit = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed.query) query = parsed.query;
    chain = parsed.chain || null;
    limit = parsed.limit || null;
  } catch {
    // raw string is the query itself
  }

  if (!query || query.trim().length < 3) {
    return { valid: false, reason: 'Empty or missing query.' };
  }

  // Reject NSFW/scam keywords
  if (NSFW_KEYWORDS.test(query)) {
    return { valid: false, reason: 'Query contains disallowed content and cannot be processed.' };
  }

  // Chain must be base if specified
  if (chain && chain.toLowerCase() !== 'base') {
    return { valid: false, reason: `Only the Base network is supported. Received: ${chain}` };
  }

  // Clamp limit to 50 (do NOT reject)
  if (limit !== null && limit > 50) {
    limit = 50;
  }

  return { valid: true, query, chain, limit };
}

const handledJobs = new Set();

function extractContent(req) {
  if (!req) return '';
  if (typeof req === 'string') {
    try { req = JSON.parse(req); } catch { return req; }
  }
  if (typeof req === 'object') {
    return req.query || req.topic || req.requirement || req.content || JSON.stringify(req);
  }
  return String(req);
}

async function waitForTransaction(client, jobId, maxWaitMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const fresh = await client.getJobById(jobId);
    if (fresh && fresh.phase === 2) return fresh;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`Job ${jobId} did not reach TRANSACTION phase within ${maxWaitMs}ms`);
}

async function scanAlpha() {
  try {
    const boostRes = await axios.get(
      'https://api.dexscreener.com/token-boosts/latest/v1',
      { timeout: 8000 }
    );

    const boosted = (boostRes.data || [])
      .filter(t => t.chainId === 'base')
      .slice(0, 5)
      .map(t => ({
        address: t.tokenAddress,
        url: t.url,
        boostAmount: t.amount,
        totalAmount: t.totalAmount,
      }));

    const pairsRes = await axios.get(
      'https://api.dexscreener.com/latest/dex/search?q=base',
      { timeout: 8000 }
    );

    const topGainers = (pairsRes.data?.pairs || [])
      .filter(p => p.chainId === 'base' && p.priceChange?.h24 > 20 && p.liquidity?.usd > 10000)
      .sort((a, b) => (b.priceChange?.h24 || 0) - (a.priceChange?.h24 || 0))
      .slice(0, 5)
      .map(p => ({
        name: p.baseToken?.name,
        symbol: p.baseToken?.symbol,
        address: p.baseToken?.address,
        price_usd: p.priceUsd,
        change_24h: `+${p.priceChange?.h24}%`,
        liquidity: `$${(p.liquidity?.usd || 0).toLocaleString()}`,
        volume_24h: `$${(p.volume?.h24 || 0).toLocaleString()}`,
        dexscreener: `https://dexscreener.com/base/${p.pairAddress}`,
      }));

    return {
      scan_time: new Date().toISOString(),
      top_gainers_base: topGainers,
      boosted_tokens_base: boosted,
      gsb_signal: topGainers.length > 0
        ? `${topGainers[0].symbol} leading with ${topGainers[0].change_24h} — watch for continuation.`
        : 'No strong alpha signals detected right now. Market is quiet.',
      powered_by: 'GSB Intelligence Swarm',
    };
  } catch (err) {
    return { error: `Scan failed: ${err.message}`, scan_time: new Date().toISOString() };
  }
}

async function start() {
  console.log(`[${AGENT_NAME}] Starting ACP provider...`);
  let client;
  client = await buildAcpClient({
    privateKey: process.env.AGENT_WALLET_PRIVATE_KEY,
    entityId: parseInt(process.env.ALPHA_SCANNER_ENTITY_ID),
    agentWalletAddress: process.env.ALPHA_SCANNER_WALLET_ADDRESS,
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
          await job.respond(true, 'Scanning Base for alpha...');
          console.log(`[${AGENT_NAME}] Job ${job.id} accepted. Waiting for TRANSACTION phase...`);
          freshJob = await waitForTransaction(client, job.id);
          console.log(`[${AGENT_NAME}] Job ${job.id} in TRANSACTION phase. Scanning...`);
        }

        const result = await scanAlpha();
        await freshJob.deliver({ type: 'text', value: JSON.stringify(result, null, 2) });
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
  console.log(`[${AGENT_NAME}] Online. Scanning Base for alpha. $${JOB_PRICE} USDC per job.`);
}

start().catch(console.error);
