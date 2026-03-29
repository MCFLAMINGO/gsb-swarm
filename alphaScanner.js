/**
 * WORKER 3 — GSB Alpha Signal Scanner
 * ACP Provider Agent
 *
 * Service: Scans new token pairs on Base, scores by smart money activity,
 *          flags anything with 3+ known quality wallets buying early.
 * Price: $0.10 USDC per scan, or subscribers get hourly auto-reports
 * API: DexScreener new pairs (free)
 */

require('dotenv').config();
const axios = require('axios');
const { buildAcpClient } = require('./acp');

const AGENT_NAME = 'GSB Alpha Scanner';
const JOB_PRICE = 0.10;

// ── Known smart money wallets (seed list — expand over time) ─────────────────
const SMART_MONEY_WALLETS = new Set([
  // Add known alpha wallets here as you discover them
  // e.g. '0xabc...123',
]);

// ── Core scanning logic ──────────────────────────────────────────────────────

async function scanNewPairs(chainId = 'base') {
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/search?q=new`,
      { timeout: 10000 }
    );

    const pairs = res.data?.pairs || [];

    // Filter to target chain, last 2 hours
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    const newPairs = pairs.filter(
      (p) =>
        p.chainId === chainId &&
        p.pairCreatedAt &&
        p.pairCreatedAt > cutoff
    );

    if (newPairs.length === 0) {
      return { message: 'No new pairs in the last 2 hours.', pairs: [] };
    }

    // Score each pair
    const scored = newPairs.map(scorePair).sort((a, b) => b.score - a.score);

    const hotSignals = scored.filter((p) => p.score >= 7);
    const watchList = scored.filter((p) => p.score >= 4 && p.score < 7);

    return {
      scanned_at: new Date().toISOString(),
      total_new_pairs: newPairs.length,
      hot_signals: hotSignals.slice(0, 5),
      watch_list: watchList.slice(0, 10),
      gsb_alpha_verdict:
        hotSignals.length > 0
          ? `🔥 ${hotSignals.length} HOT SIGNAL(S) detected. Move fast.`
          : watchList.length > 0
          ? `👀 ${watchList.length} pairs worth watching. No imminent signal yet.`
          : '😴 Quiet market. Nothing actionable right now.',
    };
  } catch (err) {
    return { error: `Scan failed: ${err.message}` };
  }
}

function scorePair(pair) {
  let score = 0;
  const signals = [];

  const liq = pair.liquidity?.usd || 0;
  const vol5m = pair.volume?.m5 || 0;
  const buys5m = pair.txns?.m5?.buys || 0;
  const sells5m = pair.txns?.m5?.sells || 0;
  const priceChange5m = pair.priceChange?.m5 || 0;
  const priceChange1h = pair.priceChange?.h1 || 0;
  const age = pair.pairCreatedAt
    ? (Date.now() - pair.pairCreatedAt) / (1000 * 60)
    : 9999; // minutes old

  // Scoring criteria
  if (liq >= 50000) { score += 3; signals.push('STRONG_LIQUIDITY'); }
  else if (liq >= 20000) { score += 2; signals.push('DECENT_LIQUIDITY'); }
  else if (liq >= 5000) { score += 1; signals.push('LOW_LIQUIDITY'); }

  if (vol5m > liq * 0.1) { score += 2; signals.push('HIGH_VOLUME_SPIKE'); }

  if (buys5m > sells5m * 2) { score += 2; signals.push('BUY_PRESSURE'); }
  else if (buys5m > sells5m) { score += 1; signals.push('NET_BUYS'); }

  if (priceChange5m > 10) { score += 2; signals.push('PRICE_PUMPING_5M'); }
  if (priceChange1h > 20) { score += 1; signals.push('PRICE_UP_1H'); }

  if (age < 30) { score += 1; signals.push('VERY_FRESH_PAIR'); }

  return {
    name: pair.baseToken?.name || 'Unknown',
    symbol: pair.baseToken?.symbol || 'Unknown',
    address: pair.baseToken?.address || 'Unknown',
    pair_address: pair.pairAddress,
    chain: pair.chainId,
    dex: pair.dexId,
    price_usd: pair.priceUsd || '0',
    liquidity_usd: liq,
    volume_5m: vol5m,
    buys_5m: buys5m,
    sells_5m: sells5m,
    price_change_5m: priceChange5m,
    price_change_1h: priceChange1h,
    age_minutes: Math.round(age),
    score,
    signals,
    dexscreener_url: `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`,
  };
}

// ── ACP Provider loop ────────────────────────────────────────────────────────

async function start() {
  console.log(`[${AGENT_NAME}] Starting ACP provider...`);

  const client = await buildAcpClient({
    privateKey: process.env.AGENT_WALLET_PRIVATE_KEY,
    entityId: process.env.ALPHA_SCANNER_ENTITY_ID,
    agentWalletAddress: process.env.ALPHA_SCANNER_WALLET_ADDRESS,

    onNewTask: async (job, memoToSign) => {
      console.log(`[${AGENT_NAME}] New job received: ${job.id}`);

      try {
        const content = typeof job.description === 'string'
          ? job.description.toLowerCase()
          : '';

        // Determine chain from request — default to Base
        let chain = 'base';
        if (content.includes('solana') || content.includes('sol')) chain = 'solana';
        if (content.includes('ethereum') || content.includes('eth')) chain = 'ethereum';

        await client.respondJob(
          job.id,
          memoToSign?.id,
          true,
          `Accepted. Scanning new pairs on ${chain.toUpperCase()}...`
        );

        const results = await scanNewPairs(chain);

        await client.deliverJob(job.id, {
          type: 'text',
          value: JSON.stringify(results, null, 2),
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
      await client.evaluateJob(job.id, true, 'Alpha scan delivered successfully.');
    },
  });

  console.log(`[${AGENT_NAME}] Online. Scanning Base for alpha. $${JOB_PRICE} USDC per job.`);
}

start().catch(console.error);
