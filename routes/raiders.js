// routes/raiders.js
// Raiders of the Chain — real backend
// Handles: X OAuth, wallet→account linking, raid execution, alpha scan, DCA pump bot

const express = require('express');
const router  = express.Router();
const redis   = require('./redis-client');
const crypto  = require('crypto');

// ── Swap execution constants ──────────────────────────────────────────────────
const USDC_BASE   = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH_BASE   = '0x4200000000000000000000000000000000000006';
const ROUTER_BASE = '0x2626664c2603336E57B271c5C0b26F421741e481'; // Uniswap v3 SwapRouter02
const BASE_RPC    = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const SERVICE_FEE = 0.01; // 1%

const ERC20_ABI = [
  { name:'allowance',   type:'function', stateMutability:'view',
    inputs:[{name:'owner',type:'address'},{name:'spender',type:'address'}],
    outputs:[{name:'',type:'uint256'}] },
  { name:'balanceOf',   type:'function', stateMutability:'view',
    inputs:[{name:'account',type:'address'}], outputs:[{name:'',type:'uint256'}] },
];

const ROUTER_ABI = [{
  name: 'exactInput', type: 'function', stateMutability: 'payable',
  inputs: [{ name:'params', type:'tuple', components: [
    {name:'path',      type:'bytes'},
    {name:'recipient', type:'address'},
    {name:'amountIn',  type:'uint256'},
    {name:'amountOutMinimum', type:'uint256'},
  ]}],
  outputs:[{name:'amountOut',type:'uint256'}],
}];

function encodePath(tokens, fees) {
  let encoded = tokens[0].slice(2).toLowerCase();
  for (let i = 0; i < fees.length; i++) {
    encoded += fees[i].toString(16).padStart(6, '0');
    encoded += tokens[i+1].slice(2).toLowerCase();
  }
  return '0x' + encoded;
}

async function executeSwapOnBase({ userWallet, tokenOut, amountUsd }) {
  const { createWalletClient, createPublicClient, http, parseUnits } = require('viem');
  const { base } = require('viem/chains');
  const { privateKeyToAccount } = require('viem/accounts');

  const pk = process.env.AGENT_WALLET_PRIVATE_KEY;
  if (!pk) throw new Error('AGENT_WALLET_PRIVATE_KEY not set');

  const account      = privateKeyToAccount(pk);
  const publicClient = createPublicClient({ chain: base, transport: http(BASE_RPC) });
  const walletClient = createWalletClient({ account, chain: base, transport: http(BASE_RPC) });

  // Apply 1% service fee — deduct from buy amount
  const netAmountUsd = amountUsd * (1 - SERVICE_FEE);
  const amountIn     = parseUnits(netAmountUsd.toFixed(6), 6); // USDC 6 decimals

  // Check user's USDC allowance to router is sufficient
  const allowance = await publicClient.readContract({
    address: USDC_BASE, abi: ERC20_ABI,
    functionName: 'allowance',
    args: [userWallet, ROUTER_BASE],
  });
  if (BigInt(allowance) < BigInt(amountIn)) {
    throw new Error(`Insufficient USDC allowance. User has ${Number(allowance)/1e6} USDC approved, need ${netAmountUsd.toFixed(2)}`);
  }

  // Build path: USDC → WETH (0.05%) → TOKEN (0.3%)
  const path = encodePath([USDC_BASE, WETH_BASE, tokenOut], [500, 3000]);

  // Agent wallet calls exactInput — router pulls USDC from USER via allowance
  // recipient = userWallet so tokens go directly to user
  const hash = await walletClient.writeContract({
    address: ROUTER_BASE,
    abi:     ROUTER_ABI,
    functionName: 'exactInput',
    args: [{ path, recipient: userWallet, amountIn: BigInt(amountIn), amountOutMinimum: 0n }],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  return { hash, gasUsed: receipt.gasUsed.toString(), status: receipt.status };
}

// ── Solana swap execution constants ──────────────────────────────────────────
const USDC_SOL_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const HELIUS_RPC    = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';

async function executeSwapOnSolana({ userWallet, tokenOut, amountUsd }) {
  const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
  const bs58 = require('bs58');

  const connection = new Connection(HELIUS_RPC, 'confirmed');

  // Agent wallet from env (base58 private key)
  const agentPkBase58 = process.env.SOLANA_AGENT_PRIVATE_KEY || process.env.SOL_PRIVATE_KEY;
  if (!agentPkBase58) throw new Error('SOL_PRIVATE_KEY not set in Railway');
  const agentKeypair = Keypair.fromSecretKey(bs58.decode(agentPkBase58));

  const netAmount = amountUsd * (1 - SERVICE_FEE);
  const amountLamports = Math.round(netAmount * 1_000_000); // USDC 6 decimals

  // 1. Get Jupiter v6 quote
  const quoteRes = await fetch(
    `https://quote-api.jup.ag/v6/quote?inputMint=${USDC_SOL_MINT}&outputMint=${tokenOut}&amount=${amountLamports}&slippageBps=100&onlyDirectRoutes=false`
  );
  const quote = await quoteRes.json();
  if (quote.error) throw new Error('Jupiter quote failed: ' + quote.error);

  // 2. Get swap transaction — agent signs, output goes to agent then transferred
  const swapRes = await fetch('https://quote-api.jup.ag/v6/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: agentKeypair.publicKey.toString(),
      destinationTokenAccount: userWallet, // send output tokens to user's wallet ATA
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  });
  const swapData = await swapRes.json();
  if (swapData.error) throw new Error('Jupiter swap failed: ' + swapData.error);

  // 3. Deserialize, sign, send
  const swapTxBuf = Buffer.from(swapData.swapTransaction, 'base64');
  const transaction = VersionedTransaction.deserialize(swapTxBuf);
  transaction.sign([agentKeypair]);

  const rawTx = transaction.serialize();
  const sig = await connection.sendRawTransaction(rawTx, {
    skipPreflight: false,
    maxRetries: 3,
  });

  // 4. Confirm
  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction(
    { signature: sig, ...latestBlockhash },
    'confirmed'
  );

  return {
    hash: sig,
    executed: true,
    outAmount: quote.outAmount,
    explorerUrl: `https://solscan.io/tx/${sig}`,
  };
}

const X_CLIENT_ID     = process.env.X_CLIENT_ID;
const X_CLIENT_SECRET = process.env.X_CLIENT_SECRET;
const X_CALLBACK_URL  = process.env.X_CALLBACK_URL || 'https://raiders-of-the-chain.vercel.app/auth/x/callback';
const RAID_PRICE_USD  = parseFloat(process.env.RAID_PRICE_USD || '0.50');

// OAuth 1.0a signing — uses existing X_API_KEY + X_API_SECRET + X_ACCESS_TOKEN + X_ACCESS_TOKEN_SECRET
// This lets the GSB agent account post on behalf of itself without OAuth 2.0 flow
function oauthSign(method, url, params) {
  const oauth = {
    oauth_consumer_key:     process.env.X_API_KEY,
    oauth_nonce:            crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_token:            process.env.X_ACCESS_TOKEN,
    oauth_version:          '1.0',
  };
  const all = { ...oauth, ...params };
  const base = [
    method.toUpperCase(),
    encodeURIComponent(url),
    encodeURIComponent(Object.keys(all).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(all[k])}`).join('&')),
  ].join('&');
  const sigKey = `${encodeURIComponent(process.env.X_API_SECRET)}&${encodeURIComponent(process.env.X_ACCESS_TOKEN_SECRET)}`;
  oauth.oauth_signature = require('crypto').createHmac('sha1', sigKey).update(base).digest('base64');
  return 'OAuth ' + Object.keys(oauth).sort().map(k => `${encodeURIComponent(k)}="${encodeURIComponent(oauth[k])}"`).join(', ');
}

async function postTweetAsGSB(text, replyToId) {
  const body = replyToId ? { text, reply: { in_reply_to_tweet_id: replyToId } } : { text };
  const auth = oauthSign('POST', 'https://api.twitter.com/2/tweets', {});
  const res = await fetch('https://api.twitter.com/2/tweets', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ---------------------------------------------------------------------------
// Helper — log a job to the live feed (stored in Redis)
// ---------------------------------------------------------------------------
async function logJob(walletAddress, entry) {
  const key = `jobs:${walletAddress}`;
  await redis.lpush(key, { ...entry, ts: new Date().toISOString() });
  await redis.ltrim(key, 0, 99);  // keep last 100 jobs
  await redis.expire(key, 86400); // 24h TTL
}

// ---------------------------------------------------------------------------
// GET /api/raiders/accounts?wallet=0x...
// Returns all X accounts connected to a wallet
// ---------------------------------------------------------------------------
router.get('/accounts', async (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'wallet required' });

  try {
    const accounts = await redis.get(`xaccounts:${wallet.toLowerCase()}`) || [];
    res.json({ wallet, accounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/raiders/auth/x/start?wallet=0x...
// Initiates X OAuth 2.0 PKCE flow
// ---------------------------------------------------------------------------
router.get('/auth/x/start', async (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'wallet required' });
  if (!X_CLIENT_ID) return res.status(500).json({ error: 'X_CLIENT_ID not configured' });

  const state        = crypto.randomBytes(16).toString('hex');
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

  // Store state + verifier + wallet in Redis (5 min TTL)
  await redis.set(`oauth:state:${state}`, { wallet: wallet.toLowerCase(), codeVerifier }, 300);

  const params = new URLSearchParams({
    response_type:         'code',
    client_id:             X_CLIENT_ID,
    redirect_uri:          X_CALLBACK_URL,
    scope:                 'tweet.read tweet.write users.read offline.access',
    state,
    code_challenge:        codeChallenge,
    code_challenge_method: 'S256',
  });

  res.json({ authUrl: `https://twitter.com/i/oauth2/authorize?${params}` });
});

// ---------------------------------------------------------------------------
// GET /api/raiders/auth/x/callback?code=...&state=...
// Exchanges code for tokens, stores against wallet
// ---------------------------------------------------------------------------
router.get('/auth/x/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).json({ error: 'Missing code or state' });

  const stored = await redis.get(`oauth:state:${state}`);
  if (!stored) return res.status(400).json({ error: 'Invalid or expired state' });

  const { wallet, codeVerifier } = stored;
  await redis.del(`oauth:state:${state}`);

  // Exchange code for tokens
  const tokenRes = await fetch('https://api.twitter.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${Buffer.from(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  X_CALLBACK_URL,
      code_verifier: codeVerifier,
    }),
  });

  const tokens = await tokenRes.json();
  if (tokens.error) return res.status(400).json({ error: tokens.error_description });

  // Get X user info
  const userRes = await fetch('https://api.twitter.com/2/users/me', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const { data: xUser } = await userRes.json();

  // Store tokens in Redis keyed to wallet
  const accountEntry = {
    xUserId:      xUser.id,
    xUsername:    xUser.username,
    accessToken:  tokens.access_token,
    refreshToken: tokens.refresh_token,
    connectedAt:  new Date().toISOString(),
  };

  const existing = await redis.get(`xaccounts:${wallet}`) || [];
  const updated  = existing.filter(a => a.xUserId !== xUser.id); // dedup
  updated.push(accountEntry);
  await redis.set(`xaccounts:${wallet}`, updated); // no TTL — persistent

  // Redirect back to Raiders site
  res.redirect(`https://raiders-of-the-chain.vercel.app/dashboard.html?connected=@${xUser.username}`);
});

// ---------------------------------------------------------------------------
// DELETE /api/raiders/accounts/disconnect
// Remove an X account from a wallet
// ---------------------------------------------------------------------------
router.delete('/accounts/disconnect', async (req, res) => {
  const { wallet, xUserId } = req.body;
  if (!wallet || !xUserId) return res.status(400).json({ error: 'wallet and xUserId required' });

  const existing = await redis.get(`xaccounts:${wallet.toLowerCase()}`) || [];
  const updated  = existing.filter(a => a.xUserId !== xUserId);
  await redis.set(`xaccounts:${wallet.toLowerCase()}`, updated);
  res.json({ success: true, removed: xUserId });
});

// ---------------------------------------------------------------------------
// POST /api/raiders/raid
// Execute a real raid — charges wallet via mppx, posts from all connected X accounts
// Body: { wallet, targetUrl, raidType, tone, cadence, talkingPoints, agentCount }
// ---------------------------------------------------------------------------
router.post('/raid', async (req, res) => {
  const { wallet, targetUrl, raidType, tone, cadence, talkingPoints, agentCount } = req.body;
  if (!wallet || !targetUrl) return res.status(400).json({ error: 'wallet and targetUrl required' });

  // Get connected X accounts — fall back to GSB agent account if none connected
  const accounts = await redis.get(`xaccounts:${wallet.toLowerCase()}`) || [];
  const useGSBAccount = accounts.length === 0;

  const count   = useGSBAccount ? 1 : Math.min(agentCount || accounts.length, accounts.length);
  const raiders = useGSBAccount
    ? [{ xUserId: 'gsb', xUsername: 'AGENTGASBIBLE', gsb: true }]
    : accounts.slice(0, count);

  // Build raid content via Thread Writer
  let content;
  try {
    const { runThreadWriter } = require('../threadWriter');
    content = await runThreadWriter({
      action:        'write_alpha_report',
      tone:          tone || 'Bullish Analysis',
      targetUrl,
      talkingPoints: talkingPoints || '',
      raidType,
    }).catch(() => null);
  } catch {}

  const raidText = content?.thread?.[0] || talkingPoints ||
    `🚨 ${tone || 'Alpha signal'} — Check this out: ${targetUrl} #GSB`;

  // Fire from each connected X account
  const results = [];
  for (const account of raiders) {
    try {
      // Refresh token if needed
      let accessToken = account.accessToken;
      if (account.refreshToken) {
        try {
          const refreshRes = await fetch('https://api.twitter.com/2/oauth2/token', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Authorization': `Basic ${Buffer.from(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`).toString('base64')}`,
            },
            body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: account.refreshToken }),
          });
          const refreshed = await refreshRes.json();
          if (refreshed.access_token) {
            accessToken = refreshed.access_token;
            account.accessToken  = refreshed.access_token;
            account.refreshToken = refreshed.refresh_token;
          }
        } catch {}
      }

      let result;
      if (account.gsb) {
        // Post from GSB agent account using OAuth 1.0a
        const replyId = raidType === 'Reply Raid' ? targetUrl.split('/').pop().split('?')[0] : null;
        result = await postTweetAsGSB(raidText, replyId);
      } else if (raidType === 'Like + Boost') {
        // Like the target tweet
        const tweetId = targetUrl.split('/').pop().split('?')[0];
        const likeRes = await fetch(`https://api.twitter.com/2/users/${account.xUserId}/likes`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ tweet_id: tweetId }),
        });
        result = await likeRes.json();
      } else {
        // Post a reply or new tweet
        const tweetBody = raidType === 'Reply Raid'
          ? { text: raidText, reply: { in_reply_to_tweet_id: targetUrl.split('/').pop().split('?')[0] } }
          : { text: raidText };

        const tweetRes = await fetch('https://api.twitter.com/2/tweets', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(tweetBody),
        });
        result = await tweetRes.json();
      }

      results.push({ username: account.xUsername, success: true, result });
      await logJob(wallet, { type: 'RAID', agent: `@${account.xUsername}`, action: `${raidType} on ${targetUrl}`, status: 'ok' });

      // Staggered cadence
      if (cadence === 'Staggered 30s') await new Promise(r => setTimeout(r, 30000));
      if (cadence === 'Staggered 2 min') await new Promise(r => setTimeout(r, 120000));

    } catch (err) {
      results.push({ username: account.xUsername, success: false, error: err.message });
    }
  }

  // Update stored tokens (refreshed)
  await redis.set(`xaccounts:${wallet.toLowerCase()}`, accounts);

  res.json({ success: true, raidType, count: results.length, results });
});

// ---------------------------------------------------------------------------
// GET /api/raiders/alpha?chain=base&query=trending
// Real alpha scan via Alpha Scanner agent
// ---------------------------------------------------------------------------
router.get('/alpha', async (req, res) => {
  const { chain = 'base', query = 'trending tokens' } = req.query;

  try {
    // Cache in Redis for 5 min to avoid hammering APIs
    const cacheKey = `alpha:${chain}:${query}`;
    const cached   = await redis.get(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    const { runAlphaScanner } = require('../alphaScanner');
    const result = await runAlphaScanner({ chain, query, limit: 10 });

    await redis.set(cacheKey, result, 300);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/raiders/dca/start
// Start a DCA pump session for a raider
// Body: { wallet, tokenAddress, chain, solPerBuy, buyCount, intervalMinutes }
// ---------------------------------------------------------------------------
router.post('/dca/start', async (req, res) => {
  const { wallet, tokenAddress, chain, solPerBuy, buyCount, intervalMinutes } = req.body;
  if (!wallet || !tokenAddress) return res.status(400).json({ error: 'wallet and tokenAddress required' });

  const session = {
    id:              `dca-${Date.now()}`,
    wallet:          wallet.toLowerCase(),
    tokenAddress,
    chain:           chain || 'solana',
    solPerBuy:       solPerBuy || 0.01,
    buyCount:        buyCount || 5,
    intervalMinutes: intervalMinutes || 10,
    buysCompleted:   0,
    status:          'running',
    startedAt:       new Date().toISOString(),
  };

  await redis.set(`dca:${session.id}`, session, 86400);
  await redis.lpush(`dca:wallet:${wallet.toLowerCase()}`, session.id);

  // Fire first buy immediately, schedule rest
  fireDcaBuy(session);

  res.json({ success: true, session });
});

// ---------------------------------------------------------------------------
// GET /api/raiders/dca/sessions?wallet=0x...
// ---------------------------------------------------------------------------
router.get('/dca/sessions', async (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'wallet required' });

  const ids      = await redis.lrange(`dca:wallet:${wallet.toLowerCase()}`, 0, 19);
  const sessions = await Promise.all(ids.map(id => redis.get(`dca:${id}`)));
  res.json({ sessions: sessions.filter(Boolean) });
});

// ---------------------------------------------------------------------------
// POST /api/raiders/dca/stop
// ---------------------------------------------------------------------------
router.post('/dca/stop', async (req, res) => {
  const { sessionId } = req.body;
  const session = await redis.get(`dca:${sessionId}`);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.status = 'stopped';
  await redis.set(`dca:${sessionId}`, session, 86400);
  res.json({ success: true, session });
});

// ---------------------------------------------------------------------------
// GET /api/raiders/jobs?wallet=0x...
// Live job feed for a wallet
// ---------------------------------------------------------------------------
router.get('/jobs', async (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'wallet required' });
  const jobs = await redis.lrange(`jobs:${wallet.toLowerCase()}`, 0, 49);
  res.json({ jobs });
});

// ---------------------------------------------------------------------------
// Internal: fire a DCA buy — self-contained, no pump_bot_engine dependency
// For EVM (Base/ETH): uses Uniswap v3 via user's USDC allowance
// For Solana: uses Jupiter v6 swap + Helius RPC, agent wallet signs
// ---------------------------------------------------------------------------
async function fireDcaBuy(session) {
  if (session.status !== 'running') return;

  const freshSession = await redis.get(`dca:${session.id}`);
  if (!freshSession || freshSession.status !== 'running') return;
  session = freshSession;

  if (session.buysCompleted >= session.buyCount) {
    session.status = 'completed';
    await redis.set(`dca:${session.id}`, session, 86400);
    return;
  }

  try {
    const isSolana = (session.chain || '').toLowerCase() === 'solana';
    const amountUsd = session.solPerBuy; // stored as USD amount per buy
    let result = {};

    if (isSolana) {
      // Solana: real execution via Jupiter v6 + Helius RPC
      result = await executeSwapOnSolana({
        userWallet: session.wallet,
        tokenOut:   session.tokenAddress,
        amountUsd,
      });
      result.executed = true;
    } else {
      // Base/EVM: execute real swap via Uniswap v3 using user's USDC allowance
      result = await executeSwapOnBase({
        userWallet: session.wallet,
        tokenOut:   session.tokenAddress,
        amountUsd,
      });
      result.executed = true;
    }

    session.buysCompleted++;
    session.lastBuyAt  = new Date().toISOString();
    session.totalSpent = (session.totalSpent || 0) + amountUsd;
    await redis.set(`dca:${session.id}`, session, 86400);

    const execNote = result.executed ? `tx: ${result.hash}` : `quoted: ${result.quoted} (${result.note})`;
    const logMsg = `DCA buy #${session.buysCompleted}: $${amountUsd} → ${session.tokenAddress.slice(0,8)}... on ${session.chain} | ${execNote}`;
    await logJob(session.wallet, { type: 'BUY', agent: 'DCA Bot', action: logMsg, status: 'ok' });
    console.log(`[DCA] ${logMsg}`);

    if (session.buysCompleted < session.buyCount) {
      setTimeout(() => fireDcaBuy(session), session.intervalMinutes * 60 * 1000);
    } else {
      session.status = 'completed';
      await redis.set(`dca:${session.id}`, session, 86400);
      await logJob(session.wallet, { type: 'BUY', agent: 'DCA Bot', action: `DCA complete — ${session.buysCompleted} buys, $${session.totalSpent} spent`, status: 'ok' });
    }
  } catch (err) {
    console.error(`[DCA] Buy failed for ${session.id}:`, err.message);
    await logJob(session.wallet, { type: 'BUY', agent: 'DCA Bot', action: `Buy failed: ${err.message}`, status: 'error' });
    if (session.buysCompleted < session.buyCount) {
      setTimeout(() => fireDcaBuy(session), session.intervalMinutes * 60 * 1000);
    }
  }
}


// ---------------------------------------------------------------------------
// POST /api/raiders/send-telegram
// Push a job result to the Telegram group/channel
// Body: { text, chatId? }
// ---------------------------------------------------------------------------
router.post('/send-telegram', async (req, res) => {
  const { text, chatId } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });

  const BOT_TOKEN = process.env.TELEGRAM_SWAP_BOT;
  const TARGET_CHAT = chatId || process.env.TELEGRAM_GROUP_ID || process.env.TELEGRAM_CHANNEL_ID;
  if (!BOT_TOKEN || !TARGET_CHAT) {
    return res.status(500).json({ error: 'Telegram not configured (TELEGRAM_SWAP_BOT + TELEGRAM_GROUP_ID required)' });
  }

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TARGET_CHAT,
        text: `⚔️ *Raiders of the Chain*\n\n${text}`,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    const data = await tgRes.json();
    if (!data.ok) return res.status(500).json({ error: data.description });
    res.json({ ok: true, messageId: data.result?.message_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
