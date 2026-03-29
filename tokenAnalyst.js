/**
 * WORKER 1 — GSB Token Analyst
 * ACP Provider Agent
 *
 * Service: Full token report for any contract address on Base/Solana
 * Price: $0.25 USDC per job
 * APIs: DexScreener (free), Basescan (free)
 */

import 'dotenv/config';
import axios from 'axios';
import { buildAcpClient } from './acp.js';

const AGENT_NAME = 'GSB Token Analyst';
const JOB_PRICE = 0.25;

async function analyzeToken(contractAddress) {
  try {
    const dexRes = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`,
      { timeout: 8000 }
    );

    const pairs = dexRes.data?.pairs;
    if (!pairs || pairs.length === 0) {
      return { error: 'No trading pairs found for this token on DexScreener.' };
    }

    const pair = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

    return {
      token: {
        name: pair.baseToken?.name || 'Unknown',
        symbol: pair.baseToken?.symbol || 'Unknown',
        address: contractAddress,
      },
      price: {
        usd: pair.priceUsd,
        change_5m: pair.priceChange?.m5 || 0,
        change_1h: pair.priceChange?.h1 || 0,
        change_24h: pair.priceChange?.h24 || 0,
      },
      liquidity_usd: pair.liquidity?.usd || 0,
      volume: {
        m5: pair.volume?.m5 || 0,
        h1: pair.volume?.h1 || 0,
        h24: pair.volume?.h24 || 0,
      },
      transactions: {
        buys_24h: pair.txns?.h24?.buys || 0,
        sells_24h: pair.txns?.h24?.sells || 0,
      },
      market_cap: pair.marketCap || pair.fdv || 0,
      dex: pair.dexId,
      pair_address: pair.pairAddress,
      dexscreener_url: `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`,
      gsb_verdict: generateVerdict(pair),
      analyzed_at: new Date().toISOString(),
    };
  } catch (err) {
    return { error: `Analysis failed: ${err.message}` };
  }
}

function generateVerdict(pair) {
  const liq = pair.liquidity?.usd || 0;
  const vol24h = pair.volume?.h24 || 0;
  const change24h = pair.priceChange?.h24 || 0;

  if (liq > 100000 && vol24h > 50000 && change24h > 10) return '🔥 BULLISH — Strong liquidity, high volume, upward momentum.';
  if (liq > 50000 && vol24h > 10000) return '👀 WATCH — Decent setup. Monitor for breakout.';
  if (liq < 5000) return '⚠️ RISKY — Low liquidity. High rug potential.';
  return '📊 NEUTRAL — Average activity. No clear signal.';
}

async function start() {
  console.log(`[${AGENT_NAME}] Starting ACP provider...`);

  const client = await buildAcpClient({
    privateKey: process.env.AGENT_WALLET_PRIVATE_KEY,
    entityId: parseInt(process.env.TOKEN_ANALYST_ENTITY_ID),
    agentWalletAddress: process.env.TOKEN_ANALYST_WALLET_ADDRESS,

    onNewTask: async (job, memoToSign) => {
      console.log(`[${AGENT_NAME}] New job received: ${job.id}`);
      try {
        const content = typeof job.description === 'string' ? job.description : JSON.stringify(job.description);
        const addressMatch = content.match(/0x[a-fA-F0-9]{40}/);
        const contractAddress = addressMatch ? addressMatch[0] : content.trim();

        if (!contractAddress || contractAddress.length < 10) {
          await client.respondJob(job.id, memoToSign?.id, false, 'Please provide a valid contract address.');
          return;
        }

        await client.respondJob(job.id, memoToSign?.id, true, `Accepted. Analyzing ${contractAddress}...`);
        const report = await analyzeToken(contractAddress);
        await client.deliverJob(job.id, { type: 'text', value: JSON.stringify(report, null, 2) });
        console.log(`[${AGENT_NAME}] Job ${job.id} delivered.`);
      } catch (err) {
        console.error(`[${AGENT_NAME}] Job ${job.id} failed:`, err.message);
        await client.deliverJob(job.id, { type: 'text', value: JSON.stringify({ error: err.message }) });
      }
    },

    onEvaluate: async (job) => {
      await client.evaluateJob(job.id, true, 'Token analysis delivered successfully.');
    },
  });

  console.log(`[${AGENT_NAME}] Online. Listening for jobs at $${JOB_PRICE} USDC each.`);
}

start().catch(console.error);
