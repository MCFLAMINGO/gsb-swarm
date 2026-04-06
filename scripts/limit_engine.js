const fs = require('fs');
const { getTokenPrice, buildSwapUrl } = require('./dca_engine');

const LIMIT_FILE = '/tmp/gsb-limit-orders.json';

function loadLimitOrders() {
  try {
    if (!fs.existsSync(LIMIT_FILE)) return {};
    const raw = fs.readFileSync(LIMIT_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('[LimitEngine] Failed to load limit orders:', e.message);
    return {};
  }
}

function saveLimitOrders(data) {
  try {
    fs.writeFileSync(LIMIT_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[LimitEngine] Failed to save limit orders:', e.message);
  }
}

function createLimitOrder({ userId, walletAddress, token, amount, chain, triggerPrice, direction, expireHours }) {
  if (!userId || !walletAddress || !token || !amount || !chain || !triggerPrice || !direction) {
    throw new Error('Missing required fields for limit order');
  }
  if (direction !== 'above' && direction !== 'below') {
    throw new Error('direction must be "above" or "below"');
  }

  const hours = typeof expireHours === 'number' && expireHours > 0 ? expireHours : 72;
  const now = Date.now();
  const id = `limit_${now}_${Math.random().toString(36).slice(2, 8)}`;

  const order = {
    id,
    userId,
    walletAddress,
    token,
    amount,
    chain,
    triggerPrice: Number(triggerPrice),
    direction,
    status: 'active',
    createdAt: now,
    expiresAt: now + hours * 3600000,
  };

  const data = loadLimitOrders();
  if (!data[userId]) data[userId] = {};
  data[userId][id] = order;
  saveLimitOrders(data);

  return order;
}

function listLimitOrders(userId, walletAddress) {
  const data = loadLimitOrders();
  const userOrders = data[userId] || {};
  const now = Date.now();

  return Object.values(userOrders).filter(order => {
    if (order.status === 'cancelled' || order.status === 'deleted') return false;
    if (walletAddress && order.walletAddress !== walletAddress) return false;
    // exclude expired orders that have already been marked expired
    if (order.status === 'expired') return false;
    // exclude orders whose expiry has passed even if not yet marked
    if (order.expiresAt && order.expiresAt < now && order.status === 'active') return false;
    return true;
  });
}

function cancelLimitOrder(userId, orderId) {
  const data = loadLimitOrders();
  if (!data[userId] || !data[userId][orderId]) {
    throw new Error('Order not found');
  }
  if (data[userId][orderId].status !== 'active') {
    throw new Error('Order is not active');
  }
  data[userId][orderId].status = 'cancelled';
  data[userId][orderId].cancelledAt = Date.now();
  saveLimitOrders(data);
  return data[userId][orderId];
}

function buildLimitSwapUrl(order) {
  // Use the same Uniswap deep link pattern as DCA
  const chain = (order.chain || 'base').toLowerCase();
  const token = encodeURIComponent(order.token);
  const amount = encodeURIComponent(order.amount);

  if (order.direction === 'below') {
    // Buy the dip: spend USDC to get TOKEN
    return `https://app.uniswap.org/swap?chain=${chain}&inputCurrency=USDC&outputCurrency=${token}&exactAmount=${amount}&exactField=input`;
  } else {
    // Take profit: sell TOKEN for USDC
    return `https://app.uniswap.org/swap?chain=${chain}&inputCurrency=${token}&outputCurrency=USDC&exactAmount=${amount}&exactField=input`;
  }
}

async function checkAndExecute(tgNotify) {
  const data = loadLimitOrders();
  const now = Date.now();
  let dirty = false;

  for (const userId of Object.keys(data)) {
    const userOrders = data[userId];

    for (const orderId of Object.keys(userOrders)) {
      const order = userOrders[orderId];
      if (order.status !== 'active') continue;

      // Check expiry first
      if (order.expiresAt && order.expiresAt < now) {
        order.status = 'expired';
        order.expiredAt = now;
        dirty = true;

        try {
          await tgNotify(
            userId,
            `⏰ *Limit Order Expired*\n\n` +
            `Your limit order for *${order.token}* at $${order.triggerPrice} has expired.\n` +
            `_Create a new order to keep watching the price._`
          );
        } catch (notifyErr) {
          console.error(`[LimitEngine] Failed to notify user ${userId} of expiry:`, notifyErr.message);
        }
        continue;
      }

      // Fetch current price
      let currentPrice;
      try {
        currentPrice = await getTokenPrice(order.token, order.chain);
      } catch (priceErr) {
        console.error(`[LimitEngine] Failed to get price for ${order.token}:`, priceErr.message);
        continue;
      }

      if (currentPrice == null) continue;

      const triggered =
        (order.direction === 'below' && currentPrice <= order.triggerPrice) ||
        (order.direction === 'above' && currentPrice >= order.triggerPrice);

      if (triggered) {
        order.status = 'triggered';
        order.triggeredAt = now;
        order.triggeredPrice = currentPrice;
        dirty = true;

        let swapUrl;
        try {
          swapUrl = buildLimitSwapUrl(order);
        } catch (urlErr) {
          swapUrl = `https://app.uniswap.org/swap`;
        }

        const action = order.direction === 'below' ? `Buy $${order.amount} USDC` : `Sell $${order.amount}`;

        const msg =
          `🎯 *Limit Order Triggered!*\n\n` +
          `${order.token} hit $${currentPrice}\n` +
          `Your order: ${action}\n` +
          `[Execute swap now](${swapUrl})\n\n` +
          `_This link expires in 15 minutes_`;

        try {
          await tgNotify(userId, msg);
        } catch (notifyErr) {
          console.error(`[LimitEngine] Failed to notify user ${userId} of trigger:`, notifyErr.message);
        }
      }
    }
  }

  if (dirty) {
    saveLimitOrders(data);
  }
}

module.exports = {
  loadLimitOrders,
  saveLimitOrders,
  createLimitOrder,
  listLimitOrders,
  cancelLimitOrder,
  checkAndExecute,
};
