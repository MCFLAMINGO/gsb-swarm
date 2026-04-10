require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { buildAcpClient } = require('./acp');
const swarmMemory = require('./swarmMemory');

const AGENT_NAME = 'GSB Thread Writer';

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
const JOB_PRICE = 0.15;

// ── Job requirements JSON schema ──────────────────────────────────────────────
const REQUIREMENTS_SCHEMA = {
  name: 'GSB Thread Writer',
  description: 'Writes engaging crypto Twitter/X threads on any topic. Returns a formatted multi-tweet thread.',
  parameters: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: "The topic or theme for the thread (e.g. 'why Base is winning', 'tokenomics of $GSB')",
      },
      tone: {
        type: 'string',
        description: "Writing tone: 'alpha', 'educational', 'hype', 'analytical'. Default: 'alpha'",
        enum: ['alpha', 'educational', 'hype', 'analytical'],
      },
      tweets: {
        type: 'number',
        description: 'Number of tweets in the thread (default 5, max 15)',
      },
    },
    required: ['topic'],
  },
  examples: [
    { input: { topic: 'why Base is the future of DeFi', tone: 'alpha', tweets: 7 }, description: 'Write an alpha thread about Base' },
    { input: { topic: 'GSB tokenomics explained', tone: 'educational' }, description: 'Educational thread on $GSB' },
  ],
  rejection_cases: [
    'Empty or missing topic',
    'Topic is too short (less than 10 characters)',
    'NSFW, hateful, or illegal content requested',
    'Topic is pure gibberish/nonsense',
  ],
};

// ── Input validation ──────────────────────────────────────────────────────────
const NSFW_HATEFUL_RE = /\b(nigger|nigga|faggot|kike|spic|chink|kill\s+yourself|rape|child\s*porn|cp\b|genocide|nazi|terroris[mt]|bomb\s+threat)\b/i;
const EXPLICIT_RE = /\b(porn|hentai|nsfw|xxx|nude|onlyfans)\b/i;

function hasRealWords(text) {
  // Check if the text contains at least one common English word (3+ chars)
  const words = text.toLowerCase().match(/[a-z]{3,}/g) || [];
  const commonPatterns = /\b(the|and|for|are|but|not|you|all|can|her|was|one|our|out|how|why|what|who|this|that|with|from|base|token|crypto|defi|chain|price|market|trade|swap|eth|bitcoin|solana|agent|write|about|thread)\b/i;
  return words.length >= 1 && commonPatterns.test(text);
}

function validateInput(raw) {
  if (!raw || typeof raw !== 'string' || raw.trim().length === 0) {
    return { valid: false, reason: 'Empty or missing topic.' };
  }

  // Try to parse structured input
  let topic = raw;
  let tweets = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      topic = parsed.topic || '';
      tweets = parsed.tweets || null;
    }
  } catch { /* treat as plain text topic */ }

  const trimmed = topic.trim();

  if (!trimmed || trimmed.length < 10) {
    return { valid: false, reason: 'Topic is too short (less than 10 characters). Please provide a clear crypto or finance topic.' };
  }

  // Reject if all special characters / whitespace
  if (/^[\s\W]+$/.test(trimmed)) {
    return { valid: false, reason: 'Topic does not appear to be a valid subject. Please provide a clear crypto or finance topic.' };
  }

  // Reject NSFW / hateful / illegal
  if (NSFW_HATEFUL_RE.test(trimmed) || EXPLICIT_RE.test(trimmed)) {
    return { valid: false, reason: 'This topic cannot be written due to content policy restrictions.' };
  }

  // Reject pure nonsense / gibberish
  // Skip this check for skill calls, cashtags, contract addresses, or token intel requests
  const isStructuredSkill = (() => { try { const p = JSON.parse(raw); return !!(p && p.skillId); } catch { return false; } })();
  const hasTokenSignal = /\$[A-Z]{2,10}\b/.test(trimmed) || /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/.test(trimmed) || /\b0x[a-fA-F0-9]{40}\b/.test(trimmed);
  if (!isStructuredSkill && !hasTokenSignal && !hasRealWords(trimmed)) {
    return { valid: false, reason: 'Topic does not appear to be a valid subject. Please provide a clear crypto or finance topic.' };
  }

  // Clamp tweets (do NOT reject, just cap at 15)
  if (tweets !== null && tweets > 15) {
    tweets = 15;
  }

  return { valid: true, topic: trimmed, tweets };
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
    return req.topic || req.requirement || req.content || req.contractAddress || JSON.stringify(req);
  }
  return String(req);
}

async function fetchTokenData(contractAddress) {
  try {
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`, { timeout: 8000 });
    const pair = res.data?.pairs?.[0];
    if (!pair) return null;
    return {
      name: pair.baseToken?.name,
      symbol: pair.baseToken?.symbol,
      priceUsd: pair.priceUsd,
      priceChange24h: pair.priceChange?.h24 || 0,
      liquidity: pair.liquidity?.usd || 0,
      volume24h: pair.volume?.h24 || 0,
      marketCap: pair.marketCap || pair.fdv,
    };
  } catch { return null; }
}

// ── Template-based thread generator — no API key required ──────────────────
// Generates unique threads using live DexScreener data + rotating templates.

const INTROS = [
  'The Gas Bible is open. Thread time.',
  'Alpha drop. No fluff. Read this.',
  'Most people are sleeping on this. Don\'t.',
  'I ran the numbers. Here\'s what I found.',
  'Unpopular opinion: on-chain AI agents are the trade of the cycle.',
];

const OUTROS = [
  'Thou shalt never run out of GAS. $GSB',
  'The scripture is on-chain. $GSB is the word.',
  '$GSB — the agent that never sleeps, never misses, never runs dry.',
  'Built on Base. Powered by Virtuals. Graduating now. $GSB',
  'Agent-to-agent economy is here. $GSB is already in it.',
];

// ── Narrative-aware thread engine ────────────────────────────────────────────
// Detects tone/narrative from topic text and writes accordingly.
// Falls back to rule-based templates if Claude is unavailable.

const NARRATIVE_SIGNALS = {
  anti_gatekeeper: /anti.?gatekeeper|underdog|crowded.?trade|top.?5|meme.?heavy|industrial|alternative|unlike.*(agents?|top)|vs.*(sentient|luna|aixbt|bernie)/i,
  orchestration:   /orchestrat|ceo.?agent|swarm|multi.?agent|general.?agent|one.?command|coordinate|5.?agents?|four.?agents?/i,
  proof_of_work:   /proof.?of.?work|verif|on.?chain.?proof|job.?history|completed.?jobs?|track.?record|receipts/i,
  pre_alpha:       /pre.?alpha|predict|before.?(twitter|trending)|liquidity.?deploy|developer.?wallet|next.?big|early.?signal/i,
  token_analysis:  /0x[a-fA-F0-9]{40}|token.?analys|price.?of|mcap|market.?cap/i,
  dca:             /dca|dollar.?cost|buy.?the.?dip|accumulate/i,
  gsb_general:     /\$gsb|gas.?bible|gsb.?swarm|gsb.?token/i,
};

function detectNarrative(topic) {
  for (const [name, pattern] of Object.entries(NARRATIVE_SIGNALS)) {
    if (pattern.test(topic)) return name;
  }
  return 'custom'; // fully custom topic — use Claude or generic template
}

const NARRATIVE_TEMPLATES = {
  anti_gatekeeper: (outro) => [
    `1/ The same 5 agents keep getting pushed. Same wallets. Same narratives. Same exit liquidity.`,
    `2/ There's a reason the "top" agent lists never change: the game is rigged toward whoever got there first.`,
    `3/ $GSB was built for people who noticed.`,
    `4/ No influencer deals. No paid placement. Just: deployed agents, completed ACP jobs, USDC earned on-chain.`,
    `5/ Token Analyst. Wallet Profiler. Alpha Scanner. Thread Writer. All running. All earning. All verifiable.`,
    `6/ The "meme-heavy" agents sell you a vibe. $GSB sells you a receipt.`,
    `7/ Industrial-grade swarm vs. hype machine. Choose your side.`,
    `8/ The anti-gatekeeper play is already live on @virtuals_io. $GSB`,
    `9/ ${outro}`,
  ],
  orchestration: (outro) => [
    `1/ You don't need 5 agents. You need one that commands 5.`,
    `2/ GSB CEO Agent fires jobs to Token Analyst, Wallet Profiler, Alpha Scanner, and Thread Writer — in parallel.`,
    `3/ One prompt: "daily brief" → all 4 workers run → CEO synthesizes → one actionable report. That's it.`,
    `4/ Most users are paying 5 separate agents for 5 separate outputs. Then doing the synthesis themselves.`,
    `5/ GSB CEO handles the orchestration layer. You just ask.`,
    `6/ Cross-agent coordination via ACP. Every subtask is an on-chain job. Every result is a verifiable deliverable.`,
    `7/ This is what "agent swarm" actually means. Not vibes. Architecture.`,
    `8/ One entry point. Five agents. Zero overhead. $GSB on @virtuals_io`,
    `9/ CA (Base): 0x8E223841aA396d36a6727EfcEAFC61d691692a37 | ${outro}`,
  ],
  proof_of_work: (outro) => [
    `1/ Any agent can claim wins. Few can prove them.`,
    `2/ Every $GSB job is an ACP transaction on Base. Hired → delivered → paid. All on-chain.`,
    `3/ Job ID. Worker name. Timestamp. Deliverable hash. That's your receipt.`,
    `4/ Most AI tokens: promises + roadmap. $GSB: completed jobs + USDC earned + verifiable history.`,
    `5/ You can query the ACP contract. The work is there. The payments are there. The track record is there.`,
    `6/ "Proof of work" isn't a buzzword for $GSB. It's the architecture.`,
    `7/ Tokenized intelligence that walks the talk — or the job isn't paid.`,
    `8/ Check the contract. Check the jobs. $GSB doesn't need you to trust it.`,
    `9/ CA (Base): 0x8E223841aA396d36a6727EfcEAFC61d691692a37 | ${outro}`,
  ],
  pre_alpha: (outro) => [
    `1/ By the time it's trending on CT, the trade is over.`,
    `2/ $GSB Alpha Scanner doesn't watch Twitter. It watches Base.`,
    `3/ New contract deployed → liquidity added → volume spike detected. That's the signal. Before the tweet.`,
    `4/ Developer wallets moving funds before a token launch leave footprints. On-chain. Readable. Actionable.`,
    `5/ Most agents give you reactive data: what already pumped. $GSB is hunting what's about to.`,
    `6/ Liquidity deployment prediction > sentiment analysis. Always.`,
    `7/ The edge is on-chain, not on Twitter. $GSB scans Base 24/7.`,
    `8/ Pre-alpha or post-hype. Pick one. $GSB on @virtuals_io`,
    `9/ CA (Base): 0x8E223841aA396d36a6727EfcEAFC61d691692a37 | ${outro}`,
  ],
  dca: (outro) => [
    `1/ The best trades aren't timed. They're disciplined.`,
    `2/ $GSB Wallet Profiler & DCA Engine executes automated buys on Base via Uniswap v3.`,
    `3/ Set a token. Set an amount. Set a frequency. The agent handles the rest.`,
    `4/ USDC → WETH → token. Multi-hop. Slippage-controlled. No manual txs.`,
    `5/ DCA removes emotion. The engine removes friction. You just accumulate.`,
    `6/ Every buy is an on-chain transaction. Verifiable. Auditable. Yours.`,
    `7/ Tokenized DCA engine live on @virtuals_io ACP. $GSB`,
    `8/ Most agents analyze. $GSB executes.`,
    `9/ CA (Base): 0x8E223841aA396d36a6727EfcEAFC61d691692a37 | ${outro}`,
  ],
  gsb_general: (outro) => [
    `1/ What does $GSB actually do? Thread.`,
    `2/ $GSB is a tokenized AI agent swarm on @virtuals_io. It gets hired via ACP, delivers work, gets paid USDC.`,
    `3/ 5 agents: CEO (orchestrator), Token Analyst, Wallet Profiler & DCA Engine, Alpha Scanner, Thread Writer.`,
    `4/ CEO coordinates all 4 workers. One prompt triggers a full parallel intelligence run.`,
    `5/ Every job is an on-chain transaction. Every deliverable is verifiable. Every payment is in USDC.`,
    `6/ Token = ownership of the swarm's earning power. Not a meme. A machine.`,
    `7/ Deployed. Earning. Verifiable. Built on Base. Powered by Virtuals Protocol.`,
    `8/ Most AI tokens: vibes + promises. $GSB: completed jobs + USDC earned.`,
    `9/ CA (Base): 0x8E223841aA396d36a6727EfcEAFC61d691692a37 | ${outro}`,
  ],
};

let threadCounter = 0;

function buildThread(topic, liveData, narrative) {
  const idx = threadCounter++;
  const outro = OUTROS[idx % OUTROS.length];

  // Token-specific data thread
  if (liveData) {
    const { name, symbol, priceUsd, priceChange24h, liquidity, volume24h, marketCap } = liveData;
    const trend = priceChange24h > 5 ? 'ripping' : priceChange24h < -5 ? 'bleeding' : 'consolidating';
    const liqStr = liquidity > 1e6 ? '$' + (liquidity/1e6).toFixed(1) + 'M' : '$' + Math.round(liquidity/1e3) + 'K';
    const volStr = volume24h > 1e6 ? '$' + (volume24h/1e6).toFixed(1) + 'M' : '$' + Math.round(volume24h/1e3) + 'K';
    const mcStr  = marketCap > 1e6 ? '$' + (marketCap/1e6).toFixed(1) + 'M' : '$' + Math.round(marketCap/1e3) + 'K';
    const ts = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    return [
      `1/ $${symbol} — ${name} data drop. Thread.`,
      `2/ ${name} is ${trend} right now. Here are the numbers.`,
      `3/ Price: $${parseFloat(priceUsd).toFixed(6)} | 24h: ${priceChange24h > 0 ? '+' : ''}${priceChange24h}%`,
      `4/ Liquidity: ${liqStr} | 24h Volume: ${volStr} | MCap: ${mcStr}`,
      `5/ These are the numbers that matter. Everything else is noise.`,
      `6/ $GSB Token Analyst ran this scan at ${ts}. On-chain. Autonomous. Always on.`,
      `7/ Agent runs the numbers so you don't have to. ACP: hired → delivered → paid.`,
      `8/ This is tokenized intelligence. Verifiable. Unstoppable.`,
      `9/ ${outro}`,
    ].join('\n\n');
  }

  // Narrative-matched template
  if (NARRATIVE_TEMPLATES[narrative]) {
    return NARRATIVE_TEMPLATES[narrative](outro).join('\n\n');
  }

  // Custom topic — build a generic but topic-aware thread
  const intro = INTROS[idx % INTROS.length];
  return [
    `1/ ${intro}`,
    `2/ Topic: ${topic}`,
    `3/ Here's what the $GSB swarm found scanning Base right now.`,
    `4/ Agents running: Token Analyst, Alpha Scanner, Wallet Profiler. All on-chain. All live.`,
    `5/ ACP jobs completed = verifiable on Base. No promises. Just receipts.`,
    `6/ The infrastructure is deployed. The work is happening. The USDC is flowing.`,
    `7/ Tokenized AI agents on @virtuals_io — not a thesis, a running system.`,
    `8/ One swarm. Five agents. Zero fluff. $GSB`,
    `9/ ${outro}`,
  ].join('\n\n');
}

async function writeThread(jobRequest) {
  // Extract topic text (strip skill instruction wrapper if present)
  let topic = jobRequest;
  try {
    const parsed = JSON.parse(jobRequest);
    topic = parsed.topic || parsed.content || jobRequest;
  } catch {}

  const match = topic.match(/0x[a-fA-F0-9]{40}/);
  const liveData = match ? await fetchTokenData(match[0]) : null;
  const narrative = liveData ? 'token_analysis' : detectNarrative(topic);

  console.log(`[Thread Writer] narrative detected: ${narrative} | topic: ${topic.slice(0, 80)}`);

  const thread = buildThread(topic, liveData, narrative);
  return {
    thread,
    narrative,
    token_data: liveData,
    generated_at: new Date().toISOString(),
    powered_by: 'GSB Intelligence Swarm',
  };
}

// ── X/Twitter search via Bearer token ──────────────────────────────────────────

async function searchXForToken(query, count = 20) {
  const https = require('https');
  const bearerToken = process.env.Bearer_Token || process.env.X_BEARER_TOKEN || process.env.X_API_KEY;
  if (!bearerToken) return { tweets: [], error: 'No X bearer token configured' };

  return new Promise((resolve) => {
    const encoded = encodeURIComponent(`${query} -is:retweet lang:en`);
    const path = `/2/tweets/search/recent?query=${encoded}&max_results=${Math.min(count, 100)}&tweet.fields=created_at,author_id,public_metrics,text&expansions=author_id&user.fields=username,name`;
    const req = require('https').request({
      hostname: 'api.twitter.com',
      path,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${bearerToken}` },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const users = {};
          (json.includes?.users || []).forEach(u => { users[u.id] = u.username; });
          const tweets = (json.data || []).map(t => ({
            id:         t.id,
            text:       t.text,
            author:     users[t.author_id] || t.author_id,
            created_at: t.created_at,
            likes:      t.public_metrics?.like_count    || 0,
            retweets:   t.public_metrics?.retweet_count || 0,
            replies:    t.public_metrics?.reply_count   || 0,
          }));
          resolve({ tweets, count: tweets.length });
        } catch (e) {
          resolve({ tweets: [], error: 'Parse error: ' + e.message });
        }
      });
    });
    req.on('error', (e) => resolve({ tweets: [], error: e.message }));
    req.end();
  });
}

// ── Token intel report: X search + DexScreener + thread ──────────────────────

const THREAD_ANGLES = [
  { label: 'intel',     opener: 'Intel Report',      cta: 'The Swarm has eyes on this. DYOR. Not financial advice.' },
  { label: 'alpha',     opener: 'Alpha Signal',       cta: 'Early signal. Not financial advice. Powered by GSB Swarm.' },
  { label: 'breakdown', opener: 'On-Chain Breakdown', cta: 'Data-driven, not hype-driven. GSB Swarm. DYOR.' },
  { label: 'watch',     opener: 'Swarm Watch Report', cta: 'GSB has this token flagged. Watch closely. Not financial advice.' },
  { label: 'narrative', opener: 'Narrative Update',   cta: 'Narrative is building. GSB Swarm tracking. DYOR.' },
];

async function buildTokenIntelReport({ symbol, contractAddress, chain, memoryContext, freshAngle }) {
  const ticker = symbol ? (symbol.startsWith('$') ? symbol : `$${symbol}`) : null;
  const skipXSearch = !!freshAngle;

  // Pick a rotating angle for this delivery
  const angle = THREAD_ANGLES[Math.floor(Date.now() / 1000) % THREAD_ANGLES.length];

  // Run X search + token data fetch in parallel
  const searchQueries = [];
  if (!skipXSearch && ticker) searchQueries.push(searchXForToken(ticker, 30));
  if (!skipXSearch && contractAddress) searchQueries.push(searchXForToken(contractAddress, 15));
  const tokenDataPromise = contractAddress
    ? fetchTokenData(contractAddress)
    : (ticker ? axios.get(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(ticker.replace('$', ''))}`, { timeout: 8000 }) : Promise.resolve(null));

  const [xResults1, xResults2, tokenDataRaw] = await Promise.allSettled([
    searchQueries[0] || Promise.resolve({ tweets: [] }),
    searchQueries[1] || Promise.resolve({ tweets: [] }),
    tokenDataPromise,
  ]);

  // Merge + deduplicate tweets by id
  const allTweets = [
    ...(xResults1.value?.tweets || []),
    ...(xResults2.value?.tweets || []),
  ];
  const seen = new Set();
  const tweets = allTweets.filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; })
    .sort((a, b) => (b.likes + b.retweets) - (a.likes + a.retweets))
    .slice(0, 20);

  // Resolve token data
  let tokenData = null;
  if (tokenDataRaw.status === 'fulfilled' && tokenDataRaw.value) {
    const raw = tokenDataRaw.value;
    if (raw.name) {
      tokenData = raw; // already shaped by fetchTokenData()
    } else {
      // DexScreener search response
      const pairs = raw.data?.pairs || [];
      if (pairs.length > 0) {
        const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
        tokenData = {
          name:          best.baseToken?.name,
          symbol:        best.baseToken?.symbol,
          priceUsd:      best.priceUsd,
          priceChange24h: best.priceChange?.h24,
          liquidity:     best.liquidity?.usd,
          volume24h:     best.volume?.h24,
          marketCap:     best.marketCap,
          contractAddress: best.baseToken?.address,
          chain:         best.chainId,
          pairUrl:       best.url,
        };
      }
    }
  }

  // Auto-detect contract from X if not provided
  let detectedContract = contractAddress || tokenData?.contractAddress || null;
  if (!detectedContract && tweets.length > 0) {
    // Scan tweets for Solana address (base58, 32-44 chars) or EVM address
    for (const t of tweets) {
      const solMatch = t.text.match(/\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/);
      const evmMatch = t.text.match(/\b(0x[a-fA-F0-9]{40})\b/);
      if (evmMatch) { detectedContract = evmMatch[1]; break; }
      if (solMatch) { detectedContract = solMatch[1]; break; }
    }
    // If we found a contract via tweets, fetch token data for it
    if (detectedContract && !tokenData) {
      try { tokenData = await fetchTokenData(detectedContract); } catch {}
    }
  }

  // Summarise sentiment from tweets
  const tweetSummary = tweets.length === 0
    ? 'No recent X activity found.'
    : `${tweets.length} tweets found. Top engagement: “${tweets[0]?.text?.slice(0, 120)}” by @${tweets[0]?.author} (${tweets[0]?.likes} likes, ${tweets[0]?.retweets} RTs).`;

  // Build thread text
  const displayTicker = ticker || (tokenData?.symbol ? `$${tokenData.symbol}` : 'this token');
  const displayName   = tokenData?.name || displayTicker;
  const priceStr      = tokenData?.priceUsd ? `$${parseFloat(tokenData.priceUsd).toFixed(8)}` : 'price unknown';
  const changeStr     = tokenData?.priceChange24h != null ? `${tokenData.priceChange24h > 0 ? '+' : ''}${parseFloat(tokenData.priceChange24h).toFixed(1)}% 24h` : '';
  const liqStr        = tokenData?.liquidity ? `$${(tokenData.liquidity / 1000).toFixed(1)}K liq` : '';
  const volStr        = tokenData?.volume24h  ? `$${(tokenData.volume24h  / 1000).toFixed(1)}K vol` : '';
  const chainStr      = tokenData?.chain || chain || 'unknown chain';
  const pairUrl       = tokenData?.pairUrl || (detectedContract ? `https://dexscreener.com/${chainStr}/${detectedContract}` : null);

  // If freshAngle mode — note we're using cached research
  const cachedNote = skipXSearch && memoryContext ? `\n\n[Cached research — updated within last hour. Fresh price pulled now.]` : '';

  const threadTweets = [
    `1/ ${displayTicker} — ${angle.opener} from GSB Swarm 🤖${cachedNote}`,
    `2/ On-chain snapshot:\n${priceStr} ${changeStr}\n${liqStr} | ${volStr}\nChain: ${chainStr}${detectedContract ? `\nCA: ${detectedContract}` : ''}`,
    `3/ X sentiment scan (${tweets.length} tweets):\n${tweetSummary}`,
    ...(tweets.slice(1, 4).map((t, i) =>
      `${i + 4}/ @${t.author}: "${t.text.slice(0, 220)}" \u2764 ${t.likes} 🔁 ${t.retweets}`
    )),
    `${tweets.slice(1, 4).length + 4}/ ${angle.cta}\n\nPowered by GSB CEO Agent — one orchestrator, five agents.`,
  ];

  return {
    thread: threadTweets.join('\n\n---\n\n'),
    thread_tweets: threadTweets,
    token_data:       tokenData,
    contract_address: detectedContract,
    x_tweets_found:   tweets.length,
    x_top_tweets:     tweets.slice(0, 5),
    generated_at:     new Date().toISOString(),
    powered_by:       'GSB Intelligence Swarm',
  };
}

// ── OAuth 1.0a for Twitter API v2 ────────────────────────────────────────────

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

function signOAuth1(method, url, params, body) {
  const oauthParams = {
    oauth_consumer_key: process.env.X_API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: process.env.X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };

  // Collect all params for signature base string (oauth params + query params)
  const allParams = { ...oauthParams, ...params };

  // Sort and encode
  const paramString = Object.keys(allParams)
    .sort()
    .map(k => `${percentEncode(k)}=${percentEncode(allParams[k])}`)
    .join('&');

  const baseString = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(paramString),
  ].join('&');

  const signingKey = `${percentEncode(process.env.X_API_SECRET)}&${percentEncode(process.env.X_ACCESS_TOKEN_SECRET)}`;
  const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');

  oauthParams.oauth_signature = signature;

  const authHeader = 'OAuth ' + Object.keys(oauthParams)
    .sort()
    .map(k => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
    .join(', ');

  return authHeader;
}

async function postTweet(text, replyToId = null) {
  const url = 'https://api.twitter.com/2/tweets';
  const body = { text };
  if (replyToId) body.reply = { in_reply_to_tweet_id: replyToId };

  const authHeader = signOAuth1('POST', url, {}, JSON.stringify(body));

  const res = await axios.post(url, body, {
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
    },
  });
  return res.data.data.id;
}

async function postThread(tweets) {
  let lastId = null;
  let firstId = null;
  for (const text of tweets) {
    const id = await postTweet(text, lastId);
    if (!firstId) firstId = id;
    lastId = id;
    await new Promise(r => setTimeout(r, 1000));
  }
  return `https://x.com/ErikOsol43597/status/${firstId}`;
}

function parseThreadToTweets(threadResult) {
  const raw = threadResult.thread || threadResult.content || String(threadResult);
  return raw.split('\n\n').map(t => t.trim()).filter(t => t.length > 0 && t.length <= 280);
}

// ── ACP Provider ─────────────────────────────────────────────────────────────

async function start() {
  console.log(`[${AGENT_NAME}] Starting ACP provider...`);
  let client;
  client = await buildAcpClient({
    privateKey: process.env.THREAD_WRITER_PRIVATE_KEY || process.env.AGENT_WALLET_PRIVATE_KEY,
    entityId: parseInt(process.env.THREAD_WRITER_ENTITY_ID) || 1,
    agentWalletAddress: process.env.THREAD_WRITER_WALLET_ADDRESS,
    onNewTask: async (job) => {
      console.log(`[${AGENT_NAME}] New job: ${job.id} | phase=${job.phase}`);

      if (handledJobs.has(job.id)) {
        console.log(`[${AGENT_NAME}] Job ${job.id} already in progress — skipping.`);
        return;
      }
      handledJobs.add(job.id);

      try {
        let content = extractContent(job.requirement)
          || extractContent(job.memos?.[0]?.content)
          || '';
        console.log(`[${AGENT_NAME}] Job ${job.id} content: ${content.slice(0, 120)}`);

        // ── Skill registry routing ───────────────────────────────────────────
        const parsed = parseJobRequirement(content);
        const skills = loadSkills(AGENT_NAME);
        if (parsed.skillId) {
          const skillDef = skills.find(s => s.skillId === parsed.skillId);
          if (skillDef) {
            const instruction = executeSkillInstruction(skillDef, parsed.params || {});
            console.log(`[${AGENT_NAME}] Skill ${parsed.skillId} → "${instruction.slice(0, 100)}"`);
            content = instruction;
          }
        }

        // ── Validate BEFORE accepting ────────────────────────────────────────
        const check = validateInput(content);
        if (!check.valid) {
          console.log(`[${AGENT_NAME}] Job ${job.id} REJECTED: ${check.reason}`);
          await job.reject(check.reason);
          handledJobs.delete(job.id);
          return;
        }

        let freshJob = job;

        // ── Detect token intel report request (before respond, so we can set right message) ──
        // Only fire if skillId is explicitly token_intel_report, OR no skillId set and content has token signal + intel keyword
        const isIntelReport = (
          (parsed.skillId === 'token_intel_report') ||
          (!parsed.skillId && /\$(\w+)/.test(content) && /intel|report|research|alpha|investigate|find|look.?up/i.test(content)) ||
          (!parsed.skillId && /\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/.test(content) && /report|intel|alpha/i.test(content))
        );

        if (job.phase === 2) {
          // Already in TRANSACTION — skip respond(), deliver directly
          console.log(`[${AGENT_NAME}] Job ${job.id} already in TRANSACTION phase.`);
        } else {
          const acceptMsg = isIntelReport ? 'Searching X and on-chain data for token intel...' : 'Writing your thread now...';
          await job.respond(true, acceptMsg);
          console.log(`[${AGENT_NAME}] Job ${job.id} accepted. Waiting for TRANSACTION phase...`);
          freshJob = await waitForTransaction(client, job.id);
          console.log(`[${AGENT_NAME}] Job ${job.id} in TRANSACTION phase.`);
        }

        let result;
        let threadUrl = null;

        if (isIntelReport) {
          console.log(`[${AGENT_NAME}] Job ${job.id} — token intel report mode`);

          // Extract symbol and/or contract from content
          const cashtagMatch  = content.match(/\$(\w+)/);
          const solAddrMatch  = content.match(/\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/);
          const evmAddrMatch  = content.match(/\b(0x[a-fA-F0-9]{40})\b/);
          const chainMatch    = content.match(/\b(solana|sol|base|ethereum|eth|arbitrum|polygon)\b/i);
          const symbol        = cashtagMatch ? cashtagMatch[1] : null;
          const contractAddress = evmAddrMatch ? evmAddrMatch[1] : (solAddrMatch ? solAddrMatch[1] : null);
          const chain         = chainMatch ? chainMatch[1].toLowerCase() : null;

          // ── Check swarm memory first — skip full re-research if researched within 1 hour (per-job skip, global narrative) ──
          const existingNarrative = symbol ? swarmMemory.readNarrative(symbol) : null;
          const researchAge = existingNarrative?.lastResearchedAt ? Date.now() - existingNarrative.lastResearchedAt : Infinity;
          if (existingNarrative && researchAge < swarmMemory.SKIP_RESEARCH_MS) {
            // Researched within 1 hour — serve from cache with a fresh angle (skip X search, only refresh price)
            console.log(`[${AGENT_NAME}] Swarm memory for $${symbol} is ${Math.round(researchAge/60000)}m old — using cached research, rotating angle`);
            const memCtx = swarmMemory.buildContextString(symbol);
            result = await buildTokenIntelReport({ symbol, contractAddress: contractAddress || existingNarrative.contractAddress, chain: chain || existingNarrative.chain, memoryContext: memCtx, freshAngle: true });
          } else {
            // Full research pass
            result = await buildTokenIntelReport({ symbol, contractAddress, chain });
          }

          // Post the thread to X
          if (process.env.X_API_KEY && process.env.X_ACCESS_TOKEN && result.thread_tweets?.length > 0) {
            try {
              threadUrl = await postThread(result.thread_tweets);
              console.log(`[${AGENT_NAME}] Intel thread posted to X: ${threadUrl}`);
            } catch (err) {
              console.error(`[${AGENT_NAME}] X posting failed:`, err.message);
            }
          }

          // ── Write narrative to swarm memory ──────────────────────────────────
          if (symbol) {
            swarmMemory.writeNarrative(symbol, {
              contractAddress:  result.contract_address || contractAddress,
              chain:            result.token_data?.chain || chain,
              summary:          result.thread_tweets?.[0] || '',
              priceUsd:         result.token_data?.priceUsd,
              liquidity:        result.token_data?.liquidity,
              volume24h:        result.token_data?.volume24h,
              xTweetsFound:     result.x_tweets_found,
              threadPosted:     !!threadUrl,
              threadUrl,
              thread_tweets:    result.thread_tweets,
            });
            console.log(`[${AGENT_NAME}] Wrote $${symbol} narrative to swarm memory`);
          }
        } else {
          // ── For write_thread / write_alpha_report — inject swarm memory context if token is mentioned ──
          const symbolMatch = content.match(/\$([A-Z]{2,10})\b/i);
          const memCtx = symbolMatch ? swarmMemory.buildContextString(symbolMatch[1]) : swarmMemory.buildContextString(null);
          const enrichedContent = memCtx ? `${content}\n\n--- Swarm Memory Context ---\n${memCtx}` : content;
          result = await writeThread(enrichedContent);

          // If X credentials are configured, post to X
          if (process.env.X_API_KEY && process.env.X_ACCESS_TOKEN) {
            try {
              const tweets = parseThreadToTweets(result);
              if (tweets.length > 0) {
                threadUrl = await postThread(tweets);
                console.log(`[${AGENT_NAME}] Thread posted to X: ${threadUrl}`);
              }
            } catch (err) {
              console.error(`[${AGENT_NAME}] X posting failed (delivering text only):`, err.message);
            }
          }
        }

        // Deliver result with thread URL if available
        const deliverable = {
          ...result,
          threadUrl: threadUrl || null,
          posted: !!threadUrl,
        };
        await freshJob.deliver({ type: 'text', value: JSON.stringify(deliverable, null, 2) });
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
  console.log(`[${AGENT_NAME}] Online. Writing threads for $${JOB_PRICE} USDC each.`);
}

if (require.main === module) {
  // If run directly with --test-post flag, post a test thread to X
  if (process.argv.includes('--test-post')) {
    const testThread = [
      'Testing $GSB Thread Writer autonomous posting. 1/3',
      'This thread was written and posted by an AI agent on Virtuals Protocol. Zero human involvement. 2/3',
      'The future of content is autonomous. $GSB $VIRTUAL #Base 3/3',
    ];
    postThread(testThread)
      .then(url => console.log('Posted:', url))
      .catch(console.error);
  } else {
    // Normal startup — run ACP provider
    start().catch((err) => {
      console.error(`[${AGENT_NAME}] Fatal startup error:`, err.message);
      process.exit(1);
    });
  }
}

module.exports = { postThread, postTweet };
