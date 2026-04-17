/**
 * POST /api/throw-test
 * Runs a real Tempo mainnet plumbing test using THROW_HOST_PK + THROW_PLAYER_PK env vars.
 * Streams step results as NDJSON so the dashboard can show live progress.
 *
 * Steps:
 *   1. Check HOST balance
 *   2. Check PLAYER balance
 *   3. Tempo RPC reachable
 *   4. Generate ephemeral escrow keypair
 *   5. HOST → Escrow transfer ($0.10)
 *   6. PLAYER → Escrow transfer ($0.10)
 *   7. Verify escrow pot
 *   8. Escrow → PLAYER settlement
 *   9. Verify final balances
 */

const TEMPO_RPC    = 'https://tempo-mainnet.core.chainstack.com/b6e3587d839ae0350e2a75f3aac441b2';
const USDC_ADDR    = '0x20c000000000000000000000b9537d11c60e8b50';
const PATHUSD_ADDR = '0x20c0000000000000000000000000000000000000';
const BET_AMOUNT   = 0.10;

async function getViemModules() {
  const viem     = await import('viem');
  const accounts = await import('viem/accounts');
  const chains   = await import('viem/chains');
  const tempo    = await import('viem/tempo').catch(() => null);
  return { viem, accounts, chains, tempo };
}

async function fetchBalance(tokenAddr, walletAddr) {
  const data = '0x70a08231' + walletAddr.replace(/^0x/i, '').toLowerCase().padStart(64, '0');
  const res = await fetch(TEMPO_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: tokenAddr, data }, 'latest'] }),
  });
  const j = await res.json();
  if (!j.result || j.result === '0x') return 0;
  return Number(BigInt(j.result)) / 1e6;
}

async function runThrowTest(send) {
  const hostPK   = process.env.THROW_HOST_PK;
  const playerPK = process.env.THROW_PLAYER_PK;

  if (!hostPK || !playerPK) {
    send({ step: 'Config check', status: 'FAIL', detail: 'THROW_HOST_PK or THROW_PLAYER_PK missing in env' });
    return false;
  }

  let mods;
  try {
    mods = await getViemModules();
  } catch (e) {
    send({ step: 'Load viem', status: 'FAIL', detail: e.message });
    return false;
  }

  const { viem: { createClient, http, publicActions, walletActions, parseUnits }, accounts: { privateKeyToAccount, generatePrivateKey }, chains: { mainnet } } = mods;
  const tempoMod = mods.tempo;

  // Build client — with or without viem/tempo actions
  function makeClient(pk, feeToken) {
    const account = privateKeyToAccount(pk);
    let chain;
    try {
      chain = tempoMod ? tempoMod.tempo({ feeToken }) : { ...mainnet, id: 4217, name: 'Tempo Mainnet', rpcUrls: { default: { http: [TEMPO_RPC] } } };
    } catch (_) {
      chain = { id: 4217, name: 'Tempo Mainnet', nativeCurrency: { name: 'PATH', symbol: 'PATH', decimals: 18 }, rpcUrls: { default: { http: [TEMPO_RPC] } } };
    }
    const client = createClient({ account, chain, transport: http(TEMPO_RPC) })
      .extend(publicActions)
      .extend(walletActions);
    if (tempoMod && tempoMod.tempoActions) {
      return client.extend(tempoMod.tempoActions());
    }
    return client;
  }

  async function transfer(senderClient, tokenAddr, toAddr, amount) {
    if (tempoMod && tempoMod.Actions) {
      const { receipt } = await tempoMod.Actions.token.transferSync(senderClient, {
        token: tokenAddr,
        to: toAddr,
        amount: parseUnits(amount.toFixed(6), 6),
      });
      return receipt.transactionHash;
    }
    throw new Error('viem/tempo Actions not available — transferSync requires tempo module');
  }

  let allPass = true;

  // ── Step 1: HOST balance ──
  send({ step: 'HOST balance check', status: 'running' });
  const hostAcct = privateKeyToAccount(hostPK);
  const hostUSDC0 = await fetchBalance(USDC_ADDR, hostAcct.address);
  const hostPath0 = await fetchBalance(PATHUSD_ADDR, hostAcct.address);
  const hostTotal0 = hostUSDC0 + hostPath0;
  if (hostTotal0 >= BET_AMOUNT) {
    send({ step: 'HOST balance check', status: 'PASS', detail: `USDC.e $${hostUSDC0.toFixed(4)} + pathUSD $${hostPath0.toFixed(4)} = $${hostTotal0.toFixed(4)}` });
  } else {
    send({ step: 'HOST balance check', status: 'FAIL', detail: `Only $${hostTotal0.toFixed(4)} — need $${BET_AMOUNT}` });
    allPass = false; return allPass;
  }

  // ── Step 2: PLAYER balance ──
  send({ step: 'PLAYER balance check', status: 'running' });
  const playerAcct = privateKeyToAccount(playerPK);
  const playerUSDC0 = await fetchBalance(USDC_ADDR, playerAcct.address);
  const playerPath0 = await fetchBalance(PATHUSD_ADDR, playerAcct.address);
  const playerTotal0 = playerUSDC0 + playerPath0;
  if (playerTotal0 >= BET_AMOUNT) {
    send({ step: 'PLAYER balance check', status: 'PASS', detail: `USDC.e $${playerUSDC0.toFixed(4)} + pathUSD $${playerPath0.toFixed(4)} = $${playerTotal0.toFixed(4)}` });
  } else {
    send({ step: 'PLAYER balance check', status: 'FAIL', detail: `Only $${playerTotal0.toFixed(4)} — need $${BET_AMOUNT}` });
    allPass = false; return allPass;
  }

  // ── Step 3: Tempo RPC ──
  send({ step: 'Tempo RPC check', status: 'running' });
  try {
    const r = await fetch(TEMPO_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    });
    const j = await r.json();
    send({ step: 'Tempo RPC check', status: 'PASS', detail: `block ${parseInt(j.result, 16).toLocaleString()}` });
  } catch (e) {
    send({ step: 'Tempo RPC check', status: 'FAIL', detail: e.message });
    allPass = false; return allPass;
  }

  // ── Step 4: Escrow keypair ──
  send({ step: 'Generate escrow keypair', status: 'running' });
  const escrowPK   = generatePrivateKey();
  const escrowAcct = privateKeyToAccount(escrowPK);
  send({ step: 'Generate escrow keypair', status: 'PASS', detail: escrowAcct.address });

  // ── Step 5: HOST → Escrow ──
  send({ step: 'HOST → Escrow transfer', status: 'running' });
  try {
    const hostToken  = hostUSDC0 >= BET_AMOUNT ? USDC_ADDR : PATHUSD_ADDR;
    const hostClient = makeClient(hostPK, hostToken);
    const hash = await transfer(hostClient, hostToken, escrowAcct.address, BET_AMOUNT);
    send({ step: 'HOST → Escrow transfer', status: 'PASS', detail: `tx: ${hash.slice(0, 18)}…` });
  } catch (e) {
    send({ step: 'HOST → Escrow transfer', status: 'FAIL', detail: e.message });
    allPass = false; return allPass;
  }

  // ── Step 6: PLAYER → Escrow ──
  send({ step: 'PLAYER → Escrow transfer', status: 'running' });
  try {
    const playerToken  = playerUSDC0 >= BET_AMOUNT ? USDC_ADDR : PATHUSD_ADDR;
    const playerClient = makeClient(playerPK, playerToken);
    const hash = await transfer(playerClient, playerToken, escrowAcct.address, BET_AMOUNT);
    send({ step: 'PLAYER → Escrow transfer', status: 'PASS', detail: `tx: ${hash.slice(0, 18)}…` });
  } catch (e) {
    send({ step: 'PLAYER → Escrow transfer', status: 'FAIL', detail: e.message });
    allPass = false; return allPass;
  }

  // ── Step 7: Verify escrow pot ──
  send({ step: 'Verify escrow pot', status: 'running' });
  await new Promise(r => setTimeout(r, 2000));
  const escrowUSDC  = await fetchBalance(USDC_ADDR, escrowAcct.address);
  const escrowPath  = await fetchBalance(PATHUSD_ADDR, escrowAcct.address);
  const escrowTotal = escrowUSDC + escrowPath;
  const expected    = BET_AMOUNT * 2;
  if (escrowTotal >= expected * 0.95) {
    send({ step: 'Verify escrow pot', status: 'PASS', detail: `$${escrowTotal.toFixed(4)} (expected ~$${expected.toFixed(2)})` });
  } else {
    send({ step: 'Verify escrow pot', status: 'FAIL', detail: `$${escrowTotal.toFixed(4)} expected $${expected.toFixed(2)}` });
    allPass = false;
  }

  // ── Step 8: Settle → PLAYER ──
  send({ step: 'Escrow → PLAYER settlement', status: 'running' });
  try {
    const settleToken   = escrowUSDC >= 0.001 ? USDC_ADDR : PATHUSD_ADDR;
    const escrowClient  = makeClient(escrowPK, settleToken);
    const settleAmount  = Math.max(0, escrowTotal - 0.001);
    const hash = await transfer(escrowClient, settleToken, playerAcct.address, settleAmount);
    send({ step: 'Escrow → PLAYER settlement', status: 'PASS', detail: `$${settleAmount.toFixed(4)} tx: ${hash.slice(0, 18)}…` });
  } catch (e) {
    send({ step: 'Escrow → PLAYER settlement', status: 'FAIL', detail: e.message });
    allPass = false; return allPass;
  }

  // ── Step 9: Final balances ──
  send({ step: 'Verify final balances', status: 'running' });
  await new Promise(r => setTimeout(r, 2000));
  const hostUSDCF   = await fetchBalance(USDC_ADDR, hostAcct.address);
  const hostPathF   = await fetchBalance(PATHUSD_ADDR, hostAcct.address);
  const playerUSDCF = await fetchBalance(USDC_ADDR, playerAcct.address);
  const playerPathF = await fetchBalance(PATHUSD_ADDR, playerAcct.address);
  const hostLost    = (hostUSDCF + hostPathF) < hostTotal0;
  const playerGain  = (playerUSDCF + playerPathF) > (playerUSDC0 + playerPath0);
  if (hostLost && playerGain) {
    send({ step: 'Verify final balances', status: 'PASS', detail: `HOST -$${(hostTotal0 - hostUSDCF - hostPathF).toFixed(4)} PLAYER +$${(playerUSDCF + playerPathF - playerUSDC0 - playerPath0).toFixed(4)}` });
  } else {
    send({ step: 'Verify final balances', status: 'FAIL', detail: `hostLost=${hostLost} playerGain=${playerGain}` });
    allPass = false;
  }

  return allPass;
}

module.exports = function registerThrowTestRoute(app) {
  app.post('/api/throw-test', async (req, res) => {
    // Auth check — require dashboard token
    const auth = req.headers['authorization'] || '';
    const token = auth.replace('Bearer ', '');
    if (token !== process.env.DASHBOARD_PASSWORD) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Stream NDJSON
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.flushHeaders();

    const send = (obj) => {
      res.write(JSON.stringify(obj) + '\n');
    };

    try {
      const allPass = await runThrowTest(send);
      send({ done: true, allPass });
    } catch (e) {
      send({ done: true, allPass: false, error: e.message });
    }
    res.end();
  });

  console.log('[throw-test] /api/throw-test route registered');
};
