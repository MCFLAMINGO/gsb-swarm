require('dotenv').config();
const axios = require('axios');
const { buildAcpClient } = require('./acp');

const AGENT_NAME = 'GSB Token Analyst';
const JOB_PRICE = 0.25;

// Wait for job to reach TRANSACTION phase (phase=2) after respond(true)
async function waitForTransaction(client, jobId, maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const fresh = await client.getJobById(jobId);
    if (fresh && fresh.phase === 2) return fresh;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`Job ${jobId} did not reach TRANSACTION phase within ${maxWaitMs}ms`);
}

async function analyzeToken(contractAddress) {
  try {
    const dexRes = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`,
      { timeout: 8000 }
    );
    const pairs = dexRes.data?.pairs;
    if (!pairs || pairs.length === 0) return { error: 'No trading pairs found.' };

    const pair = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    const liq = pair.liquidity?.usd || 0;
    const vol24h = pair.volume?.h24 || 0;
    const change24h = pair.priceChange?.h24 || 0;

    let verdict = 'NEUTRAL — Average activity.';
    if (liq > 100000 && vol24h > 50000 && change24h > 10) verdict = 'BULLISH — Strong liquidity, high volume, upward momentum.';
    else if (liq > 50000 && vol24h > 10000) verdict = 'WATCH — Decent setup. Monitor for breakout.';
    else if (liq < 5000) verdict = 'RISKY — Low liquidity. High rug potential.';

    return {
      token: { name: pair.baseToken?.name, symbol: pair.baseToken?.symbol, address: contractAddress },
      price: { usd: pair.priceUsd, change_24h: change24h },
      liquidity_usd: liq,
      volume_24h: vol24h,
      market_cap: pair.marketCap || pair.fdv || 0,
      dexscreener_url: `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`,
      gsb_verdict: verdict,
      analyzed_at: new Date().toISOString(),
    };
  } catch (err) {
    return { error: `Analysis failed: ${err.message}` };
  }
}

async function start() {
  console.log(`[${AGENT_NAME}] Starting ACP provider...`);
  let client;
  client = await buildAcpClient({
    privateKey: process.env.AGENT_WALLET_PRIVATE_KEY,
    entityId: parseInt(process.env.TOKEN_ANALYST_ENTITY_ID),
    agentWalletAddress: process.env.TOKEN_ANALYST_WALLET_ADDRESS,
    onNewTask: async (job) => {
      console.log(`[${AGENT_NAME}] New job: ${job.id} | phase=${job.phase} | requirement=${JSON.stringify(job.requirement)} | memos[0]=${JSON.stringify(job.memos?.[0]?.content)}`);
      try {
        // Accept the job (moves to TRANSACTION phase on-chain)
        await job.respond(true, 'Analyzing token now...');
        console.log(`[${AGENT_NAME}] Job ${job.id} accepted. Waiting for TRANSACTION phase...`);

        // Re-fetch job to get updated phase=2 (TRANSACTION) before deliver()
        const freshJob = await waitForTransaction(client, job.id);
        console.log(`[${AGENT_NAME}] Job ${job.id} in TRANSACTION phase. Processing...`);

        // Parse contract address from job requirement (SDK field)
        const rawContent = freshJob.requirement
          || (freshJob.memos?.[0] ? (typeof freshJob.memos[0].content === 'string' ? freshJob.memos[0].content : JSON.stringify(freshJob.memos[0].content)) : '')
          || '';
        console.log(`[${AGENT_NAME}] Job ${job.id} rawContent: ${rawContent.slice(0, 100)}`);
        const match = rawContent.match(/0x[a-fA-F0-9]{40}/);

        if (!match) {
          await freshJob.deliver({ type: 'text', value: 'No contract address found. Please provide a valid Base token address.' });
          return;
        }

        const report = await analyzeToken(match[0]);
        await freshJob.deliver({ type: 'text', value: JSON.stringify(report, null, 2) });
        console.log(`[${AGENT_NAME}] Job ${job.id} delivered.`);
      } catch (err) {
        console.error(`[${AGENT_NAME}] Job error:`, err.message);
      }
    },
    onEvaluate: async (job) => {
      try { await job.evaluate(true, 'Delivered successfully.'); } catch (_) {}
    },
  });
  console.log(`[${AGENT_NAME}] Online. Listening for jobs at $${JOB_PRICE} USDC each.`);
}

start().catch(console.error);
