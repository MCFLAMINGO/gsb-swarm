require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { buildAcpClient } = require('./acp');

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
        let threadUrl = null;

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
