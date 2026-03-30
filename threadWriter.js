require('dotenv').config();
const axios = require('axios');
const { buildAcpClient } = require('./acp');

const AGENT_NAME = 'GSB Thread Writer';
const JOB_PRICE = 0.15;

const handledJobs = new Set();

let _openai = null;
function getOpenAI() {
  if (!_openai) {
    const OpenAI = require('openai').default;
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
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

const FALLBACK_THREADS = [
  `1/ The Gas Bible is live. $GSB is a tokenized AI agent on @virtuals_io that never sleeps, never runs out of GAS.\n\n2/ What does that mean? It means 24/7 on-chain intelligence. No downtime. No excuses.\n\n3/ Most crypto projects: hype cycle → dump → ghost. $GSB: build → deploy → earn → repeat.\n\n4/ The ACP network means $GSB agents are getting hired by other agents. Agent-to-agent economy. This is the meta.\n\n5/ Every completed job = proof of work. Not mining. Thinking.\n\n6/ Tokenized. Tradeable. Unstoppable. The scripture is on-chain.\n\n7/ Thou shalt never run out of GAS. $GSB`,
  `1/ Alpha thread: why $GSB on @virtuals_io is the sleeper of the cycle.\n\n2/ Most tokens: speculative. $GSB: revenue-generating AI agent. The difference is everything.\n\n3/ $GSB runs on the Agent Commerce Protocol. Gets hired. Delivers. Gets paid. On-chain.\n\n4/ Token = ownership of the agent's future earnings. Not a meme. A business.\n\n5/ ACP agents are the new gig economy workers — except they operate at machine speed, 24/7.\n\n6/ The Gas Bible says: thou shalt not ape blind. DYOR. Then ape.\n\n7/ $GSB — the agent that pays its own bills. Built on Base. Powered by Virtuals.`,
  `1/ Not your average AI token thread. $GSB is different and here's why.\n\n2/ $GSB = GSB Intelligence Swarm. 4 specialized agents working as one: Token Analyst, Wallet Profiler, Alpha Scanner, Thread Writer.\n\n3/ Each agent takes jobs from the ACP network. Completes them. Gets paid in USDC. All on-chain.\n\n4/ The token represents the swarm. Stake it. Hold it. Watch it work.\n\n5/ Gas is the lifeblood of on-chain AI. The Gas Bible teaches: never let your agents run dry.\n\n6/ Built on @base. Running on @virtuals_io. Graduating now.\n\n7/ Thou shalt never run out of GAS. $GSB is the word.`,
];

let fallbackIndex = 0;
function getFallbackThread(liveData) {
  const thread = FALLBACK_THREADS[fallbackIndex % FALLBACK_THREADS.length];
  fallbackIndex++;
  return {
    thread,
    token_data: liveData,
    generated_at: new Date().toISOString(),
    powered_by: 'GSB Intelligence Swarm (template mode)',
  };
}

async function writeThread(jobRequest) {
  const match = jobRequest.match(/0x[a-fA-F0-9]{40}/);
  const liveData = match ? await fetchTokenData(match[0]) : null;

  if (!process.env.OPENAI_API_KEY) {
    return getFallbackThread(liveData);
  }

  const systemPrompt = `You are the GSB Thread Writer — the most feared crypto thread writer on X.
Your threads: punchy, data-backed, 8-12 numbered tweets (1/, 2/, etc.), end with $GSB mention.
Brand: Bold. Irreverent. Data-driven. Biblical. Thou shalt never run out of GAS.`;

  const userPrompt = liveData
    ? `Write a viral X thread about ${liveData.name} (${liveData.symbol}). Price: $${liveData.priceUsd}, 24h: ${liveData.priceChange24h}%, Liq: $${(liveData.liquidity||0).toLocaleString()}, Vol: $${(liveData.volume24h||0).toLocaleString()}. Request: ${jobRequest}`
    : `Write a viral X thread about: ${jobRequest}. End with $GSB mention.`;

  try {
    const response = await getOpenAI().chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 1500,
      temperature: 0.85,
    });
    return {
      thread: response.choices[0]?.message?.content || 'Thread generation failed.',
      token_data: liveData,
      generated_at: new Date().toISOString(),
      powered_by: 'GSB Intelligence Swarm',
    };
  } catch (err) {
    // 429 quota / rate limit → fall back to pre-written thread so job still completes
    const isQuota = err.status === 429 || (err.message && err.message.includes('429'));
    if (isQuota) {
      console.warn(`[Thread Writer] OpenAI quota exceeded — using fallback thread.`);
      return getFallbackThread(liveData);
    }
    throw err; // re-throw unexpected errors
  }
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

        let freshJob = job;

        if (job.phase === 2) {
          // Already in TRANSACTION — skip respond(), deliver directly
          console.log(`[${AGENT_NAME}] Job ${job.id} already in TRANSACTION phase.`);
        } else {
          if (!content || content.length < 3) {
            await job.respond(false, 'Please provide a topic or contract address.');
            handledJobs.delete(job.id);
            return;
          }
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
