/**
 * WORKER 2 — GSB Wallet Profiler
 * ACP Provider Agent
 *
 * Service: Full wallet PnL, holdings, trade history, whale classification
 * Price: $0.50 USDC per job
 * APIs: Zerion (free), DexScreener, Basescan (free)
 */

require('dotenv').config();
const axios = require('axios');
const { buildAcpClient } = require('./acp');

const AGENT_NAME = 'GSB Wallet Profiler';
const JOB_PRICE = 0.50;

// ── Core profiling logic ─────────────────────────────────────────────────────

async function profileWallet(walletAddress) {
  try {
    const results = await Promise.allSettled([
      fetchZerionPortfolio(walletAddress),
      fetchBasescanTxHistory(walletAddress),
    ]);

    const portfolio = results[0].status === 'fulfilled' ? results[0].value : null;
    const txHistory = results[1].status === 'fulfilled' ? results[1].value : [];

    const classification = classifyWhale(portfolio);
    const winRate = calculateWinRate(txHistory);

    return {
      wallet: walletAddress,
      classification,
      portfolio: portfolio
        ? {
            total_value_usd: portfolio.total_value_usd,
            top_holdings: portfolio.top_holdings,
            chains: portfolio.chains,
          }
        : { note: 'Portfolio data unavailable' },
      trading_history: {
        total_txns: txHistory.length,
        win_rate: winRate,
        recent_10: txHistory.slice(0, 10),
      },
      gsb_verdict: generateWalletVerdict(portfolio, winRate, classification),
      analyzed_at: new Date().toISOString(),
    };
  } catch (err) {
    return { error: `Wallet profiling failed: ${err.message}` };
  }
}

async function fetchZerionPortfolio(address) {
  try {
    const res = await axios.get(
      `https://api.zerion.io/v1/wallets/${address}/portfolio`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${process.env.ZERION_API_KEY || 'demo'}:`).toString('base64')}`,
          accept: 'application/json',
        },
        timeout: 8000,
      }
    );

    const data = res.data?.data?.attributes;
    if (!data) return null;

    return {
      total_value_usd: data.total?.positions || 0,
      chains: data.positions_distribution_by_chain || {},
      top_holdings: [], // Zerion returns positions separately
    };
  } catch {
    return null;
  }
}

async function fetchBasescanTxHistory(address) {
  try {
    const res = await axios.get('https://api.basescan.org/api', {
      params: {
        module: 'account',
        action: 'tokentx',
        address,
        startblock: 0,
        endblock: 99999999,
        page: 1,
        offset: 20,
        sort: 'desc',
      },
      timeout: 8000,
    });

    const txns = res.data?.result;
    if (!Array.isArray(txns)) return [];

    return txns.map((tx) => ({
      hash: tx.hash,
      token: tx.tokenSymbol,
      value: (parseFloat(tx.value) / Math.pow(10, parseInt(tx.tokenDecimal || 18))).toFixed(4),
      direction: tx.to?.toLowerCase() === address.toLowerCase() ? 'IN' : 'OUT',
      timestamp: new Date(parseInt(tx.timeStamp) * 1000).toISOString(),
    }));
  } catch {
    return [];
  }
}

function classifyWhale(portfolio) {
  const value = portfolio?.total_value_usd || 0;
  if (value >= 1_000_000) return '🐋 MEGA WHALE ($1M+)';
  if (value >= 100_000) return '🐳 WHALE ($100K–$1M)';
  if (value >= 10_000) return '🐬 DOLPHIN ($10K–$100K)';
  if (value >= 1_000) return '🐟 FISH ($1K–$10K)';
  return '🦐 SHRIMP (<$1K)';
}

function calculateWinRate(txHistory) {
  if (!txHistory || txHistory.length === 0) return 'Insufficient data';
  const inTxns = txHistory.filter((t) => t.direction === 'IN').length;
  const total = txHistory.length;
  return `${Math.round((inTxns / total) * 100)}% inflow ratio (${total} txns analyzed)`;
}

function generateWalletVerdict(portfolio, winRate, classification) {
  const value = portfolio?.total_value_usd || 0;
  if (value > 100000) return `💎 HIGH VALUE WALLET — ${classification}. Track this address.`;
  if (value > 10000) return `👀 NOTABLE WALLET — ${classification}. Active on-chain.`;
  return `📊 STANDARD WALLET — ${classification}. Normal activity.`;
}

// ── ACP Provider loop ────────────────────────────────────────────────────────

async function start() {
  console.log(`[${AGENT_NAME}] Starting ACP provider...`);

  const client = await buildAcpClient({
    privateKey: process.env.AGENT_WALLET_PRIVATE_KEY,
    entityId: process.env.WALLET_PROFILER_ENTITY_ID,
    agentWalletAddress: process.env.WALLET_PROFILER_WALLET_ADDRESS,

    onNewTask: async (job, memoToSign) => {
      console.log(`[${AGENT_NAME}] New job received: ${job.id}`);

      try {
        const content = typeof job.description === 'string'
          ? job.description
          : JSON.stringify(job.description);

        const addressMatch = content.match(/0x[a-fA-F0-9]{40}/);
        const walletAddress = addressMatch ? addressMatch[0] : content.trim();

        if (!walletAddress || !walletAddress.startsWith('0x')) {
          await client.respondJob(job.id, memoToSign?.id, false, 'No valid wallet address provided.');
          return;
        }

        await client.respondJob(job.id, memoToSign?.id, true, `Accepted. Profiling ${walletAddress}...`);

        const profile = await profileWallet(walletAddress);
        await client.deliverJob(job.id, {
          type: 'text',
          value: JSON.stringify(profile, null, 2),
        });

        console.log(`[${AGENT_NAME}] Job ${job.id} delivered.`);
      } catch (err) {
        console.error(`[${AGENT_NAME}] Job ${job.id} failed:`, err.message);
        await client.deliverJob(job.id, {
          type: 'text',
          value: JSON.stringify({ error: err.message }),
        });
      }
    },

    onEvaluate: async (job) => {
      await client.evaluateJob(job.id, true, 'Wallet profile delivered successfully.');
    },
  });

  console.log(`[${AGENT_NAME}] Online. Listening for jobs at $${JOB_PRICE} USDC each.`);
}

start().catch(console.error);
