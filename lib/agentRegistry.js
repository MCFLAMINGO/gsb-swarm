'use strict';
/**
 * lib/agentRegistry.js — API token → wallet + tier lookup
 *
 * agent_registry table (auto-created on first call):
 *   token        TEXT PRIMARY KEY
 *   wallet       TEXT NOT NULL        -- Tempo / EVM wallet address
 *   tier         TEXT DEFAULT 'paid'  -- 'paid' | 'sandbox'
 *   daily_limit  INT  DEFAULT 1000
 *   created_at   TIMESTAMPTZ DEFAULT now()
 *   label        TEXT                 -- optional human label
 *
 * Sandbox tier:
 *   - No token OR unrecognised token → sandbox
 *   - 3 calls/day per IP (tracked in sandbox_usage ephemeral map)
 *   - Only FL ZIPs, limited response fields (enforced by callers)
 */

const db = require('./db');

// In-memory sandbox call counter  { ip: { date: 'YYYY-MM-DD', count: N } }
const sandboxUsage = new Map();

const SANDBOX_DAILY_LIMIT = 3;

// ── ensure table exists ───────────────────────────────────────────────────────
let _tableReady = false;
async function ensureTable() {
  if (_tableReady) return;
  if (!process.env.LOCAL_INTEL_DB_URL) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS agent_registry (
        token        TEXT PRIMARY KEY,
        wallet       TEXT NOT NULL,
        tier         TEXT NOT NULL DEFAULT 'paid',
        daily_limit  INT  NOT NULL DEFAULT 1000,
        label        TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    _tableReady = true;
  } catch (e) {
    console.error('[agentRegistry] table init error:', e.message);
  }
}

// ── lookupToken ───────────────────────────────────────────────────────────────
/**
 * Returns { token, wallet, tier, daily_limit } for a registered token,
 * or null if not found.
 */
async function lookupToken(token) {
  if (!token || !process.env.LOCAL_INTEL_DB_URL) return null;
  await ensureTable();
  try {
    return await db.queryOne(
      `SELECT token, wallet, tier, daily_limit, label
         FROM agent_registry
        WHERE token = $1`,
      [token]
    );
  } catch (e) {
    console.error('[agentRegistry] lookup error:', e.message);
    return null;
  }
}

// Internal IPs — Railway localhost, loopback, private subnets used by Railway internal proxy
const INTERNAL_IPS = new Set([
  '127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost',
]);
function isInternalIP(ip) {
  if (!ip) return false;
  if (INTERNAL_IPS.has(ip)) return true;
  // Railway private subnet: 10.x.x.x, 172.16-31.x.x, 192.168.x.x
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('::ffff:10.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  return false;
}

// ── resolveCaller ─────────────────────────────────────────────────────────────
/**
 * Given a raw token string (from header) and caller IP, returns:
 *   { caller, tier, wallet, allowed: true }   — paid registered agent
 *   { caller: 'internal', tier: 'internal', allowed: true } — Railway-internal callers
 *   { caller: 'sandbox:<ip>', tier: 'sandbox', allowed: true/false }  — free tier
 *
 * allowed=false means sandbox daily limit exceeded → caller should 402.
 */
async function resolveCaller(token, ip) {
  // 0. Internal Railway calls (localhost, loopback, private subnet) — always allow, free
  if (isInternalIP(ip)) {
    return {
      caller:  token || 'internal',
      wallet:  null,
      tier:    'internal',
      label:   'internal',
      allowed: true,
    };
  }

  // 1. Try registered token
  if (token) {
    const rec = await lookupToken(token);
    if (rec) {
      return {
        caller:  rec.token,
        wallet:  rec.wallet,
        tier:    rec.tier || 'paid',
        label:   rec.label || null,
        allowed: true,
      };
    }
  }

  // 2. Sandbox — track by IP
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const key   = ip || 'unknown';
  const entry = sandboxUsage.get(key) || { date: today, count: 0 };
  if (entry.date !== today) {
    entry.date  = today;
    entry.count = 0;
  }
  entry.count += 1;
  sandboxUsage.set(key, entry);

  return {
    caller:  `sandbox:${key}`,
    wallet:  null,
    tier:    'sandbox',
    label:   null,
    allowed: entry.count <= SANDBOX_DAILY_LIMIT,
  };
}

// ── registerToken (utility for setup scripts) ─────────────────────────────────
async function registerToken({ token, wallet, tier = 'paid', daily_limit = 1000, label = null }) {
  await ensureTable();
  await db.query(
    `INSERT INTO agent_registry (token, wallet, tier, daily_limit, label)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (token) DO UPDATE
       SET wallet = EXCLUDED.wallet,
           tier   = EXCLUDED.tier,
           daily_limit = EXCLUDED.daily_limit,
           label  = EXCLUDED.label`,
    [token, wallet, tier, daily_limit, label]
  );
}

module.exports = { lookupToken, resolveCaller, registerToken, ensureTable, SANDBOX_DAILY_LIMIT };
