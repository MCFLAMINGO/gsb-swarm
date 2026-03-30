require('dotenv').config();
const axios = require('axios');
const { buildAcpClient } = require('./acp');

const AGENT_NAME = 'GSB Thread Writer';
const JOB_PRICE = 0.15;

// Lazy-init OpenAI — don't crash at module load if key is missing/invalid
let _openai = null;
function getOpenAI() {
  if (!_openai) {
    const OpenAI = require('openai').default;
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
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

async function writeThread(jobRequest) {
  const match = jobRequest.match(/0x[a-fA-F0-9]{40}/);
  const liveData = match ? await fetchTokenData(match[0]) : null;

  const systemPrompt = `You are the GSB Thread Writer — the most feared crypto thread writer on X.
Your threads: punchy, data-backed, 8-12 numbered tweets (1/, 2/, etc.), end with $GSB mention.
Brand: Bold. Irreverent. Data-driven. Biblical. Thou shalt never run out of GAS.`;

  const userPrompt = liveData
    ? `Write a viral X thread about ${liveData.name} (${liveData.symbol}). Price: $${liveData.priceUsd}, 24h: ${liveData.priceChange24h}%, Liq: $${(liveData.liquidity||0).toLocaleString()}, Vol: $${(liveData.volume24h||0).toLocaleString()}. Request: ${jobRequest}`
    : `Write a viral X thread about: ${jobRequest}. End with $GSB mention.`;

  // If no OpenAI key, return a template thread
  if (!process.env.OPENAI_API_KEY) {
    return {
      thread: `1/ The Gas Bible is written. $GSB is the agent that never runs dry.\n\n2/ While others panic about gas fees, $GSB agents are already 3 moves ahead.\n\n3/ Tokenized intelligence. On-chain. Always on. Always earning.\n\n4/ Thou shalt never run out of GAS. — $GSB`,
      token_data: liveData,
      generated_at: new Date().toISOString(),
      powered_by: 'GSB Intelligence Swarm (template mode)',
    };
  }

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
}

async function start() {
  console.log(`[${AGENT_NAME}] Starting ACP provider...`);
  const client = await buildAcpClient({
    privateKey: process.env.AGENT_WALLET_PRIVATE_KEY,
    entityId: parseInt(process.env.THREAD_WRITER_ENTITY_ID),
    agentWalletAddress: process.env.THREAD_WRITER_WALLET_ADDRESS,
    onNewTask: async (job, memoToSign) => {
      console.log(`[${AGENT_NAME}] New job: ${job.id}`);
      try {
        const content = typeof job.description === 'string' ? job.description : JSON.stringify(job.description);
        if (!content || content.length < 3) {
          await client.respondJob(job.id, memoToSign?.id, false, 'Provide a topic or contract address.');
          return;
        }
        await client.respondJob(job.id, memoToSign?.id, true, 'Writing your thread...');
        const result = await writeThread(content);
        await client.deliverJob(job.id, { type: 'text', value: JSON.stringify(result, null, 2) });
        console.log(`[${AGENT_NAME}] Job ${job.id} delivered.`);
      } catch (err) {
        console.error(`[${AGENT_NAME}] Job error:`, err.message);
        try {
          await client.deliverJob(job.id, { type: 'text', value: JSON.stringify({ error: err.message }) });
        } catch (_) {}
      }
    },
    onEvaluate: async (job) => {
      await client.evaluateJob(job.id, true, 'Delivered.');
    },
  });
  console.log(`[${AGENT_NAME}] Online. Writing threads for $${JOB_PRICE} USDC each.`);
}

start().catch((err) => {
  console.error(`[${AGENT_NAME}] Fatal startup error:`, err.message);
  process.exit(1);
});
