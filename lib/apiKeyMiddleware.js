/**
 * apiKeyMiddleware.js — LocalIntel MCP payment gate
 *
 * Enforces payment on POST /api/local-intel/mcp for external callers.
 *
 * Accepted auth headers (either works):
 *   X-LocalIntel-Key: <token>
 *   Authorization: Bearer <token>
 *
 * Bypass (free, no key needed):
 *   - Requests from localhost / Railway internal network (10.x.x.x)
 *   - X-Internal-Secret: <INTERNAL_SECRET> header
 *   - methods: tools/list, initialize, notifications/*, ping
 *
 * Pricing (stored as micro-USD in agent_registry.balance_usd_micro):
 *   1 USD = 1,000,000 micro-USD
 *   Standard query (limit < 100):  $0.001
 *   Bulk ZIP pull  (limit >= 100): $0.005
 *   Premium tool:                  $0.010
 *
 * Accepted top-up tokens:
 *   pathUSD on Tempo mainnet — deposit to agent_registry.deposit_address
 *   USDC on Base mainnet     — same deposit address or x402 rail
 */

'use strict';

const INTERNAL_SECRET = process.env.INTERNAL_SECRET || 'localintel-internal-2026';

const PRICE = {
  standard:  1000,   // $0.001
  bulk:      5000,   // $0.005
  premium:  10000,   // $0.010
};

const PREMIUM_TOOLS = new Set(['local_intel_for_agent', 'local_intel_ask', 'local_intel_compare']);

function isInternal(req) {
  const ip = req.ip || req.socket?.remoteAddress || '';
  return (
    ip === '127.0.0.1' || ip === '::1' ||
    ip.startsWith('10.') || ip.startsWith('172.') ||
    ip.startsWith('::ffff:127.') || ip.startsWith('::ffff:10.')
  );
}

function calcCost(body) {
  if (!body || body.method !== 'tools/call') return 0;
  const name  = body.params?.name || '';
  const args  = body.params?.arguments || {};
  if (PREMIUM_TOOLS.has(name)) return PRICE.premium;
  const limit = parseInt(args.limit) || 50;
  return limit >= 100 ? PRICE.bulk : PRICE.standard;
}

function extractToken(req) {
  const keyHeader = req.headers['x-localintel-key'];
  if (keyHeader) return keyHeader.trim();
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return req.query?.key || null;
}

// Create + migrate agent_registry table (fully idempotent)
async function migrateTable(db) {
  // Create base table if it doesn't exist
  await db.query(`
    CREATE TABLE IF NOT EXISTS agent_registry (
      token              TEXT PRIMARY KEY,
      label              TEXT,
      balance_usd_micro  BIGINT NOT NULL DEFAULT 0,
      total_spent_micro  BIGINT NOT NULL DEFAULT 0,
      total_queries      BIGINT NOT NULL DEFAULT 0,
      deposit_address    TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at       TIMESTAMPTZ
    )
  `);
  // Add any columns that may be missing on older tables
  await db.query(`
    ALTER TABLE agent_registry
      ADD COLUMN IF NOT EXISTS balance_usd_micro  BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS total_spent_micro  BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS total_queries      BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS deposit_address    TEXT,
      ADD COLUMN IF NOT EXISTS last_used_at       TIMESTAMPTZ
  `);
}

function createApiKeyMiddleware(db) {
  // Run migration best-effort at startup
  migrateTable(db).catch(e =>
    console.error('[api-key-mw] migration failed (ok if first boot):', e.message)
  );

  return async function apiKeyMiddleware(req, res, next) {
    const body   = req.body || {};
    const method = body.method || '';

    // 1. Free methods — no payment needed
    if (
      method === 'tools/list' ||
      method === 'initialize' ||
      method === 'ping' ||
      method.startsWith('notifications/')
    ) return next();

    // 2. Internal Railway network — free
    if (isInternal(req)) {
      req.billingEntry = { token: 'internal', tier: 'internal' };
      return next();
    }

    // 3. Internal secret header — free (for Railway workers calling back)
    if (req.headers['x-internal-secret'] === INTERNAL_SECRET) {
      req.billingEntry = { token: 'internal-secret', tier: 'internal' };
      return next();
    }

    // 4. Require a token
    const token = extractToken(req);
    if (!token) {
      return res.status(402).json({
        jsonrpc: '2.0', id: body.id || null,
        error: {
          code: -32000,
          message: 'Payment required — include X-LocalIntel-Key or Authorization: Bearer <token>',
          data: {
            register: 'POST https://gsb-swarm-production.up.railway.app/api/local-intel/register',
            pricing: { standard: '$0.001', bulk_zip: '$0.005', premium: '$0.010' },
            accepted_tokens: ['pathUSD on Tempo mainnet', 'USDC on Base mainnet'],
            x402_endpoint: 'https://gsb-swarm-production.up.railway.app/api/local-intel/mcp/x402',
          },
        },
      });
    }

    // 5. Look up token in agent_registry
    let entry;
    try {
      const rows = await db.query(
        'SELECT * FROM agent_registry WHERE token = $1',
        [token]
      );
      entry = rows[0];
    } catch (e) {
      console.error('[api-key-mw] DB lookup error:', e.message);
      // Fail open on DB error — don't block callers when Postgres is flaky
      req.billingEntry = { token, tier: 'paid', balance_usd_micro: Infinity };
      return next();
    }

    if (!entry) {
      return res.status(401).json({
        jsonrpc: '2.0', id: body.id || null,
        error: {
          code: -32001,
          message: 'Unrecognised API key. Register at: POST /api/local-intel/register',
        },
      });
    }

    // 6. Check balance
    const cost = calcCost(body);
    const balance = entry.balance_usd_micro ?? 0;

    if (balance < cost) {
      return res.status(402).json({
        jsonrpc: '2.0', id: body.id || null,
        error: {
          code: -32002,
          message: 'Insufficient balance',
          data: {
            balance_usd:     (balance / 1_000_000).toFixed(6),
            cost_usd:        (cost / 1_000_000).toFixed(6),
            deposit_address: entry.deposit_address || null,
            top_up_info:     'Send pathUSD (Tempo mainnet) or USDC (Base) to your deposit address, or use the x402 rail',
            x402_endpoint:   'https://gsb-swarm-production.up.railway.app/api/local-intel/mcp/x402',
          },
        },
      });
    }

    // 7. Deduct atomically — only deducts if balance is still sufficient (race-safe)
    if (cost > 0) {
      try {
        await db.query(
          `UPDATE agent_registry
              SET balance_usd_micro = balance_usd_micro - $1,
                  total_spent_micro = COALESCE(total_spent_micro, 0) + $1,
                  total_queries     = COALESCE(total_queries, 0) + 1,
                  last_used_at      = NOW()
            WHERE token = $2
              AND balance_usd_micro >= $1`,
          [cost, token]
        );
      } catch (e) {
        console.error('[api-key-mw] deduct error:', e.message);
      }
    }

    req.billingEntry = { ...entry, cost_charged: cost };
    next();
  };
}

module.exports = { createApiKeyMiddleware, PRICE };
