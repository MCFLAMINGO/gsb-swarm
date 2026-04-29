'use strict';
/**
 * lib/x402Middleware.js — x402 HTTP 402 payment layer for LocalIntel MCP
 *
 * Supports two networks in the paymentRequirements array:
 *   1. Base mainnet  (eip155:8453)  — USDC — CDP facilitator (Coinbase-native)
 *   2. Tempo mainnet (eip155:4217)  — pathUSD — verified via Tempo RPC
 *
 * Usage (raw Node http.createServer handler):
 *   const { x402Gate } = require('./lib/x402Middleware');
 *
 *   // In your request handler, before running the tool:
 *   const gate = await x402Gate(req, toolName, amount);
 *   if (gate.reject) {
 *     res.writeHead(gate.status);
 *     return res.end(JSON.stringify(gate.body));
 *   }
 *   // gate.paymentInfo = { txHash, amount, from, network } or null (sandbox/bearer)
 *
 * Payment header flow (x402 spec):
 *   Client receives 402 → pays on-chain → retries with X-PAYMENT header (base64 JSON)
 *   { network: 'base'|'tempo', txHash: '0x...' }
 *
 * Receipt logging:
 *   Every verified payment writes to Postgres payments_x402 table.
 *   Duplicate txHash is rejected (idempotency).
 */

const { createPublicClient, http: viemHttp, parseUnits } = require('viem');
const db = require('./db');

// ── Constants ─────────────────────────────────────────────────────────────────

// Base mainnet treasury — receives USDC on Base
const BASE_TREASURY    = process.env.BASE_TREASURY    || '0x1447612B0Dc9221434bA78F63026E356de7F30FA';
// Tempo mainnet treasury — receives pathUSD on Tempo
const TEMPO_TREASURY   = process.env.LOCAL_INTEL_TREASURY || '0x774f484192Cf3F4fB9716Af2e15f44371fD32FEA';
// Legacy alias (kept for module.exports compat)
const TREASURY         = TEMPO_TREASURY;

// Base mainnet USDC
const BASE_RPC         = 'https://mainnet.base.org';
const BASE_CHAIN_ID    = 8453;
const BASE_USDC        = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_CAIP2       = 'eip155:8453';

// Tempo mainnet pathUSD
const TEMPO_RPC        = 'https://tempo-mainnet.core.chainstack.com/b6e3587d839ae0350e2a75f3aac441b2';
const TEMPO_CHAIN_ID   = 4217;
const PATHUSD_ADDR     = '0x20c0000000000000000000000000000000000000';
const TEMPO_CAIP2      = 'eip155:4217';

// CDP facilitator (recommended by Coinbase for mainnet agents — Agent.market compatible)
const CDP_FACILITATOR  = 'https://api.cdp.coinbase.com/platform/v2/x402';

// Minimal ERC-20 Transfer event ABI for on-chain verification
const TRANSFER_ABI = [{
  type: 'event',
  name: 'Transfer',
  inputs: [
    { name: 'from',  type: 'address', indexed: true },
    { name: 'to',    type: 'address', indexed: true },
    { name: 'value', type: 'uint256', indexed: false },
  ],
}];

// ── Clients (lazy) ────────────────────────────────────────────────────────────
let _baseClient  = null;
let _tempoClient = null;

function baseClient() {
  if (!_baseClient) {
    _baseClient = createPublicClient({ transport: viemHttp(BASE_RPC) });
  }
  return _baseClient;
}

function tempoClient() {
  if (!_tempoClient) {
    _tempoClient = createPublicClient({ transport: viemHttp(TEMPO_RPC) });
  }
  return _tempoClient;
}

// ── On-chain verification ─────────────────────────────────────────────────────

/**
 * Verify a Transfer(from, to=treasury, value>=expected) in a tx receipt.
 * Returns { from, amount } or null.
 * @param {object} client   - viem public client for the correct chain
 * @param {string} txHash
 * @param {string} tokenAddr
 * @param {number} expectedUSD
 * @param {string} treasury  - chain-specific treasury address
 */
async function verifyTransfer(client, txHash, tokenAddr, expectedUSD, treasury) {
  try {
    const receipt = await client.getTransactionReceipt({ hash: txHash });
    if (!receipt || receipt.status !== 'success') return null;

    const expectedAtomic = parseUnits(String(expectedUSD), 6); // USDC + pathUSD both 6 decimals
    const treasuryLower  = treasury.toLowerCase();

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== tokenAddr.toLowerCase()) continue;
      try {
        // Decode Transfer event manually (avoid viem decodeEventLog version compat issues)
        if (log.topics.length < 3) continue;
        const to = '0x' + log.topics[2].slice(26); // last 20 bytes of 32-byte topic
        if (to.toLowerCase() !== treasuryLower) continue;
        const value = BigInt(log.data);
        if (value >= expectedAtomic) {
          const from = '0x' + log.topics[1].slice(26);
          return { from, amount: Number(value) / 1e6 };
        }
      } catch { continue; }
    }
    return null;
  } catch (e) {
    console.error('[x402] verifyTransfer error:', e.message);
    return null;
  }
}

// ── Parse X-PAYMENT header ────────────────────────────────────────────────────

function parsePaymentHeader(header) {
  if (!header) return null;
  try {
    // x402 v2: base64-encoded JSON  { network, txHash } or { network, transaction }
    const decoded = Buffer.from(header, 'base64').toString('utf8');
    const obj = JSON.parse(decoded);
    return {
      network: (obj.network || 'base').toLowerCase(),
      txHash:  obj.txHash || obj.transaction || null,
    };
  } catch {
    // Fallback: raw tx hash (assume Base)
    if (/^0x[0-9a-f]{64}$/i.test(header.trim())) {
      return { network: 'base', txHash: header.trim() };
    }
    return null;
  }
}

// ── Build 402 response body ───────────────────────────────────────────────────

function build402(toolName, amount, resourceUrl) {
  const amountStr  = String(amount);
  const atomicAmt  = String(Math.round(amount * 1e6)); // 6 decimals

  return {
    x402Version: 2,
    error: 'payment_required',
    description: `LocalIntel MCP — ${toolName} costs $${amountStr} pathUSD/USDC per call`,
    resource: resourceUrl,
    facilitator: CDP_FACILITATOR,
    accepts: [
      {
        scheme:            'exact',
        network:           BASE_CAIP2,
        asset:             BASE_USDC,
        maxAmountRequired: atomicAmt,
        payTo:             BASE_TREASURY,
        description:       `${toolName} — USDC on Base`,
        mimeType:          'application/json',
        maxTimeoutSeconds: 300,
        estimatedFee:      '<$0.001',
        estimatedFinality: '~2s',
      },
      {
        scheme:            'exact',
        network:           TEMPO_CAIP2,
        asset:             PATHUSD_ADDR,
        maxAmountRequired: atomicAmt,
        payTo:             TEMPO_TREASURY,
        description:       `${toolName} — pathUSD on Tempo`,
        mimeType:          'application/json',
        maxTimeoutSeconds: 300,
        estimatedFee:      '~$0.006',
        estimatedFinality: '~3s',
      },
    ],
    // CDP / Agent.market compatible paymentRequirements alias
    paymentRequirements: [
      {
        scheme:            'exact',
        network:           BASE_CAIP2,
        maxAmountRequired: atomicAmt,
        resource:          resourceUrl,
        description:       `LocalIntel ${toolName}`,
        mimeType:          'application/json',
        payTo:             BASE_TREASURY,
        maxTimeoutSeconds: 300,
        asset:             BASE_USDC,
      },
      {
        scheme:            'exact',
        network:           TEMPO_CAIP2,
        maxAmountRequired: atomicAmt,
        resource:          resourceUrl,
        description:       `LocalIntel ${toolName}`,
        mimeType:          'application/json',
        payTo:             TEMPO_TREASURY,
        maxTimeoutSeconds: 300,
        asset:             PATHUSD_ADDR,
      },
    ],
  };
}

// ── Main gate function ────────────────────────────────────────────────────────

/**
 * x402Gate — call before running a paid tool.
 *
 * @param {object} req         - Node http.IncomingMessage
 * @param {string} toolName    - e.g. 'local_intel_compare'
 * @param {number} amount      - USD amount (e.g. 0.08)
 * @param {object} opts
 *   @param {boolean} opts.skip       - skip gate entirely (sandbox/bearer already handled)
 *   @param {string}  opts.resourceUrl
 *
 * Returns:
 *   { reject: false, paymentInfo: { txHash, amount, from, network } | null }
 *   { reject: true,  status: 402|400, body: {...} }
 */
async function x402Gate(req, toolName, amount, opts = {}) {
  if (opts.skip) return { reject: false, paymentInfo: null };

  const resourceUrl = opts.resourceUrl || `https://gsb-swarm-production.up.railway.app/api/local-intel/mcp`;
  const paymentHeader = req.headers['x-payment'] || req.headers['payment-signature'];

  if (!paymentHeader) {
    // No payment proof — return 402
    return {
      reject: true,
      status: 402,
      body: build402(toolName, amount, resourceUrl),
    };
  }

  const parsed = parsePaymentHeader(paymentHeader);
  if (!parsed || !parsed.txHash) {
    return {
      reject: true,
      status: 400,
      body: { error: 'invalid_payment_header', message: 'X-PAYMENT must be base64 JSON { network, txHash } or a raw 0x tx hash' },
    };
  }

  // Verify on the correct chain
  let verification = null;
  const isTempo = parsed.network === 'tempo';
  if (isTempo) {
    verification = await verifyTransfer(tempoClient(), parsed.txHash, PATHUSD_ADDR, amount, TEMPO_TREASURY);
  } else {
    // Default: Base USDC
    verification = await verifyTransfer(baseClient(), parsed.txHash, BASE_USDC, amount, BASE_TREASURY);
  }

  if (!verification) {
    return {
      reject: true,
      status: 400,
      body: {
        error: 'payment_verification_failed',
        network: parsed.network,
        txHash: parsed.txHash,
        message: `Could not verify $${amount} transfer to ${isTempo ? TEMPO_TREASURY : BASE_TREASURY} on ${parsed.network}`,
      },
    };
  }

  // ── Write receipt to Postgres (idempotent — duplicate txHash is a no-op) ──
  try {
    await db.query(
      `INSERT INTO payments_x402 (tx_hash, from_address, chain, amount_usd, tool_name, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (tx_hash) DO NOTHING`,
      [parsed.txHash, verification.from, parsed.network, verification.amount, toolName]
    );
  } catch (dbErr) {
    // Non-fatal — log but don't block the call. Postgres is king but the tool still ran.
    console.error('[x402] receipt write error:', dbErr.message);
  }

  return {
    reject: false,
    paymentInfo: {
      txHash:  parsed.txHash,
      amount:  verification.amount,
      from:    verification.from,
      network: parsed.network,
    },
  };
}

module.exports = { x402Gate, build402, verifyTransfer, TREASURY, BASE_TREASURY, TEMPO_TREASURY, BASE_USDC, PATHUSD_ADDR };
