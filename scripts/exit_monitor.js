/**
 * GSB Exit Monitor — GFLOP-driven position manager
 * 
 * Monitors open positions after a buy-signal trade.
 * Exit rules (first trigger wins):
 *   1. Stop loss:    price drops -20% from entry
 *   2. Take profit:  price rises +50% from entry  
 *   3. Time stop:    4 hours elapsed with no profit
 *   4. GFLOP exit:  AKT + RNDR both flip bearish while in position
 * 
 * Usage: node exit_monitor.js <positionFile>
 * positionFile: JSON with { tokenAddress, tokenName, buyPrice, amountUsd, buyTimestamp, walletAddress }
 */

const { createWalletClient, createPublicClient, http, parseUnits, maxUint256, formatUnits } = require('viem');
const { base } = require('viem/chains');
const { privateKeyToAccount } = require('viem/accounts');
const fs   = require('fs');
const path = require('path');

const PRIVATE_KEY = process.env.AGENT_WALLET_PRIVATE_KEY;
const BASE_RPC    = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const USDC        = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH        = '0x4200000000000000000000000000000000000006';
const ROUTER      = '0x2626664c2603336E57B271c5C0b26F421741e481';
const COINGECKO   = 'https://api.coingecko.com/api/v3/simple/price?ids=akash-network,render-token&vs_currencies=usd&include_24hr_change=true';

const STOP_LOSS_PCT   = -0.20;  // -20%
const TAKE_PROFIT_PCT =  0.50;  // +50%
const TIME_STOP_MS    = 4 * 60 * 60 * 1000; // 4 hours
const PRICE_CHECK_MS  = 60_000;  // every 60s
const GFLOP_CHECK_MS  = 30 * 60_000; // every 30 min

// ── Position file ─────────────────────────────────────────────────────────────
const posFile = process.argv[2] || '/tmp/gsb-open-positions.json';

function loadPositions() {
  try {
    return JSON.parse(fs.readFileSync(posFile, 'utf8'));
  } catch {
    return {};
  }
}

function savePositions(positions) {
  fs.writeFileSync(posFile, JSON.stringify(positions, null, 2));
}

// ── Price fetch via DexScreener ───────────────────────────────────────────────
async function getTokenPrice(tokenAddress) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    const data = await res.json();
    const pairs = data.pairs || [];
    // Find highest liquidity pair
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const best = pairs[0];
    if (!best) return null;
    return {
      price: parseFloat(best.priceUsd || '0'),
      volume5m: best.volume?.m5 || 0,
      priceChange5m: best.priceChange?.m5 || 0,
      liquidity: best.liquidity?.usd || 0,
    };
  } catch (e) {
    console.error('[price] Error:', e.message);
    return null;
  }
}

// ── GFLOP signal check ────────────────────────────────────────────────────────
async function getGflopSignal() {
  try {
    const res = await fetch(COINGECKO);
    const data = await res.json();
    const akt  = data['akash-network']?.usd_24h_change || 0;
    const rndr = data['render-token']?.usd_24h_change || 0;
    const bothBearish = akt < -3 && rndr < -3;
    const bothBullish = akt > 2 && rndr > 2;
    return { akt, rndr, bothBearish, bothBullish };
  } catch {
    return { akt: 0, rndr: 0, bothBearish: false, bothBullish: false };
  }
}

// ── Sell executor ─────────────────────────────────────────────────────────────
async function executeSell(tokenAddress, tokenName, tokenBalance) {
  console.log(`[sell] Executing sell: ${tokenName} balance=${tokenBalance}`);

  const ERC20_ABI = [
    { name:'approve', type:'function', inputs:[{name:'spender',type:'address'},{name:'amount',type:'uint256'}], outputs:[{name:'',type:'bool'}] },
    { name:'allowance', type:'function', inputs:[{name:'owner',type:'address'},{name:'spender',type:'address'}], outputs:[{name:'',type:'uint256'}] },
    { name:'balanceOf', type:'function', inputs:[{name:'account',type:'address'}], outputs:[{name:'',type:'uint256'}] },
    { name:'decimals', type:'function', inputs:[], outputs:[{name:'',type:'uint8'}] },
  ];

  const MULTIHOP_ABI = [{
    name: 'exactInput',
    type: 'function',
    inputs: [{ name: 'params', type: 'tuple', components: [
      {name:'path',type:'bytes'},
      {name:'recipient',type:'address'},
      {name:'amountIn',type:'uint256'},
      {name:'amountOutMinimum',type:'uint256'},
    ]}],
    outputs: [{name:'amountOut',type:'uint256'}],
  }];

  const account = privateKeyToAccount(PRIVATE_KEY);
  const walletClient = createWalletClient({ account, chain: base, transport: http(BASE_RPC) });
  const publicClient = createPublicClient({ chain: base, transport: http(BASE_RPC) });

  // Get actual token balance
  const decimals = await publicClient.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: 'decimals' });
  const balance  = await publicClient.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });

  if (balance === 0n) {
    console.log('[sell] Balance is 0 — nothing to sell');
    return null;
  }

  // Approve token for router
  const allowance = await publicClient.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, ROUTER] });
  if (allowance < balance) {
    const approveTx = await walletClient.writeContract({ address: tokenAddress, abi: ERC20_ABI, functionName: 'approve', args: [ROUTER, maxUint256] });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    console.log('[sell] Token approved:', approveTx);
  }

  // Encode reverse path: TOKEN (fee 3000) -> WETH (fee 500) -> USDC
  const encodePath = (tokens, fees) => {
    let encoded = tokens[0].slice(2).toLowerCase();
    for (let i = 0; i < fees.length; i++) {
      encoded += fees[i].toString(16).padStart(6, '0');
      encoded += tokens[i+1].slice(2).toLowerCase();
    }
    return '0x' + encoded;
  };
  const path = encodePath([tokenAddress, WETH, USDC], [3000, 500]);

  const hash = await walletClient.writeContract({
    address: ROUTER,
    abi: MULTIHOP_ABI,
    functionName: 'exactInput',
    args: [{ path, recipient: account.address, amountIn: balance, amountOutMinimum: 0n }],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log('[sell] ✅ Sold:', hash);
  return hash;
}

// ── Telegram alert ────────────────────────────────────────────────────────────
async function tgAlert(msg) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat  = process.env.TELEGRAM_CHANNEL_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: msg, parse_mode: 'Markdown' }),
    });
  } catch {}
}

// ── Main monitor loop ─────────────────────────────────────────────────────────
async function monitor() {
  console.log('[exit-monitor] Starting GFLOP exit monitor...');
  if (!PRIVATE_KEY) { console.error('[exit-monitor] No PRIVATE_KEY'); process.exit(1); }

  let lastGflopCheck = 0;
  let gflopSignal = { bothBearish: false, bothBullish: false, akt: 0, rndr: 0 };

  while (true) {
    const positions = loadPositions();
    const openPositions = Object.entries(positions).filter(([, p]) => p.status === 'open');

    if (openPositions.length === 0) {
      await new Promise(r => setTimeout(r, PRICE_CHECK_MS));
      continue;
    }

    // Refresh GFLOP signal every 30 min
    if (Date.now() - lastGflopCheck > GFLOP_CHECK_MS) {
      gflopSignal = await getGflopSignal();
      lastGflopCheck = Date.now();
      console.log(`[gflop] AKT: ${gflopSignal.akt.toFixed(2)}% RNDR: ${gflopSignal.rndr.toFixed(2)}% bearish=${gflopSignal.bothBearish}`);
    }

    for (const [posId, pos] of openPositions) {
      const priceData = await getTokenPrice(pos.tokenAddress);
      if (!priceData) continue;

      const { price, liquidity } = priceData;
      const entryPrice  = pos.buyPrice;
      const pnlPct      = (price - entryPrice) / entryPrice;
      const ageMs       = Date.now() - pos.buyTimestamp;
      const ageHrs      = (ageMs / 3_600_000).toFixed(1);

      console.log(`[monitor] ${pos.tokenName}: entry=$${entryPrice.toFixed(8)} now=$${price.toFixed(8)} pnl=${(pnlPct*100).toFixed(1)}% age=${ageHrs}h liq=$${liquidity.toLocaleString()}`);

      let exitReason = null;

      if (pnlPct <= STOP_LOSS_PCT) {
        exitReason = `STOP LOSS — ${(pnlPct*100).toFixed(1)}% loss`;
      } else if (pnlPct >= TAKE_PROFIT_PCT) {
        exitReason = `TAKE PROFIT — +${(pnlPct*100).toFixed(1)}% gain`;
      } else if (ageMs >= TIME_STOP_MS && pnlPct < 0) {
        exitReason = `TIME STOP — 4hr elapsed, down ${(pnlPct*100).toFixed(1)}%`;
      } else if (gflopSignal.bothBearish && ageMs > 30 * 60_000) {
        exitReason = `GFLOP EXIT — AKT ${gflopSignal.akt.toFixed(1)}% RNDR ${gflopSignal.rndr.toFixed(1)}% both bearish`;
      } else if (liquidity < 5000) {
        exitReason = `LIQUIDITY EXIT — pool dried up ($${liquidity.toLocaleString()})`;
      }

      if (exitReason) {
        console.log(`[exit] Triggering exit: ${exitReason}`);
        try {
          const txHash = await executeSell(pos.tokenAddress, pos.tokenName, null);
          const pnlUsd = (pos.amountUsd * pnlPct).toFixed(2);
          const emoji  = pnlPct >= 0 ? '✅' : '❌';

          await tgAlert(
            `${emoji} *Position Closed: ${pos.tokenName}*\n\n` +
            `Exit reason: ${exitReason}\n` +
            `Entry: $${entryPrice.toFixed(8)}\n` +
            `Exit:  $${price.toFixed(8)}\n` +
            `P&L:   ${pnlPct >= 0 ? '+' : ''}$${pnlUsd} (${(pnlPct*100).toFixed(1)}%)\n` +
            `Age:   ${ageHrs} hours\n` +
            (txHash ? `Tx: https://basescan.org/tx/${txHash}` : 'Sell tx pending')
          );

          // Mark position closed
          positions[posId].status     = 'closed';
          positions[posId].exitPrice  = price;
          positions[posId].exitReason = exitReason;
          positions[posId].exitTx     = txHash;
          positions[posId].pnlPct     = pnlPct;
          positions[posId].pnlUsd     = parseFloat(pnlUsd);
          positions[posId].closedAt   = new Date().toISOString();
          savePositions(positions);

          console.log(`[exit] Position closed: ${exitReason} | P&L: ${(pnlPct*100).toFixed(1)}%`);
        } catch (sellErr) {
          console.error('[exit] Sell failed:', sellErr.message);
          await tgAlert(`⚠️ *Exit triggered but sell failed!*\n${pos.tokenName}\nReason: ${exitReason}\nError: ${sellErr.message.slice(0,200)}\n\n*Sell manually now.*`);
        }
      }
    }

    await new Promise(r => setTimeout(r, PRICE_CHECK_MS));
  }
}

monitor().catch(e => {
  console.error('[exit-monitor] Fatal:', e.message);
  process.exit(1);
});
