'use strict';
/**
 * ACP Auth Manager — GSB Swarm
 *
 * Manages the Virtuals ACP access token lifecycle on Railway:
 *
 *  Token sources (tried in order):
 *  1. VIRTUALS_PRIVY_TOKEN env var  — set manually, expires in 60 min
 *  2. Cached file (/tmp/gsb-acp-token.json) — written after a successful refresh
 *
 *  Auto-refresh:
 *  - Decodes the JWT to check expiry before every API call
 *  - If token expires in < 5 minutes, tries to refresh using VIRTUALS_REFRESH_TOKEN
 *  - Refresh hits POST /auth/cli/refresh on api.acp.virtuals.io
 *  - On success: writes new token + refresh token to /tmp/gsb-acp-token.json
 *  - On failure: logs a clear actionable message telling you exactly what to do
 *
 *  How to get a refresh token:
 *  The ACP CLI refresh token is different from privy:refresh_token.
 *  It comes from running `acp configure` which stores it in the OS keychain.
 *  Since your Mac can't run the CLI, grab it from the browser network tab:
 *    1. app.virtuals.io → DevTools → Network → filter "cli/token"
 *    2. Find the POST /auth/cli/token response
 *    3. Copy the "refreshToken" field from the response body
 *  Set it as VIRTUALS_REFRESH_TOKEN in Railway.
 *
 *  Alternatively: use the web refresh token (privy:refresh_token from localStorage)
 *  via the Privy session endpoint. This module tries both.
 */

const fs   = require('fs');
const path = require('path');

const ACP_SERVER    = 'https://api.acp.virtuals.io';
const PRIVY_SERVER  = 'https://auth.privy.io';
const PRIVY_APP_ID  = 'cltsev9j90f67yhyw4sngtrpv'; // from JWT aud claim
const TOKEN_CACHE   = '/tmp/gsb-acp-token.json';
const EXPIRY_BUFFER = 5 * 60; // refresh if < 5 min remaining

// ── JWT helpers ───────────────────────────────────────────────────────────────
function decodeJwtPayload(token) {
  try {
    const payload = token.split('.')[1];
    const padded  = payload + '='.repeat((4 - payload.length % 4) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch { return null; }
}

function tokenExpiresIn(token) {
  const p = decodeJwtPayload(token);
  if (!p?.exp) return 0;
  return p.exp - Math.floor(Date.now() / 1000);
}

function isTokenFresh(token) {
  if (!token) return false;
  return tokenExpiresIn(token) > EXPIRY_BUFFER;
}

// ── Token cache (persists across the 45s startup delay) ──────────────────────
function loadCache() {
  try { return JSON.parse(fs.readFileSync(TOKEN_CACHE, 'utf8')); }
  catch { return {}; }
}

function saveCache(data) {
  try { fs.writeFileSync(TOKEN_CACHE, JSON.stringify(data, null, 2)); } catch {}
}

// ── Refresh via ACP CLI refresh endpoint ─────────────────────────────────────
async function refreshViaAcpCli(refreshToken) {
  try {
    const res = await fetch(`${ACP_SERVER}/auth/cli/refresh`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const token    = body?.data?.token;
    const newRefresh = body?.data?.refreshToken;
    if (token) return { token, refreshToken: newRefresh || refreshToken };
  } catch {}
  return null;
}

// ── Refresh via Privy session endpoint ────────────────────────────────────────
async function refreshViaPrivy(privyRefreshToken, currentAccessToken) {
  try {
    // Privy session refresh: POST /api/v1/sessions
    // Requires current access token in Authorization + refresh_token in body
    const res = await fetch(`${PRIVY_SERVER}/api/v1/sessions`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'privy-app-id':  PRIVY_APP_ID,
        'Authorization': `Bearer ${currentAccessToken}`,
      },
      body: JSON.stringify({ refresh_token: privyRefreshToken }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const token      = body?.token;
    const newRefresh = body?.refresh_token;
    if (token) return { token, refreshToken: newRefresh || privyRefreshToken };
  } catch {}
  return null;
}

// ── Main: get a valid token ───────────────────────────────────────────────────
async function getValidToken() {
  // 1. Check env var
  const envToken = process.env.VIRTUALS_PRIVY_TOKEN;
  if (envToken && isTokenFresh(envToken)) {
    return envToken;
  }

  // 2. Check cache file
  const cache = loadCache();
  if (cache.token && isTokenFresh(cache.token)) {
    return cache.token;
  }

  // 3. Try to refresh
  const staleToken     = envToken || cache.token;   // need for Privy refresh
  const acpRefreshTok  = process.env.VIRTUALS_REFRESH_TOKEN || cache.refreshToken;
  const privyRefreshTok = process.env.VIRTUALS_PRIVY_REFRESH_TOKEN || cache.privyRefreshToken;

  // Try ACP CLI refresh first (cleaner)
  if (acpRefreshTok) {
    console.log('[acpAuth] Access token expired — refreshing via ACP CLI...');
    const result = await refreshViaAcpCli(acpRefreshTok);
    if (result) {
      console.log('[acpAuth] ✅ Token refreshed via ACP CLI.');
      saveCache({ token: result.token, refreshToken: result.refreshToken });
      return result.token;
    }
    console.warn('[acpAuth] ACP CLI refresh failed. Trying Privy...');
  }

  // Try Privy session refresh as fallback
  if (privyRefreshTok && staleToken) {
    console.log('[acpAuth] Trying Privy session refresh...');
    const result = await refreshViaPrivy(privyRefreshTok, staleToken);
    if (result) {
      console.log('[acpAuth] ✅ Token refreshed via Privy.');
      saveCache({ token: result.token, privyRefreshToken: result.refreshToken });
      return result.token;
    }
    console.warn('[acpAuth] Privy refresh also failed.');
  }

  // 4. All refresh attempts failed — log actionable instructions
  const expiresIn = staleToken ? tokenExpiresIn(staleToken) : -1;
  const expired   = expiresIn <= 0;

  console.error(`
[acpAuth] ❌ No valid ACP token available.
  Token status: ${expired ? 'EXPIRED' : `expires in ${expiresIn}s`}
  
  To fix: update VIRTUALS_PRIVY_TOKEN in Railway with a fresh token.
  
  Quick steps:
  1. Go to https://app.virtuals.io — make sure you're logged in
  2. Open DevTools (Cmd+Option+I) → Console tab
  3. Run: localStorage.getItem('privy:token')
  4. Copy the value (without quotes)
  5. In Railway → gsb-swarm service → Variables → update VIRTUALS_PRIVY_TOKEN
  
  For permanent fix, also set VIRTUALS_PRIVY_REFRESH_TOKEN:
  3b. Run: localStorage.getItem('privy:refresh_token')
  4b. Set as VIRTUALS_PRIVY_REFRESH_TOKEN in Railway
  
  ACP registration will be skipped until token is updated.
`);

  return null;
}

// ── Seed cache from env on first load ────────────────────────────────────────
// If env tokens are fresh, seed the cache so refresh tokens persist across restarts
(function seedCache() {
  const cache = loadCache();
  let changed = false;

  const envToken   = process.env.VIRTUALS_PRIVY_TOKEN;
  const envRefresh = process.env.VIRTUALS_REFRESH_TOKEN;
  const envPrivyR  = process.env.VIRTUALS_PRIVY_REFRESH_TOKEN;

  if (envToken && !cache.token)        { cache.token = envToken;               changed = true; }
  if (envRefresh && !cache.refreshToken) { cache.refreshToken = envRefresh;    changed = true; }
  if (envPrivyR && !cache.privyRefreshToken) { cache.privyRefreshToken = envPrivyR; changed = true; }

  if (changed) saveCache(cache);
})();

module.exports = { getValidToken, isTokenFresh, tokenExpiresIn };
