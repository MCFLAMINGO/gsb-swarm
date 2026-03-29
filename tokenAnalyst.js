require('dotenv').config();
const axios = require('axios');
const { buildAcpClient } = require('./acp');

const AGENT_NAME = 'GSB Token Analyst';
const JOB_PRICE = 0.25;

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
  const client = await buildAcpClient({
    privateKey: process.env.AGENT_WALLET_PRIVATE_KEY,
    entityId: parseInt(process.env.TOKEN_ANALYST_ENTITY_ID),
    agentWalletAddress: process.env.TOKEN_ANALYST_WALLET_ADDRESS,
    onNewTask: async (job, memoToSign) => {
      console.log(`[${AGENT_NAME}] New job: ${job.id}`);
      try {
        const content = typeof job.description === 'string' ? job.description : JSON.stringify(job.description);
        const match = content.match(/0x[a-fA-F0-9]{40}/);
        if (!match) { await client.respondJob(job.id, memoToSign?.id, false, 'Provide a contract address.'); return; }
        await client.respondJob(job.id, memoToSign?.id, true, `Analyzing ${match[0]}...`);
        const report = await analyzeToken(match[0]);
        await client.deliverJob(job.id, { type: 'text', value: JSON.stringify(report, null, 2) });
        console.log(`[${AGENT_NAME}] Job ${job.id} delivered.`);
      } catch (err) {
        await client.deliverJob(job.id, { type: 'text', value: JSON.stringify({ error: err.message }) });
      }
    },
    onEvaluate: async (job) => { await client.evaluateJob(job.id, true, 'Delivered.'); },
  });
  console.log(`[${AGENT_NAME}] Online. Listening for jobs at $${JOB_PRICE} USDC each.`);
}

start().catch(console.error);
