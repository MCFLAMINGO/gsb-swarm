// routes/raiders.js
// Raiders of the Chain — real backend
// Handles: X OAuth, wallet→account linking, raid execution, alpha scan, DCA pump bot

const express = require('express');
const router  = express.Router();
const redis   = require('./redis-client');
const crypto  = require('crypto');

const X_CLIENT_ID     = process.env.X_CLIENT_ID;
const X_CLIENT_SECRET = process.env.X_CLIENT_SECRET;
const X_CALLBACK_URL  = process.env.X_CALLBACK_URL || 'https://raiders-of-the-chain.vercel.app/auth/x/callback';
const RAID_PRICE_USD  = parseFloat(process.env.RAID_PRICE_USD || '0.50');

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

  // Get connected X accounts
  const accounts = await redis.get(`xaccounts:${wallet.toLowerCase()}`) || [];
  if (accounts.length === 0) return res.status(400).json({ error: 'No X accounts connected. Connect at least one X account first.' });

  const count   = Math.min(agentCount || accounts.length, accounts.length);
  const raiders = accounts.slice(0, count);

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
      if (raidType === 'Like + Boost') {
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
// Internal: fire a DCA buy (called async, not in request lifecycle)
// ---------------------------------------------------------------------------
async function fireDcaBuy(session) {
  if (session.status !== 'running') return;
  if (session.buysCompleted >= session.buyCount) {
    session.status = 'completed';
    await redis.set(`dca:${session.id}`, session, 86400);
    return;
  }

  try {
    const { executeOneBuy } = require('../pump_bot_engine');
    const result = await executeOneBuy(session);
    session.buysCompleted++;
    session.lastBuyAt = new Date().toISOString();
    await redis.set(`dca:${session.id}`, session, 86400);
    await logJob(session.wallet, {
      type:   'BUY',
      agent:  'DCA Bot',
      action: `Bought ${session.solPerBuy} SOL of ${session.tokenAddress} on ${session.chain}`,
      status: 'ok',
      result,
    });

    if (session.buysCompleted < session.buyCount) {
      setTimeout(() => fireDcaBuy(session), session.intervalMinutes * 60 * 1000);
    } else {
      session.status = 'completed';
      await redis.set(`dca:${session.id}`, session, 86400);
    }
  } catch (err) {
    console.error(`[DCA] Buy failed for ${session.id}:`, err.message);
    await logJob(session.wallet, { type: 'BUY', agent: 'DCA Bot', action: `Buy failed: ${err.message}`, status: 'error' });
    // Retry next interval
    if (session.buysCompleted < session.buyCount) {
      setTimeout(() => fireDcaBuy(session), session.intervalMinutes * 60 * 1000);
    }
  }
}

module.exports = router;
