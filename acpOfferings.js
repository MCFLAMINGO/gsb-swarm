'use strict';
/**
 * ACP Offering & Agent Description Auto-Registration — GSB Swarm
 *
 * Runs at Railway startup. For each agent:
 *   1. Updates the agent's description on Virtuals ACP (rich, search-optimised)
 *   2. Upserts offerings — creates missing ones, updates descriptions on existing ones
 *
 * Auth: delegates to acpAuth.js → getValidToken().
 * acpAuth handles expiry detection, auto-refresh via VIRTUALS_REFRESH_TOKEN (ACP CLI)
 * and VIRTUALS_PRIVY_REFRESH_TOKEN (Privy web session). No token management here.
 *
 * Why this matters: acp browse uses semantic search on agent + offering descriptions.
 * Rich descriptions = higher ranking = more external agents find and hire you.
 */

const { getValidToken } = require('./acpAuth');
const ACP = 'https://api.acp.virtuals.io';

// ── Agent catalogue — UUIDs confirmed from API ────────────────────────────────
const AGENTS = [
  {
    id:   '019d756b-0217-7252-8094-7854afde1703',
    name: 'GSB Token Analyst',
    description:
      'On-chain token intelligence agent. Analyzes any ERC-20 or SPL token: price, ' +
      '24h volume, liquidity depth, market cap, holder distribution, whale wallet tracking, ' +
      'liquidity pool health, and rug risk score. Returns a structured buy/hold/avoid verdict. ' +
      'Supports Base, Ethereum, Arbitrum, Polygon, BSC, Avalanche, Optimism, and Solana. ' +
      'Hire for: token analysis, crypto research, DeFi due diligence, whale tracking, ' +
      'liquidity monitoring, on-chain analytics.',
    offerings: [
      {
        name:          'analyze_token',
        description:   'Full token analysis: price, 24h change, volume, liquidity, market cap, top holders, ' +
                       'whale concentration, liquidity pool health, rug risk score, and buy/hold/avoid verdict. ' +
                       'Works on any ERC-20 (Base/ETH/ARB/Polygon/BSC/AVAX/OP) or SPL token (Solana).',
        requirements:  JSON.stringify({ type: 'object', properties: {
          address: { type: 'string', description: 'Token contract address' },
          chain:   { type: 'string', description: 'Chain: base, ethereum, arbitrum, polygon, bsc, avalanche, optimism, solana' },
        }, required: ['address'] }),
        deliverable:   'JSON: price, change24h, volume24h, liquidity, marketCap, holderCount, whaleCount, rugRiskScore, verdict, reasoning',
        priceType:     'fixed', priceValue: 0.10, slaMinutes: 5, requiredFunds: false, isHidden: false,
      },
      {
        name:          'track_whale_wallets',
        description:   'Identify and track top 10 whale wallets holding a token. Returns wallet addresses, ' +
                       'balance, percentage of supply, wallet classification (whale/smart money/retail/bot), ' +
                       'last activity timestamp, and whether wallets are accumulating or distributing.',
        requirements:  JSON.stringify({ type: 'object', properties: {
          address: { type: 'string', description: 'Token contract address' },
          chain:   { type: 'string', description: 'Chain name' },
        }, required: ['address'] }),
        deliverable:   'JSON array: walletAddress, balance, supplyPct, class, lastActivity, trend',
        priceType:     'fixed', priceValue: 0.15, slaMinutes: 5, requiredFunds: false, isHidden: false,
      },
      {
        name:          'monitor_liquidity',
        description:   'Monitor the liquidity pool health for any trading pair. Returns pool TVL, ' +
                       '24h liquidity change, LP token distribution, top LPs, pool utilisation rate, ' +
                       'and a rug risk assessment based on LP concentration.',
        requirements:  JSON.stringify({ type: 'object', properties: {
          address: { type: 'string', description: 'Token or pool contract address' },
          chain:   { type: 'string', description: 'Chain name' },
        }, required: ['address'] }),
        deliverable:   'JSON: tvl, change24h, lpCount, topLPs, utilizationRate, rugRisk',
        priceType:     'fixed', priceValue: 0.12, slaMinutes: 5, requiredFunds: false, isHidden: false,
      },
      {
        name:          'job_receipt',
        description:   'Generate a verifiable on-chain job receipt for any completed analysis. ' +
                       'Returns a signed summary of the job including agent ID, skill used, timestamp, and result hash.',
        requirements:  JSON.stringify({ type: 'object', properties: {
          jobId: { type: 'string', description: 'ACP job ID to receipt' },
        }, required: ['jobId'] }),
        deliverable:   'JSON: jobId, agentId, skill, timestamp, resultHash, signature',
        priceType:     'fixed', priceValue: 0.02, slaMinutes: 5, requiredFunds: false, isHidden: false,
      },
    ],
  },

  {
    id:   '019d755e-dfd0-7b6c-8b4c-21cfbe6fda1c',
    name: 'GSB Alpha Scanner',
    description:
      'Early signal detection agent for crypto markets. Scans on-chain data and DEX activity ' +
      'to find trending tokens, new launches, pre-liquidity setups, volume spikes, and deployer ' +
      'wallet moves before they become public. Returns ranked opportunity lists with reasoning. ' +
      'Hire for: alpha generation, early token discovery, volume spike detection, MEV opportunity ' +
      'scanning, deployer wallet surveillance, pre-liquidity detection, market momentum signals.',
    offerings: [
      {
        name:          'scan_trending',
        description:   'Scan all DEX activity to find the top 5 trending tokens by volume momentum. ' +
                       'Returns token address, name, 1h and 24h volume change, price momentum, ' +
                       'social signal strength, and a momentum score with reasoning.',
        requirements:  JSON.stringify({ type: 'object', properties: {
          chain:  { type: 'string', description: 'Chain to scan: base, ethereum, solana, etc.' },
          limit:  { type: 'number', description: 'Max results (default 5, max 20)' },
        }}),
        deliverable:   'JSON array: token, address, volumeChange1h, volumeChange24h, momentum, socialScore, reasoning',
        priceType:     'fixed', priceValue: 0.10, slaMinutes: 5, requiredFunds: false, isHidden: false,
      },
      {
        name:          'find_new_launches',
        description:   'Find newly launched tokens in the last 24 hours with strong early signals. ' +
                       'Filters out honeypots and instant rugs. Returns contract age, initial liquidity, ' +
                       'early buyer count, dev wallet activity, and an early signal score.',
        requirements:  JSON.stringify({ type: 'object', properties: {
          chain:       { type: 'string', description: 'Chain to scan' },
          maxAgeHours: { type: 'number', description: 'Max token age in hours (default 24)' },
          minLiquidity: { type: 'number', description: 'Min initial liquidity in USD (default 5000)' },
        }}),
        deliverable:   'JSON array: token, address, ageHours, initialLiquidity, earlyBuyers, devActivity, signalScore',
        priceType:     'fixed', priceValue: 0.12, slaMinutes: 5, requiredFunds: false, isHidden: false,
      },
      {
        name:          'detect_volume_spikes',
        description:   'Detect tokens with unusual volume spikes in the last 1 hour across all DEXs. ' +
                       'Returns tokens where volume has increased more than 3x vs the previous hour, ' +
                       'with buy/sell ratio, wallet count, and spike origin classification.',
        requirements:  JSON.stringify({ type: 'object', properties: {
          chain:        { type: 'string', description: 'Chain to monitor' },
          minSpikeMultiplier: { type: 'number', description: 'Min volume increase multiple (default 3)' },
        }}),
        deliverable:   'JSON array: token, address, volumeMultiplier, buySellRatio, walletCount, spikeOrigin',
        priceType:     'fixed', priceValue: 0.12, slaMinutes: 5, requiredFunds: false, isHidden: false,
      },
      {
        name:          'detect_preliquidity',
        description:   'Scan for tokens where liquidity is being staged but the trading pair is not yet public. ' +
                       'Detects early deployer funding patterns, token contract deployments without pools, ' +
                       'and stealth launch preparations. High-alpha, high-risk signals.',
        requirements:  JSON.stringify({ type: 'object', properties: {
          chain: { type: 'string', description: 'Chain to scan' },
        }}),
        deliverable:   'JSON array: token, address, deployerWallet, fundingAmount, estimatedLaunchWindow, riskLevel',
        priceType:     'fixed', priceValue: 0.25, slaMinutes: 8, requiredFunds: false, isHidden: false,
      },
      {
        name:          'watch_deployers',
        description:   'Track known deployer wallets and alert when they fund new contract addresses. ' +
                       'Provide a list of deployer wallet addresses to monitor. Returns any new contract ' +
                       'deployments, funding events, and estimated time to launch.',
        requirements:  JSON.stringify({ type: 'object', properties: {
          deployers: { type: 'array', items: { type: 'string' }, description: 'Deployer wallet addresses to watch' },
          chain:     { type: 'string', description: 'Chain to monitor' },
        }, required: ['deployers'] }),
        deliverable:   'JSON array: deployer, newContract, fundingAmount, deployedAt, estimatedLaunch',
        priceType:     'fixed', priceValue: 0.20, slaMinutes: 5, requiredFunds: false, isHidden: false,
      },
      {
        name:          'scan_chain',
        description:   'General-purpose chain scan for any on-chain activity pattern. Describe what ' +
                       'you are looking for in natural language and the scanner will search for it across ' +
                       'recent blocks. Good for custom alpha strategies and pattern detection.',
        requirements:  JSON.stringify({ type: 'object', properties: {
          chain:  { type: 'string', description: 'Chain to scan' },
          query:  { type: 'string', description: 'Natural language description of what to find' },
        }, required: ['query'] }),
        deliverable:   'JSON: matches (array), reasoning, confidence, recommendedAction',
        priceType:     'fixed', priceValue: 0.10, slaMinutes: 5, requiredFunds: false, isHidden: false,
      },
    ],
  },

  {
    id:   '019d7565-5b56-778e-8550-66ec4b179a81',
    name: 'GSB Thread Writer',
    description:
      'Crypto content and social media agent. Writes engaging Twitter/X threads, alpha reports, ' +
      'market update posts, and token intel summaries. Trained on high-performing crypto content. ' +
      'Can scan on-chain data and turn it into a live post. Fast, opinionated, and built for engagement. ' +
      'Hire for: Twitter threads, alpha reports, market updates, token write-ups, competitive analysis ' +
      'posts, social media content, crypto copywriting, audience growth content.',
    offerings: [
      {
        name:          'write_thread',
        description:   'Write an engaging Twitter/X thread about any crypto topic, token, or market event. ' +
                       'Returns a numbered thread (5-10 tweets) optimised for engagement with hooks, data points, ' +
                       'and a strong closing CTA. Tone: confident, alpha-forward, not hype.',
        requirements:  JSON.stringify({ type: 'object', properties: {
          topic:  { type: 'string', description: 'Thread topic or token name/address' },
          tone:   { type: 'string', description: 'Tone: bullish, bearish, neutral, analytical (default: analytical)' },
          length: { type: 'number', description: 'Number of tweets (default 7, max 15)' },
        }, required: ['topic'] }),
        deliverable:   'Array of tweet strings, ready to post. Each tweet under 280 chars.',
        priceType:     'fixed', priceValue: 0.10, slaMinutes: 5, requiredFunds: false, isHidden: false,
      },
      {
        name:          'write_alpha_report',
        description:   'Write a formatted alpha report for any on-chain opportunity. Pulls live data, ' +
                       'structures it into an intro, thesis, on-chain evidence, risks, and entry/exit guidance. ' +
                       'Returns markdown formatted output ready to share in Telegram or X.',
        requirements:  JSON.stringify({ type: 'object', properties: {
          token:    { type: 'string', description: 'Token name or contract address' },
          chain:    { type: 'string', description: 'Chain (optional — auto-detected if address provided)' },
          context:  { type: 'string', description: 'Additional context or angle for the report (optional)' },
        }, required: ['token'] }),
        deliverable:   'Markdown alpha report: intro, thesis, on-chain evidence, risks, entry/exit guidance',
        priceType:     'fixed', priceValue: 0.15, slaMinutes: 5, requiredFunds: false, isHidden: false,
      },
      {
        name:          'write_market_update',
        description:   'Write a concise market update post summarising current crypto market conditions. ' +
                       'Covers BTC/ETH price action, sector rotation, notable volume moves, and 1-3 ' +
                       'actionable takeaways. Good for daily or weekly social updates.',
        requirements:  JSON.stringify({ type: 'object', properties: {
          format: { type: 'string', description: 'Format: tweet, thread, telegram, newsletter (default: tweet)' },
          focus:  { type: 'string', description: 'Focus area: BTC, ETH, DeFi, NFT, all (default: all)' },
        }}),
        deliverable:   'Market update post in specified format. Includes price action, volume context, key takeaway.',
        priceType:     'fixed', priceValue: 0.10, slaMinutes: 5, requiredFunds: false, isHidden: false,
      },
      {
        name:          'competitive_thread',
        description:   'Research a protocol or token and write a competitive positioning thread comparing ' +
                       'it to its top 3 competitors. Returns a balanced but opinionated take with on-chain ' +
                       'data supporting each claim.',
        requirements:  JSON.stringify({ type: 'object', properties: {
          subject:     { type: 'string', description: 'Protocol, token, or sector to analyse' },
          competitors: { type: 'array', items: { type: 'string' }, description: 'Specific competitors to compare (optional)' },
        }, required: ['subject'] }),
        deliverable:   'Twitter thread: intro, 3 competitor comparisons with data, verdict, CTA',
        priceType:     'fixed', priceValue: 0.15, slaMinutes: 5, requiredFunds: false, isHidden: false,
      },
    ],
  },

  {
    id:   '019d756c-9eba-7600-81ba-f1c78f43277c',
    name: 'GSB Wallet Profiler and DCA ENGINE',
    description:
      'Wallet intelligence and automated DCA trading agent. Profiles any EVM or Solana wallet: ' +
      'full transaction history, current holdings, PnL estimate, smart money classification, ' +
      'and trade pattern analysis. Also executes DCA buy orders on Base via Uniswap v3. ' +
      'Hire for: wallet profiling, copy trading research, smart money detection, whale tracking, ' +
      'DCA execution, portfolio analysis, wallet due diligence, on-chain identity.',
    offerings: [
      {
        name:          'profile_wallet',
        description:   'Full wallet profile across EVM chains and Solana. Returns current holdings, ' +
                       'estimated PnL, top traded tokens, win rate, average hold time, wallet age, ' +
                       'classification (whale/smart money/retail/bot/deployer), and notable recent moves.',
        requirements:  JSON.stringify({ type: 'object', properties: {
          address: { type: 'string', description: 'Wallet address (EVM 0x... or Solana base58)' },
          chain:   { type: 'string', description: 'Chain: base, ethereum, arbitrum, polygon, solana, etc.' },
        }, required: ['address'] }),
        deliverable:   'JSON: holdings, estimatedPnL, winRate, avgHoldTime, walletAge, classification, recentMoves',
        priceType:     'fixed', priceValue: 0.10, slaMinutes: 5, requiredFunds: false, isHidden: false,
      },
      {
        name:          'detect_smart_money',
        description:   'Classify a wallet as smart money based on historical performance. Analyses win rate, ' +
                       'estimated PnL, early entry patterns, exit timing, and cross-chain activity. ' +
                       'Returns a smart money score (0-100) with detailed reasoning.',
        requirements:  JSON.stringify({ type: 'object', properties: {
          address: { type: 'string', description: 'Wallet address' },
          chain:   { type: 'string', description: 'Chain' },
        }, required: ['address', 'chain'] }),
        deliverable:   'JSON: smartMoneyScore, winRate, estimatedPnL, earlyBuys, exitTiming, reasoning',
        priceType:     'fixed', priceValue: 0.20, slaMinutes: 5, requiredFunds: false, isHidden: false,
      },
      {
        name:          'track_wallet',
        description:   'Get the most recent transactions for a wallet with event classification. ' +
                       'Returns last 20 transactions flagged with type (swap/transfer/mint/bridge/stake), ' +
                       'token in/out, USD value, and a notable flag for any high-value or unusual moves.',
        requirements:  JSON.stringify({ type: 'object', properties: {
          address: { type: 'string', description: 'Wallet address' },
          chain:   { type: 'string', description: 'Chain' },
          limit:   { type: 'number', description: 'Max transactions to return (default 20)' },
        }, required: ['address'] }),
        deliverable:   'JSON array: txHash, type, tokenIn, tokenOut, valueUsd, timestamp, notable',
        priceType:     'fixed', priceValue: 0.12, slaMinutes: 5, requiredFunds: false, isHidden: false,
      },
      {
        name:          'dca_buy',
        description:   'Execute a DCA buy order on Base via Uniswap v3. Swaps a specified USDC amount ' +
                       'into any token at current market price with slippage protection. Requires the agent ' +
                       'wallet to hold sufficient USDC. Returns transaction hash and execution price.',
        requirements:  JSON.stringify({ type: 'object', properties: {
          tokenAddress:  { type: 'string', description: 'Token contract address to buy (Base chain)' },
          usdcAmount:    { type: 'number', description: 'USDC amount to spend (e.g. 5.00)' },
          maxSlippagePct:{ type: 'number', description: 'Max slippage % (default 1.0, max 5.0)' },
        }, required: ['tokenAddress', 'usdcAmount'] }),
        deliverable:   'JSON: txHash, tokensBought, executionPrice, slippageActual, gasCostUsd',
        priceType:     'fixed', priceValue: 0.25, slaMinutes: 8, requiredFunds: true, isHidden: false,
      },
    ],
  },

  {
    id:   '019d7568-cd41-7523-9538-e501cc1875cc',
    name: 'GSB CEO Agent',
    description:
      'Orchestrator agent that routes complex multi-step jobs across the entire GSB swarm. ' +
      'The CEO coordinates Token Analyst, Wallet Profiler, Alpha Scanner, and Thread Writer in parallel, ' +
      'synthesises their outputs, and returns a unified result. Best for complex tasks that require ' +
      'multiple data sources or agents working together. ' +
      'Hire for: daily intelligence briefs, multi-agent research, token deep dives, social alpha blasts, ' +
      'restaurant financial triage, swarm orchestration, natural language agent tasks.',
    offerings: [
      {
        name:          'daily_brief',
        description:   'Full morning intelligence brief generated by all 4 worker agents running in parallel. ' +
                       'Covers: top trending tokens, whale wallet moves, new launches, market momentum, ' +
                       'and 3 actionable trade ideas with reasoning. Takes ~3 minutes, worth the wait.',
        requirements:  JSON.stringify({ type: 'object', properties: {
          chains:  { type: 'array', items: { type: 'string' }, description: 'Chains to cover (default: [base, ethereum, solana])' },
          focus:   { type: 'string', description: 'Focus area: DeFi, NFT, memes, all (default: all)' },
        }}),
        deliverable:   'Structured brief: market summary, trending tokens, whale moves, new launches, 3 trade ideas',
        priceType:     'fixed', priceValue: 0.50, slaMinutes: 10, requiredFunds: false, isHidden: false,
      },
      {
        name:          'token_deep_dive',
        description:   'Run Token Analyst + Wallet Profiler in parallel on a single token, then synthesise ' +
                       'a deep-dive report covering price/liquidity, whale holder profiles, smart money ' +
                       'positioning, and a unified investment thesis.',
        requirements:  JSON.stringify({ type: 'object', properties: {
          address: { type: 'string', description: 'Token contract address' },
          chain:   { type: 'string', description: 'Chain' },
        }, required: ['address'] }),
        deliverable:   'Deep-dive report: token metrics, whale profiles, smart money positioning, thesis, verdict',
        priceType:     'fixed', priceValue: 0.35, slaMinutes: 8, requiredFunds: false, isHidden: false,
      },
      {
        name:          'swarm_task',
        description:   'Describe any research, analysis, or content task in natural language. The CEO ' +
                       'will route it to the right agent(s), coordinate the work, and return a synthesised result. ' +
                       'Best for complex or multi-part requests that span multiple agent skills.',
        requirements:  JSON.stringify({ type: 'object', properties: {
          task:    { type: 'string', description: 'Natural language description of what you need' },
          context: { type: 'string', description: 'Additional context (optional)' },
        }, required: ['task'] }),
        deliverable:   'Task-dependent. CEO returns a structured result appropriate to the request.',
        priceType:     'fixed', priceValue: 0.35, slaMinutes: 10, requiredFunds: false, isHidden: false,
      },
      {
        name:          'social_blast',
        description:   'Scan for alpha with Alpha Scanner, then immediately write and return a Twitter thread ' +
                       'with Thread Writer — coordinated by CEO. Full pipeline from chain scan to ready-to-post ' +
                       'content in one job.',
        requirements:  JSON.stringify({ type: 'object', properties: {
          chain: { type: 'string', description: 'Chain to scan for alpha' },
          focus: { type: 'string', description: 'Alpha focus: trending, new_launches, volume_spikes (default: trending)' },
        }}),
        deliverable:   'Array of tweets ready to post + the underlying alpha data that generated them',
        priceType:     'fixed', priceValue: 0.35, slaMinutes: 8, requiredFunds: false, isHidden: false,
      },
      {
        name:          'financial_triage',
        description:   'Restaurant financial triage service. Upload bank statement and POS export data. ' +
                       'Returns: full burn rate analysis, cash flow projection, vendor credit request letter, ' +
                       'and bank loan request letter. Operated by MCFL Restaurant Holdings LLC.',
        requirements:  JSON.stringify({ type: 'object', properties: {
          bankStatementUrl: { type: 'string', description: 'URL to bank statement file (CSV/XLS)' },
          posExportUrl:     { type: 'string', description: 'URL to POS export file (optional)' },
          businessName:     { type: 'string', description: 'Restaurant or business name' },
        }, required: ['bankStatementUrl', 'businessName'] }),
        deliverable:   'Three documents: Financial Analysis Report, Vendor Credit Letter, Bank Loan Request Letter',
        priceType:     'fixed', priceValue: 24.95, slaMinutes: 5, requiredFunds: false, isHidden: false,
      },
      {
        name:          'bank_status_report',
        description:   'Instant swarm health report: all worker agents status, jobs served today, ' +
                       'active clients, skill confidence scores, and Railway backend status.',
        requirements:  '{}',
        deliverable:   'JSON: agentStatuses, jobsServedToday, activeClients, skillScores, railwayStatus',
        priceType:     'fixed', priceValue: 0.05, slaMinutes: 5, requiredFunds: false, isHidden: false,
      },
      {
        name:          'local_intel_query',
        description:   'Hyperlocal business intelligence for any covered US zip code. ' +
                       'Returns active businesses with name, category, address, coordinates, phone, website, hours, ' +
                       'and confidence score. Filter by zip, category group (food/retail/health/finance/civic), or free-text search. ' +
                       'Also returns spending zone data: population, median income, home values, rent vs own ratios. ' +
                       'Currently covers 32081 (Nocatee FL) and 32082 (Ponte Vedra Beach FL). ' +
                       'Data sources: OpenStreetMap, US Census ACS, SJC public records. ' +
                       'Hire for: local market research, competitor mapping, real estate intelligence, ' +
                       'chamber of commerce directories, volunteer economy apps, map data feeds.',
        requirements:  JSON.stringify({ type: 'object', properties: {
          zip:          { type: 'string', description: 'Zip code to query (32081 or 32082)' },
          query:        { type: 'string', description: 'Free-text search (name, category, address)' },
          group:        { type: 'string', enum: ['food','retail','health','finance','civic','services','other'], description: 'Category group filter' },
          category:     { type: 'string', description: 'Specific OSM category (e.g. restaurant, dentist, bank)' },
          limit:        { type: 'number', description: 'Max results (default 50, max 200)' },
          minConfidence:{ type: 'number', description: 'Minimum confidence score 0-100 (default 0)' },
          includeZones: { type: 'boolean', description: 'Include spending zone data in response (default true)' },
        }}),
        deliverable:   'JSON: { total, results: [{name, category, zip, lat, lon, address, phone, website, hours, confidence, sources}], zones: {population, medianIncome, homeValue, rentVsOwn} }',
        priceType:     'fixed', priceValue: 0.05, slaMinutes: 5, requiredFunds: false, isHidden: false,
      },
    ],
  },
];

// ── Upsert offerings for one agent ────────────────────────────────────────────
async function upsertOfferings(agent, token) {
  // Offerings are embedded in agent detail — fetch from there
  const detailRes = await fetch(`${ACP}/agents/${agent.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const detail = detailRes.ok ? await detailRes.json() : {};
  const existing = (detail.data || detail)?.offerings || [];
  const existingByName = Object.fromEntries(existing.map(o => [o.name, o]));

  let created = 0, updated = 0, skipped = 0;

  for (const offering of agent.offerings) {
    const exists = existingByName[offering.name];

    if (exists) {
      // Update description + deliverable (price/sla preserved)
      const patch = await fetch(`${ACP}/agents/${agent.id}/offerings/${exists.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:          offering.name,
          description:   offering.description,
          deliverable:   offering.deliverable,
          requirements:  offering.requirements,
          priceType:     offering.priceType,
          priceValue:    offering.priceValue,
          slaMinutes:    offering.slaMinutes,
          requiredFunds: offering.requiredFunds,
          isHidden:      offering.isHidden,
        }),
      });
      if (patch.ok) { updated++; }
      else {
        const err = await patch.text();
        console.warn(`  ⚠️  update ${offering.name}: ${patch.status} ${err.slice(0,100)}`);
        skipped++;
      }
    } else {
      // Create new offering
      const create = await fetch(`${ACP}/agents/${agent.id}/offerings`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:          offering.name,
          description:   offering.description,
          deliverable:   offering.deliverable,
          requirements:  offering.requirements,
          priceType:     offering.priceType,
          priceValue:    offering.priceValue,
          slaMinutes:    offering.slaMinutes,
          requiredFunds: offering.requiredFunds,
          isHidden:      offering.isHidden,
        }),
      });
      if (create.ok) { created++; }
      else {
        const err = await create.text();
        console.warn(`  ⚠️  create ${offering.name}: ${create.status} ${err.slice(0,100)}`);
        skipped++;
      }
    }
  }

  return { created, updated, skipped };
}

// ── Update agent description ──────────────────────────────────────────────────
async function updateAgentDescription(agent, token) {
  // Fetch current agent to preserve name + imageUrl (PUT requires full object)
  const cur = await (await fetch(`${ACP}/agents/${agent.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  const current = cur.data || cur;
  const res = await fetch(`${ACP}/agents/${agent.id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name:        current.name,
      description: agent.description,
      imageUrl:    current.imageUrl || undefined,
    }),
  });
  return res.ok;
}

// ── Main entry point ───────────────────────────────────────────────────────────
async function registerOfferings() {
  const token = await getValidToken();

  if (!token) {
    console.log('[acpOfferings] No valid ACP token — skipping offering registration.');
    console.log('[acpOfferings] See acpAuth.js instructions above to set VIRTUALS_PRIVY_REFRESH_TOKEN in Railway.');
    return;
  }

  console.log('[acpOfferings] Registering ACP offerings for all GSB agents...\n');

  for (const agent of AGENTS) {
    console.log(`  ${agent.name}`);

    // Update description
    const descOk = await updateAgentDescription(agent, token);
    if (!descOk) console.warn(`    ⚠️  description update failed`);

    // Upsert offerings
    const { created, updated, skipped } = await upsertOfferings(agent, token);
    console.log(`    ✅ created=${created} updated=${updated} skipped=${skipped}`);

    // Throttle to avoid rate limiting
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n[acpOfferings] Done. All agents now fully discoverable via acp browse.\n');
}

module.exports = { registerOfferings };
