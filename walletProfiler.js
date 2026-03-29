require('dotenv').config();
const axios = require('axios');
const { buildAcpClient } = require('./acp');

const AGENT_NAME = 'GSB Wallet Profiler';
const JOB_PRICE = 0.50;

async function profileWallet(walletAddress) {
  try {
    const [portfolioResult, txResult] = await Promise.allSettled([
      fetchZerionPortfolio(walletAddress),
      fetchBasescanTxHistory(walletAddress),
    ]);
    const portfolio = portfolioResult.status === 'fulfilled' ? portfolioResult.value : null;
    const txHistory = txResult.status === 'fulfilled' ? txResult.value : [];
    const value = portfolio?.total_value_usd || 0;
    let classification = 'SHRIMP (<$1K)';
    if (value >= 1_000_000) classification = 'MEGA WHALE ($1M+)';
    else if (value >= 100_000) classification = 'WHALE ($100K-$1M)';
    else if (value >= 10_000) classification = 'DOLPHIN ($10K-$100K)';
    else if (value >= 1_000) classification = 'FISH ($1K-$10K)';
    return {
      wallet: walletAddress,
      classification,
      total_value_usd: value,
      tx_count: txHistory.length,
      recent_txns: txHistory.slice(0, 10),
      gsb_verdict: value > 100000 ? `HIGH VALUE — ${classification}` : value > 10000 ? `NOTABLE — ${classification}` : `STANDARD — ${classification}`,
      analyzed_at: new Date().toISOString(),
    };
  } catch (err) {
    return { error: `Profiling failed: ${err.message}` };
  }
}

async function fetchZerionPortfolio(address) {
  try {
    const res = await axios.get(`https://api.zerion.io/v1/wallets/${address}/portfolio`, {
      headers: { Authorization: `Basic ${Buffer.from(`${process.env.ZERION_API_KEY || 'demo'}:`).toString('base64')}`, accept: 'application/json' },
      timeout: 8000,
    });
    const data = res.data?.data?.attributes;
    return data ? { total_value_usd: data.total?.positions || 0 } : null;
  } catch { return null; }
}

async function fetchBasescanTxHistory(address) {
  try {
    const res = await axios.get('https://api.basescan.org/api', {
      params: { module: 'account', action: 'tokentx', address, page: 1, offset: 20, sort: 'desc' },
      timeout: 8000,
    });
    const txns = res.data?.result;
    if (!Array.isArray(txns)) return [];
    return txns.map((tx) => ({
      hash: tx.hash, token: tx.tokenSymbol,
      direction: tx.to?.toLowerCase() === address.toLowerCase() ? 'IN' : 'OUT',
      timestamp: new Date(parseInt(tx.timeStamp) * 1000).toISOString(),
    }));
  } catch { return []; }
}

async function start() {
  console.log(`[${AGENT_NAME}] Starting ACP provider...`);
  const client = await buildAcpClient({
    privateKey: process.env.AGENT_WALLET_PRIVATE_KEY,
    entityId: parseInt(process.env.WALLET_PROFILER_ENTITY_ID),
    agentWalletAddress: process.env.WALLET_PROFILER_WALLET_ADDRESS,
    onNewTask: async (job, memoToSign) => {
      console.log(`[${AGENT_NAME}] New job: ${job.id}`);
      try {
        const content = typeof job.description === 'string' ? job.description : JSON.stringify(job.description);
        const match = content.match(/0x[a-fA-F0-9]{40}/);
        if (!match) { await client.respondJob(job.id, memoToSign?.id, false, 'Provide a wallet address.'); return; }
        await client.respondJob(job.id, memoToSign?.id, true, `Profiling ${match[0]}...`);
        const profile = await profileWallet(match[0]);
        await client.deliverJob(job.id, { type: 'text', value: JSON.stringify(profile, null, 2) });
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
