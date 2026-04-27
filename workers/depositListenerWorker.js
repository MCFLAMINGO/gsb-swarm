/**
 * depositListenerWorker.js — LocalIntel deposit top-up listener
 *
 * Polls Tempo mainnet + Base mainnet for inbound transfers to registered
 * deposit addresses. Credits balance_usd_micro in agent_registry.
 *
 * Runs as a long-lived process on Railway (spawned by dashboard-server.js
 * via trigger-deposit-listener, or auto-started in the startup IIFE).
 *
 * Supported tokens:
 *   pathUSD (Tempo mainnet, chain 4217) — 0x2000...0000
 *   USDC    (Base mainnet,  chain 8453) — 0x8335...
 *
 * How it works:
 *   1. Load all agent_registry rows that have a deposit_address
 *   2. Poll getLogs(Transfer) on both chains since last_polled_block
 *   3. For any Transfer(to=deposit_address), credit amount * 1e6 micro-USD
 *   4. Log each credit to deposit_credits table (idempotent on tx_hash)
 *   5. Sleep POLL_INTERVAL_MS, repeat
 *
 * Idempotent: tx_hash is PRIMARY KEY in deposit_credits — no double-credits.
 */

'use strict';

const { createPublicClient, http, parseAbi } = require('viem');

// ── Config ────────────────────────────────────────────────────────────────────
const TEMPO_RPC     = process.env.TEMPO_RPC_URL
  || 'https://tempo-mainnet.core.chainstack.com/b6e3587d839ae0350e2a75f3aac441b2';
const BASE_RPC      = process.env.BASE_RPC_URL  || 'https://mainnet.base.org';

const PATHUSD_ADDR  = '0x20c0000000000000000000000000000000000000'; // pathUSD on Tempo
const BASE_USDC     = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC on Base

const POLL_INTERVAL_MS = 30_000;   // 30 seconds between polls
const LOG_BLOCK_RANGE  = 500;      // getLogs block window per call

const TRANSFER_ABI = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

// ── Viem clients ──────────────────────────────────────────────────────────────
const tempoClient = createPublicClient({
  transport: http(TEMPO_RPC, { timeout: 15_000 }),
});
const baseClient = createPublicClient({
  transport: http(BASE_RPC, { timeout: 15_000 }),
});

// ── DB ────────────────────────────────────────────────────────────────────────
const db = require('../lib/db');

async function ensureTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS deposit_credits (
      tx_hash        TEXT PRIMARY KEY,
      token          TEXT NOT NULL,       -- 'pathUSD' | 'USDC'
      network        TEXT NOT NULL,       -- 'tempo' | 'base'
      from_address   TEXT NOT NULL,
      to_address     TEXT NOT NULL,       -- the registered deposit_address
      amount_usd     NUMERIC(18,6) NOT NULL,
      micro_usd      BIGINT NOT NULL,
      registry_token TEXT,               -- agent_registry.token credited
      block_number   BIGINT,
      credited_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS deposit_listener_state (
      id              INT PRIMARY KEY DEFAULT 1,
      tempo_last_block BIGINT NOT NULL DEFAULT 0,
      base_last_block  BIGINT NOT NULL DEFAULT 0,
      last_poll_at     TIMESTAMPTZ
    )
  `);
  // Insert default row if missing
  await db.query(`
    INSERT INTO deposit_listener_state (id) VALUES (1)
    ON CONFLICT (id) DO NOTHING
  `);
  // Add balance columns to agent_registry if missing
  await db.query(`
    ALTER TABLE agent_registry
      ADD COLUMN IF NOT EXISTS balance_usd_micro BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS total_spent_micro BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS total_queries     BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS deposit_address   TEXT,
      ADD COLUMN IF NOT EXISTS last_used_at      TIMESTAMPTZ
  `);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getLastBlocks() {
  const rows = await db.query('SELECT tempo_last_block, base_last_block FROM deposit_listener_state WHERE id = 1');
  return rows[0] || { tempo_last_block: 0n, base_last_block: 0n };
}

async function saveLastBlocks({ tempoBlock, baseBlock }) {
  await db.query(
    `UPDATE deposit_listener_state
        SET tempo_last_block = $1, base_last_block = $2, last_poll_at = NOW()
      WHERE id = 1`,
    [tempoBlock, baseBlock]
  );
}

// Get all registered deposit addresses as a Set (lowercase)
async function getDepositAddresses() {
  const rows = await db.query(
    'SELECT token, deposit_address FROM agent_registry WHERE deposit_address IS NOT NULL'
  );
  // map: lowercase_address → registry_token
  const map = {};
  for (const r of rows) {
    if (r.deposit_address) map[r.deposit_address.toLowerCase()] = r.token;
  }
  return map;
}

// Credit a deposit — idempotent on tx_hash
async function creditDeposit({ txHash, token, network, fromAddr, toAddr, amountUSD, registryToken, blockNumber }) {
  const microUSD = Math.round(amountUSD * 1_000_000);
  if (microUSD <= 0) return;

  // Idempotent insert
  const inserted = await db.query(
    `INSERT INTO deposit_credits
       (tx_hash, token, network, from_address, to_address, amount_usd, micro_usd, registry_token, block_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (tx_hash) DO NOTHING
     RETURNING tx_hash`,
    [txHash, token, network, fromAddr, toAddr, amountUSD, microUSD, registryToken, blockNumber]
  );

  if (!inserted.length) {
    console.log(`[deposit-listener] dup tx ${txHash.slice(0, 12)} — skipped`);
    return;
  }

  // Credit the agent_registry balance
  await db.query(
    `UPDATE agent_registry
        SET balance_usd_micro = balance_usd_micro + $1
      WHERE token = $2`,
    [microUSD, registryToken]
  );

  console.log(`[deposit-listener] ✅ Credited $${amountUSD.toFixed(6)} ${token} → ${registryToken} (${txHash.slice(0, 12)})`);
}

// ── Poll one chain ────────────────────────────────────────────────────────────

async function pollChain({ client, tokenAddr, tokenName, network, lastBlock, depositAddresses }) {
  let currentBlock;
  try {
    currentBlock = await client.getBlockNumber();
  } catch (e) {
    console.warn(`[deposit-listener] ${network} getBlockNumber failed: ${e.message}`);
    return lastBlock;
  }

  if (currentBlock <= lastBlock) return lastBlock;

  const fromBlock = lastBlock === 0n ? currentBlock - 100n : lastBlock + 1n;
  const toBlock   = currentBlock;

  // Chunk into LOG_BLOCK_RANGE windows to avoid RPC limits
  let processed = fromBlock;
  while (processed <= toBlock) {
    const chunkTo = processed + BigInt(LOG_BLOCK_RANGE) - 1n < toBlock
      ? processed + BigInt(LOG_BLOCK_RANGE) - 1n
      : toBlock;

    try {
      const logs = await client.getLogs({
        address:   tokenAddr,
        event:     TRANSFER_ABI[0],
        fromBlock: processed,
        toBlock:   chunkTo,
      });

      for (const log of logs) {
        const toAddr = log.args?.to?.toLowerCase();
        if (!toAddr || !depositAddresses[toAddr]) continue;

        const registryToken = depositAddresses[toAddr];
        const fromAddr      = log.args?.from || '0x';
        const rawValue      = log.args?.value || 0n;
        const amountUSD     = Number(rawValue) / 1e6; // both tokens are 6 decimals
        const txHash        = log.transactionHash;
        const blockNumber   = Number(log.blockNumber);

        console.log(`[deposit-listener] 💰 ${network} ${tokenName} transfer: $${amountUSD.toFixed(4)} → ${toAddr}`);

        await creditDeposit({
          txHash, token: tokenName, network, fromAddr, toAddr,
          amountUSD, registryToken, blockNumber,
        });
      }
    } catch (e) {
      console.warn(`[deposit-listener] ${network} getLogs ${processed}-${chunkTo} failed: ${e.message}`);
    }

    processed = chunkTo + 1n;
  }

  return currentBlock;
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function runLoop() {
  await ensureTables();
  console.log('[deposit-listener] 🚀 Started — polling Tempo (pathUSD) + Base (USDC) every 30s');

  let { tempo_last_block, base_last_block } = await getLastBlocks();
  let tempoBlock = BigInt(tempo_last_block || 0);
  let baseBlock  = BigInt(base_last_block  || 0);

  while (true) {
    try {
      const depositAddresses = await getDepositAddresses();
      const addrCount = Object.keys(depositAddresses).length;

      if (addrCount === 0) {
        console.log('[deposit-listener] No registered deposit addresses — sleeping');
      } else {
        console.log(`[deposit-listener] Polling ${addrCount} deposit addresses...`);

        // Poll both chains in parallel
        const [newTempo, newBase] = await Promise.all([
          pollChain({
            client: tempoClient, tokenAddr: PATHUSD_ADDR, tokenName: 'pathUSD',
            network: 'tempo', lastBlock: tempoBlock, depositAddresses,
          }),
          pollChain({
            client: baseClient, tokenAddr: BASE_USDC, tokenName: 'USDC',
            network: 'base', lastBlock: baseBlock, depositAddresses,
          }),
        ]);

        tempoBlock = newTempo;
        baseBlock  = newBase;
        await saveLastBlocks({ tempoBlock, baseBlock });
      }
    } catch (e) {
      console.error('[deposit-listener] loop error:', e.message);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

runLoop().catch(e => {
  console.error('[deposit-listener] fatal:', e.message);
  process.exit(1);
});
