// ── Solana buy via PumpPortal (pump.fun bonding curve, pre-graduation) ────────
async function executeOneBuySolPumpFun(session) {
  const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
  const bs58 = require('bs58');

  const solPrivKey = process.env.SOLANA_PUMP_PRIVATE_KEY || process.env.SOL_PRIVATE_KEY || process.env.AGENT_WALLET_PRIVATE_KEY;
  if (!solPrivKey) throw new Error('SOLANA_PUMP_PRIVATE_KEY not set');

  let keypair;
  try {
    keypair = Keypair.fromSecretKey(bs58.decode(solPrivKey));
  } catch {
    throw new Error('Invalid Solana private key — set SOLANA_PUMP_PRIVATE_KEY');
  }

  const solAmount = session.solPerBuy || 0.01; // SOL per buy
  const mint      = session.tokenAddress;

  // PumpPortal trade-local: returns raw tx bytes, we sign + send
  const ppRes = await fetch('https://pumpportal.fun/api/trade-local', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey:        keypair.publicKey.toBase58(),
      action:           'buy',
      mint,
      denominatedInSol: 'true',
      amount:           solAmount,
      slippage:         15,          // 15% — bonding curve can move fast
      priorityFee:      0.0005,      // ~0.0005 SOL priority fee
      pool:             'pump',      // force bonding curve (use 'raydium' post-graduation)
    }),
    signal: AbortSignal.timeout(12000),
  });

  if (!ppRes.ok) {
    const txt = await ppRes.text();
    throw new Error(`PumpPortal error ${ppRes.status}: ${txt.slice(0, 200)}`);
  }

  // Response is raw transaction bytes
  const txBytes = Buffer.from(await ppRes.arrayBuffer());
  const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');
  const tx = VersionedTransaction.deserialize(txBytes);
  tx.sign([keypair]);

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await connection.confirmTransaction(sig, 'confirmed');

  return { hash: sig, amountOut: 0n, gasUsed: 0n, solSpent: solAmount };
}

// ── Solana buy via Jupiter API ────────────────────────────────────────────────
async function executeOneBuySolana(session) {
  const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
  const bs58 = require('bs58');

  const solPrivKey = process.env.SOLANA_PUMP_PRIVATE_KEY || process.env.SOL_PRIVATE_KEY || process.env.AGENT_WALLET_PRIVATE_KEY;
  if (!solPrivKey) throw new Error('SOLANA_PUMP_PRIVATE_KEY not set');

  const SOL_USDC   = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const outputMint = session.tokenAddress;
  const lamports   = Math.round(session.intervalAmount * 1_000_000); // USDC 6 decimals
  const slippageBps = 300; // 3% slippage for pump bot

  // Get Jupiter quote
  const quoteRes = await fetch(
    `https://quote-api.jup.ag/v6/quote?inputMint=${SOL_USDC}&outputMint=${outputMint}&amount=${lamports}&slippageBps=${slippageBps}`,
    { signal: AbortSignal.timeout(8000) }
  );
  const quote = await quoteRes.json();
  if (!quote.outAmount) throw new Error('Jupiter quote failed: ' + JSON.stringify(quote).slice(0, 200));

  // Get swap transaction
  let keypair;
  try {
    const decoded = bs58.decode(solPrivKey);
    keypair = Keypair.fromSecretKey(decoded);
  } catch {
    throw new Error('Invalid Solana private key — set SOLANA_PUMP_PRIVATE_KEY');
  }

  const swapRes = await fetch('https://quote-api.jup.ag/v6/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
    signal: AbortSignal.timeout(10000),
  });
  const swapData = await swapRes.json();
  if (!swapData.swapTransaction) throw new Error('Jupiter swap tx failed');

  // Sign and send
  const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');
  const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
  const tx    = VersionedTransaction.deserialize(txBuf);
  tx.sign([keypair]);

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await connection.confirmTransaction(sig, 'confirmed');

  return { hash: sig, amountOut: BigInt(quote.outAmount || 0), gasUsed: 0n };
}

'use strict';
require('dotenv').config();
const fs   = require('fs');
const path = require('path');

// ── Constants ─────────────────────────────────────────────────────────────────
const SESSIONS_FILE   = '/tmp/gsb-pump-sessions.json';
const SWARM_WALLET    = '0x592b6eEbd4C99b49Cf23f722E4F62FAEf4cD044d';
const USDC_BASE       = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const UNISWAP_ROUTER  = '0x2626664c2603336E57B271c5C0b26F421741e481';
const WETH_BASE       = '0x4200000000000000000000000000000000000006';
const PLATFORM_FEE    = 0.10;  // 10% of tokens kept
const MAX_SESSION_USD = 1000;
const PAYOUT_DELAY_MS = 20 * 60 * 1000; // 20 min after last buy

const VALID_INTERVALS  = [0.01, 0.02, 0.05, 0.10, 0.25, 0.50, 1.00]; // USDC per buy
const VALID_RATES_MS   = {
  '30s': 30_000,
  '1m':  60_000,
  '2m':  120_000,
  '5m':  300_000,
};

// ── Session store ─────────────────────────────────────────────────────────────
function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { return {}; }
}
function saveSessions(sessions) {
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2)); } catch {}
}

// ── Chain config ──────────────────────────────────────────────────────────────
const CHAIN_USDC = {
  base:     '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  arbitrum: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
  polygon:  '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
};
const CHAIN_ROUTER = {
  base:     '0x2626664c2603336E57B271c5C0b26F421741e481',
  ethereum: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  arbitrum: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  polygon:  '0xE592427A0AEce92De3Edee1F18E0157C05861564',
};
const CHAIN_WETH = {
  base:     '0x4200000000000000000000000000000000000006',
  ethereum: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  arbitrum: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  polygon:  '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
};
const CHAIN_RPC = {
  base:     process.env.BASE_RPC_URL || 'https://base.drpc.org',
  ethereum: process.env.ETH_RPC_URL  || 'https://eth.drpc.org',
  arbitrum: process.env.ARB_RPC_URL  || 'https://arbitrum.drpc.org',
  polygon:  process.env.POLY_RPC_URL || 'https://polygon.drpc.org',
};

// ── Viem swap executor ────────────────────────────────────────────────────────
async function executeOneBuy(session) {
  const { createWalletClient, createPublicClient, http, parseUnits, maxUint256 } = require('viem');
  const chainMap = { base: require('viem/chains').base, ethereum: require('viem/chains').mainnet, arbitrum: require('viem/chains').arbitrum, polygon: require('viem/chains').polygon };
  const { privateKeyToAccount } = require('viem/accounts');

  const chain   = session.chain || 'base';
  const viemChain = chainMap[chain] || chainMap.base;
  const rpc     = CHAIN_RPC[chain] || CHAIN_RPC.base;
  const usdc    = CHAIN_USDC[chain] || CHAIN_USDC.base;
  const router  = CHAIN_ROUTER[chain] || CHAIN_ROUTER.base;
  const weth    = CHAIN_WETH[chain] || CHAIN_WETH.base;

  const pk = process.env.AGENT_WALLET_PRIVATE_KEY;
  if (!pk) throw new Error('AGENT_WALLET_PRIVATE_KEY not set');

  const account      = privateKeyToAccount(pk.startsWith('0x') ? pk : '0x' + pk);
  const walletClient = createWalletClient({ account, chain: viemChain, transport: http(rpc) });
  const publicClient = createPublicClient({ chain: viemChain, transport: http(rpc) });

  const ERC20_ABI = [
    { name: 'approve',   type: 'function', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
    { name: 'allowance', type: 'function', inputs: [{ name: 'owner',   type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
    { name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  ];
  const MULTIHOP_ABI = [{
    name: 'exactInput', type: 'function',
    inputs: [{ name: 'params', type: 'tuple', components: [
      { name: 'path', type: 'bytes' }, { name: 'recipient', type: 'address' },
      { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' },
    ]}],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  }];

  const amountIn = parseUnits(String(session.intervalAmount.toFixed(6)), 6);

  // Check + approve USDC if needed
  const allowance = await publicClient.readContract({ address: usdc, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, router] });
  if (allowance < amountIn) {
    const approveTx = await walletClient.writeContract({ address: usdc, abi: ERC20_ABI, functionName: 'approve', args: [router, maxUint256] });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
  }

  // Build path: USDC → WETH → token
  const encodePath = (tokens, fees) => {
    let enc = tokens[0].slice(2).toLowerCase();
    for (let i = 0; i < fees.length; i++) {
      enc += fees[i].toString(16).padStart(6, '0');
      enc += tokens[i + 1].slice(2).toLowerCase();
    }
    return '0x' + enc;
  };

  // Try direct USDC→token first (500 fee tier), fall back to USDC→WETH→token
  let path;
  let tokenOutAddress = session.tokenAddress;
  // ── Solana path — pump.fun uses PumpPortal, others use Jupiter ───────────────
  if (session.chain === 'solana') {
    if (session.isPumpFun) return await executeOneBuySolPumpFun(session);
    return await executeOneBuySolana(session);
  }
  path = encodePath([usdc, weth, tokenOutAddress], [500, 3000]);

  // Get token balance before
  let balBefore = 0n;
  try {
    balBefore = await publicClient.readContract({ address: tokenOutAddress, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });
  } catch {}

  const hash = await walletClient.writeContract({
    address: router, abi: MULTIHOP_ABI, functionName: 'exactInput',
    args: [{ path, recipient: account.address, amountIn, amountOutMinimum: 0n }],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  // Get token balance after to calculate amount received
  let amountOut = 0n;
  try {
    const balAfter = await publicClient.readContract({ address: tokenOutAddress, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });
    amountOut = balAfter - balBefore;
  } catch {}

  return { hash, amountOut, gasUsed: receipt.gasUsed };
}

// ── USDC deposit detection ────────────────────────────────────────────────────
async function checkDepositReceived(session) {
  const chain = session.chain || 'base';

  // ── Solana sessions: check for SOL deposit via Solana RPC ──
  if (session.chain === 'solana') {
    // Try multiple RPCs in sequence — public mainnet is rate-limited from server IPs
    const SOL_RPCS = [
      process.env.SOLANA_RPC_URL,
      'https://solana-rpc.publicnode.com',    // free, no key needed, handles getTransaction
      'https://api.mainnet-beta.solana.com',  // last resort — rate-limits on getTransaction
    ].filter(Boolean);

    for (const rpcUrl of SOL_RPCS) {
      try {
        const { Connection, PublicKey } = require('@solana/web3.js');
        const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
        const GSB_SOL_WALLET = process.env.GSB_SOL_WALLET || 'F7U3MrnsoZ3umLTmH9Wtae6VGhnWQPRj4Z1Vtv2QSRFs';
        const cutoff = session.createdAt - 60_000;
        const expectedLamports = Math.round(session.totalSol * 1e9);

        const sigs = await connection.getSignaturesForAddress(new PublicKey(GSB_SOL_WALLET), { limit: 25 });
        for (const sigInfo of sigs) {
          if (!sigInfo.blockTime) continue;
          if (sigInfo.blockTime * 1000 < cutoff) break;
          const tx = await connection.getTransaction(sigInfo.signature, { maxSupportedTransactionVersion: 0 });
          if (!tx || !tx.meta) continue;
          const accts = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys;
          const idx   = accts.findIndex(k => k.toBase58() === GSB_SOL_WALLET);
          if (idx === -1) continue;
          const delta = (tx.meta.postBalances[idx] || 0) - (tx.meta.preBalances[idx] || 0);
          // Allow 1% tolerance for rounding / fee edge cases
          if (delta >= Math.round(expectedLamports * 0.99)) return true;
        }
        return false; // RPC responded — no matching deposit found
      } catch (err) {
        console.error(`[pump] SOL deposit check failed on ${rpcUrl}: ${err.message} — trying next RPC`);
      }
    }
    // ── Balance-delta fallback: single getBalance call, no getTransaction needed ──
    // Works even when getTransaction is rate-limited (429)
    console.warn('[pump] All getTransaction RPCs failed — falling back to balance-delta check');
    for (const rpcUrl of SOL_RPCS) {
      try {
        const { Connection, PublicKey } = require('@solana/web3.js');
        const GSB_SOL_WALLET = process.env.GSB_SOL_WALLET || 'F7U3MrnsoZ3umLTmH9Wtae6VGhnWQPRj4Z1Vtv2QSRFs';
        const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
        const currentBalance = await connection.getBalance(new PublicKey(GSB_SOL_WALLET));
        const expectedLamports = Math.round(session.totalSol * 1e9);
        // If we have a baseline, check delta; otherwise store baseline and wait
        if (session.solBalanceAtStart === null || session.solBalanceAtStart === undefined) {
          session.solBalanceAtStart = currentBalance;
          console.log(`[pump] Balance baseline set: ${(currentBalance/1e9).toFixed(6)} SOL`);
          return false;
        }
        const delta = currentBalance - session.solBalanceAtStart;
        console.log(`[pump] Balance delta: ${(delta/1e9).toFixed(6)} SOL, need ${session.totalSol} SOL`);
        if (delta >= Math.round(expectedLamports * 0.99)) return true;
        return false;
      } catch (err) {
        console.error(`[pump] Balance fallback failed on ${rpcUrl}: ${err.message}`);
      }
    }
    return false;
  }

  // ── EVM sessions: Poll Blockscout for inbound USDC transfers ────────────────
  try {
    const explorerBase = chain === 'base' ? 'https://base.blockscout.com' : 'https://blockscout.com';
    const url = `${explorerBase}/api/v2/addresses/${SWARM_WALLET}/token-transfers?token=${CHAIN_USDC[chain] || USDC_BASE}&filter=to`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    const items = d.items || [];
    const cutoff = session.createdAt - 60_000; // allow 1min before session creation
    const expected = Math.round(session.totalAmount * 1e6);
    return items.some(tx => {
      const ts = new Date(tx.timestamp).getTime();
      const val = parseInt(tx.total?.value || '0');
      return ts > cutoff && val >= expected;
    });
  } catch {
    return false;
  }
}

// ── Solana SPL token payout for pump.fun sessions ────────────────────────────
async function sendSplTokensToUser(session) {
  const { Connection, Keypair, PublicKey, Transaction } = require('@solana/web3.js');
  const splToken = require('@solana/spl-token');
  const bs58 = require('bs58');

  const solPrivKey = process.env.SOLANA_PUMP_PRIVATE_KEY || process.env.SOL_PRIVATE_KEY || process.env.AGENT_WALLET_PRIVATE_KEY;
  if (!solPrivKey) throw new Error('SOLANA_PUMP_PRIVATE_KEY not set');
  const keypair = Keypair.fromSecretKey(bs58.decode(solPrivKey));

  const connection   = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');
  const mintPubkey   = new PublicKey(session.tokenAddress);
  const receiverKey  = new PublicKey(session.receivingWallet);

  // Get source ATA (our wallet's token account)
  const sourceATA = await splToken.getAssociatedTokenAddress(mintPubkey, keypair.publicKey);
  const sourceAcct = await splToken.getAccount(connection, sourceATA);
  const totalBal = BigInt(sourceAcct.amount.toString());

  if (totalBal === 0n) throw new Error('No SPL token balance to send');

  // Create/get receiver ATA
  const destATA = await splToken.getOrCreateAssociatedTokenAccount(connection, keypair, mintPubkey, receiverKey);

  const userShare = (totalBal * 90n) / 100n;

  const tx = new Transaction().add(
    splToken.createTransferInstruction(sourceATA, destATA.address, keypair.publicKey, userShare)
  );
  const sig = await connection.sendTransaction(tx, [keypair]);
  await connection.confirmTransaction(sig, 'confirmed');

  return { hash: sig, userShare: userShare.toString(), platformShare: (totalBal - userShare).toString() };
}

// ── Token payout ──────────────────────────────────────────────────────────────
async function sendTokensToUser(session) {
  const { createWalletClient, createPublicClient, http } = require('viem');
  const chainMap = { base: require('viem/chains').base, ethereum: require('viem/chains').mainnet, arbitrum: require('viem/chains').arbitrum, polygon: require('viem/chains').polygon };
  const { privateKeyToAccount } = require('viem/accounts');

  const chain     = session.chain || 'base';
  const viemChain = chainMap[chain] || chainMap.base;
  const rpc       = CHAIN_RPC[chain] || CHAIN_RPC.base;

  const pk = process.env.AGENT_WALLET_PRIVATE_KEY;
  if (!pk) throw new Error('AGENT_WALLET_PRIVATE_KEY not set');

  const account      = privateKeyToAccount(pk.startsWith('0x') ? pk : '0x' + pk);
  const walletClient = createWalletClient({ account, chain: viemChain, transport: http(rpc) });
  const publicClient = createPublicClient({ chain: viemChain, transport: http(rpc) });

  const ERC20_ABI = [
    { name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
    { name: 'transfer',  type: 'function', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  ];

  const tokenAddress = session.tokenAddress;
  const totalBal = await publicClient.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });

  if (totalBal === 0n) throw new Error('No token balance to send');

  // 90% to user, 10% platform fee stays in swarm wallet
  const userShare = (totalBal * 90n) / 100n;

  const hash = await walletClient.writeContract({
    address: tokenAddress, abi: ERC20_ABI, functionName: 'transfer',
    args: [session.receivingWallet, userShare],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  return { hash, userShare: userShare.toString(), platformShare: (totalBal - userShare).toString() };
}

// ── Session lifecycle ─────────────────────────────────────────────────────────
const VALID_SOL_INTERVALS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1]; // SOL per buy
const MAX_SESSION_SOL     = 5; // max 5 SOL per pump.fun session

function createSession({ userId, tokenAddress, chain, totalAmount, intervalAmount, rateName, receivingWallet,
                         isPumpFun, totalSol, solPerBuy }) {
  // Solana sessions (any token) are SOL-denominated; EVM sessions use USD
  const isSolana = chain === 'solana' || isPumpFun;
  // isPumpFun = use PumpPortal (bonding curve); plain Solana = Jupiter
  // Both are SOL-denominated for budget/deposit purposes
  if (isSolana) {
    if (!totalSol || totalSol > MAX_SESSION_SOL) throw new Error(`Solana sessions max ${MAX_SESSION_SOL} SOL`);
    if (!VALID_SOL_INTERVALS.includes(Number(solPerBuy))) throw new Error(`Invalid SOL per buy. Use: ${VALID_SOL_INTERVALS.join(', ')}`);
  } else {
    if (totalAmount > MAX_SESSION_USD)   throw new Error(`Max session is $${MAX_SESSION_USD}`);
    if (!VALID_INTERVALS.includes(intervalAmount)) throw new Error(`Invalid interval. Use: ${VALID_INTERVALS.join(', ')}`);
  }
  if (!VALID_RATES_MS[rateName])       throw new Error(`Invalid rate. Use: ${Object.keys(VALID_RATES_MS).join(', ')}`);
  if (!tokenAddress || tokenAddress.length < 10) throw new Error('Invalid token address');
  if (!receivingWallet || receivingWallet.length < 10) throw new Error('Receiving wallet required');

  // pump.fun = PumpPortal (bonding curve tokens ending in 'pump'), everything else on Solana uses Jupiter
  const detectedPumpFun = isPumpFun || (isSolana && tokenAddress.endsWith('pump'));

  const sessions = loadSessions();
  // Cancel any existing active session for this user
  Object.values(sessions).forEach(s => {
    if (s.userId === String(userId) && s.status === 'pending_deposit') {
      s.status = 'cancelled';
    }
  });

  const sessionId = 'pump_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  sessions[sessionId] = {
    sessionId,
    userId: String(userId),
    tokenAddress,
    chain: isSolana ? 'solana' : (chain || 'base'),
    isPumpFun: detectedPumpFun,
    totalAmount:    isSolana ? null : totalAmount,
    totalSol:       isSolana ? Number(totalSol) : null,
    intervalAmount: isSolana ? null : intervalAmount,
    solPerBuy:      isSolana ? Number(solPerBuy) : null,
    rateName,
    rateMs: VALID_RATES_MS[rateName],
    receivingWallet,
    status: 'pending_deposit',   // pending_deposit → running → paying_out → complete | cancelled | error
    solBalanceAtStart: null,   // set async after session create for balance-delta detection
    buys: [],
    totalSpent: 0,
    totalTokensReceived: '0',
    createdAt: Date.now(),
    lastBuyAt: null,
    depositTxHash: null,
    payoutTxHash: null,
    error: null,
  };
  saveSessions(sessions);
  return sessions[sessionId];
}

function getSession(sessionId) {
  return loadSessions()[sessionId] || null;
}

function getUserSession(userId) {
  const sessions = loadSessions();
  return Object.values(sessions)
    .filter(s => s.userId === String(userId))
    .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
}

function cancelSession(sessionId) {
  const sessions = loadSessions();
  if (sessions[sessionId] && ['pending_deposit', 'running'].includes(sessions[sessionId].status)) {
    sessions[sessionId].status = 'cancelled';
    saveSessions(sessions);
    return true;
  }
  return false;
}

// ── Main ticker — called by setInterval in dashboard-server.js ────────────────
let _running = {};  // sessionId → true (in-flight guard)

async function tick(notify) {
  const sessions = loadSessions();
  let dirty = false;

  for (const session of Object.values(sessions)) {
    if (_running[session.sessionId]) continue;

    // ── Check deposit for pending sessions ──────────────────────────────────
    if (session.status === 'pending_deposit') {
      const _prevBalSnap = session.solBalanceAtStart;
      const received = await checkDepositReceived(session);
      if (session.solBalanceAtStart !== _prevBalSnap) dirty = true; // persist balance baseline
      if (received) {
        session.status = 'running';
        session.startedAt = Date.now();
        dirty = true;
        console.log(`[pump] Session ${session.sessionId} deposit confirmed — starting`);
        const _solSess = session.chain === 'solana';
        const startMsg = _solSess
          ? `✅ *Pump Bot Started*\n\nDeposit received. Buying ${session.tokenAddress.slice(0,10)}... every ${session.rateName} at ${session.solPerBuy} SOL/buy\nTotal: ${session.totalSol} SOL${session.isPumpFun ? '\n🔥 pump.fun bonding curve' : '\n⚡ Jupiter'}`
          : `✅ *Pump Bot Started*\n\nDeposit received. Buying ${session.tokenAddress.slice(0,10)}... every ${session.rateName} at $${session.intervalAmount}/buy\nTotal: $${session.totalAmount}`;
        if (notify) notify(session.userId, startMsg);
      }
      continue;
    }

    // ── Execute buys for running sessions ────────────────────────────────────
    if (session.status === 'running') {
      const now = Date.now();
      const nextBuyAt = (session.lastBuyAt || session.startedAt || now) + session.rateMs;
      if (now < nextBuyAt) continue;

      // Check if we've spent all the budget (SOL or USD depending on session type)
      const budgetExhausted = session.chain === 'solana'
        ? session.totalSpent >= session.totalSol
        : session.totalSpent >= session.totalAmount;

      if (budgetExhausted) {
        session.status = 'pending_payout';
        session.payoutAfter = now + PAYOUT_DELAY_MS;
        dirty = true;
        console.log(`[pump] Session ${session.sessionId} budget exhausted — payout in 20min`);
        const doneMsg = session.chain === 'solana'
          ? `🏁 *Pump Bot Complete*\n\nAll ${session.totalSol} SOL deployed.\nToken payout in 20 minutes to ${session.receivingWallet.slice(0,10)}...`
          : `🏁 *Pump Bot Complete*\n\nAll $${session.totalAmount} deployed.\nToken payout in 20 minutes to ${session.receivingWallet.slice(0,10)}...`;
        if (notify) notify(session.userId, doneMsg);
        continue;
      }

      // Calculate this buy amount (don't overspend)
      let buyAmount;
      if (session.chain === 'solana') {
        const remainingSol = session.totalSol - session.totalSpent;
        buyAmount = Math.min(session.solPerBuy, remainingSol);
      } else {
        const remaining = session.totalAmount - session.totalSpent;
        buyAmount = Math.min(session.intervalAmount, remaining);
      }

      _running[session.sessionId] = true;
      try {
        if (session.chain === 'solana') {
          console.log(`[pump] Solana buying ${buyAmount} SOL of ${session.tokenAddress.slice(0,10)} (${session.isPumpFun ? 'PumpPortal' : 'Jupiter'}) for session ${session.sessionId}`);
        } else {
          console.log(`[pump] Buying $${buyAmount} of ${session.tokenAddress.slice(0,10)} on ${session.chain} for session ${session.sessionId}`);
        }
        const result = await executeOneBuy({ ...session, intervalAmount: buyAmount, solPerBuy: buyAmount });
        session.totalSpent = Math.round((session.totalSpent + buyAmount) * 1e9) / 1e9;
        session.lastBuyAt  = Date.now();
        session.buys.push({
          ts: Date.now(), amount: buyAmount, hash: result.hash,
          amountOut: result.amountOut ? result.amountOut.toString() : '0',
          gas: result.gasUsed ? result.gasUsed.toString() : '0',
        });
        // Accumulate tokens received
        session.totalTokensReceived = (BigInt(session.totalTokensReceived || '0') + (result.amountOut || 0n)).toString();
        dirty = true;
        console.log(`[pump] Buy OK: ${session.chain === 'solana' ? buyAmount + ' SOL' : '$' + buyAmount} → ${result.hash}`);
        if (notify && session.buys.length % 5 === 0) {
          // Progress update every 5 buys
          const progressMsg = session.chain === 'solana'
            ? `⚡ *Pump Bot Update*\n\nBuys: ${session.buys.length}\nSpent: ${session.totalSpent.toFixed(4)} / ${session.totalSol} SOL`
            : `⚡ *Pump Bot Update*\n\nBuys: ${session.buys.length}\nSpent: $${session.totalSpent.toFixed(2)} / $${session.totalAmount}\nRemaining: $${(session.totalAmount - session.totalSpent).toFixed(2)}`;
          notify(session.userId, progressMsg);
        }
      } catch (err) {
        console.error(`[pump] Buy failed for ${session.sessionId}:`, err.message);
        session.buys.push({ ts: Date.now(), amount: buyAmount, error: err.message });
        session.error = err.message;
        // Don't kill the session on one failed buy — keep trying
        dirty = true;
      } finally {
        delete _running[session.sessionId];
        if (session.chain !== 'solana') {
          session.intervalAmount = parseFloat((sessions[session.sessionId]?.intervalAmount || buyAmount).toFixed(6));
        }
      }
    }

    // ── Payout for completed sessions ─────────────────────────────────────────
    if (session.status === 'pending_payout' && Date.now() >= session.payoutAfter) {
      _running[session.sessionId] = true;
      try {
        console.log(`[pump] Paying out session ${session.sessionId} to ${session.receivingWallet}`);
        const payout = session.chain === 'solana'
          ? await sendSplTokensToUser(session)
          : await sendTokensToUser(session);
        session.status       = 'complete';
        session.payoutTxHash = payout.hash;
        dirty = true;
        console.log(`[pump] Payout OK: ${payout.hash}`);
        const _explorerBase = session.chain === 'ethereum' ? 'https://etherscan.io/tx/' : session.chain === 'arbitrum' ? 'https://arbiscan.io/tx/' : session.chain === 'solana' ? 'https://solscan.io/tx/' : 'https://basescan.org/tx/';
        const payoutMsg = `💸 *Tokens Sent*\n\n90% of tokens sent to ${session.receivingWallet.slice(0,10)}...\n[View tx](${_explorerBase}${payout.hash})\n\nThank you for using GSB Pump Bot 🤖`;
        if (notify) notify(session.userId, payoutMsg);
      } catch (err) {
        console.error(`[pump] Payout failed for ${session.sessionId}:`, err.message);
        session.error  = 'Payout failed: ' + err.message;
        session.status = 'error';
        dirty = true;
        if (notify) notify(session.userId, `⚠️ Payout error: ${err.message}\nContact support.`);
      } finally {
        delete _running[session.sessionId];
      }
    }
  }

  if (dirty) saveSessions(sessions);
}

module.exports = {
  createSession, getSession, getUserSession, cancelSession, tick,
  SWARM_WALLET, VALID_INTERVALS, VALID_SOL_INTERVALS, VALID_RATES_MS,
  MAX_SESSION_USD, MAX_SESSION_SOL,
};
