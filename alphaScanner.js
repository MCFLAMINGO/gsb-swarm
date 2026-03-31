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

// ── Data sources (no API keys required) ──────────────────────────────────────
const GECKO_BASE   = 'https://api.geckoterminal.com/api/v2/networks/base';
const DEX_BOOST    = 'https://api.dexscreener.com/token-boosts/latest/v1';
const GECKO_HEADERS = { 'Accept': 'application/json', 'User-Agent': 'GSB-Alpha-Scanner/1.0' };

function fmt(n) {
  const num = parseFloat(n || 0);
  if (num >= 1e6) return `$${(num / 1e6).toFixed(2)}M`;
  if (num >= 1e3) return `$${(num / 1e3).toFixed(1)}K`;
  return `$${num.toFixed(2)}`;
}

async function scanAlpha() {
  try {
    // Run all fetches in parallel
    const [trendingRes, newPoolsRes, boostRes] = await Promise.allSettled([
      // 1. GeckoTerminal — trending pools on Base (most reliable source)
      axios.get(`${GECKO_BASE}/trending_pools?page=1`, { headers: GECKO_HEADERS, timeout: 10000 }),
      // 2. GeckoTerminal — newest pools on Base (new launches)
      axios.get(`${GECKO_BASE}/new_pools?page=1`, { headers: GECKO_HEADERS, timeout: 10000 }),
      // 3. DexScreener boosted tokens
      axios.get(DEX_BOOST, { timeout: 8000 }),
    ]);

    // ── Top gainers from trending pools ───────────────────────────────────────
    const trendingPools = trendingRes.status === 'fulfilled'
      ? (trendingRes.value.data?.data || [])
      : [];

    const topGainers = trendingPools
      .map(p => {
        const a = p.attributes || {};
        const change24h = parseFloat(a.price_change_percentage?.h24 || 0);
        const vol24h    = parseFloat(a.volume_usd?.h24 || 0);
        const liq       = parseFloat(a.reserve_in_usd || 0);
        const price     = parseFloat(a.base_token_price_usd || 0);
        return { p, a, change24h, vol24h, liq, price };
      })
      .filter(({ liq, vol24h }) => liq > 1000 && vol24h > 500)
      .sort((a, b) => b.change24h - a.change24h)
      .slice(0, 5)
      .map(({ a, change24h, vol24h, liq, price }) => {
        const name = a.name || '';
        const [base] = name.split(' / ');
        const changeStr = change24h >= 0 ? `+${change24h.toFixed(1)}%` : `${change24h.toFixed(1)}%`;
        return {
          name: base.trim(),
          pair: name,
          price_usd: price < 0.0001 ? price.toExponential(4) : price.toFixed(6),
          change_24h: changeStr,
          liquidity: fmt(liq),
          volume_24h: fmt(vol24h),
          geckoterminal: a.pool_created_at
            ? `https://www.geckoterminal.com/base/pools/${a.address}`
            : null,
          fdv: fmt(a.fdv_usd || 0),
        };
      });

    // ── New launches ──────────────────────────────────────────────────────────
    const newPools = newPoolsRes.status === 'fulfilled'
      ? (newPoolsRes.value.data?.data || [])
      : [];

    const newLaunches = newPools
      .filter(p => parseFloat(p.attributes?.reserve_in_usd || 0) > 500)
      .slice(0, 5)
      .map(p => {
        const a = p.attributes || {};
        const name = a.name || '';
        const [base] = name.split(' / ');
        const ageMin = Math.floor((Date.now() - new Date(a.pool_created_at || Date.now()).getTime()) / 60000);
        return {
          name: base.trim(),
          pair: name,
          age: ageMin < 60 ? `${ageMin}m ago` : `${Math.floor(ageMin / 60)}h ago`,
          liquidity: fmt(a.reserve_in_usd || 0),
          volume_24h: fmt((a.volume_usd || {}).h24 || 0),
          change_24h: `${parseFloat((a.price_change_percentage || {}).h24 || 0).toFixed(1)}%`,
        };
      });

    // ── DexScreener boosted tokens on Base ───────────────────────────────────
    const boosted = boostRes.status === 'fulfilled'
      ? (boostRes.value.data || [])
          .filter(t => t.chainId === 'base')
          .slice(0, 3)
          .map(t => ({ address: t.tokenAddress, url: t.url, boost: t.totalAmount }))
      : [];

    // ── Signal ────────────────────────────────────────────────────────────────
    let gsb_signal = 'Market is quiet on Base right now. No high-conviction plays detected.';
    if (topGainers.length > 0) {
      const top = topGainers[0];
      gsb_signal = `${top.name} leading Base with ${top.change_24h} | Vol: ${top.volume_24h} | Liq: ${top.liquidity} — watch for continuation.`;
    }

    return {
      scan_time: new Date().toISOString(),
      top_gainers_base: topGainers,
      new_launches_base: newLaunches,
      boosted_tokens_base: boosted,
      gsb_signal,
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
