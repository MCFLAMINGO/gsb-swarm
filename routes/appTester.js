'use strict';
/**
 * appTester.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Real Playwright browser automation for MCFL apps.
 * Streams SSE events back to the dashboard as each worker completes.
 *
 * GET /api/app-test/run?appId=throw&suite=quick
 *
 * SSE event shapes (matches dashboard parser):
 *   data: {"type":"log",       "data":"message string"}
 *   data: {"type":"worker_start","data":{"workerId":"W1"}}
 *   data: {"type":"worker_done", "data":{"workerId":"W1","passed":true,"message":"...","rows":[...]}}
 *   data: {"type":"done"}
 */

const express  = require('express');
const router   = express.Router();
const { chromium } = require('playwright');

// ── App registry ─────────────────────────────────────────────────────────────
const APPS = {
  throw: {
    name:    'THROW',
    url:     'https://www.throw5onit.com',
    authType: 'wallet-inject',
  },
  voluntrack: {
    name:    'VolunTrack',
    url:     'https://voluntrack-nexus.lovable.app',
    authType: 'e2e-switcher',
  },
  passithere: {
    name:    'PassItHere',
    url:     'https://passithere.com',
    authType: 'e2e-switcher',
  },
};

// ── Mock ethereum wallet injected into page context ───────────────────────────
// Simulates MetaMask/Phantom so wallet-connect flows see a connected wallet.
const MOCK_WALLET_ADDRESS = '0xDeAdBeEf00000000000000000000000000001337';
const MOCK_WALLET_SCRIPT = `
  window.__mockWalletAddress = '${MOCK_WALLET_ADDRESS}';

  // EIP-1193 mock provider
  const mockProvider = {
    isMetaMask: true,
    isConnected: () => true,
    selectedAddress: '${MOCK_WALLET_ADDRESS}',
    chainId: '0x2105', // Base mainnet = 8453
    networkVersion: '8453',
    _events: {},

    on(event, handler) {
      this._events[event] = this._events[event] || [];
      this._events[event].push(handler);
    },
    removeListener() {},

    request({ method, params }) {
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return Promise.resolve(['${MOCK_WALLET_ADDRESS}']);
        case 'eth_chainId':
          return Promise.resolve('0x2105');
        case 'net_version':
          return Promise.resolve('8453');
        case 'eth_getBalance':
          return Promise.resolve('0x16345785D8A0000'); // 0.1 ETH
        case 'personal_sign':
        case 'eth_sign':
          // Return a valid-looking signature so apps don't throw
          return Promise.resolve('0x' + 'ab'.repeat(32) + 'cd'.repeat(32) + '1b');
        case 'eth_sendTransaction':
          // Return a fake tx hash
          return Promise.resolve('0x' + '42'.repeat(32));
        case 'wallet_switchEthereumChain':
        case 'wallet_addEthereumChain':
          return Promise.resolve(null);
        default:
          return Promise.resolve(null);
      }
    },
  };

  Object.defineProperty(window, 'ethereum', {
    value: mockProvider,
    writable: false,
    configurable: true,
  });

  // Also expose as window.solana for Phantom-style apps
  window.solana = {
    isPhantom: true,
    isConnected: true,
    publicKey: { toString: () => '11111111111111111111111111111111' },
    connect: () => Promise.resolve({ publicKey: { toString: () => '11111111111111111111111111111111' } }),
    disconnect: () => Promise.resolve(),
    signMessage: (msg) => Promise.resolve({ signature: new Uint8Array(64) }),
    signTransaction: (tx) => Promise.resolve(tx),
  };

  console.log('[mock-wallet] window.ethereum injected at', '${MOCK_WALLET_ADDRESS}');
`;

// ── SSE helpers ───────────────────────────────────────────────────────────────
function sseLog(res, msg) {
  res.write(`data: ${JSON.stringify({ type: 'log', data: msg })}\n\n`);
}
function sseWorkerStart(res, workerId) {
  res.write(`data: ${JSON.stringify({ type: 'worker_start', data: { workerId } })}\n\n`);
}
function sseWorkerDone(res, workerId, passed, message, rows = []) {
  res.write(`data: ${JSON.stringify({ type: 'worker_done', data: { workerId, passed, message, rows } })}\n\n`);
}
function sseDone(res) {
  res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
}

// ── Launch browser helper ─────────────────────────────────────────────────────
async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });
}

// ── W1: Auth / Wallet connect ─────────────────────────────────────────────────
async function runW1(res, app, browser) {
  sseWorkerStart(res, 'W1');
  const rows = [];
  let passed = true;
  let message = '';

  const ctx  = await browser.newContext({ viewport: { width: 390, height: 844 } }); // mobile
  const page = await ctx.newPage();

  try {
    // Inject mock wallet before any page script runs
    await ctx.addInitScript(MOCK_WALLET_SCRIPT);

    sseLog(res, `[W1] Loading ${app.url}…`);
    await page.goto(app.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const title = await page.title();
    rows.push({ name: 'Page loaded', ok: true, note: title });
    sseLog(res, `[W1] Page title: "${title}"`);

    if (app.authType === 'wallet-inject') {
      // Look for connect wallet button
      const connectSelectors = [
        'button:has-text("Connect")',
        'button:has-text("connect")',
        '[data-testid*="connect"]',
        'button:has-text("wallet")',
        'button:has-text("Wallet")',
        'button:has-text("Sign in")',
      ];

      let connected = false;
      for (const sel of connectSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
          sseLog(res, `[W1] Found connect button: "${sel}" — clicking`);
          await btn.click().catch(() => {});
          await page.waitForTimeout(2000);

          // Check if address appeared
          const addrVisible = await page.locator(`text=${MOCK_WALLET_ADDRESS.slice(0,6)}`).isVisible({ timeout: 3000 }).catch(() => false)
            || await page.locator('text=0xDeAd').isVisible({ timeout: 1000 }).catch(() => false)
            || await page.locator('[data-testid*="address"]').isVisible({ timeout: 1000 }).catch(() => false);

          rows.push({ name: 'Wallet connect button', ok: true, note: sel });
          rows.push({ name: 'Address visible post-connect', ok: addrVisible, note: addrVisible ? 'address shown' : 'no address element found (may be modal-based)' });
          connected = true;
          sseLog(res, `[W1] Connect clicked — address visible: ${addrVisible}`);
          break;
        }
      }

      if (!connected) {
        // No connect button found — check if already shows connected state
        const alreadyConnected = await page.locator('text=0x').first().isVisible({ timeout: 2000 }).catch(() => false);
        rows.push({ name: 'Wallet connect button', ok: alreadyConnected, note: alreadyConnected ? 'auto-connected' : 'no connect button found' });
        if (!alreadyConnected) passed = false;
      }

    } else {
      // e2e-switcher — just verify page loaded without auth wall
      const bodyText = await page.textContent('body').catch(() => '');
      const hasContent = bodyText.length > 100;
      rows.push({ name: 'Page has content (no auth wall)', ok: hasContent, note: hasContent ? `${bodyText.length} chars` : 'page empty or blocked' });
      if (!hasContent) passed = false;
    }

    message = passed ? `Auth flow OK — ${rows.filter(r => r.ok).length}/${rows.length} checks passed` : 'Auth issues detected';

  } catch (err) {
    passed = false;
    message = `W1 error: ${err.message}`;
    rows.push({ name: 'W1 execution', ok: false, error: err.message });
    sseLog(res, `[W1] ❌ ${err.message}`);
  } finally {
    await ctx.close().catch(() => {});
  }

  sseWorkerDone(res, 'W1', passed, message, rows);
  return passed;
}

// ── W2: Navigation — walk all screens ────────────────────────────────────────
async function runW2(res, app, browser) {
  sseWorkerStart(res, 'W2');
  const rows = [];
  let passed = true;

  const ctx  = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  // Capture console errors
  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', err => consoleErrors.push(err.message));

  try {
    await ctx.addInitScript(MOCK_WALLET_SCRIPT);

    sseLog(res, `[W2] Loading ${app.url}…`);
    await page.goto(app.url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1500);

    // Screenshot root render check
    const rootOk = await page.locator('body').isVisible();
    rows.push({ route: '/', name: 'Root renders', ok: rootOk });
    sseLog(res, `[W2] Root: ${rootOk ? '✅' : '❌'}`);

    // Collect all internal nav links
    const links = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      const origin  = window.location.origin;
      return anchors
        .map(a => ({ href: a.href, text: (a.textContent || '').trim().slice(0, 40) }))
        .filter(l => l.href.startsWith(origin) && !l.href.includes('#') && l.href !== origin + '/')
        .reduce((acc, l) => { // dedupe
          if (!acc.find(x => x.href === l.href)) acc.push(l);
          return acc;
        }, [])
        .slice(0, 8); // cap at 8 routes
    });

    sseLog(res, `[W2] Found ${links.length} internal routes to walk`);

    for (const link of links) {
      try {
        sseLog(res, `[W2] Navigating to ${link.href} ("${link.text}")`);
        await page.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(800);

        const status200 = !page.url().includes('404') && !page.url().includes('error');
        const hasContent = await page.locator('body').evaluate(el => el.innerText.length > 50).catch(() => false);
        const ok = status200 && hasContent;

        rows.push({
          route:  link.href.replace(app.url, '') || '/',
          name:   link.text || link.href,
          ok,
          note:   ok ? 'rendered' : 'empty or error page',
          urlAfter: page.url(),
        });
        sseLog(res, `[W2] ${ok ? '✅' : '❌'} ${link.text}`);
      } catch (e) {
        rows.push({ route: link.href, name: link.text, ok: false, error: e.message });
        sseLog(res, `[W2] ❌ ${link.text}: ${e.message}`);
      }
    }

    // Check for critical JS errors
    const criticalErrors = consoleErrors.filter(e =>
      !e.includes('favicon') && !e.includes('analytics') && !e.includes('gtag')
    );
    if (criticalErrors.length > 0) {
      rows.push({ name: 'Console errors', ok: false, note: criticalErrors.slice(0, 3).join(' | ') });
      sseLog(res, `[W2] ⚠️ ${criticalErrors.length} console errors`);
    } else {
      rows.push({ name: 'Console errors', ok: true, note: 'none' });
    }

    const failCount = rows.filter(r => !r.ok && !r.skipped).length;
    passed = failCount === 0;

  } catch (err) {
    passed = false;
    rows.push({ name: 'W2 execution', ok: false, error: err.message });
    sseLog(res, `[W2] ❌ ${err.message}`);
  } finally {
    await ctx.close().catch(() => {});
  }

  const failCount = rows.filter(r => !r.ok).length;
  sseWorkerDone(res, 'W2', passed, `Nav: ${rows.length - failCount} routes OK, ${failCount} issues`, rows);
  return passed;
}

// ── W3: Buttons — tap visible buttons, record outcome ────────────────────────
async function runW3(res, app, browser) {
  sseWorkerStart(res, 'W3');
  const rows = [];
  let passed = true;

  const ctx  = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  try {
    await ctx.addInitScript(MOCK_WALLET_SCRIPT);
    await page.goto(app.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Find all clickable buttons that are visible and not disabled
    const buttons = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
      return btns
        .filter(b => {
          const rect = b.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && !b.disabled && !b.closest('[aria-hidden]');
        })
        .map(b => ({
          text:   (b.textContent || b.value || b.getAttribute('aria-label') || '').trim().slice(0, 50),
          testId: b.getAttribute('data-testid') || '',
          tag:    b.tagName.toLowerCase(),
        }))
        .filter(b => b.text.length > 0)
        .slice(0, 10); // cap at 10 buttons
    });

    sseLog(res, `[W3] Found ${buttons.length} clickable buttons`);

    for (const btn of buttons) {
      const sel = btn.testId
        ? `[data-testid="${btn.testId}"]`
        : `button:has-text("${btn.text.replace(/"/g, '')}")`;

      try {
        const locator = page.locator(sel).first();
        const visible = await locator.isVisible({ timeout: 1000 }).catch(() => false);
        if (!visible) { rows.push({ button: btn.text, ok: true, skipped: true, note: 'not visible' }); continue; }

        // Snapshot before
        const urlBefore = page.url();

        await locator.click({ timeout: 3000, force: false }).catch(async () => {
          await locator.click({ timeout: 3000, force: true });
        });
        await page.waitForTimeout(600);

        const urlAfter   = page.url();
        const navigated  = urlAfter !== urlBefore;
        const errorShown = await page.locator('[role="alert"], .error, .toast-error').isVisible({ timeout: 500 }).catch(() => false);
        const modalOpened = await page.locator('[role="dialog"], .modal').isVisible({ timeout: 500 }).catch(() => false);

        rows.push({ button: btn.text, testId: btn.testId, ok: true, navigated, urlAfter: navigated ? urlAfter : null, modalOpened, errorShown });
        sseLog(res, `[W3] ✅ "${btn.text}" — nav:${navigated} modal:${modalOpened} err:${errorShown}`);

        // Navigate back if we went somewhere
        if (navigated) {
          await page.goto(app.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForTimeout(1000);
        }

      } catch (e) {
        rows.push({ button: btn.text, testId: btn.testId, ok: false, error: e.message });
        sseLog(res, `[W3] ❌ "${btn.text}": ${e.message}`);
      }
    }

    const failCount = rows.filter(r => !r.ok && !r.skipped).length;
    passed = failCount === 0;

  } catch (err) {
    passed = false;
    rows.push({ name: 'W3 execution', ok: false, error: err.message });
  } finally {
    await ctx.close().catch(() => {});
  }

  const failCount = rows.filter(r => !r.ok && !r.skipped).length;
  sseWorkerDone(res, 'W3', passed, `Buttons: ${rows.length} tested, ${failCount} errors`, rows);
  return passed;
}

// ── W4: Forms — empty submit + fill validation ────────────────────────────────
async function runW4(res, app, browser) {
  sseWorkerStart(res, 'W4');
  const rows = [];
  let passed = true;

  const ctx  = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  try {
    await ctx.addInitScript(MOCK_WALLET_SCRIPT);
    await page.goto(app.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Find all forms
    const forms = await page.locator('form').all();
    sseLog(res, `[W4] Found ${forms.length} forms`);

    if (forms.length === 0) {
      rows.push({ field: 'forms', ok: true, skipped: true, note: 'no forms on page' });
    }

    for (let fi = 0; fi < Math.min(forms.length, 3); fi++) {
      const form = forms[fi];

      // Find submit button
      const submitBtn = form.locator('button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Send"), button:has-text("Save")').first();
      const hasSubmit = await submitBtn.isVisible({ timeout: 1000 }).catch(() => false);

      // Empty submit — should show validation errors
      if (hasSubmit) {
        await submitBtn.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(800);
        const errorShown = await page.locator('[aria-invalid], .error, [data-error], [class*="error"]').first().isVisible({ timeout: 1000 }).catch(() => false);
        rows.push({
          field: `form[${fi}] empty submit`,
          ok: true, // we just check it doesn't crash
          expectedError: 'validation message',
          gotError: errorShown,
          note: errorShown ? 'validation shown' : 'no validation — check required attrs',
        });
        sseLog(res, `[W4] Form ${fi} empty submit — validation shown: ${errorShown}`);
      }

      // Fill inputs with test data
      const inputs = await form.locator('input:not([type="hidden"]):not([type="submit"]):not([type="checkbox"])').all();
      for (const input of inputs.slice(0, 4)) {
        const type  = await input.getAttribute('type') || 'text';
        const name  = await input.getAttribute('name') || await input.getAttribute('placeholder') || 'field';
        const value = type === 'email' ? 'test@mcflamingo.com' : type === 'number' ? '42' : type === 'tel' ? '9045551234' : 'test input';

        try {
          await input.fill(value, { timeout: 2000 });
          rows.push({ field: name, ok: true, note: `filled: "${value}"` });
        } catch (e) {
          rows.push({ field: name, ok: false, error: e.message });
        }
      }
    }

    const failCount = rows.filter(r => !r.ok && !r.skipped).length;
    passed = failCount === 0;

  } catch (err) {
    passed = false;
    rows.push({ field: 'W4 execution', ok: false, error: err.message });
  } finally {
    await ctx.close().catch(() => {});
  }

  const failCount = rows.filter(r => !r.ok && !r.skipped).length;
  sseWorkerDone(res, 'W4', passed, `Forms: ${rows.length} checks, ${failCount} errors`, rows);
  return passed;
}

// ── W5: Signals — network roundtrip check ────────────────────────────────────
async function runW5(res, app, browser) {
  sseWorkerStart(res, 'W5');
  const rows = [];
  let passed = true;

  const ctx  = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  // Capture network requests made by the page
  const apiCalls = [];
  page.on('response', async resp => {
    try {
      const url = resp.url();
      if (url.includes('/api/') || url.includes('railway.app') || url.includes('supabase')) {
        apiCalls.push({ url: url.replace(/\?.*/, ''), status: resp.status() });
      }
    } catch {}
  });

  try {
    await ctx.addInitScript(MOCK_WALLET_SCRIPT);
    await page.goto(app.url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Check API calls made on load
    const failedCalls = apiCalls.filter(c => c.status >= 500);
    const okCalls     = apiCalls.filter(c => c.status < 400);

    sseLog(res, `[W5] ${apiCalls.length} API calls on load — ${okCalls.length} OK, ${failedCalls.length} errors`);

    rows.push({
      signal: 'API calls on load',
      ok: failedCalls.length === 0,
      note: `${apiCalls.length} total, ${failedCalls.length} errors`,
    });

    for (const bad of failedCalls.slice(0, 3)) {
      rows.push({ signal: bad.url, ok: false, note: `HTTP ${bad.status}` });
      passed = false;
    }

    // For THROW — check the Railway backend is reachable
    if (app.url.includes('throw5onit')) {
      const t0  = Date.now();
      const res2 = await fetch('https://gsb-swarm-production.up.railway.app/health').catch(() => null);
      const ms  = Date.now() - t0;
      const ok  = res2?.ok ?? false;
      rows.push({ signal: 'Railway backend /health', ok, latencyMs: ms, note: ok ? `${ms}ms` : 'unreachable' });
      if (!ok) passed = false;
      sseLog(res, `[W5] Railway /health: ${ok ? '✅' : '❌'} ${ms}ms`);
    }

    const failCount = rows.filter(r => !r.ok).length;
    passed = passed && failCount === 0;

  } catch (err) {
    passed = false;
    rows.push({ signal: 'W5 execution', ok: false, error: err.message });
  } finally {
    await ctx.close().catch(() => {});
  }

  const failCount = rows.filter(r => !r.ok).length;
  sseWorkerDone(res, 'W5', passed, `Signals: ${rows.length} checks, ${failCount} failures`, rows);
  return passed;
}

// ── Main route ────────────────────────────────────────────────────────────────
router.get('/run', async (req, res) => {
  const { appId, suite = 'quick' } = req.query;
  const app = APPS[appId];

  if (!app) {
    return res.status(400).json({ error: `Unknown appId: ${appId}. Valid: ${Object.keys(APPS).join(', ')}` });
  }

  // SSE headers
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  sseLog(res, `▶ Starting ${suite} suite for ${app.name} (${app.url})`);

  let browser;
  try {
    sseLog(res, '🌐 Launching headless Chromium…');
    browser = await launchBrowser();
    sseLog(res, '✅ Browser ready');

    const workers = suite === 'quick' ? ['W1', 'W2'] : ['W1', 'W2', 'W3', 'W4', 'W5'];

    for (const w of workers) {
      sseLog(res, `\n── Running ${w} ──`);
      try {
        if (w === 'W1') await runW1(res, app, browser);
        if (w === 'W2') await runW2(res, app, browser);
        if (w === 'W3') await runW3(res, app, browser);
        if (w === 'W4') await runW4(res, app, browser);
        if (w === 'W5') await runW5(res, app, browser);
      } catch (err) {
        sseLog(res, `❌ ${w} crashed: ${err.message}`);
        sseWorkerDone(res, w, false, `Crashed: ${err.message}`, []);
      }
    }

  } catch (err) {
    sseLog(res, `❌ Fatal: ${err.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    sseLog(res, '✅ Browser closed');
  }

  sseDone(res);
  res.end();
});

module.exports = router;
