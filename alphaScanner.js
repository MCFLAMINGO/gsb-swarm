require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { buildAcpClient } = require('./acp');
const swarmMemory = require('./swarmMemory');
const { CHAIN_CONFIG, resolveChain, SUPPORTED_CHAINS } = require('./chains');

const AGENT_NAME = 'GSB Alpha Scanner';

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
const JOB_PRICE = 0.10;

// ── Job requirements JSON schema ──────────────────────────────────────────────
const REQUIREMENTS_SCHEMA = {
  name: 'GSB Alpha Scanner',
  description: `Scans for alpha signals: trending tokens, new launches, whale movements, DEX volume spikes. Supports: ${SUPPORTED_CHAINS.join(', ')}.`,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: "What to scan for — e.g. 'trending tokens', 'new launches today', 'whale wallets moving'",
      },
      chain: {
        type: 'string',
        description: `Blockchain to scan (${SUPPORTED_CHAINS.join(', ')}). Defaults to base.`,
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
    { input: { query: 'new launches', chain: 'ethereum', limit: 20 }, description: 'Find new token launches on Ethereum' },
    { input: { query: 'trending on arbitrum' }, description: 'Scan Arbitrum for trending tokens' },
  ],
  rejection_cases: [
    'Empty or missing query',
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

  // Resolve chain — default to 'base' if not specified or unrecognized
  if (!chain) {
    // Try to extract chain from plain text (e.g. "scan solana", "alpha on ethereum")
    const textChainMatch = raw.match(/\b(base|ethereum|eth|arbitrum|arb|polygon|matic|solana|sol|bsc|bnb|binance|avalanche|avax|optimism|op)\b/i);
    if (textChainMatch) chain = textChainMatch[1];
  }
  const resolvedChain = resolveChain(chain) || 'base';

  // Clamp limit to 50 (do NOT reject)
  if (limit !== null && limit > 50) {
    limit = 50;
  }

  // Detect token address in query — Solana (base58, 32-44 chars, no 0x) or EVM (0x + 40 hex)
  const solanaAddrMatch = raw.match(/\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/);
  const evmAddrMatch    = raw.match(/\b(0x[a-fA-F0-9]{40})\b/);
  let tokenAddress = null;
  if (evmAddrMatch) {
    tokenAddress = evmAddrMatch[1];
  } else if (solanaAddrMatch && !raw.match(/^[0-9]+$/)) {
    // Only treat as Solana address if it looks like base58 (not a pure number string)
    tokenAddress = solanaAddrMatch[1];
    // If chain not explicitly set, infer solana from base58 address
    if (resolvedChain === 'base') {
      // leave chain as-is if user specified it, otherwise set solana
      if (!chain) {
        const inferredChain = 'solana';
        return { valid: true, query, chain: inferredChain, limit, tokenAddress };
      }
    }
  }

  return { valid: true, query, chain: resolvedChain, limit, tokenAddress };
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
const GECKO_API    = 'https://api.geckoterminal.com/api/v2/networks';
const DEX_BOOST    = 'https://api.dexscreener.com/token-boosts/latest/v1';
const DEX_TOKENS   = 'https://api.dexscreener.com/latest/dex/tokens';
const GECKO_HEADERS = { 'Accept': 'application/json', 'User-Agent': 'GSB-Alpha-Scanner/1.0' };

// ── Specific token address lookup via DexScreener ─────────────────────────────
async function lookupToken(tokenAddress, hintChain) {
  try {
    const res = await axios.get(`${DEX_TOKENS}/${tokenAddress}`, { timeout: 10000 });
    const pairs = res.data?.pairs || [];
    if (!pairs.length) {
      return { error: `No trading pairs found for ${tokenAddress}. Token may be too new or not yet listed on any DEX.` };
    }

    // Sort by liquidity descending, prefer hintChain if provided
    const sorted = pairs
      .filter(p => p.liquidity?.usd > 0 || p.volume?.h24 > 0)
      .sort((a, b) => {
        // Prefer the hinted chain
        if (hintChain && a.chainId === hintChain && b.chainId !== hintChain) return -1;
        if (hintChain && b.chainId === hintChain && a.chainId !== hintChain) return 1;
        return (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0);
      });

    if (!sorted.length) {
      // Return raw first pair even if low liquidity
      const p = pairs[0];
      return {
        token_address: tokenAddress,
        name: p.baseToken?.name || 'Unknown',
        symbol: p.baseToken?.symbol || '?',
        chain: p.chainId,
        price_usd: p.priceUsd || '0',
        liquidity: '$0',
        volume_24h: '$0',
        change_1h: '0%',
        change_24h: '0%',
        fdv: '$0',
        pair_url: p.url,
        note: 'Very low liquidity — early stage token.',
      };
    }

    const best = sorted[0];
    const isPumpFun = best.url?.includes('pump.fun') || tokenAddress.endsWith('pump');

    // Build concise multi-chain summary if pairs exist on multiple chains
    const chains = [...new Set(sorted.map(p => p.chainId))].slice(0, 3);

    const change1h  = parseFloat(best.priceChange?.h1  || 0);
    const change24h = parseFloat(best.priceChange?.h24 || 0);
    const liq       = best.liquidity?.usd  || 0;
    const vol24h    = best.volume?.h24     || 0;
    const fdv       = best.fdv             || 0;
    const mcap      = best.marketCap       || 0;

    const signal = (() => {
      if (isPumpFun && liq < 10000) return 'pump.fun bonding curve — pre-graduation. High risk, high reward.';
      if (liq < 5000)  return 'Very thin liquidity. Treat as speculative.';
      if (change1h > 20) return `Pumping hard — +${change1h.toFixed(1)}% in the last hour. Watch for reversal.`;
      if (change24h > 50) return `Up ${change24h.toFixed(1)}% in 24h. Momentum play — set stop loss.`;
      if (change24h < -30) return `Down ${Math.abs(change24h).toFixed(1)}% in 24h. Potential oversold bounce or distribution.`;
      return 'Stable price action. Monitor for breakout.';
    })();

    return {
      token_address: tokenAddress,
      name:        best.baseToken?.name   || 'Unknown',
      symbol:      best.baseToken?.symbol || '?',
      chain:       best.chainId,
      chains_listed: chains,
      price_usd:   best.priceUsd || '0',
      price_native: best.priceNative || '0',
      liquidity:   fmt(liq),
      volume_24h:  fmt(vol24h),
      change_1h:   `${change1h >= 0 ? '+' : ''}${change1h.toFixed(2)}%`,
      change_24h:  `${change24h >= 0 ? '+' : ''}${change24h.toFixed(2)}%`,
      fdv:         fmt(fdv),
      market_cap:  fmt(mcap),
      pair_url:    best.url,
      dex:         best.dexId,
      is_pump_fun: isPumpFun,
      gsb_signal:  signal,
      powered_by:  'GSB Intelligence Swarm',
    };
  } catch (err) {
    return { error: `Token lookup failed: ${err.message}`, token_address: tokenAddress };
  }
}

function fmt(n) {
  const num = parseFloat(n || 0);
  if (num >= 1e6) return `$${(num / 1e6).toFixed(2)}M`;
  if (num >= 1e3) return `$${(num / 1e3).toFixed(1)}K`;
  return `$${num.toFixed(2)}`;
}

async function scanAlpha(chain = 'base') {
  try {
    const resolvedChain = resolveChain(chain) || 'base';
    const geckoId = CHAIN_CONFIG[resolvedChain]?.geckoTerminalId || 'base';
    const chainName = CHAIN_CONFIG[resolvedChain]?.name || resolvedChain;
    const geckoBase = `${GECKO_API}/${geckoId}`;

    // Run all fetches in parallel
    const [trendingRes, newPoolsRes, boostRes] = await Promise.allSettled([
      // 1. GeckoTerminal — trending pools on target chain
      axios.get(`${geckoBase}/trending_pools?page=1`, { headers: GECKO_HEADERS, timeout: 10000 }),
      // 2. GeckoTerminal — newest pools on target chain
      axios.get(`${geckoBase}/new_pools?page=1`, { headers: GECKO_HEADERS, timeout: 10000 }),
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
            ? `https://www.geckoterminal.com/${geckoId}/pools/${a.address}`
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

    // ── DexScreener boosted tokens on target chain ─────────────────────────
    const boosted = boostRes.status === 'fulfilled'
      ? (boostRes.value.data || [])
          .filter(t => t.chainId === resolvedChain)
          .slice(0, 3)
          .map(t => ({ address: t.tokenAddress, url: t.url, boost: t.totalAmount }))
      : [];

    // ── Signal ────────────────────────────────────────────────────────────────
    let gsb_signal = `Market is quiet on ${chainName} right now. No high-conviction plays detected.`;
    if (topGainers.length > 0) {
      const top = topGainers[0];
      gsb_signal = `${top.name} leading ${chainName} with ${top.change_24h} | Vol: ${top.volume_24h} | Liq: ${top.liquidity} — watch for continuation.`;
    }

    return {
      scan_time: new Date().toISOString(),
      chain: resolvedChain,
      chain_name: chainName,
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
    privateKey: process.env.ALPHA_SCANNER_PRIVATE_KEY || process.env.AGENT_WALLET_PRIVATE_KEY,
    entityId: parseInt(process.env.ALPHA_SCANNER_ENTITY_ID) || 1,
    agentWalletAddress: process.env.ALPHA_SCANNER_WALLET_ADDRESS,
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

        // ── Validate BEFORE accepting ────────────────────────────────────────
        const check = validateInput(rawContent);
        if (!check.valid) {
          console.log(`[${AGENT_NAME}] Job ${job.id} REJECTED: ${check.reason}`);
          await job.reject(check.reason);
          handledJobs.delete(job.id);
          return;
        }

        const jobChain = check.chain || 'base';
        const chainName = CHAIN_CONFIG[jobChain]?.name || jobChain;
        let freshJob = job;

        // ACP v2: ack immediately, process async
        if (job.phase !== 2) {
          await job.respond(true, `Scanning ${chainName} for alpha...`);
          console.log(`[${AGENT_NAME}] Job ${job.id} acked — processing async`);
          try { freshJob = await waitForTransaction(client, job.id, 30000); } catch { freshJob = job; }
        }

        // If a specific token address was detected, look it up directly
        const result = check.tokenAddress
          ? await lookupToken(check.tokenAddress, jobChain)
          : await scanAlpha(jobChain);
        await freshJob.deliver({ type: 'text', value: JSON.stringify(result, null, 2) });
        console.log(`[${AGENT_NAME}] Job ${job.id} delivered.`);

        // ── Write findings to swarm memory ────────────────────────────────────
        try {
          const sym = result.symbol || result.baseToken?.symbol;
          const addr = result.contractAddress || check.tokenAddress;
          if (sym) {
            swarmMemory.writeNarrative(sym, {
              contractAddress: addr || result.contractAddress,
              chain:           result.chain || jobChain,
              priceUsd:        result.priceUsd,
              liquidity:       result.liquidity,
              volume24h:       result.volume24h,
              alphaVerdict:    result.gsb_signal || result.verdict,
            });
          }
          if (addr) swarmMemory.writeFinding(`alpha:${addr}`, AGENT_NAME, result);
        } catch (_) {}
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
  console.log(`[${AGENT_NAME}] Online. Multi-chain alpha scanning (${SUPPORTED_CHAINS.join(', ')}). $${JOB_PRICE} USDC per job.`);
}

start().catch(console.error);
