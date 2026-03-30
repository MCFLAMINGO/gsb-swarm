require('dotenv').config();
const axios = require('axios');
const { buildAcpClient } = require('./acp');

const AGENT_NAME = 'GSB Wallet Profiler';
const JOB_PRICE = 0.50;

const handledJobs = new Set();

async function waitForTransaction(client, jobId, maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const fresh = await client.getJobById(jobId);
    if (fresh && fresh.phase === 2) return fresh;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`Job ${jobId} did not reach TRANSACTION phase within ${maxWaitMs}ms`);
}

function extractContent(requirement) {
  if (!requirement) return '';
  if (typeof requirement === 'string') return requirement;
  if (typeof requirement === 'object') {
    return requirement.topic || requirement.requirement || requirement.content || requirement.walletAddress || JSON.stringify(requirement);
  }
  return String(requirement);
}

async function profileWallet(address) {
  try {
    const txRes = await axios.get(
      `https://api.basescan.org/api?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&sort=desc&apikey=YourApiKeyToken`,
      { timeout: 8000 }
    ).catch(() => ({ data: { result: [] } }));

    const txs = txRes.data?.result || [];
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
  let client;
  client = await buildAcpClient({
    privateKey: process.env.AGENT_WALLET_PRIVATE_KEY,
    entityId: parseInt(process.env.WALLET_PROFILER_ENTITY_ID),
    agentWalletAddress: process.env.WALLET_PROFILER_WALLET_ADDRESS,
    onNewTask: async (job) => {
      console.log(`[${AGENT_NAME}] New job: ${job.id} | phase=${job.phase}`);

      if (handledJobs.has(job.id)) {
        console.log(`[${AGENT_NAME}] Job ${job.id} already in progress — skipping duplicate.`);
        return;
      }
      handledJobs.add(job.id);

      try {
        await job.respond(true, 'Profiling wallet now...');
        console.log(`[${AGENT_NAME}] Job ${job.id} accepted. Waiting for TRANSACTION phase...`);

        const freshJob = await waitForTransaction(client, job.id);
        console.log(`[${AGENT_NAME}] Job ${job.id} in TRANSACTION phase.`);

        const rawContent = extractContent(freshJob.requirement)
          || extractContent(freshJob.memos?.[0]?.content)
          || '';
        const match = rawContent.match(/0x[a-fA-F0-9]{40}/);

        if (!match) {
          await freshJob.deliver({ type: 'text', value: 'No wallet address found. Please provide a valid Base wallet address.' });
          return;
        }

        const profile = await profileWallet(match[0]);
        await freshJob.deliver({ type: 'text', value: JSON.stringify(profile, null, 2) });
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
  console.log(`[${AGENT_NAME}] Online. Listening for jobs at $${JOB_PRICE} USDC each.`);
}

start().catch(console.error);
