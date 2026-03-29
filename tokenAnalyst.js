/**
 * WORKER 1 — GSB Token Analyst
 * ACP Provider Agent
 * 
 * Service: Full token report for any contract address on Base/Solana
 * Price: $0.25 USDC per job
 * APIs: DexScreener (free), Basescan (free)
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const axios = require('axios');
const { buildAcpClient } = require('../utils/acp');

const AGENT_NAME = 'GSB Token Analyst';
const JOB_PRICE = 0.25;

// ── Core analysis logic ─────────────────────────────────────────────────────

async function analyzeToken(contractAddress) {
  try {
    // DexScreener — price, volume, liquidity, pair info
    const dexRes = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`,
      { timeout: 8000 }
    );

    const pairs = dexRes.data?.pairs;
    if (!pairs || pairs.length === 0) {
      return { error: 'No trading pairs found for this token on DexScreener.' };
    }

    // Pick highest liquidity pair
    const pair = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

    const report = {
      token: {
        name: pair.baseToken?.name || 'Unknown',
        symbol: pair.baseToken?.symbol || 'Unknown',
        address: contractAddress,
      },
      price: {
        usd: pair.priceUsd || '0',
        change_5m: pair.priceChange?.m5 || 0,
        change_1h: pair.priceChange?.h1 || 0,
        change_24h: pair.priceChange?.h24 || 0,
      },
      liquidity: {
        usd: pair.liquidity?.usd || 0,
        base: pair.liquidity?.base || 0,
        quote: pair.liquidity?.quote || 0,
      },
      volume: {
        m5: pair.volume?.m5 || 0,
        h1: pair.volume?.h1 || 0,
        h24: pair.volume?.h24 || 0,
      },
      market_cap: pair.marketCap || pair.fdv || 'Unknown',
      fdv: pair.fdv || 'Unknown',
      txns_24h: {
        buys: pair.txns?.h24?.buys || 0,
        sells: pair.txns?.h24?.sells || 0,
      },
      dex: pair.dexId || 'Unknown',
      chain: pair.chainId || 'Unknown',
      pair_address: pair.pairAddress || 'Unknown',
      pair_created_at: pair.pairCreatedAt
        ? new Date(pair.pairCreatedAt).toISOString()
        : 'Unknown',
      rug_risk: assessRugRisk(pair),
      gsb_verdict: generateVerdict(pair),
    };

    return report;
  } catch (err) {
    return { error: `Analysis failed: ${err.message}` };
  }
}

function assessRugRisk(pair) {
  const risks = [];
  const liq = pair.liquidity?.usd || 0;
  const vol24 = pair.volume?.h24 || 0;
  const age = pair.pairCreatedAt
    ? (Date.now() - pair.pairCreatedAt) / (1000 * 60 * 60 * 24)
    : 999;

  if (liq < 10000) risks.push('LOW_LIQUIDITY');
  if (vol24 > liq * 5) risks.push('SUSPICIOUS_VOLUME_RATIO');
  if (age < 1) risks.push('VERY_NEW_PAIR');
  if ((pair.txns?.h24?.sells || 0) > (pair.txns?.h24?.buys || 0) * 2) risks.push('HEAVY_SELL_PRESSURE');
  if ((pair.priceChange?.h24 || 0) < -50) risks.push('MASSIVE_DUMP_24H');

  if (risks.length === 0) return { level: 'LOW', flags: [] };
  if (risks.length <= 2) return { level: 'MEDIUM', flags: risks };
  return { level: 'HIGH', flags: risks };
}

function generateVerdict(pair) {
  const liq = pair.liquidity?.usd || 0;
  const change24h = pair.priceChange?.h24 || 0;
  const buys = pair.txns?.h24?.buys || 0;
  const sells = pair.txns?.h24?.sells || 0;

  if (liq > 100000 && change24h > 0 && buys > sells) return '🟢 BULLISH — Strong liquidity, positive momentum, buy pressure dominant.';
  if (liq > 50000 && change24h > -10) return '🟡 NEUTRAL — Decent liquidity, watch for direction.';
  if (liq < 10000) return '🔴 HIGH RISK — Low liquidity. Approach with extreme caution.';
  return '🟡 NEUTRAL — Mixed signals. DYOR.';
}

// ── ACP Provider loop ────────────────────────────────────────────────────────

async function start() {
  console.log(`[${AGENT_NAME}] Starting ACP provider...`);

  const client = await buildAcpClient({
    privateKey: process.env.AGENT_WALLET_PRIVATE_KEY,
    entityId: process.env.TOKEN_ANALYST_ENTITY_ID,
    agentWalletAddress: process.env.TOKEN_ANALYST_WALLET_ADDRESS,

    onNewTask: async (job, memoToSign) => {
      console.log(`[${AGENT_NAME}] New job received: ${job.id}`);

      try {
        // Parse the contract address from job description/content
        const content = typeof job.description === 'string'
          ? job.description
          : JSON.stringify(job.description);

        const addressMatch = content.match(/0x[a-fA-F0-9]{40}/);
        const contractAddress = addressMatch
          ? addressMatch[0]
          : content.trim().replace(/\s/g, '');

        if (!contractAddress) {
          await client.respondJob(job.id, memoToSign?.id, false, 'No valid contract address provided.');
          return;
        }

        // Accept the job
        await client.respondJob(job.id, memoToSign?.id, true, `Accepted. Analyzing ${contractAddress}...`);

        // Run analysis
        const report = await analyzeToken(contractAddress);

        // Deliver result
        const deliverable = JSON.stringify(report, null, 2);
        await client.deliverJob(job.id, { type: 'text', value: deliverable });

        console.log(`[${AGENT_NAME}] Job ${job.id} delivered successfully.`);
      } catch (err) {
        console.error(`[${AGENT_NAME}] Job ${job.id} failed:`, err.message);
        await client.deliverJob(job.id, {
          type: 'text',
          value: JSON.stringify({ error: err.message }),
        });
      }
    },

    onEvaluate: async (job) => {
      // Auto-evaluate as complete
      console.log(`[${AGENT_NAME}] Evaluating job ${job.id}`);
      await client.evaluateJob(job.id, true, 'Token analysis delivered successfully.');
    },
  });

  console.log(`[${AGENT_NAME}] Online. Listening for jobs at $${JOB_PRICE} USDC each.`);
}

start().catch(console.error);
