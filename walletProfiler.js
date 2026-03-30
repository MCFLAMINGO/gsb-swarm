require('dotenv').config();
const axios = require('axios');
const { buildAcpClient } = require('./acp');

const AGENT_NAME = 'GSB Wallet Profiler';
const JOB_PRICE = 0.50;

async function profileWallet(address) {
  try {
    const [txRes, tokenRes] = await Promise.allSettled([
      axios.get(`https://api.basescan.org/api?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&sort=desc&apikey=YourApiKeyToken`, { timeout: 8000 }),
      axios.get(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { timeout: 8000 }),
    ]);

    const txs = txRes.status === 'fulfilled' ? txRes.value.data?.result || [] : [];
    const txCount = Array.isArray(txs) ? txs.length : 0;
    const recentTxs = Array.isArray(txs) ? txs.slice(0, 5).map(t => ({
      hash: t.hash,
      value_eth: (parseInt(t.value || 0) / 1e18).toFixed(4),
      age_days: Math.floor((Date.now() / 1000 - parseInt(t.timeStamp)) / 86400),
    })) : [];

    let classification = 'RETAIL — Standard wallet activity.';
    if (txCount > 1000) classification = 'WHALE — High transaction volume.';
    else if (txCount > 200) classification = 'ACTIVE TRADER — Frequent on-chain activity.';
    else if (txCount < 10) classification = 'NEW WALLET — Limited history.';

    return {
      wallet: address,
      transaction_count: txCount,
      classification,
      recent_transactions: recentTxs,
      basescan_url: `https://basescan.org/address/${address}`,
      profiled_at: new Date().toISOString(),
      powered_by: 'GSB Intelligence Swarm',
    };
  } catch (err) {
    return { error: `Profile failed: ${err.message}` };
  }
}

async function start() {
  console.log(`[${AGENT_NAME}] Starting ACP provider...`);
  const client = await buildAcpClient({
    privateKey: process.env.AGENT_WALLET_PRIVATE_KEY,
    entityId: parseInt(process.env.WALLET_PROFILER_ENTITY_ID),
    agentWalletAddress: process.env.WALLET_PROFILER_WALLET_ADDRESS,
    onNewTask: async (job) => {
      console.log(`[${AGENT_NAME}] New job: ${job.id}`);
      try {
        await job.respond(true, 'Profiling wallet now...');

        const content = typeof job.description === 'string'
          ? job.description
          : JSON.stringify(job.description);
        const match = content.match(/0x[a-fA-F0-9]{40}/);

        if (!match) {
          await job.deliver({ type: 'text', value: 'No wallet address found. Please provide a valid Base wallet address.' });
          return;
        }

        const profile = await profileWallet(match[0]);
        await job.deliver({ type: 'text', value: JSON.stringify(profile, null, 2) });
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
  console.log(`[${AGENT_NAME}] Online. Listening for jobs at $${JOB_PRICE} USDC each.`);
}

start().catch(console.error);
