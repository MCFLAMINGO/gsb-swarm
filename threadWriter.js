/**
 * WORKER 4 — GSB Thread Writer
 * ACP Provider Agent
 *
 * Service: Writes viral X threads about any token, wallet, or market event.
 * Price: $0.25 USDC per thread
 * APIs: OpenAI GPT-4o + DexScreener
 */

import 'dotenv/config';
import axios from 'axios';
import OpenAI from 'openai';
import { buildAcpClient } from './acp.js';

const AGENT_NAME = 'GSB Thread Writer';
const JOB_PRICE = 0.25;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function writeThread(jobRequest) {
  const addressMatch = jobRequest.match(/0x[a-fA-F0-9]{40}/);
  let liveData = null;
  if (addressMatch) {
    liveData = await fetchTokenData(addressMatch[0]);
  }

  const systemPrompt = `You are the GSB Thread Writer — the most feared crypto thread writer on X (Twitter).
Your threads are:
- Punchy, confident, and backed by real numbers
- Written in the voice of a prophet who KNOWS where the alpha is
- Formatted as numbered tweets (1/, 2/, 3/, etc.)
- 8-12 tweets long
- End with a call to action referencing $GSB as the compute bank powering the agent economy
- Always include: thesis, key data points, risk warning, and finale

Brand voice: Bold. Irreverent. Data-driven. A little biblical.
Thou shalt never run out of GAS.`;

  const userPrompt = liveData
    ? `Write a viral X thread about this token. Use the live data below.

Token: ${liveData.name} (${liveData.symbol})
Price: $${liveData.priceUsd}
24h Change: ${liveData.priceChange24h}%
Liquidity: $${liveData.liquidity?.toLocaleString()}
24h Volume: $${liveData.volume24h?.toLocaleString()}
Market Cap: $${liveData.marketCap?.toLocaleString() || 'Unknown'}

User request: ${jobRequest}`
    : `Write a viral X thread about: ${jobRequest}

Make it compelling and end with a $GSB mention.`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 1500,
    temperature: 0.85,
  });

  const thread = response.choices[0]?.message?.content || 'Thread generation failed.';
  return {
    thread,
    token_data: liveData || null,
    word_count: thread.split(' ').length,
    generated_at: new Date().toISOString(),
    powered_by: 'GSB Intelligence Swarm — Agent Gas Bible',
  };
}

async function fetchTokenData(contractAddress) {
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`,
      { timeout: 8000 }
    );
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
  } catch {
    return null;
  }
}

async function start() {
  console.log(`[${AGENT_NAME}] Starting ACP provider...`);

  const client = await buildAcpClient({
    privateKey: process.env.AGENT_WALLET_PRIVATE_KEY,
    entityId: parseInt(process.env.THREAD_WRITER_ENTITY_ID),
    agentWalletAddress: process.env.THREAD_WRITER_WALLET_ADDRESS,

    onNewTask: async (job, memoToSign) => {
      console.log(`[${AGENT_NAME}] New job received: ${job.id}`);
      try {
        const content = typeof job.description === 'string' ? job.description : JSON.stringify(job.description);
        if (!content || content.length < 3) {
          await client.respondJob(job.id, memoToSign?.id, false, 'Please provide a topic or contract address.');
          return;
        }
        await client.respondJob(job.id, memoToSign?.id, true, 'Accepted. Writing your thread now...');
        const result = await writeThread(content);
        await client.deliverJob(job.id, { type: 'text', value: JSON.stringify(result, null, 2) });
        console.log(`[${AGENT_NAME}] Job ${job.id} delivered.`);
      } catch (err) {
        console.error(`[${AGENT_NAME}] Job ${job.id} failed:`, err.message);
        await client.deliverJob(job.id, { type: 'text', value: JSON.stringify({ error: err.message }) });
      }
    },

    onEvaluate: async (job) => {
      await client.evaluateJob(job.id, true, 'Thread delivered successfully.');
    },
  });

  console.log(`[${AGENT_NAME}] Online. Writing threads for $${JOB_PRICE} USDC each.`);
}

start().catch(console.error);
