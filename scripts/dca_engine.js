/**
 * GSB DCA Engine
 * Executes Dollar Cost Averaging orders on a schedule
 * Stores orders in /tmp/gsb-dca-orders.json
 */

const fs = require('fs');
const DCA_FILE = '/tmp/gsb-dca-orders.json';
const WALLETS_FILE = '/tmp/gsb-swap-wallets.json';

function loadOrders() {
  try { return JSON.parse(fs.readFileSync(DCA_FILE, 'utf8')); } catch { return {}; }
}
function saveOrders(data) {
  try { fs.writeFileSync(DCA_FILE, JSON.stringify(data, null, 2)); } catch {} 
}
function loadWallets() {
  try { return JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8')); } catch { return {}; }
}
function saveWallets(data) {
  try { fs.writeFileSync(WALLETS_FILE, JSON.stringify(data, null, 2)); } catch {}
}

// Frequency → milliseconds
const FREQ_MS = {
  hourly:  60 * 60 * 1000,
  daily:   24 * 60 * 60 * 1000,
  weekly:  7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

function createOrder({ userId, walletAddress, token, amount, frequency, chain = 'base', maxPrice = null, totalOrders = null }) {
  const orders = loadOrders();
  const id = `dca_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const order = {
    id, userId, walletAddress, token: token.toUpperCase(),
    amount: parseFloat(amount), frequency, chain,
    maxPrice: maxPrice ? parseFloat(maxPrice) : null,
    totalOrders: totalOrders ? parseInt(totalOrders) : null,
    executedCount: 0, totalSpent: 0,
    status: 'active',
    createdAt: Date.now(),
    nextExecuteAt: Date.now() + 60000, // First execution in 1 minute
    history: [],
  };
  if (!orders[userId]) orders[userId] = {};
  orders[userId][id] = order;
  saveOrders(orders);
  return order;
}

function listOrders(userId, walletAddress) {
  const orders = loadOrders();
  const userOrders = orders[userId] || {};
  return Object.values(userOrders).filter(o =>
    (!walletAddress || o.walletAddress === walletAddress) && o.status !== 'deleted'
  );
}

function stopOrder(userId, orderId) {
  const orders = loadOrders();
  if (orders[userId]?.[orderId]) {
    orders[userId][orderId].status = 'stopped';
    saveOrders(orders);
    return true;
  }
  return false;
}

function saveWallet({ userId, userName, walletAddress }) {
  const wallets = loadWallets();
  wallets[userId] = { userId, userName, walletAddress, connectedAt: Date.now() };
  saveWallets(wallets);
}

function getWallet(userId) {
  const wallets = loadWallets();
  return wallets[userId] || null;
}

// Get current price from DexScreener
async function getTokenPrice(token, chain = 'base') {
  try {
    const chainMap = { base: 'base', ethereum: 'ethereum', solana: 'solana', bsc: 'bsc', arbitrum: 'arbitrum', polygon: 'polygon' };
    const chainId = chainMap[chain] || 'base';
    const url = `https://api.dexscreener.com/latest/dex/search?q=${token}`;
    const res = await fetch(url);
    const data = await res.json();
    let pairs = (data.pairs || []).filter(p => p.chainId === chainId);
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const p = pairs[0];
    if (!p) return null;
    return {
      price: parseFloat(p.priceUsd || '0'),
      contractAddress: p.baseToken?.address,
      symbol: p.baseToken?.symbol,
      pairAddress: p.pairAddress,
    };
  } catch { return null; }
}

// Build Uniswap swap URL for a given order execution
function buildSwapUrl(order, contractAddress) {
  const chainParams = {
    base: 'base', ethereum: 'mainnet', solana: 'solana',
    bsc: 'bnb', arbitrum: 'arbitrum', polygon: 'polygon',
  };
  const chainParam = chainParams[order.chain] || 'base';
  const usdcAddress = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC on Base
  return `https://app.uniswap.org/swap?chain=${chainParam}&inputCurrency=${usdcAddress}&outputCurrency=${contractAddress}&exactAmount=${order.amount}&exactField=input`;
}

// Execute all due DCA orders and return results
async function executeDueDCAs(tgNotify) {
  const orders = loadOrders();
  const now = Date.now();
  const results = [];

  for (const userId of Object.keys(orders)) {
    for (const orderId of Object.keys(orders[userId])) {
      const order = orders[userId][orderId];
      if (order.status !== 'active') continue;
      if (order.nextExecuteAt > now) continue;

      // Check total orders limit
      if (order.totalOrders && order.executedCount >= order.totalOrders) {
        order.status = 'completed';
        saveOrders(orders);
        continue;
      }

      try {
        // Get current price
        const priceData = await getTokenPrice(order.token, order.chain);
        if (!priceData) {
          console.log(`[dca] Could not get price for ${order.token}, skipping`);
          order.nextExecuteAt = now + FREQ_MS[order.frequency];
          saveOrders(orders);
          continue;
        }

        // Check max price condition
        if (order.maxPrice && priceData.price > order.maxPrice) {
          console.log(`[dca] ${order.token} price $${priceData.price} > max $${order.maxPrice}, skipping`);
          order.nextExecuteAt = now + FREQ_MS[order.frequency];
          saveOrders(orders);
          if (tgNotify) {
            await tgNotify(userId, `⏸ DCA *${order.token}* skipped — price $${priceData.price.toFixed(8)} above max $${order.maxPrice}`);
          }
          continue;
        }

        // Build swap URL
        const swapUrl = buildSwapUrl(order, priceData.contractAddress);
        const tokensReceived = order.amount / priceData.price;

        // Record execution
        const execution = {
          executedAt: now,
          price: priceData.price,
          amountUsd: order.amount,
          tokensReceived,
          swapUrl,
        };
        order.history.push(execution);
        order.executedCount += 1;
        order.totalSpent += order.amount;
        order.nextExecuteAt = now + FREQ_MS[order.frequency];

        saveOrders(orders);
        results.push({ order, execution, priceData });

        // Notify user via Telegram
        if (tgNotify) {
          const avg = order.totalSpent / order.executedCount / (order.totalSpent / priceData.price / order.executedCount);
          const msg =
            `⚡ *DCA Executed #${order.executedCount}*\n\n` +
            `Token: *${order.token}* (${order.chain})\n` +
            `Bought: ~${tokensReceived.toFixed(4)} ${order.token}\n` +
            `Spent: $${order.amount} USDC\n` +
            `Price: $${priceData.price.toFixed(8)}\n` +
            `Total invested: $${order.totalSpent}\n\n` +
            `[Complete swap on Uniswap](${swapUrl})\n\n` +
            `_Next buy: ${new Date(order.nextExecuteAt).toLocaleString()}_`;
          await tgNotify(userId, msg);
        }

        console.log(`[dca] Executed ${order.token} for user ${userId} at $${priceData.price}`);
      } catch(e) {
        console.error(`[dca] Error executing order ${orderId}:`, e.message);
        order.nextExecuteAt = now + FREQ_MS[order.frequency];
        saveOrders(orders);
      }
    }
  }
  return results;
}

// Search tokens across chains
async function searchTokens(query, chain = 'base') {
  try {
    const chainMap = { base: 'base', ethereum: 'ethereum', solana: 'solana', bsc: 'bsc', arbitrum: 'arbitrum', polygon: 'polygon' };
    const chainId = chainMap[chain] || 'base';
    const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    const data = await res.json();
    const pairs = (data.pairs || [])
      .filter(p => p.chainId === chainId)
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))
      .slice(0, 5);
    return pairs.map(p => ({
      symbol: p.baseToken?.symbol,
      name: p.baseToken?.name,
      address: p.baseToken?.address,
      price: parseFloat(p.priceUsd || '0'),
      change24h: p.priceChange?.h24 || 0,
      liquidity: p.liquidity?.usd || 0,
    }));
  } catch { return []; }
}

// Get quote for swap
async function getQuote(tokenIn, tokenOut, amount, chain = 'base') {
  const priceData = await getTokenPrice(tokenOut, chain);
  if (!priceData) return null;
  return {
    price: priceData.price,
    change24h: 0,
    contractAddress: priceData.contractAddress,
    estimatedOut: amount / priceData.price,
  };
}

// Get wallet portfolio via DexScreener
async function getPortfolio(walletAddress) {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${walletAddress}`);
    const d = await r.json();
    return { tokens: [] }; // DexScreener doesn't support wallet lookup, return empty
  } catch { return { tokens: [] }; }
}

module.exports = {
  createOrder, listOrders, stopOrder,
  saveWallet, getWallet,
  executeDueDCAs,
  searchTokens, getQuote, getTokenPrice,
  getPortfolio, buildSwapUrl,
};
