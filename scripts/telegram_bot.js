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

const BOT_TOKEN    = process.env.TELEGRAM_SWAP_BOT_TOKEN;
const GSB_TREASURY = '0x8E223841aA396d36a6727EfcEAFC61d691692a37';
const ALERTS_FILE  = '/tmp/gsb-bot-alerts.json';

if (!BOT_TOKEN) { console.error('[bot] No TELEGRAM_BOT_TOKEN'); process.exit(1); }

// ── Alerts store ──────────────────────────────────────────────────────────────
let alerts = {};
try { alerts = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8')); } catch {}
function saveAlerts() { try { fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts)); } catch {} }

// ── Telegram API ──────────────────────────────────────────────────────────────
function tgRequest(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, res => {
      let chunks = '';
      res.on('data', d => chunks += d);
      res.on('end', () => resolve(JSON.parse(chunks)));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function sendMessage(chatId, text, extra = {}) {
  return tgRequest('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...extra });
}

// ── Token analysis via our script ─────────────────────────────────────────────
async function analyzeToken(input) {
  try {
    const scriptPath = path.join(__dirname, 'token_analysis.js');
    const output = execSync(`node ${scriptPath} "${input.replace(/"/g, '')}"`, {
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

// ── Trending tokens ───────────────────────────────────────────────────────────
async function getTrending() {
  try {
    const res = await fetch('https://api.geckoterminal.com/api/v2/networks/base/trending_pools?page=1');
    const data = await res.json();
    return (data?.data || []).slice(0, 5).map(p => {
      const a = p.attributes || {};
      const vol = Number(a.volume_usd?.h24 || 0);
      const chg = Number(a.price_change_percentage?.h24 || 0);
      return `${a.name}: ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% | $${vol.toLocaleString()} vol`;
    });
  } catch { return ['Could not fetch trending data']; }
}

// ── Price check ───────────────────────────────────────────────────────────────
async function getPrice(input) {
  try {
    const isAddress = input.startsWith('0x');
    const url = isAddress
      ? `https://api.dexscreener.com/latest/dex/tokens/${input}`
      : `https://api.dexscreener.com/latest/dex/search?q=${input.replace('$', '')}`;
    const res = await fetch(url);
    const data = await res.json();
    const pairs = (data.pairs || []).filter(p => p.chainId === 'base');
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const p = pairs[0];
    if (!p) return null;
    return {
      symbol: p.baseToken?.symbol,
      price: parseFloat(p.priceUsd || '0'),
      change24h: p.priceChange?.h24 || 0,
      volume24h: p.volume?.h24 || 0,
      liquidity: p.liquidity?.usd || 0,
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
    `/trending — Top 5 Base tokens\n` +
    `/buy [token] [amount] — Get swap link\n` +
    `/alert [token] [price] — Price alert\n` +
    `/help — This menu\n\n` +
    `_Examples:_\n` +
    `/analyze FETCHR\n` +
    `/price $VIRTUAL\n` +
    `/buy AGNT 5\n` +
    `/alert FETCHR 0.000002\n\n` +
    `Fees support $GSB buybacks. Trade smart. 🚀`;
  await sendMessage(chatId, msg);
}

async function handleAnalyze(chatId, input) {
  if (!input) {
    return sendMessage(chatId, '❌ Please specify a token: `/analyze FETCHR` or `/analyze 0x610a...`');
  }
  await sendMessage(chatId, `🔍 Analyzing *${input}*... (10-15 seconds)`);
  const result = await analyzeToken(input);
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
  if (!input) return sendMessage(chatId, '❌ Usage: `/price VIRTUAL`');
  const data = await getPrice(input);
  if (!data) return sendMessage(chatId, `❌ Could not find price for *${input}* on Base.`);
  const dir = Number(data.change24h) >= 0 ? '📈' : '📉';
  const msg =
    `${dir} *${data.symbol}*\n` +
    `Price: \`$${data.price.toFixed(8)}\`\n` +
    `24h: ${Number(data.change24h) >= 0 ? '+' : ''}${Number(data.change24h).toFixed(2)}%\n` +
    `Vol: $${Number(data.volume24h).toLocaleString()}\n` +
    `Liq: $${Number(data.liquidity).toLocaleString()}`;
  await sendMessage(chatId, msg);
}

async function handleTrending(chatId) {
  await sendMessage(chatId, '⏳ Fetching trending Base tokens...');
  const tokens = await getTrending();
  const msg = `🔥 *Trending on Base*\n\n${tokens.map((t, i) => `${i+1}. ${t}`).join('\n')}\n\n_Updated every 5 minutes_`;
  await sendMessage(chatId, msg);
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
    const updates = res.result || [];
    for (const update of updates) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (!msg?.text) continue;

      const chatId = msg.chat.id;
      const userId = msg.from.id;
      const text   = msg.text.trim();
      const parts  = text.split(/\s+/);
      const cmd    = parts[0].toLowerCase().replace('@gsbswapbot', '');
      const arg1   = parts[1] || '';
      const arg2   = parts[2] || '';

      console.log(`[bot] ${userId}: ${text}`);

      try {
        if (cmd === '/start' || cmd === '/help') await handleStart(chatId, userId);
        else if (cmd === '/analyze') await handleAnalyze(chatId, arg1);
        else if (cmd === '/price')   await handlePrice(chatId, arg1);
        else if (cmd === '/trending') await handleTrending(chatId);
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

console.log('[bot] GSB Swap Bot starting...');
poll();
