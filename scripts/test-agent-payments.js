'use strict';
/**
 * test-agent-payments.js
 *
 * Runs 5 ACP agent wallets (Base/USDC) through one paid MCP call each.
 * Each agent pays $0.01 USDC to TREASURY via the x402 endpoint, then
 * calls its matching vertical tool.
 *
 * Payment flow (x402 protocol):
 *  1. POST /api/local-intel/mcp/x402  →  server returns 402 with paymentRequirements
 *  2. Client reads requirements, signs EIP-3009 USDC transfer auth with agent PK
 *  3. Re-send with X-PAYMENT header  →  server verifies + forwards to MCP
 *
 * Usage (run from /gsb-swarm):
 *   node scripts/test-agent-payments.js
 *
 * Reads PKs from Railway env vars:
 *   CEO_SIGNER_PK, WALLET_PROFILER_SIGNER_PK, ALPHA_SCANNER_SIGNER_PK,
 *   TOKEN_ANALYST_SIGNER_PK, THREAD_WRITER_SIGNER_PK
 *
 * Or override with local .env or env export before running.
 */

const { createWalletClient, http, createPublicClient } = require('viem');
const { base } = require('viem/chains');
const { privateKeyToAccount } = require('viem/accounts');

// x402 client — CJS path
const { createPaymentHeader, selectPaymentRequirements } = require('x402/client');

const BASE_URL = process.env.MCP_BASE_URL || 'https://gsb-swarm-production.up.railway.app';
const X402_ENDPOINT = `${BASE_URL}/api/local-intel/mcp/x402`;
const TREASURY = '0x774f484192Cf3F4fB9716Af2e15f44371fD32FEA';

// ── Note on ACP wallet addresses ──────────────────────────────────────────────
// The ACP agent wallet addresses (0xb165a3b0... etc.) are ACP-platform custodied.
// Their EVM private keys are managed by the ACP SDK, not exposed in Railway.
// For payment signing we use EVM wallets we DO hold keys for:
//   PLAYER (0x592b...)  = $9 USDC on Base — represents buyer/agent side
//   EXECUTOR (0xca55...) = $15 USDC on Base — represents orchestrator
// Each "agent" call is labeled with its ACP identity but signs from PLAYER.
// Future: ACP SDK natively supports x402 calls — wallet=self, sign=ACP.

// ── Agent definitions ──────────────────────────────────────────────────────────
const AGENTS = [
  {
    name:     'GSB CEO (1332) — Realtor vertical',
    pkEnv:    'THROW_PLAYER_PK',           // PLAYER wallet — $9 USDC on Base
    address:  '0x592b6eEbd4C99b49Cf23f722E4F62FAEf4cD044d',
    vertical: 'local_intel_realtor',
    query:    'What is the owner-occupancy rate and home value median?',
    zip:      '32082',
  },
  {
    name:     'GSB Wallet Profiler (1334) — Healthcare vertical',
    pkEnv:    'THROW_PLAYER_PK',
    address:  '0x592b6eEbd4C99b49Cf23f722E4F62FAEf4cD044d',
    vertical: 'local_intel_healthcare',
    query:    'What is the senior population percentage that drives home health demand?',
    zip:      '32082',
  },
  {
    name:     'GSB Alpha Scanner (1335) — Construction vertical',
    pkEnv:    'THROW_PLAYER_PK',
    address:  '0x592b6eEbd4C99b49Cf23f722E4F62FAEf4cD044d',
    vertical: 'local_intel_construction',
    query:    'What new construction or development projects are active in this ZIP?',
    zip:      '32082',
  },
  {
    name:     'GSB Token Analyst (1333) — Restaurant vertical',
    pkEnv:    'THROW_PLAYER_PK',
    address:  '0x592b6eEbd4C99b49Cf23f722E4F62FAEf4cD044d',
    vertical: 'local_intel_restaurant',
    query:    'What restaurants are in Ponte Vedra Beach?',
    zip:      '32082',
  },
  {
    name:     'GSB Thread Writer (1336) — Retail vertical',
    pkEnv:    'THROW_PLAYER_PK',
    address:  '0x592b6eEbd4C99b49Cf23f722E4F62FAEf4cD044d',
    vertical: 'local_intel_retail',
    query:    'What retail categories are undersupplied for the income level here?',
    zip:      '32082',
  },
];

// ── x402 payment helper ────────────────────────────────────────────────────────

async function fetchWithX402Payment(privateKey, method, body) {
  const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(pk);

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(),
  });

  // Step 1: probe — send request, expect 402
  const probeRes = await fetch(X402_ENDPOINT, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (probeRes.status !== 402) {
    // Already answered (no paywall?) or error
    const data = await probeRes.json();
    return { status: probeRes.status, data, paid: false };
  }

  // Step 2: parse payment requirements from 402 response
  const paymentRequired = await probeRes.json();
  const requirements = paymentRequired?.accepts || paymentRequired;

  // selectPaymentRequirements picks the best match for our chain/scheme
  const selected = selectPaymentRequirements(
    Array.isArray(requirements) ? requirements : [requirements],
    { network: 'base', scheme: 'exact' }
  );

  if (!selected) {
    throw new Error('No matching payment requirement for Base/exact scheme');
  }

  // Step 3: sign payment header using EIP-3009
  const paymentHeader = await createPaymentHeader(walletClient, 1, selected);

  // Step 4: re-send with X-PAYMENT header
  const paidRes = await fetch(X402_ENDPOINT, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-PAYMENT': paymentHeader,
    },
    body: JSON.stringify(body),
  });

  const data = await paidRes.json();
  return { status: paidRes.status, data, paid: true };
}

// ── Run one agent ──────────────────────────────────────────────────────────────

async function runAgent(agent) {
  const pk = process.env[agent.pkEnv];
  if (!pk) {
    return {
      agent: agent.name,
      status: 'SKIP',
      reason: `${agent.pkEnv} not set in env`,
    };
  }

  const mcpBody = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: {
      name: agent.vertical,
      arguments: { query: agent.query, zip: agent.zip },
    },
  };

  try {
    const { status, data, paid } = await fetchWithX402Payment(pk, 'POST', mcpBody);

    const toolData = data?.result?.content?.[0]?.text;
    let parsed = null;
    try { parsed = JSON.parse(toolData); } catch (_) { parsed = toolData; }

    const score = parsed?.confidence_score ?? '—';
    const tool  = parsed?.tool_used ?? '—';

    return {
      agent:    agent.name,
      address:  agent.address,
      vertical: agent.vertical,
      paid,
      http_status: status,
      confidence_score: score,
      tool_used: tool,
      query:    agent.query,
      status:   status === 200 ? 'PASS' : 'FAIL',
    };
  } catch (err) {
    return {
      agent:    agent.name,
      address:  agent.address,
      vertical: agent.vertical,
      status:   'ERROR',
      error:    err.message,
    };
  }
}

// ── USDC balance check ─────────────────────────────────────────────────────────

async function getUSDCBalance(address) {
  const publicClient = createPublicClient({ chain: base, transport: http() });
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  try {
    const bal = await publicClient.readContract({
      address: USDC,
      abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }],
      functionName: 'balanceOf',
      args: [address],
    });
    return (Number(bal) / 1e6).toFixed(4);
  } catch (_) {
    return 'unknown';
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  LocalIntel Agent-to-Agent Payment Test                     ║');
  console.log(`║  ${new Date().toISOString().replace('T', ' ').slice(0, 19)} EDT  →  ${X402_ENDPOINT}  ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // Pre-check: TREASURY balance before
  const treasuryBefore = await getUSDCBalance(TREASURY);
  console.log(`TREASURY balance before: $${treasuryBefore} USDC\n`);

  const results = [];
  for (const agent of AGENTS) {
    process.stdout.write(`  Running ${agent.name}... `);
    const result = await runAgent(agent);
    results.push(result);
    const icon = result.status === 'PASS' ? '✅' : result.status === 'SKIP' ? '⏭️ ' : '❌';
    console.log(`${icon} ${result.status}${result.paid ? ' · paid' : ''}${result.error ? ' · ' + result.error : ''}`);
    // Wait for Base to confirm the settlement tx before next agent
    // Treasury wallet nonce must advance before submitting next transferWithAuthorization
    if (result.paid) {
      await new Promise(r => setTimeout(r, 10000)); // ~5 Base blocks — wait for settlement confirm
    }
  }

  // Post-check: TREASURY balance after
  const treasuryAfter = await getUSDCBalance(TREASURY);
  const delta = (parseFloat(treasuryAfter) - parseFloat(treasuryBefore)).toFixed(4);

  console.log('\n── Results ───────────────────────────────────────────────────────');
  console.table(results.map(r => ({
    Agent:        r.agent,
    Vertical:     r.vertical,
    Paid:         r.paid ? 'yes' : 'no',
    Status:       r.status,
    Score:        r.confidence_score,
    Tool:         r.tool_used,
    Error:        r.error || '',
  })));

  console.log('\n── TREASURY ─────────────────────────────────────────────────────');
  console.log(`  Before: $${treasuryBefore} USDC`);
  console.log(`  After:  $${treasuryAfter} USDC`);
  console.log(`  Delta:  +$${delta} USDC`);

  const passes = results.filter(r => r.status === 'PASS').length;
  const paid   = results.filter(r => r.paid).length;
  console.log(`\n  ${passes}/${AGENTS.length} agents passed · ${paid} payments sent`);
  console.log('\n  Smithery observability: https://smithery.ai/servers/erik-7clt/local-intel');
  console.log('  Basescan TREASURY: https://basescan.org/address/0x774f484192Cf3F4fB9716Af2e15f44371fD32FEA\n');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
