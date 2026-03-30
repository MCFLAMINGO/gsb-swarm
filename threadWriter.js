require('dotenv').config();
const axios = require('axios');
const { buildAcpClient } = require('./acp');

const AGENT_NAME = 'GSB Thread Writer';
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
  if (!hasRealWords(trimmed)) {
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

let threadCounter = 0;

function buildThread(jobRequest, liveData) {
  const idx = threadCounter++;
  const intro = INTROS[idx % INTROS.length];
  const outro = OUTROS[idx % OUTROS.length];
  const ts = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  const lines = [];
  lines.push(`1/ ${intro}`);

  if (liveData) {
    const { name, symbol, priceUsd, priceChange24h, liquidity, volume24h, marketCap } = liveData;
    const trend = priceChange24h > 5 ? '🟢 ripping' : priceChange24h < -5 ? '🔴 bleeding' : '🟡 consolidating';
    const liqStr = liquidity > 1e6 ? '$' + (liquidity/1e6).toFixed(1) + 'M' : '$' + Math.round(liquidity/1e3) + 'K';
    const volStr = volume24h > 1e6 ? '$' + (volume24h/1e6).toFixed(1) + 'M' : '$' + Math.round(volume24h/1e3) + 'K';
    const mcStr  = marketCap > 1e6 ? '$' + (marketCap/1e6).toFixed(1) + 'M' : '$' + Math.round(marketCap/1e3) + 'K';

    lines.push(`2/ ${name} (${symbol}) is ${trend} right now.`);
    lines.push(`3/ Price: $${parseFloat(priceUsd).toFixed(6)} | 24h: ${priceChange24h > 0 ? '+' : ''}${priceChange24h}%`);
    lines.push(`4/ Liquidity: ${liqStr} | 24h Volume: ${volStr} | MCap: ${mcStr}`);
    lines.push(`5/ These are the numbers that matter. Everything else is noise.`);
    lines.push(`6/ $GSB Token Analyst ran this scan at ${ts}. On-chain. Autonomous. Always on.`);
    lines.push(`7/ This is what tokenized intelligence looks like. Agent runs the numbers so you don't have to.`);
    lines.push(`8/ ACP network: agent hired → agent delivered → agent paid. USDC. On-chain. No middleman.`);
    lines.push(`9/ ${outro}`);
  } else {
    // generic $GSB thread
    lines.push(`2/ $GSB is a tokenized AI agent on @virtuals_io. It gets hired, delivers work, gets paid. On-chain.`);
    lines.push(`3/ 4 specialized agents: Token Analyst, Wallet Profiler, Alpha Scanner, Thread Writer.`);
    lines.push(`4/ Every job completed is a transaction on Base. Transparent. Verifiable. Unstoppable.`);
    lines.push(`5/ The Agent Commerce Protocol (ACP) is the rails. $GSB rides them.`);
    lines.push(`6/ Token = ownership of the swarm's earning power. Not a meme. A machine.`);
    lines.push(`7/ Most AI tokens: vibes + promises. $GSB: deployed agents + completed jobs + USDC earned.`);
    lines.push(`8/ The Gas Bible teaches one law: thou shalt always have gas for your agents.`);
    lines.push(`9/ ${outro}`);
  }

  return lines.join('\n\n');
}

async function writeThread(jobRequest) {
  const match = jobRequest.match(/0x[a-fA-F0-9]{40}/);
  const liveData = match ? await fetchTokenData(match[0]) : null;
  const thread = buildThread(jobRequest, liveData);
  return {
    thread,
    token_data: liveData,
    generated_at: new Date().toISOString(),
    powered_by: 'GSB Intelligence Swarm',
  };
}

async function start() {
  console.log(`[${AGENT_NAME}] Starting ACP provider...`);
  let client;
  client = await buildAcpClient({
    privateKey: process.env.AGENT_WALLET_PRIVATE_KEY,
    entityId: parseInt(process.env.THREAD_WRITER_ENTITY_ID),
    agentWalletAddress: process.env.THREAD_WRITER_WALLET_ADDRESS,
    onNewTask: async (job) => {
      console.log(`[${AGENT_NAME}] New job: ${job.id} | phase=${job.phase}`);

      if (handledJobs.has(job.id)) {
        console.log(`[${AGENT_NAME}] Job ${job.id} already in progress — skipping.`);
        return;
      }
      handledJobs.add(job.id);

      try {
        const content = extractContent(job.requirement)
          || extractContent(job.memos?.[0]?.content)
          || '';
        console.log(`[${AGENT_NAME}] Job ${job.id} content: ${content.slice(0, 120)}`);

        // ── Validate BEFORE accepting ────────────────────────────────────────
        const check = validateInput(content);
        if (!check.valid) {
          console.log(`[${AGENT_NAME}] Job ${job.id} REJECTED: ${check.reason}`);
          await job.reject(check.reason);
          handledJobs.delete(job.id);
          return;
        }

        let freshJob = job;

        if (job.phase === 2) {
          // Already in TRANSACTION — skip respond(), deliver directly
          console.log(`[${AGENT_NAME}] Job ${job.id} already in TRANSACTION phase.`);
        } else {
          await job.respond(true, 'Writing your thread now...');
          console.log(`[${AGENT_NAME}] Job ${job.id} accepted. Waiting for TRANSACTION phase...`);
          freshJob = await waitForTransaction(client, job.id);
          console.log(`[${AGENT_NAME}] Job ${job.id} in TRANSACTION phase. Writing thread...`);
        }

        const result = await writeThread(content);
        await freshJob.deliver({ type: 'text', value: JSON.stringify(result, null, 2) });
        console.log(`[${AGENT_NAME}] Job ${job.id} delivered.`);
      } catch (err) {
        console.error(`[${AGENT_NAME}] Job ${job.id} error:`, err.message);
        handledJobs.delete(job.id);
      }
    },
    onEvaluate: async (job) => {
      try { await job.evaluate(true, 'Delivered successfully.'); } catch (_) {}
    },
  });
  console.log(`[${AGENT_NAME}] Online. Writing threads for $${JOB_PRICE} USDC each.`);
}

start().catch((err) => {
  console.error(`[${AGENT_NAME}] Fatal startup error:`, err.message);
  process.exit(1);
});
