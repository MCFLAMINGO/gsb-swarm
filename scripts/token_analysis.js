/**
 * GSB Token Analysis Engine
 * Returns Ethy-compatible token_ai_analysis_trade_suggestion JSON
 * 
 * Usage: node token_analysis.js <tokenAddress|ticker>
 */

const axios = require('axios');

const TOKEN_INPUT = process.argv[2] || '$VIRTUAL';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

async function getTokenData(input) {
  // Try DexScreener first
  let dexData = null;
  try {
    const isAddress = input.startsWith('0x');
    const url = isAddress
      ? `https://api.dexscreener.com/latest/dex/tokens/${input}`
      : `https://api.dexscreener.com/latest/dex/search?q=${input.replace('$','')}`;
    const res = await axios.get(url, { timeout: 8000 });
    const pairs = res.data?.pairs || [];
    // Filter to Base, sort by liquidity
    const basePairs = pairs.filter(p => p.chainId === 'base');
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

  const summaryShort = isBullish
    ? `Bullish momentum. Pullback buy $${entryMin}–$${entryMax}`
    : isBearish
    ? `Bearish pressure. Wait for stabilization above $${supportLevels[0]}`
    : `Neutral. Range-bound between $${supportLevels[0]} – $${resistanceLevels[0]}`;

  return { trend, supportLevels, resistanceLevels, patterns, entryZone: { min: entryMin, max: entryMax }, targets, recommendation, confidence, summaryShort };
}

async function generateAISummary(tokenData, technicals) {
  if (!ANTHROPIC_KEY) {
    return {
      summary: `${tokenData.symbol} is ${technicals.trend} with ${tokenData.priceChange24h?.toFixed(2)}% 24h change. ${technicals.recommendation} recommendation based on current momentum and liquidity ($${(tokenData.liquidity || 0).toLocaleString()}).`,
      summary_advanced: `Technical picture: ${tokenData.symbol} shows ${technicals.trend} characteristics. Key support at $${technicals.supportLevels[0]}, resistance at $${technicals.resistanceLevels[0]}. Volume of $${Number(tokenData.volume24h || 0).toLocaleString()} in 24h indicates ${Number(tokenData.volume24h || 0) > 100000 ? 'strong' : 'moderate'} activity.`,
    };
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

    const res = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      },
      { headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 15000 }
    );
    const text = res.data.content[0].text.trim();
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
    return { error: `Token ${input} not found on Base DEX`, input };
  }

  const tech = calculateTechnicals(
    dex.currentPrice, dex.priceChange24h, dex.priceChange1h,
    dex.priceChange6h, dex.high24h, dex.low24h, dex.volume24h, dex.liquidity
  );

  const aiSummary = await generateAISummary({ ...dex, priceChange1h: dex.priceChange1h }, tech);

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
      patterns:         tech.patterns,
      summaryShort:     tech.summaryShort,
      entryZone:        tech.entryZone,
      targets:          tech.targets,
      summary:          aiSummary.summary,
      summary_advanced: aiSummary.summary_advanced,
      confidence:       tech.confidence,
      recommendation:   tech.recommendation,
    },
    marketData: {
      volume24h:     String(dex.volume24h),
      marketCap:     String(cg?.marketCap || dex.marketCap || 0),
      priceChange24h: dex.priceChange24h,
      liquidity:     dex.liquidity,
      txns24h:       dex.txns24h,
    },
    gsb_verdict:   tech.recommendation,
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
