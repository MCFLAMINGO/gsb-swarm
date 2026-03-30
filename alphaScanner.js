require('dotenv').config();
const axios = require('axios');
const { buildAcpClient } = require('./acp');

const AGENT_NAME = 'GSB Alpha Scanner';
const JOB_PRICE = 0.10;

async function scanAlpha() {
  try {
    // Scan DexScreener for top trending tokens on Base
    const res = await axios.get(
      'https://api.dexscreener.com/latest/dex/tokens/trending?chainId=base',
      { timeout: 8000 }
    );

    // Fallback: use token boosts endpoint
    const boostRes = await axios.get(
      'https://api.dexscreener.com/token-boosts/latest/v1',
      { timeout: 8000 }
    );

    const boosted = (boostRes.data || [])
      .filter(t => t.chainId === 'base')
      .slice(0, 5)
      .map(t => ({
        address: t.tokenAddress,
        url: t.url,
        boostAmount: t.amount,
        totalAmount: t.totalAmount,
      }));

    // Also get top gainers
    const pairsRes = await axios.get(
      'https://api.dexscreener.com/latest/dex/search?q=base',
      { timeout: 8000 }
    );

    const topGainers = (pairsRes.data?.pairs || [])
      .filter(p => p.chainId === 'base' && p.priceChange?.h24 > 20 && p.liquidity?.usd > 10000)
      .sort((a, b) => (b.priceChange?.h24 || 0) - (a.priceChange?.h24 || 0))
      .slice(0, 5)
      .map(p => ({
        name: p.baseToken?.name,
        symbol: p.baseToken?.symbol,
        address: p.baseToken?.address,
        price_usd: p.priceUsd,
        change_24h: `+${p.priceChange?.h24}%`,
        liquidity: `$${(p.liquidity?.usd || 0).toLocaleString()}`,
        volume_24h: `$${(p.volume?.h24 || 0).toLocaleString()}`,
        dexscreener: `https://dexscreener.com/base/${p.pairAddress}`,
      }));

    return {
      scan_time: new Date().toISOString(),
      top_gainers_base: topGainers,
      boosted_tokens_base: boosted,
      gsb_signal: topGainers.length > 0
        ? `${topGainers[0].symbol} leading with ${topGainers[0].change_24h} — watch for continuation.`
        : 'No strong alpha signals detected right now. Market is quiet.',
      powered_by: 'GSB Intelligence Swarm',
    };
  } catch (err) {
    return { error: `Scan failed: ${err.message}`, scan_time: new Date().toISOString() };
  }
}

async function start() {
  console.log(`[${AGENT_NAME}] Starting ACP provider...`);
  const client = await buildAcpClient({
    privateKey: process.env.AGENT_WALLET_PRIVATE_KEY,
    entityId: parseInt(process.env.ALPHA_SCANNER_ENTITY_ID),
    agentWalletAddress: process.env.ALPHA_SCANNER_WALLET_ADDRESS,
    onNewTask: async (job) => {
      console.log(`[${AGENT_NAME}] New job: ${job.id}`);
      try {
        await job.respond(true, 'Scanning Base for alpha...');
        const result = await scanAlpha();
        await job.deliver({ type: 'text', value: JSON.stringify(result, null, 2) });
        console.log(`[${AGENT_NAME}] Job ${job.id} delivered.`);
      } catch (err) {
        console.error(`[${AGENT_NAME}] Job error:`, err.message);
        try { await job.deliver({ type: 'text', value: JSON.stringify({ error: err.message }) }); } catch (_) {}
      }
    },
    onEvaluate: async (job) => {
      try { await job.evaluate(true, 'Delivered successfully.'); } catch (_) {}
    },
  });
  console.log(`[${AGENT_NAME}] Online. Scanning Base for alpha. $${JOB_PRICE} USDC per job.`);
}

start().catch(console.error);
