require('dotenv').config();
const axios = require('axios');
const { buildAcpClient } = require('./acp');

const AGENT_NAME = 'GSB Alpha Scanner';
const JOB_PRICE = 0.10;

async function scanNewPairs(chainId = 'base') {
  try {
    const res = await axios.get('https://api.dexscreener.com/latest/dex/search?q=new', { timeout: 10000 });
    const pairs = res.data?.pairs || [];
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    const newPairs = pairs.filter((p) => p.chainId === chainId && p.pairCreatedAt && p.pairCreatedAt > cutoff);
    if (newPairs.length === 0) return { message: 'No new pairs in the last 2 hours.', pairs: [] };

    const scored = newPairs.map((pair) => {
      let score = 0; const signals = [];
      const liq = pair.liquidity?.usd || 0;
      const vol5m = pair.volume?.m5 || 0;
      const buys5m = pair.txns?.m5?.buys || 0;
      const sells5m = pair.txns?.m5?.sells || 0;
      const age = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 60000 : 9999;
      if (liq >= 50000) { score += 3; signals.push('STRONG_LIQUIDITY'); }
      else if (liq >= 20000) { score += 2; signals.push('DECENT_LIQUIDITY'); }
      else if (liq >= 5000) { score += 1; signals.push('LOW_LIQUIDITY'); }
      if (vol5m > liq * 0.1) { score += 2; signals.push('HIGH_VOLUME_SPIKE'); }
      if (buys5m > sells5m * 2) { score += 2; signals.push('BUY_PRESSURE'); }
      if (pair.priceChange?.m5 > 10) { score += 2; signals.push('PRICE_PUMPING'); }
      if (age < 30) { score += 1; signals.push('VERY_FRESH'); }
      return { name: pair.baseToken?.name, symbol: pair.baseToken?.symbol, liquidity_usd: liq, score, signals, age_minutes: Math.round(age), dexscreener_url: `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}` };
    }).sort((a, b) => b.score - a.score);

    const hot = scored.filter((p) => p.score >= 7);
    const watch = scored.filter((p) => p.score >= 4 && p.score < 7);
    return {
      scanned_at: new Date().toISOString(),
      total_new_pairs: newPairs.length,
      hot_signals: hot.slice(0, 5),
      watch_list: watch.slice(0, 10),
      verdict: hot.length > 0 ? `${hot.length} HOT SIGNAL(S). Move fast.` : watch.length > 0 ? `${watch.length} pairs watching.` : 'Quiet market.',
    };
  } catch (err) {
    return { error: `Scan failed: ${err.message}` };
  }
}

async function start() {
  console.log(`[${AGENT_NAME}] Starting ACP provider...`);
  const client = await buildAcpClient({
    privateKey: process.env.AGENT_WALLET_PRIVATE_KEY,
    entityId: parseInt(process.env.ALPHA_SCANNER_ENTITY_ID),
    agentWalletAddress: process.env.ALPHA_SCANNER_WALLET_ADDRESS,
    onNewTask: async (job, memoToSign) => {
      console.log(`[${AGENT_NAME}] New job: ${job.id}`);
      try {
        const content = typeof job.description === 'string' ? job.description.toLowerCase() : '';
        let chain = 'base';
        if (content.includes('solana')) chain = 'solana';
        if (content.includes('ethereum') || content.includes(' eth')) chain = 'ethereum';
        await client.respondJob(job.id, memoToSign?.id, true, `Scanning ${chain.toUpperCase()}...`);
        const results = await scanNewPairs(chain);
        await client.deliverJob(job.id, { type: 'text', value: JSON.stringify(results, null, 2) });
        console.log(`[${AGENT_NAME}] Job ${job.id} delivered.`);
      } catch (err) {
        await client.deliverJob(job.id, { type: 'text', value: JSON.stringify({ error: err.message }) });
      }
    },
    onEvaluate: async (job) => { await client.evaluateJob(job.id, true, 'Delivered.'); },
  });
  console.log(`[${AGENT_NAME}] Online. Scanning Base for alpha. $${JOB_PRICE} USDC per job.`);
}

start().catch(console.error);
