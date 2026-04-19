/**
 * GSB Swap Bot — Telegram
 * 
 * Commands:
 *   /start        — welcome + wallet address
 *   /analyze [token] — full AI analysis (free for now, $0.25 later)
 *   /trending     — top 5 Base tokens right now
 *   /price [token] — quick price check
 *   /buy [token] [amount] — swap link (non-custodial)
 *   /alert [token] [price] — set price alert
 *   /help         — command list
 * 
 * Revenue: /analyze charges 0.25 USDC to GSB treasury
 * GSB buyback: 50% of fees buy $GSB on-chain
 */

const https  = require('https');
const path   = require('path');
const fs     = require('fs');
const { execSync } = require('child_process');

const BOT_TOKEN    = process.env.TELEGRAM_SWAP_BOT;
const GSB_TREASURY = '0x8E223841aA396d36a6727EfcEAFC61d691692a37';
const ALERTS_FILE  = '/tmp/gsb-bot-alerts.json';

if (!BOT_TOKEN) { console.error('[bot] No TELEGRAM_BOT_TOKEN'); process.exit(1); }

// ── Alerts store ──────────────────────────────────────────────────────────────
let alerts = {};
try { alerts = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8')); } catch {}
function saveAlerts() { try { fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts)); } catch {} }

// ── Telegram API ──────────────────────────────────────────────────────────────
async function tgRequest(method, body) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const json = await res.json();
    if (!json.ok && json.error_code) {
      console.error(`[bot] TG API error ${json.error_code}: ${json.description}`);
    }
    return json;
  } catch(e) {
    clearTimeout(timer);
    if (e.name !== 'AbortError') console.error('[bot] fetch error:', e.message);
    return { ok: false, result: [] };
  }
}

const CHATS_FILE = '/tmp/gsb-bot-chats.json';
let chatStore = {};
try { chatStore = JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8')); } catch {}
function saveChatId(userId, chatId) {
  chatStore[String(userId)] = chatId;
  try { fs.writeFileSync(CHATS_FILE, JSON.stringify(chatStore)); } catch {}
}

async function sendMessage(chatId, text, extra = {}) {
  return tgRequest('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...extra });
}

// ── Token analysis via our script ─────────────────────────────────────────────
async function analyzeToken(input, chainHint = null) {
  try {
    // For major assets, use CoinGecko data directly
    const clean = input.replace('$','').toLowerCase().trim();
    if (!chainHint && COINGECKO_MAJORS[clean]) {
      const cg = await getCoinGeckoPrice(COINGECKO_MAJORS[clean]);
      if (cg) {
        // Build a synthetic result compatible with handleAnalyze
        const p = cg.price;
        return {
          name: cg.name,
          symbol: cg.symbol,
          currentPrice: p,
          contractAddress: '',
          marketData: { priceChange24h: cg.change24h, liquidity: cg.liquidity, volume24h: cg.volume24h },
          analysis: {
            recommendation: cg.change24h > 2 ? 'BUY' : cg.change24h < -2 ? 'AVOID' : 'HOLD',
            confidence: 85,
            trend: cg.change24h > 0 ? 'bullish' : 'bearish',
            targets: [p * 1.15, p * 1.24],
            supportLevels: [p * 0.95],
            entryZone: { min: p * 0.93, max: p * 0.98 },
            summaryShort: `${cg.name} via CoinGecko. MCap: $${Number(cg.liquidity/1e9).toFixed(2)}B`,
            summary: `24h change: ${cg.change24h.toFixed(2)}%. Volume: $${Number(cg.volume24h/1e6).toFixed(0)}M. Data from CoinGecko.`,
          },
          source: 'CoinGecko',
        };
      }
    }

    const chainArg = chainHint ? ` --chain ${chainHint}` : '';
    const scriptPath = path.join(__dirname, 'token_analysis.js');
    const output = execSync(`node ${scriptPath} "${input.replace(/"/g, '')}"${chainArg}`, {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env },
      timeout: 30000,
    }).toString();
    const line = output.split('\n').find(l => l.startsWith('ANALYSIS_RESULT:'));
    if (line) return JSON.parse(line.replace('ANALYSIS_RESULT:', ''));
    return null;
  } catch (e) {
    console.error('[analyze] Error:', e.message);
    return null;
  }
}

// ── Trending tokens (multi-chain) ────────────────────────────────────────────
const GECKO_NETWORKS = {
  base: 'base', eth: 'eth', ethereum: 'eth', sol: 'solana', solana: 'solana',
  bsc: 'bsc', bnb: 'bsc', arb: 'arbitrum', arbitrum: 'arbitrum',
  polygon: 'polygon_pos', matic: 'polygon_pos',
};

async function getTrending(chainHint = 'base') {
  try {
    const network = GECKO_NETWORKS[chainHint?.toLowerCase()] || 'base';
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/${network}/trending_pools?page=1`);
    const data = await res.json();
    return (data?.data || []).slice(0, 5).map(p => {
      const a = p.attributes || {};
      const vol = Number(a.volume_usd?.h24 || 0);
      const chg = Number(a.price_change_percentage?.h24 || 0);
      return `${a.name}: ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% | $${vol.toLocaleString()} vol`;
    });
  } catch { return ['Could not fetch trending data']; }
}

// ── Chain config ─────────────────────────────────────────────────────────────
const CHAIN_IDS = {
  base: 'base', eth: 'ethereum', ethereum: 'ethereum',
  sol: 'solana', solana: 'solana', bsc: 'bsc', bnb: 'bsc',
  arb: 'arbitrum', arbitrum: 'arbitrum', polygon: 'polygon', matic: 'polygon',
};

// CoinGecko IDs for major assets that should never be DEX-searched
const COINGECKO_MAJORS = {
  btc: 'bitcoin', bitcoin: 'bitcoin', eth: 'ethereum', ethereum: 'ethereum',
  sol: 'solana', solana: 'solana', bnb: 'binancecoin', xrp: 'ripple',
  ada: 'cardano', doge: 'dogecoin', avax: 'avalanche-2', dot: 'polkadot',
  matic: 'matic-network', link: 'chainlink', uni: 'uniswap', ltc: 'litecoin',
  atom: 'cosmos', near: 'near', algo: 'algorand', xlm: 'stellar',
};

// ── CoinGecko price for majors ────────────────────────────────────────────────
async function getCoinGeckoPrice(coinId) {
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&community_data=false&developer_data=false`);
    const data = await res.json();
    const m = data.market_data;
    return {
      symbol: data.symbol?.toUpperCase(),
      name: data.name,
      price: m?.current_price?.usd || 0,
      change24h: m?.price_change_percentage_24h || 0,
      volume24h: m?.total_volume?.usd || 0,
      liquidity: m?.market_cap?.usd || 0,
      source: 'CoinGecko',
      isMajor: true,
    };
  } catch { return null; }
}

// ── Price check (multi-chain + CoinGecko fallback) ───────────────────────────
async function getPrice(input, chainHint = null) {
  try {
    const clean = input.replace('$', '').toLowerCase().trim();

    // CoinGecko for major assets
    if (!chainHint && COINGECKO_MAJORS[clean]) {
      const cg = await getCoinGeckoPrice(COINGECKO_MAJORS[clean]);
      if (cg) return cg;
    }

    // DexScreener multi-chain search
    const isAddress = input.startsWith('0x') || (input.length === 44 && !input.includes(' '));
    const url = isAddress
      ? `https://api.dexscreener.com/latest/dex/tokens/${input}`
      : `https://api.dexscreener.com/latest/dex/search?q=${clean}`;
    const res = await fetch(url);
    const data = await res.json();

    let pairs = data.pairs || [];

    // Filter by chain if specified
    const chainFilter = chainHint ? CHAIN_IDS[chainHint.toLowerCase()] : null;
    if (chainFilter) {
      pairs = pairs.filter(p => p.chainId === chainFilter);
    }

    // Sort by liquidity, prefer exact symbol match
    pairs.sort((a, b) => {
      const symA = a.baseToken?.symbol?.toLowerCase() === clean ? 1 : 0;
      const symB = b.baseToken?.symbol?.toLowerCase() === clean ? 1 : 0;
      if (symA !== symB) return symB - symA;
      return (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0);
    });

    const p = pairs[0];
    if (!p) return null;
    return {
      symbol: p.baseToken?.symbol,
      name: p.baseToken?.name,
      price: parseFloat(p.priceUsd || '0'),
      change24h: p.priceChange?.h24 || 0,
      volume24h: p.volume?.h24 || 0,
      liquidity: p.liquidity?.usd || 0,
      chain: p.chainId,
      source: 'DexScreener',
    };
  } catch { return null; }
}

// ── Command handlers ──────────────────────────────────────────────────────────
async function handleStart(chatId, userId) {
  const msg =
    `🔮 *GSB Swap Bot*\n\n` +
    `Powered by the GSB Intelligence Swarm on Virtuals Protocol.\n\n` +
    `*Commands:*\n` +
    `/analyze [token] — AI trade analysis\n` +
    `/price [token] — Quick price check\n` +
    `/trending [chain] — Top 5 tokens (base/eth/sol/bsc/arb)\n` +
    `/buy [token] [amount] — Get swap link\n` +
    `/dca [token] [amount] [freq] — Auto-buy on schedule\n` +
    `/alert [token] [price] — Price alert\n` +
    `/wallet — Connect your wallet\n` +
    `/help — This menu\n\n` +
    `_Examples:_\n` +
    `/analyze FETCHR\n` +
    `/dca FETCHR 10 daily\n` +
    `/price $VIRTUAL\n` +
    `/alert FETCHR 0.000002\n\n` +
    `Fees support $GSB buybacks. Trade smart. 🚀`;
  const miniAppUrl = 'https://gsb-swarm-production.up.railway.app/miniapp/';
  const wcUrl = `https://gsb-swarm-production.up.railway.app/miniapp-wc/?userId=${userId}&returnUrl=${encodeURIComponent('https://t.me/gsb_swap_bot')}`;
  await tgRequest('sendMessage', {
    chat_id: chatId,
    text: msg,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '⚡ Open GSB Swap App', web_app: { url: miniAppUrl } },
        { text: '🔗 Connect Wallet', url: wcUrl },
      ], [
        { text: '📊 Trending', callback_data: 'trending' },
        { text: '💹 Analyze', callback_data: 'analyze_help' },
      ]]
    }
  });
}

async function handleWallet(chatId, userId) {
  const wcUrl = `https://gsb-swarm-production.up.railway.app/miniapp-wc/?userId=${userId}&returnUrl=${encodeURIComponent('https://t.me/gsb_swap_bot')}`;
  await tgRequest('sendMessage', {
    chat_id: chatId,
    text: `🔗 *Connect Your Wallet*\n\nTap the button below to link your wallet to your GSB account. Non-custodial — your keys never leave your wallet.`,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '🔗 Connect Wallet', url: wcUrl }
      ]]
    }
  });
}

// Supported chains display
const CHAIN_NAMES = { base:'Base', ethereum:'Ethereum', solana:'Solana', bsc:'BSC', arbitrum:'Arbitrum', polygon:'Polygon' };

async function handleAnalyze(chatId, input) {
  if (!input) {
    return sendMessage(chatId, '❌ Usage: `/analyze FETCHR` or `/analyze BTC eth`\n\nChains: base, eth, sol, bsc, arb, polygon');
  }
  // Parse optional chain: "/analyze FETCHR base" or "/analyze BTC eth"
  const parts = input.trim().split(/\s+/);
  let token = parts[0];
  let chainHint = parts[1] ? (CHAIN_IDS[parts[1].toLowerCase()] || null) : null;
  const chainLabel = chainHint ? ` on ${CHAIN_NAMES[chainHint] || chainHint}` : '';

  await sendMessage(chatId, `🔍 Analyzing *${token}*${chainLabel}... (10-15 seconds)`);
  const result = await analyzeToken(token, chainHint);
  if (!result || result.error) {
    return sendMessage(chatId, `❌ Could not analyze *${input}*. Try a contract address or check the ticker.`);
  }

  const a = result.analysis;
  const m = result.marketData;
  const emoji = a.recommendation === 'BUY' ? '🟢' : a.recommendation === 'AVOID' ? '🔴' : '🟡';

  const msg =
    `${emoji} *${result.name} (${result.symbol})*\n` +
    `💵 Price: \`$${result.currentPrice.toFixed(8)}\`\n` +
    `📊 24h: ${Number(m.priceChange24h) >= 0 ? '+' : ''}${Number(m.priceChange24h).toFixed(2)}%\n` +
    `💧 Liquidity: $${Number(m.liquidity || 0).toLocaleString()}\n` +
    `📦 Volume: $${Number(m.volume24h).toLocaleString()}\n\n` +
    `*Trend:* ${a.trend.toUpperCase()}\n` +
    `*Verdict:* ${a.recommendation} (${a.confidence}% confidence)\n\n` +
    `📈 *Targets:* $${a.targets[0].toFixed(8)} → $${a.targets[1].toFixed(8)}\n` +
    `🛡 *Support:* $${a.supportLevels[0].toFixed(8)}\n` +
    `🎯 *Entry zone:* $${a.entryZone.min.toFixed(8)} – $${a.entryZone.max.toFixed(8)}\n\n` +
    `💬 ${a.summaryShort}\n\n` +
    `_${a.summary}_\n\n` +
    `🤖 GSB Intelligence Swarm | [DexScreener](https://dexscreener.com/base/${result.contractAddress})`;

  await sendMessage(chatId, msg, { disable_web_page_preview: true });
}

async function handlePrice(chatId, input) {
  if (!input) return sendMessage(chatId, '❌ Usage: `/price VIRTUAL` or `/price BTC eth`');
  const parts = input.trim().split(/\s+/);
  const token = parts[0];
  const chainHint = parts[1] ? (CHAIN_IDS[parts[1].toLowerCase()] || null) : null;
  const data = await getPrice(token, chainHint);
  const chainLabel = data?.chain ? ` (${CHAIN_NAMES[data.chain] || data.chain})` : (data?.isMajor ? ' (CoinGecko)' : '');
  if (!data) return sendMessage(chatId, `❌ Could not find price for *${token}*.`);
  const dir = Number(data.change24h) >= 0 ? '📈' : '📉';
  const msg =
    `${dir} *${data.symbol || token}*${chainLabel}\n` +
    `Price: \`$${Number(data.price).toFixed(8)}\`\n` +
    `24h: ${Number(data.change24h) >= 0 ? '+' : ''}${Number(data.change24h).toFixed(2)}%\n` +
    `Vol: $${Number(data.volume24h).toLocaleString()}\n` +
    `Liq: $${Number(data.liquidity).toLocaleString()}`;
  await sendMessage(chatId, msg);
}

async function handleTrending(chatId, chainInput = '') {
  const chainArg = chainInput ? (CHAIN_IDS[chainInput.toLowerCase()] || 'base') : 'base';
  const chainLabel2 = CHAIN_NAMES[chainArg] || 'Base';
  await sendMessage(chatId, `⏳ Fetching trending ${chainLabel2} tokens...`);
  const tokens = await getTrending(chainArg);
  const chainSuffix = chainArg !== 'base' ? ` ${chainInput.toLowerCase()}` : '';
  const msg = `🔥 *Trending on ${chainLabel2}*\n\n${tokens.map((t, i) => `${i+1}. ${t}`).join('\n')}\n\n_To analyze: /analyze TOKEN${chainSuffix}_\n_Updated every 5 minutes_`;
  await sendMessage(chatId, msg);
}

async function handleDCA(chatId, userId, token, amount, frequency) {
  if (!token || !amount) {
    return sendMessage(chatId,
      '📅 *DCA — Dollar Cost Averaging*\n\n' +
      'Auto-buy any token on a schedule.\n\n' +
      '*Usage:* `/dca TOKEN AMOUNT FREQUENCY`\n\n' +
      '*Examples:*\n' +
      '`/dca FETCHR 10 daily` — buy $10 FETCHR every day\n' +
      '`/dca AGNT 25 weekly` — buy $25 AGNT every week\n' +
      '`/dca VIRTUAL 5 hourly` — buy $5 VIRTUAL every hour\n\n' +
      '`/dca stop` — view and stop active orders\n\n' +
      '_Open the swap app for full DCA management:_',
      { reply_markup: { inline_keyboard: [[{ text: '⚡ Open Swap App', web_app: { url: 'https://gsb-swarm-production.up.railway.app/miniapp/' } }]] } }
    );
  }

  if (token.toLowerCase() === 'stop') {
    // List active orders
    try {
      const r = await fetch(`https://gsb-swarm-production.up.railway.app/api/swap/dca/list?userId=${userId}`);
      const d = await r.json();
      const orders = d.orders || [];
      if (!orders.length) return sendMessage(chatId, '📅 No active DCA orders.');
      const msg = '📅 *Active DCA Orders*\n\n' + orders.map((o, i) =>
        `${i+1}. *${o.token}* — $${o.amount} ${o.frequency} (${o.executedCount} fills)`
      ).join('\n') + '\n\n_Use the swap app to stop orders_';
      return sendMessage(chatId, msg, {
        reply_markup: { inline_keyboard: [[{ text: '⚡ Manage in App', web_app: { url: 'https://gsb-swarm-production.up.railway.app/miniapp/' } }]] }
      });
    } catch { return sendMessage(chatId, '❌ Could not fetch orders'); }
  }

  const validFreqs = ['hourly', 'daily', 'weekly', 'monthly'];
  const freq = validFreqs.includes((frequency || 'daily').toLowerCase()) ? (frequency || 'daily').toLowerCase() : 'daily';
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt < 1) return sendMessage(chatId, '❌ Amount must be at least $1 USDC');

  try {
    const r = await fetch('https://gsb-swarm-production.up.railway.app/api/swap/dca/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: String(userId), token: token.toUpperCase(), amount: amt, frequency: freq, chain: 'base' }),
    });
    const d = await r.json();
    if (d.ok) {
      return sendMessage(chatId,
        `✅ *DCA Created*\n\n` +
        `Token: *${token.toUpperCase()}*\n` +
        `Amount: $${amt} USDC\n` +
        `Frequency: ${freq}\n` +
        `First buy: in ~1 minute\n\n` +
        `_You'll get a notification on each buy._`,
        { reply_markup: { inline_keyboard: [[{ text: '⚡ Manage in App', web_app: { url: 'https://gsb-swarm-production.up.railway.app/miniapp/' } }]] } }
      );
    } else {
      return sendMessage(chatId, `❌ ${d.error || 'Failed to create DCA'}`);
    }
  } catch { return sendMessage(chatId, '❌ Network error'); }
}

async function handleBuy(chatId, token, amount) {
  if (!token) return sendMessage(chatId, '❌ Usage: `/buy FETCHR 5`');
  const amt = parseFloat(amount) || 5;
  // Get token address
  const priceData = await getPrice(token);
  const addr = token.startsWith('0x') ? token : (priceData ? '' : '');

  const uniswapLink = addr
    ? `https://app.uniswap.org/swap?chain=base&inputCurrency=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&outputCurrency=${addr}&exactAmount=${amt}&exactField=input`
    : `https://app.uniswap.org/swap?chain=base&exactAmount=${amt}&exactField=input`;

  const msg =
    `🔄 *Buy ${token} on Base*\n\n` +
    `Amount: $${amt} USDC\n` +
    (priceData ? `Current price: $${priceData.price.toFixed(8)}\n` : '') +
    `\n👇 Click to open in Uniswap:\n${uniswapLink}\n\n` +
    `_Connect your wallet and confirm the swap. Non-custodial — you control your funds._`;
  await sendMessage(chatId, msg, { disable_web_page_preview: false });
}

async function handleAlert(chatId, userId, token, targetPrice) {
  if (!token || !targetPrice) return sendMessage(chatId, '❌ Usage: `/alert FETCHR 0.000002`');
  const price = parseFloat(targetPrice);
  if (isNaN(price)) return sendMessage(chatId, '❌ Invalid price. Example: `/alert FETCHR 0.000002`');

  if (!alerts[userId]) alerts[userId] = [];
  alerts[userId].push({ token: token.toUpperCase(), targetPrice: price, chatId, createdAt: Date.now() });
  saveAlerts();

  const msg = `✅ *Alert set!*\n\n${token.toUpperCase()} @ \`$${price}\`\n\nI'll notify you when the price reaches this level.`;
  await sendMessage(chatId, msg);
}

// ── Alert checker (runs every 60s) ────────────────────────────────────────────
async function checkAlerts() {
  const userIds = Object.keys(alerts);
  for (const userId of userIds) {
    const userAlerts = alerts[userId];
    if (!userAlerts?.length) continue;
    const toRemove = [];
    for (let i = 0; i < userAlerts.length; i++) {
      const alert = userAlerts[i];
      try {
        const data = await getPrice(alert.token);
        if (!data) continue;
        if (data.price >= alert.targetPrice) {
          await sendMessage(alert.chatId,
            `🔔 *Alert triggered!*\n\n${alert.token} hit \`$${data.price.toFixed(8)}\`\n` +
            `Your target was \`$${alert.targetPrice}\`\n\n` +
            `Use /buy ${alert.token} to trade now.`
          );
          toRemove.push(i);
        }
      } catch {}
    }
    alerts[userId] = userAlerts.filter((_, i) => !toRemove.includes(i));
  }
  saveAlerts();
}

// ── Main polling loop ─────────────────────────────────────────────────────────
let offset = 0;

async function poll() {
  try {
    const res = await tgRequest('getUpdates', { offset, timeout: 20, allowed_updates: ['message'] });
    if (!res.ok && res.error_code === 409) {
      console.warn('[bot] 409 conflict — backing off 15s...');
      setTimeout(poll, 15000);
      return;
    }
    const updates = res.result || [];
    for (const update of updates) {
      offset = update.update_id + 1;
      // Handle callback queries from inline buttons
      if (update.callback_query) {
        const cb = update.callback_query;
        const cbChatId = cb.message?.chat?.id;
        await tgRequest('answerCallbackQuery', { callback_query_id: cb.id });
        if (cb.data === 'trending') await handleTrending(cbChatId, 'base');
        if (cb.data === 'analyze_help') await sendMessage(cbChatId, '💹 Usage: `/analyze TOKEN [chain]`\nExample: `/analyze FETCHR` or `/analyze BTC eth`');
      }
      const msg = update.message;
      if (!msg?.text) continue;

      const chatId = msg.chat.id;
      const userId = msg.from.id;
      const text   = msg.text.trim();
      const parts  = text.split(/\s+/);
      const cmd    = parts[0].toLowerCase().replace('@gsb_swap_bot', '').replace('@gsbswapbot', '').split('@')[0];
      const arg1   = parts[1] || '';
      const arg2   = parts[2] || '';

      console.log(`[bot] MSG from ${userId} in ${chatId}: ${text} | cmd=${cmd}`);

      try {
        if (cmd === '/start' || cmd === '/help') await handleStart(chatId, userId);
        else if (cmd === '/analyze') await handleAnalyze(chatId, arg1);
        else if (cmd === '/price')   await handlePrice(chatId, arg1);
        else if (cmd === '/trending') await handleTrending(chatId, arg1);
        else if (cmd === '/dca')      await handleDCA(chatId, userId, arg1, arg2, parts[3] || '');
        else if (cmd === '/buy')     await handleBuy(chatId, arg1, arg2);
        else if (cmd === '/alert')   await handleAlert(chatId, userId, arg1, arg2);
        else if (text.startsWith('/')) await sendMessage(chatId, '❓ Unknown command. Use /help to see all commands.');
      } catch (cmdErr) {
        console.error('[bot] Command error:', cmdErr.message);
        try { await sendMessage(chatId, '⚠️ Error processing command. Try again.'); } catch {}
      }
    }
  } catch (e) {
    console.error('[bot] Poll error:', e.message);
  }
  setTimeout(poll, 1000);
}

// Start alert checker
setInterval(checkAlerts, 60_000);

async function startBot() {
  // Drop any existing webhook + evict any hanging getUpdates session from old container
  try { await tgRequest('deleteWebhook', { drop_pending_updates: true }); } catch {}
  // Wait 2s for old long-poll (timeout:20) to be evicted by Telegram
  await new Promise(r => setTimeout(r, 2000));
  console.log('[bot] GSB Swap Bot starting...');
  poll();
}
startBot();
