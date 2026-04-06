// GSB Railway — PnL Share Card Route
// Mount with: app.get('/api/pnl-card', pnlCardRoute);
// No imports needed — uses only built-in Express req/res.

const MINIAPP_URL = 'https://gsb-swarm-production.up.railway.app/miniapp/';

function pnlCardRoute(req, res) {
  const {
    token = 'TOKEN',
    entryPrice,
    currentPrice,
    amount,
    wallet = '',
  } = req.query;

  // ── Input validation ──────────────────────────────────────────────────────
  const entry   = parseFloat(entryPrice);
  const current = parseFloat(currentPrice);
  const invested = parseFloat(amount);

  if (isNaN(entry) || isNaN(current) || isNaN(invested) || entry === 0) {
    return res.status(400).send('<h1>Invalid parameters</h1>');
  }

  // ── Core calculations ─────────────────────────────────────────────────────
  const pnlPct   = ((current - entry) / entry) * 100;
  const pnlUsd   = (current / entry - 1) * invested;
  const isProfit = pnlPct >= 0;

  // ── Formatting helpers ────────────────────────────────────────────────────
  const sign        = isProfit ? '+' : '';
  const pnlColor    = isProfit ? '#00ff88' : '#ff4455';
  const glowColor   = isProfit ? 'rgba(0,255,136,0.35)' : 'rgba(255,68,85,0.35)';
  const pnlPctFmt   = `${sign}${pnlPct.toFixed(2)}%`;
  const pnlUsdFmt   = `${sign}$${Math.abs(pnlUsd).toFixed(2)}`;
  const tokenSymbol = token.toUpperCase();

  // Price display — use scientific notation for very small numbers
  function fmtPrice(p) {
    if (p < 0.000001) return p.toExponential(4);
    if (p < 0.01)     return p.toFixed(8);
    return p.toFixed(4);
  }

  // Wallet abbreviation
  const walletShort = wallet.length > 10
    ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}`
    : wallet;

  // Telegram share URL
  const shareText = encodeURIComponent(
    `I made ${pnlPctFmt} on $${tokenSymbol} with @gsb_swap_bot 🚀\nTrade on GSB Swarm:`
  );
  const telegramShareUrl =
    `https://t.me/share/url?url=${encodeURIComponent(MINIAPP_URL)}&text=${shareText}`;

  // Current page URL (for og:image self-reference)
  const selfUrl = `https://gsb-swarm-production.up.railway.app/api/pnl-card?token=${encodeURIComponent(tokenSymbol)}&entryPrice=${entryPrice}&currentPrice=${currentPrice}&amount=${amount}&wallet=${encodeURIComponent(wallet)}`;

  // ── HTML ──────────────────────────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>GSB PnL — ${tokenSymbol}</title>

  <!-- Open Graph / Telegram preview -->
  <meta property="og:type"        content="website" />
  <meta property="og:url"         content="${selfUrl}" />
  <meta property="og:title"       content="${sign}${pnlPct.toFixed(2)}% on $${tokenSymbol} | GSB Swarm" />
  <meta property="og:description" content="Entry $${fmtPrice(entry)} → Current $${fmtPrice(current)} | Invested $${invested.toFixed(2)} | PnL ${pnlUsdFmt}" />
  <meta property="og:image"       content="${selfUrl}" />
  <meta name="twitter:card"       content="summary_large_image" />

  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: #0d0d0d;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      padding: 24px;
    }

    /* ── Card ── */
    .card {
      width: 100%;
      max-width: 480px;
      background: linear-gradient(145deg, #141414 0%, #1a1a1a 100%);
      border: 1px solid #2a2a2a;
      border-radius: 24px;
      padding: 36px 32px 28px;
      box-shadow:
        0 0 0 1px rgba(255,255,255,0.04),
        0 32px 80px rgba(0,0,0,0.7),
        0 0 60px ${glowColor};
      position: relative;
      overflow: hidden;
    }

    /* Subtle grid texture */
    .card::before {
      content: '';
      position: absolute;
      inset: 0;
      background-image:
        linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px);
      background-size: 32px 32px;
      pointer-events: none;
    }

    /* Glow orb */
    .card::after {
      content: '';
      position: absolute;
      top: -80px;
      left: 50%;
      transform: translateX(-50%);
      width: 320px;
      height: 320px;
      background: radial-gradient(circle, ${glowColor} 0%, transparent 70%);
      pointer-events: none;
    }

    /* ── Header ── */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 28px;
      position: relative;
      z-index: 1;
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 15px;
      font-weight: 700;
      color: #ffffff;
      letter-spacing: 0.02em;
    }

    .logo-icon {
      font-size: 20px;
    }

    .logo-sub {
      font-size: 10px;
      font-weight: 400;
      color: #666;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-top: 2px;
      display: block;
    }

    .badge {
      background: ${isProfit ? 'rgba(0,255,136,0.12)' : 'rgba(255,68,85,0.12)'};
      color: ${pnlColor};
      border: 1px solid ${isProfit ? 'rgba(0,255,136,0.3)' : 'rgba(255,68,85,0.3)'};
      border-radius: 20px;
      padding: 4px 12px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    /* ── Token ── */
    .token-section {
      text-align: center;
      margin-bottom: 24px;
      position: relative;
      z-index: 1;
    }

    .token-symbol {
      font-size: 42px;
      font-weight: 900;
      color: #ffffff;
      letter-spacing: -0.02em;
      line-height: 1;
      margin-bottom: 4px;
    }

    .token-symbol span {
      color: #444;
    }

    .wallet-tag {
      font-size: 11px;
      color: #444;
      font-family: 'Courier New', monospace;
      letter-spacing: 0.04em;
    }

    /* ── PnL ── */
    .pnl-section {
      text-align: center;
      margin-bottom: 28px;
      position: relative;
      z-index: 1;
    }

    .pnl-pct {
      font-size: 72px;
      font-weight: 900;
      color: ${pnlColor};
      letter-spacing: -0.04em;
      line-height: 1;
      text-shadow: 0 0 40px ${glowColor};
      margin-bottom: 6px;
    }

    .pnl-usd {
      font-size: 22px;
      font-weight: 600;
      color: ${pnlColor};
      opacity: 0.8;
    }

    /* ── Stats grid ── */
    .stats {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 12px;
      margin-bottom: 28px;
      position: relative;
      z-index: 1;
    }

    .stat {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 12px;
      padding: 12px 10px;
      text-align: center;
    }

    .stat-label {
      font-size: 9px;
      font-weight: 700;
      color: #555;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      margin-bottom: 5px;
    }

    .stat-value {
      font-size: 13px;
      font-weight: 700;
      color: #ddd;
      font-family: 'Courier New', monospace;
      word-break: break-all;
    }

    /* ── Divider ── */
    .divider {
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent);
      margin-bottom: 22px;
      position: relative;
      z-index: 1;
    }

    /* ── CTA buttons ── */
    .actions {
      display: flex;
      flex-direction: column;
      gap: 10px;
      position: relative;
      z-index: 1;
    }

    .btn {
      display: block;
      text-align: center;
      padding: 14px 20px;
      border-radius: 14px;
      font-size: 14px;
      font-weight: 700;
      text-decoration: none;
      letter-spacing: 0.03em;
      transition: opacity 0.15s;
    }

    .btn:hover { opacity: 0.85; }

    .btn-primary {
      background: linear-gradient(135deg, #7c3aed 0%, #4f46e5 100%);
      color: #ffffff;
      box-shadow: 0 4px 24px rgba(79,70,229,0.4);
    }

    .btn-telegram {
      background: linear-gradient(135deg, #0088cc 0%, #006aaa 100%);
      color: #ffffff;
      box-shadow: 0 4px 20px rgba(0,136,204,0.35);
    }

    /* ── Footer ── */
    .footer {
      text-align: center;
      margin-top: 20px;
      position: relative;
      z-index: 1;
    }

    .footer p {
      font-size: 10px;
      color: #333;
      letter-spacing: 0.05em;
    }

    .footer strong {
      color: #444;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="card">

    <!-- Header -->
    <div class="header">
      <div class="logo">
        <span class="logo-icon">⚡</span>
        <div>
          GSB Swarm
          <span class="logo-sub">Intelligence Layer</span>
        </div>
      </div>
      <div class="badge">${isProfit ? '🟢 Profit' : '🔴 Loss'}</div>
    </div>

    <!-- Token -->
    <div class="token-section">
      <div class="token-symbol"><span>$</span>${tokenSymbol}</div>
      ${walletShort ? `<div class="wallet-tag">${walletShort}</div>` : ''}
    </div>

    <!-- PnL -->
    <div class="pnl-section">
      <div class="pnl-pct">${pnlPctFmt}</div>
      <div class="pnl-usd">${pnlUsdFmt} USD</div>
    </div>

    <!-- Stats -->
    <div class="stats">
      <div class="stat">
        <div class="stat-label">Entry</div>
        <div class="stat-value">$${fmtPrice(entry)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Current</div>
        <div class="stat-value">$${fmtPrice(current)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Invested</div>
        <div class="stat-value">$${invested.toFixed(2)}</div>
      </div>
    </div>

    <div class="divider"></div>

    <!-- CTAs -->
    <div class="actions">
      <a class="btn btn-primary" href="${MINIAPP_URL}" target="_blank" rel="noopener">
        ⚡ Trade on GSB
      </a>
      <a class="btn btn-telegram" href="${telegramShareUrl}" target="_blank" rel="noopener">
        ✈️ Share on Telegram
      </a>
    </div>

    <!-- Footer -->
    <div class="footer">
      <p>Powered by <strong>GSB Intelligence Swarm</strong> on <strong>Virtuals Protocol</strong></p>
    </div>

  </div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

module.exports = pnlCardRoute;
