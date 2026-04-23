/**
 * GSB Token Analysis Engine
 * Returns Ethy-compatible token_ai_analysis_trade_suggestion JSON
 * 
 * Usage: node token_analysis.js <tokenAddress|ticker>
 */

const nvim = require('../lib/nvim');
const axios = require('axios');

const TOKEN_INPUT  = process.argv[2] || '$VIRTUAL';
const CHAIN_INPUT_RAW = (process.argv[3] || 'base').toLowerCase();
// Normalize to DexScreener chainId values
const CHAIN_MAP = { sol: 'solana', solana: 'solana', eth: 'ethereum', ethereum: 'ethereum', arb: 'arbitrum', arbitrum: 'arbitrum', matic: 'polygon', polygon: 'polygon', bsc: 'bsc', base: 'base' };
const CHAIN_INPUT = CHAIN_MAP[CHAIN_INPUT_RAW] || CHAIN_INPUT_RAW;

// ── Honeypot safety check ─────────────────────────────────────────────────────
const EVM_CHAINS  = ['base', 'ethereum', 'eth', 'polygon', 'avalanche', 'arbitrum', 'optimism', 'bsc'];
const NON_EVM_CHAINS = ['solana', 'sol', 'sui', 'aptos', 'ton'];
async function checkHoneypot(contractAddress, chain = 'base') {
  if (NON_EVM_CHAINS.includes((chain || '').toLowerCase()))
    return { isHoneypot: false, buyTax: null, sellTax: null, isBlacklisted: false, flags: ['non-evm'] };
  if (!contractAddress || typeof contractAddress !== 'string' || !contractAddress.trim().startsWith('0x') || contractAddress.trim().length < 10)
    return { isHoneypot: false, buyTax: null, sellTax: null, isBlacklisted: false, flags: ['no contract'] };
  const address = contractAddress.trim();
  const chainIdMap = { ethereum: 1, eth: 1, bsc: 56, polygon: 137, arbitrum: 42161, optimism: 10, base: 8453, avalanche: 43114 };
  const chainId = chainIdMap[(chain || '').toLowerCase()] || 8453;
  const url = `https://api.honeypot.is/v2/IsHoneypot?address=${encodeURIComponent(address)}&chainID=${chainId}`;
  try {
    const response = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json', 'User-Agent': 'GSB-SwarmBot/1.0' }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) return { isHoneypot: false, buyTax: null, sellTax: null, isBlacklisted: false, flags: ['check failed'] };
    const data = await response.json();
    const isHoneypot    = !!(data.honeypotResult?.isHoneypot ?? data.isHoneypot ?? false);
    const buyTax        = data.simulationResult?.buyTax  ?? null;
    const sellTax       = data.simulationResult?.sellTax ?? null;
    const isBlacklisted = !!(data.flags?.includes?.('blacklist') || false);
    const derivedFlags  = Array.isArray(data.flags) ? [...data.flags] : [];
    if (!isHoneypot && sellTax !== null && sellTax > 10) derivedFlags.push(`high-sell-tax:${sellTax}%`);
    if (!isHoneypot && buyTax  !== null && buyTax  > 10) derivedFlags.push(`high-buy-tax:${buyTax}%`);
    return { isHoneypot, buyTax, sellTax, isBlacklisted, flags: derivedFlags };
  } catch (err) {
    console.warn(`[checkHoneypot] Error for ${address}:`, err.message);
    return { isHoneypot: false, buyTax: null, sellTax: null, isBlacklisted: false, flags: ['check failed'] };
  }
}
// ANTHROPIC_KEY removed — using NVIDIA NIM

async function getTokenData(input) {
  // Try DexScreener first
  let dexData = null;
  try {
    // Detect both EVM (0x...) and Solana (base58, 32-44 chars) addresses
    const isEvmAddress = input.startsWith('0x') && input.length === 42;
    const isSolAddress = !input.startsWith('0x') && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input);
    const isAddress = isEvmAddress || isSolAddress;
    const url = isAddress
      ? `https://api.dexscreener.com/latest/dex/tokens/${input}`
      : `https://api.dexscreener.com/latest/dex/search?q=${input.replace('$','')}`;
    const res = await axios.get(url, { timeout: 8000 });
    let pairs = res.data?.pairs || [];

    // If token lookup returned nothing, try as a pair address (e.g. PumpSwap pool)
    if (!pairs.length && isAddress) {
      const chainSlug = CHAIN_INPUT === 'ethereum' ? 'ethereum' : CHAIN_INPUT;
      try {
        const pairRes = await axios.get(`https://api.dexscreener.com/latest/dex/pairs/${chainSlug}/${input}`, { timeout: 8000 });
        const pairPairs = pairRes.data?.pairs || [];
        if (pairPairs.length) {
          // Re-lookup by the actual token mint
          const tokenMint = pairPairs[0]?.baseToken?.address;
          if (tokenMint && tokenMint !== input) {
            const mintRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`, { timeout: 8000 });
            pairs = mintRes.data?.pairs || pairPairs;
          } else {
            pairs = pairPairs;
          }
        }
      } catch {}
    }

    // Filter to requested chain; fall back to all chains sorted by liquidity
    let basePairs = pairs.filter(p => p.chainId === CHAIN_INPUT);
    if (!basePairs.length) basePairs = pairs; // fallback: any chain
    basePairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    if (basePairs.length > 0) {
      const p = basePairs[0];
      dexData = {
        symbol:          p.baseToken?.symbol || '',
        name:            p.baseToken?.name || '',
        contractAddress: p.baseToken?.address || '',
        currentPrice:    parseFloat(p.priceUsd || '0'),
        volume24h:       p.volume?.h24 || 0,
        priceChange24h:  p.priceChange?.h24 || 0,
        priceChange1h:   p.priceChange?.h1 || 0,
        priceChange6h:   p.priceChange?.h6 || 0,
        liquidity:       p.liquidity?.usd || 0,
        marketCap:       p.marketCap || 0,
        pairAddress:     p.pairAddress || '',
        txns24h:         { buys: p.txns?.h24?.buys || 0, sells: p.txns?.h24?.sells || 0 },
        high24h:         parseFloat(p.priceUsd || '0') * (1 + Math.abs(p.priceChange?.h24 || 0) / 100),
        low24h:          parseFloat(p.priceUsd || '0') * (1 - Math.abs(p.priceChange?.h24 || 0) / 100),
      };
    }
  } catch (e) {
    console.error('[dex] Error:', e.message);
  }

  // Try CoinGecko for additional data
  let cgData = null;
  try {
    const ticker = (input.replace('$', '')).toLowerCase();
    const cgRes = await axios.get(
      `https://api.coingecko.com/api/v3/coins/${ticker}?localization=false&tickers=false&community_data=false&developer_data=false`,
      { timeout: 8000 }
    );
    const d = cgRes.data;
    cgData = {
      image: d.image?.large || d.image?.small || '',
      marketCap: d.market_data?.market_cap?.usd || 0,
      volume24h: d.market_data?.total_volume?.usd || 0,
      ath: d.market_data?.ath?.usd || 0,
      atl: d.market_data?.atl?.usd || 0,
    };
  } catch {
    // CoinGecko failed — try by contract address
    if (dexData?.contractAddress) {
      try {
        const cgRes2 = await axios.get(
          `https://api.coingecko.com/api/v3/coins/base/contract/${dexData.contractAddress}`,
          { timeout: 8000 }
        );
        const d = cgRes2.data;
        cgData = {
          image: d.image?.large || '',
          marketCap: d.market_data?.market_cap?.usd || 0,
          volume24h: d.market_data?.total_volume?.usd || 0,
        };
      } catch {}
    }
  }

  return { dex: dexData, cg: cgData };
}

function calculateTechnicals(price, priceChange24h, priceChange1h, priceChange6h, high24h, low24h, volume24h, liquidity) {
  // Support/resistance based on recent price action
  const range = high24h - low24h;
  const supportLevels = [
    parseFloat((price * 0.95).toFixed(8)),
    parseFloat((price * 0.85).toFixed(8)),
    parseFloat((price * 0.70).toFixed(8)),
    parseFloat((low24h * 0.90).toFixed(8)),
  ].sort((a, b) => b - a);

  const resistanceLevels = [
    parseFloat((price * 1.10).toFixed(8)),
    parseFloat((price * 1.25).toFixed(8)),
    parseFloat((price * 1.50).toFixed(8)),
    parseFloat((high24h * 1.15).toFixed(8)),
  ].sort((a, b) => a - b);

  // Trend determination
  const isBullish = priceChange24h > 5 || (priceChange1h > 0 && priceChange6h > 0);
  const isBearish = priceChange24h < -10 || (priceChange1h < 0 && priceChange6h < 0 && priceChange24h < -5);
  const trend = isBullish ? 'bullish' : isBearish ? 'bearish' : 'neutral';

  // Patterns
  const patterns = [];
  if (priceChange24h > 10) patterns.push('Strong momentum breakout');
  if (priceChange1h > 0 && priceChange24h > 0) patterns.push('Higher-low structure');
  if (Math.abs(priceChange1h) < 1 && priceChange24h > 5) patterns.push('Bull-flag / continuation');
  if (priceChange24h < -15) patterns.push('Oversold bounce candidate');
  if (priceChange24h > 50) patterns.push('Parabolic move — caution');
  if (patterns.length === 0) patterns.push('Consolidation / range-bound');

  // Entry zone
  const entryMin = parseFloat((price * (isBullish ? 0.92 : 0.85)).toFixed(8));
  const entryMax = parseFloat((price * (isBullish ? 0.98 : 0.95)).toFixed(8));

  // Targets
  const targets = [
    parseFloat((price * 1.15).toFixed(8)),
    parseFloat((price * 1.35).toFixed(8)),
    parseFloat((price * 1.70).toFixed(8)),
    parseFloat((high24h * 1.20).toFixed(8)),
  ].sort((a, b) => a - b);

  // Recommendation
  let recommendation = 'HOLD';
  let confidence = 50;
  if (isBullish && liquidity > 50000) { recommendation = 'BUY'; confidence = 65; }
  if (priceChange24h > 20 && liquidity > 100000) { recommendation = 'BUY'; confidence = 72; }
  if (isBearish) { recommendation = 'AVOID'; confidence = 60; }
  if (liquidity < 10000) { recommendation = 'AVOID'; confidence = 70; } // Too illiquid
  // NOTE: honeypot override applied after safetyCheck resolves in analyzeToken()

  const summaryShort = isBullish
    ? `Bullish momentum. Pullback buy $${entryMin}–$${entryMax}`
    : isBearish
    ? `Bearish pressure. Wait for stabilization above $${supportLevels[0]}`
    : `Neutral. Range-bound between $${supportLevels[0]} – $${resistanceLevels[0]}`;

  return { trend, supportLevels, resistanceLevels, patterns, entryZone: { min: entryMin, max: entryMax }, targets, recommendation, confidence, summaryShort };
}

async function generateAISummary(tokenData, technicals) {
  if (!nvim.isReady()) {
    // No NVIDIA key — return deterministic summary from technicals
    return {
      summary: `${tokenData.symbol} momentum is ${technicals.trend}. ${technicals.recommendation} at current levels with entry around $${technicals.entryZone.min}–$${technicals.entryZone.max}.`,
      summary_advanced: `Technical picture: ${technicals.patterns.join('; ')}. Support at $${technicals.supportLevels[0]}, target $${technicals.targets[0]}. Confidence: ${technicals.confidence}%.`,
    };
  }
  try {
    const text = await nvim.nvimChat(
      'You are a crypto trading analyst. Return ONLY valid JSON with keys "summary" and "summary_advanced". No markdown, no explanation.',
      prompt, 400
    );
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('[ai] NVIDIA error:', e.message);
  }

  try {
    const prompt = `You are a crypto trading analyst. Given this data, write two brief analyses:

Token: ${tokenData.name} (${tokenData.symbol})
Price: $${tokenData.currentPrice}
24h Change: ${tokenData.priceChange24h?.toFixed(2)}%
1h Change: ${(technicals.trend === 'bullish' ? '+' : '')}${Math.abs(tokenData.priceChange1h || 0).toFixed(2)}%
Volume 24h: $${Number(tokenData.volume24h || 0).toLocaleString()}
Liquidity: $${Number(tokenData.liquidity || 0).toLocaleString()}
Trend: ${technicals.trend}
Patterns: ${technicals.patterns.join(', ')}
Recommendation: ${technicals.recommendation} (${technicals.confidence}% confidence)

Write:
1. "summary" (2 sentences, casual, actionable — like a trader friend)
2. "summary_advanced" (3 sentences, technical, professional)

Return ONLY valid JSON: {"summary": "...", "summary_advanced": "..."}`;

    const text = await nvim.nvimChat(
      'You are a crypto trading analyst. Return ONLY valid JSON with keys "summary" and "summary_advanced". No markdown, no explanation.',
      prompt, 400
    );
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('[ai] Error:', e.message);
  }

  return {
    summary: `${tokenData.symbol} momentum is ${technicals.trend}. ${technicals.recommendation} at current levels with entry around $${technicals.entryZone.min}–$${technicals.entryZone.max}.`,
    summary_advanced: `Technical picture: ${technicals.patterns.join('; ')}. Support at $${technicals.supportLevels[0]}, target $${technicals.targets[0]}. Confidence: ${technicals.confidence}%.`,
  };
}

async function analyzeToken(input) {
  const { dex, cg } = await getTokenData(input);

  if (!dex) {
    return { error: `Token ${input} not found on ${CHAIN_INPUT.toUpperCase()} — check the symbol or contract address`, input };
  }

  // ── Safety check (honeypot.is) ───────────────────────────────────────────────
  const safetyCheck = await checkHoneypot(dex.contractAddress, CHAIN_INPUT);

  const tech = calculateTechnicals(
    dex.currentPrice, dex.priceChange24h, dex.priceChange1h,
    dex.priceChange6h, dex.high24h, dex.low24h, dex.volume24h, dex.liquidity
  );

  const aiSummary = await generateAISummary({ ...dex, priceChange1h: dex.priceChange1h }, tech);

  // ── Honeypot override ────────────────────────────────────────────────────────
  let finalRecommendation = tech.recommendation;
  let finalConfidence     = tech.confidence;
  let finalPatterns       = [...tech.patterns];
  if (safetyCheck.isHoneypot) {
    finalRecommendation = 'AVOID';
    finalConfidence     = 99;
    finalPatterns       = ['HONEYPOT DETECTED', ...finalPatterns];
  }

  // Ethy-compatible output format
  const result = {
    symbol:          dex.symbol,
    name:            dex.name,
    image:           cg?.image || '',
    contractAddress: dex.contractAddress,
    currentPrice:    dex.currentPrice,
    analysis: {
      trend:            tech.trend,
      supportLevels:    tech.supportLevels,
      resistanceLevels: tech.resistanceLevels,
      patterns:         finalPatterns,
      summaryShort:     tech.summaryShort,
      entryZone:        tech.entryZone,
      targets:          tech.targets,
      summary:          aiSummary.summary,
      summary_advanced: aiSummary.summary_advanced,
      confidence:       finalConfidence,
      recommendation:   finalRecommendation,
    },
    safetyCheck: {
      isHoneypot:    safetyCheck.isHoneypot,
      buyTax:        safetyCheck.buyTax,
      sellTax:       safetyCheck.sellTax,
      isBlacklisted: safetyCheck.isBlacklisted,
      flags:         safetyCheck.flags,
    },
    marketData: {
      volume24h:     String(dex.volume24h),
      marketCap:     String(cg?.marketCap || dex.marketCap || 0),
      priceChange24h: dex.priceChange24h,
      liquidity:     dex.liquidity,
      txns24h:       dex.txns24h,
    },
    gsb_verdict:   finalRecommendation,
    gsb_signal:    `${tech.trend.toUpperCase()} — ${tech.summaryShort}`,
    analyzedAt:    new Date().toISOString(),
    source:        'GSB Token Analyst | bleeding.cash',
  };

  return result;
}

// Main
analyzeToken(TOKEN_INPUT).then(result => {
  console.log('ANALYSIS_RESULT:' + JSON.stringify(result));
}).catch(e => {
  console.error('ANALYSIS_ERROR:' + e.message);
  process.exit(1);
});
