'use strict';
/**
 * bazaar-self-pay.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Triggers first x402 payment through the CDP facilitator so LocalIntel
 * appears in the Coinbase Payments Bazaar discovery index.
 *
 * Why CDP facilitator instead of self-facilitator:
 *   The Bazaar catalogs services whose payments flow through
 *   https://x402.org/facilitator. Self-facilitated payments are invisible
 *   to the Bazaar. This script uses the public CDP facilitator for the
 *   bootstrap payment only — ongoing payments still use self-facilitator.
 *
 * Requirements:
 *   BAZAAR_PAYER_PK — private key of a Base wallet funded with ≥ $0.02 USDC
 *   (standard $0.01 + premium $0.05 + gas margin)
 *   Set in Railway env or .env.local for local testing.
 *
 * Usage:
 *   node scripts/bazaar-self-pay.js
 *
 * Expected output:
 *   ✓ Standard endpoint ($0.01) — indexed
 *   ✓ Premium endpoint ($0.05) — indexed
 *   Discovery URL: https://x402.org/facilitator/discovery/resources?payTo=0x...
 */

const { wrapFetchWithPayment, createSigner } = require('x402-fetch');
const { privateKeyToAccount }                = require('viem/accounts');
const { createWalletClient, http }           = require('viem');
const { base }                               = require('viem/chains');

// ── Config ───────────────────────────────────────────────────────────────────
const RAILWAY_BASE  = 'https://gsb-swarm-production.up.railway.app';
const TREASURY_ADDR = '0x774f484192Cf3F4fB9716Af2e15f44371fD32FEA';
const CDP_FACILITATOR = 'https://x402.org/facilitator';

const PAYER_PK = process.env.BAZAAR_PAYER_PK || process.env.THROW_TREASURY_PK || null;

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!PAYER_PK) {
    console.error('ERROR: Set BAZAAR_PAYER_PK env var to a Base wallet private key funded with ≥ $0.07 USDC');
    console.error('       If you use the treasury key it will pay itself — valid for indexing purposes.');
    process.exit(1);
  }

  const pk      = PAYER_PK.startsWith('0x') ? PAYER_PK : '0x' + PAYER_PK;
  const account = privateKeyToAccount(pk);

  console.log(`Payer wallet: ${account.address}`);
  console.log(`Treasury (payTo): ${TREASURY_ADDR}`);
  console.log(`CDP Facilitator: ${CDP_FACILITATOR}`);
  console.log('');

  // x402-fetch signer using the CDP public facilitator
  const signer       = createSigner({ walletClient: createWalletClient({ account, chain: base, transport: http() }) });
  const fetchWithPay = wrapFetchWithPayment(fetch, signer, CDP_FACILITATOR);

  const endpoints = [
    {
      label:   'Standard ($0.01)',
      url:     `${RAILWAY_BASE}/api/local-intel/mcp/x402`,
      body:    JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    },
    {
      label:   'Premium ($0.05)',
      url:     `${RAILWAY_BASE}/api/local-intel/mcp/x402/premium`,
      body:    JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2 }),
    },
  ];

  for (const ep of endpoints) {
    console.log(`→ Hitting ${ep.label}: ${ep.url}`);
    try {
      const res = await fetchWithPay(ep.url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    ep.body,
      });

      const xPayment = res.headers.get('x-payment-response');
      const status   = res.status;
      const body     = await res.text();

      if (status === 200) {
        console.log(`  ✓ Payment accepted (HTTP 200)`);
        console.log(`  x-payment-response: ${xPayment ? xPayment.slice(0, 80) + '...' : 'none'}`);
        console.log(`  Response preview: ${body.slice(0, 120)}`);
      } else if (status === 402) {
        console.log(`  ✗ Still 402 — payment not accepted. Check PAYER_PK has USDC on Base mainnet.`);
        console.log(`  Body: ${body.slice(0, 200)}`);
      } else {
        console.log(`  HTTP ${status}: ${body.slice(0, 200)}`);
      }
    } catch (err) {
      console.error(`  Error: ${err.message}`);
    }
    console.log('');
    // 3 second gap between calls
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log('─────────────────────────────────────────────────────────');
  console.log('Check Bazaar indexing (allow ~5 min for CDP to process):');
  console.log(`  https://x402.org/facilitator/discovery/resources?payTo=${TREASURY_ADDR}`);
  console.log('');
  console.log('Or query programmatically:');
  console.log(`  curl "https://x402.org/facilitator/discovery/resources?payTo=${TREASURY_ADDR}"`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
