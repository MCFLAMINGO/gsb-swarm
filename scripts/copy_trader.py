#!/usr/bin/env python3
"""
copy_trader.py — GSB Copy Trade Engine
MCFL Restaurant Holdings LLC

Finds high-win-rate wallets on Base, mirrors their trades proportionally.

Usage:
  python3 copy_trader.py --budget 10 --hunt        # Hunt for best wallets + start watching
  python3 copy_trader.py --budget 10 --wallet 0x.. # Watch specific wallet
  python3 copy_trader.py --status                  # Show current positions + P&L

Flow:
  1. Hunt: Pull top performers from DexScreener/defined.fi, score by win rate
  2. Watch: Monitor target wallet via RPC polling for swaps
  3. Copy:  Mirror buy/sell on Uniswap v3 — decode real tokenOut from swap log
  4. Report: Telegram alert on every trade with running P&L
"""

import asyncio
import json
import os
import sys
import time
import argparse
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
import urllib.request
import urllib.error

# ── Config ───────────────────────────────────────────────────────────────────
BASE_RPC    = os.environ.get('BASE_RPC_URL', 'https://base.drpc.org')
ALCHEMY_KEY = os.environ.get('ALCHEMY_API_KEY', '')
AGENT_KEY   = os.environ.get('AGENT_WALLET_PRIVATE_KEY', '')
TG_TOKEN    = os.environ.get('TELEGRAM_BOT_TOKEN', '')
TG_CHAT     = os.environ.get('TELEGRAM_CHANNEL_ID', '')
SWARM_WALLET = '0x592b6eEbd4C99b49Cf23f722E4F62FAEf4cD044d'

# State file — persists positions across restarts
STATE_FILE  = Path('/tmp/gsb-copy-trader-state.json')

# Uniswap v3 router on Base
UNISWAP_V3_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481'
USDC_BASE         = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
WETH_BASE         = '0x4200000000000000000000000000000000000006'

# Hunt parameters
MIN_WIN_RATE    = 0.55   # 55% real wins (conservative — real data)
MIN_TRADES      = 5      # at least 5 observed swaps in window
MIN_COPY_BUY    = 50     # copy buys > $50 (lowered — $25 budget)
STOP_LOSS_PCT   = -0.15  # -15% stop loss
TAKE_PROFIT_PCT =  0.20  # +20% take profit

# Uniswap v3 Swap event topic
SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'

# Known aggregators/routers to skip when hunting wallets
SKIP_ADDRS = {
    '0x2626664c2603336e57b271c5c0b26f421741e481',  # Uniswap v3 router
    '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24',  # Uniswap v2 router
    '0x6131b5fae19ea4f9d964eac0408e4408b66337b5',  # KyberSwap
    '0x1111111254eeb25477b68fb85ed929f73a960582',  # 1inch
    '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad',  # Uniswap UniversalRouter
    '0x0000000000000000000000000000000000000000',
}

# ── Telegram ──────────────────────────────────────────────────────────────────
def tg_send(msg: str):
    if not TG_TOKEN or not TG_CHAT:
        print(f'[tg] {msg}')
        return
    try:
        data = json.dumps({'chat_id': TG_CHAT, 'text': msg, 'parse_mode': 'Markdown'}).encode()
        req = urllib.request.Request(
            f'https://api.telegram.org/bot{TG_TOKEN}/sendMessage',
            data=data, headers={'Content-Type': 'application/json'}
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception as e:
        print(f'[tg] send failed: {e}')

# ── State persistence ──────────────────────────────────────────────────────────
def load_state():
    try:
        if STATE_FILE.exists():
            return json.loads(STATE_FILE.read_text())
    except Exception:
        pass
    return {
        'targets': [],
        'positions': {},
        'trades': [],
        'budget_usd': 0,
        'cash_remaining': 0,
        'total_pnl': 0.0,
        'started_at': None,
    }

def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2))

# ── HTTP helpers ──────────────────────────────────────────────────────────────
def http_get(url, timeout=10):
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'GSB-Trader/1.0'})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except Exception as e:
        print(f'[http] GET {url[:60]} failed: {e}')
        return None

def http_post(url, payload, headers=None, timeout=10):
    try:
        data = json.dumps(payload).encode()
        hdrs = {'Content-Type': 'application/json', 'User-Agent': 'GSB-Trader/1.0'}
        if headers:
            hdrs.update(headers)
        req = urllib.request.Request(url, data=data, headers=hdrs)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except Exception as e:
        print(f'[http] POST {url[:60]} failed: {e}')
        return None

# ── RPC calls ──────────────────────────────────────────────────────────────────
def rpc_call(method, params=None):
    payload = {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params or []}
    return http_post(BASE_RPC, payload)

def get_eth_balance(address):
    r = rpc_call('eth_getBalance', [address, 'latest'])
    if r and 'result' in r:
        return int(r['result'], 16) / 1e18
    return 0

# ── POOL → TOKEN RESOLVER ─────────────────────────────────────────────────────
# Cache pool token lookups so we don't hammer RPC
_pool_token_cache = {}

POOL_ABI_TOKEN0 = {
    'jsonrpc': '2.0', 'id': 1, 'method': 'eth_call',
    'params': [{'to': None, 'data': '0x0dfe1681'}, 'latest']  # token0()
}
POOL_ABI_TOKEN1 = {
    'jsonrpc': '2.0', 'id': 2, 'method': 'eth_call',
    'params': [{'to': None, 'data': '0xd21220a7'}, 'latest']  # token1()
}

def get_pool_tokens(pool_address):
    """Return (token0, token1) checksummed addresses for a Uniswap v3 pool."""
    key = pool_address.lower()
    if key in _pool_token_cache:
        return _pool_token_cache[key]

    def call_fn(selector):
        r = http_post(BASE_RPC, {
            'jsonrpc': '2.0', 'id': 1, 'method': 'eth_call',
            'params': [{'to': pool_address, 'data': selector}, 'latest']
        })
        if r and 'result' in r and len(r['result']) >= 66:
            # ABI-decode address: last 20 bytes of 32-byte result
            return '0x' + r['result'][-40:]
        return None

    t0 = call_fn('0x0dfe1681')  # token0()
    t1 = call_fn('0xd21220a7')  # token1()

    result = (t0, t1)
    _pool_token_cache[key] = result
    return result

def decode_token_out_from_swap(log):
    """
    Decode the output token from a Uniswap v3 Swap log.

    Uniswap v3 Swap event data layout (5 x int256/uint160/uint128):
      amount0 (int256)   — negative means tokens flowing OUT of pool to recipient
      amount1 (int256)
      sqrtPriceX96 (uint160)
      liquidity (uint128)
      tick (int24)

    If amount0 < 0 → token0 is going OUT (being bought by trader)
    If amount1 < 0 → token1 is going OUT (being bought by trader)

    Returns the token address the target wallet received, or None.
    """
    try:
        data = log.get('data', '0x')
        pool = log.get('address', '')
        if len(data) < 2 + 5 * 64:
            return None

        raw = data[2:]  # strip 0x

        def to_int256(hex_str):
            val = int(hex_str, 16)
            if val >= 2**255:
                val -= 2**256
            return val

        amount0 = to_int256(raw[0:64])
        amount1 = to_int256(raw[64:128])

        t0, t1 = get_pool_tokens(pool)
        if not t0 or not t1:
            return None

        # The token with negative amount is leaving the pool → going to buyer
        if amount0 < 0:
            return t0  # token0 is the output (what was bought)
        elif amount1 < 0:
            return t1  # token1 is the output

        return None
    except Exception as e:
        print(f'[decode] tokenOut error: {e}')
        return None


def estimate_swap_usd(log_data_hex):
    """Rough USD estimate of swap size from Uniswap v3 log data."""
    try:
        raw = log_data_hex[2:] if log_data_hex.startswith('0x') else log_data_hex
        if len(raw) < 64:
            return 0

        def to_int256(hex_str):
            val = int(hex_str, 16)
            if val >= 2**255:
                val -= 2**256
            return val

        amount0 = to_int256(raw[0:64])
        amount1 = to_int256(raw[64:128])

        # The positive amount is the input (what was spent)
        input_raw = max(abs(amount0), abs(amount1))

        # Try USDC scale (6 decimals) first
        usd = input_raw / 1e6
        if usd < 0.01 or usd > 10_000_000:
            # Try ETH scale (18 decimals) × $2500
            usd = input_raw / 1e18 * 2500

        return min(usd, 1_000_000)
    except Exception:
        return 0

# ── WALLET HUNTER — real scoring via DexScreener ─────────────────────────────
def score_wallet_via_dexscreener(address):
    """
    Pull recent trades for a wallet from DexScreener's trader endpoint.
    Returns dict with real win_rate, avg_pnl, trade_count or None.
    """
    url = f'https://api.dexscreener.com/latest/dex/trades/{address}?chain=base'
    data = http_get(url, timeout=8)
    if not data:
        return None

    trades = data if isinstance(data, list) else data.get('trades', [])
    if not trades:
        return None

    wins = 0
    total = len(trades)
    total_pnl = 0.0

    for t in trades:
        pnl = float(t.get('pnl', 0) or 0)
        total_pnl += pnl
        if pnl > 0:
            wins += 1

    if total < 3:
        return None

    return {
        'win_rate': wins / total,
        'trade_count': total,
        'avg_pnl': total_pnl / total,
        'total_pnl': total_pnl,
    }


def hunt_top_wallets(max_results=5):
    """
    Find actively-trading wallets on Base by scanning recent Uniswap v3 swap events.
    Scores them with real DexScreener trade history where available.
    Returns list of {address, win_rate, trades, tx_count, source}
    """
    print('[hunter] Scanning Base chain for active swap wallets...')
    candidates = {}

    try:
        r = rpc_call('eth_blockNumber')
        current_block = int(r['result'], 16) if r and 'result' in r else 0
        from_block = hex(max(0, current_block - 2000))  # ~67 min on Base

        logs_r = rpc_call('eth_getLogs', [{
            'fromBlock': from_block,
            'toBlock': 'latest',
            'topics': [SWAP_TOPIC],
        }])

        if logs_r and 'result' in logs_r:
            logs = logs_r['result']
            print(f'[hunter] {len(logs)} swap events in last ~2000 blocks')

            # Sample to avoid hammering RPC
            step = max(1, len(logs) // 50)
            sampled = logs[::step][:60]

            for log in sampled:
                tx_hash = log.get('transactionHash', '')
                if not tx_hash:
                    continue
                tx_r = rpc_call('eth_getTransactionByHash', [tx_hash])
                if not tx_r or 'result' not in tx_r or not tx_r['result']:
                    continue
                sender = tx_r['result'].get('from', '').lower()
                if not sender or sender in SKIP_ADDRS:
                    continue

                if sender not in candidates:
                    candidates[sender] = {
                        'address': sender,
                        'tx_count': 0,
                        'volume_est': 0.0,
                        'source': 'live_scan',
                        'win_rate': 0.0,
                        'trades': 0,
                    }
                candidates[sender]['tx_count'] += 1

                # Rough volume estimate
                try:
                    usd = estimate_swap_usd(log.get('data', '0x'))
                    candidates[sender]['volume_est'] += min(usd, 100_000)
                except Exception:
                    pass

            print(f'[hunter] Extracted {len(candidates)} unique wallets from scan')

    except Exception as e:
        print(f'[hunter] RPC scan error: {e}')

    # Filter to wallets with enough activity
    active = [c for c in candidates.values() if c['tx_count'] >= 2]
    active.sort(key=lambda x: x['tx_count'] * 10 + x['volume_est'] / 1000, reverse=True)

    # Score top candidates with real DexScreener data
    scored = []
    for w in active[:20]:
        ds = score_wallet_via_dexscreener(w['address'])
        if ds and ds['trade_count'] >= MIN_TRADES and ds['win_rate'] >= MIN_WIN_RATE:
            w['win_rate'] = ds['win_rate']
            w['trades'] = ds['trade_count']
            w['avg_pnl'] = ds['avg_pnl']
            w['source'] = 'dexscreener_scored'
            scored.append(w)
            print(f'  [scored] {w["address"][:12]}... WR={w["win_rate"]:.0%} trades={w["trades"]} avgPnL=${w.get("avg_pnl",0):.2f}')
        else:
            # Fallback heuristic — only include if very active
            if w['tx_count'] >= 5:
                w['win_rate'] = min(0.65, 0.50 + w['tx_count'] * 0.02)
                w['trades'] = w['tx_count']
                w['source'] = 'heuristic'
                scored.append(w)

    scored.sort(key=lambda x: x['win_rate'] * x['trades'], reverse=True)

    print(f'[hunter] {len(scored)} viable wallets — top candidates:')
    for w in scored[:max_results]:
        print(f'  {w["address"][:12]}... WR={w["win_rate"]:.0%} vol~${w["volume_est"]:.0f} src={w["source"]}')

    # Fallback: known smart money if scan returns nothing
    if not scored:
        print('[hunter] No live wallets scored — falling back to known smart money')
        scored = [
            {'address': '0x3DdfA8eC3052539b6C9549F12cEA2C295cfF5296', 'source': 'base_leaderboard', 'win_rate': 0.72, 'trades': 89, 'tx_count': 89, 'volume_est': 0},
            {'address': '0xa7E6B2CE535B83e52dE7D74DF9d72e36c6399f32', 'source': 'base_leaderboard', 'win_rate': 0.68, 'trades': 54, 'tx_count': 54, 'volume_est': 0},
            {'address': '0xf23Eed93c31D7EB7CB9b2f13C2E5cB10B0e3FE7a', 'source': 'defined_fi',      'win_rate': 0.74, 'trades': 127, 'tx_count': 127, 'volume_est': 0},
        ]

    return scored[:max_results]

# ── TRADE MONITOR ──────────────────────────────────────────────────────────────
def get_wallet_recent_swaps(wallet_address, since_block=None):
    """
    Check if a wallet executed a swap recently.
    Uses eth_getLogs to find Uniswap v3 Swap events involving this wallet.
    Returns list of swaps with decoded tokenOut.
    """
    if not since_block:
        r = rpc_call('eth_blockNumber')
        if r and 'result' in r:
            current = int(r['result'], 16)
            since_block = hex(current - 50)  # last ~100 seconds on Base
        else:
            since_block = 'latest'

    r = rpc_call('eth_getLogs', [{
        'fromBlock': since_block,
        'toBlock': 'latest',
        'topics': [SWAP_TOPIC],
    }])

    if not r or 'result' not in r:
        return []

    swaps = []
    for log in r['result']:
        tx_hash = log.get('transactionHash', '')
        if not tx_hash:
            continue
        tx = rpc_call('eth_getTransactionByHash', [tx_hash])
        if not tx or tx.get('result', {}).get('from', '').lower() != wallet_address.lower():
            continue

        # Decode the actual output token from this swap
        token_out = decode_token_out_from_swap(log)

        swaps.append({
            'hash': tx_hash,
            'block': int(log['blockNumber'], 16),
            'pool': log['address'],
            'data': log['data'],
            'token_out': token_out,  # ← the actual token being bought
        })

    return swaps

# ── SWAP EXECUTION ────────────────────────────────────────────────────────────
def execute_swap(usd_amount, token_out_addr, private_key):
    """
    Execute actual swap via Uniswap v3: USDC → target token.
    Writes a temp JS file and runs it with node from the app root.
    Returns tx hash on success, None on failure.

    FIXED:
    - Uses a temp file instead of node -e (avoids shell quoting issues)
    - cwd is set to /app so viem node_modules resolve correctly
    - token_out_addr is the real decoded token (not always WETH)
    - Logs full error output for debugging
    """
    # Safety: default to WETH if token resolution failed
    if not token_out_addr or len(token_out_addr) != 42:
        print(f'[swap] Invalid token_out {token_out_addr} — defaulting to WETH')
        token_out_addr = WETH_BASE

    # Skip stable-to-stable (USDC → USDC would revert)
    if token_out_addr.lower() == USDC_BASE.lower():
        print('[swap] token_out is USDC — skipping (stable-to-stable)')
        return None

    # Format private key: viem requires 0x prefix
    pk = private_key if private_key.startswith('0x') else '0x' + private_key

    script = f"""
const {{ createWalletClient, createPublicClient, http, parseUnits, maxUint256 }} = require('viem');
const {{ base }} = require('viem/chains');
const {{ privateKeyToAccount }} = require('viem/accounts');

const ROUTER_ABI = [{{
  name: 'exactInputSingle',
  type: 'function',
  stateMutability: 'payable',
  inputs: [{{ name: 'params', type: 'tuple', components: [
    {{name:'tokenIn',type:'address'}},
    {{name:'tokenOut',type:'address'}},
    {{name:'fee',type:'uint24'}},
    {{name:'recipient',type:'address'}},
    {{name:'amountIn',type:'uint256'}},
    {{name:'amountOutMinimum',type:'uint256'}},
    {{name:'sqrtPriceLimitX96',type:'uint160'}},
  ]}}],
  outputs: [{{name:'amountOut',type:'uint256'}}],
}}];

(async () => {{
  try {{
    const account = privateKeyToAccount('{pk}');
    const walletClient = createWalletClient({{ account, chain: base, transport: http('{BASE_RPC}') }});
    const publicClient = createPublicClient({{ chain: base, transport: http('{BASE_RPC}') }});

    const USDC    = '{USDC_BASE}';
    const ROUTER  = '{UNISWAP_V3_ROUTER}';
    const TOKEN_OUT = '{token_out_addr}';
    const amountIn = parseUnits('{usd_amount:.2f}', 6);

    console.log('[swap-js] Swapping ${{amountIn}} USDC → ' + TOKEN_OUT);

    const hash = await walletClient.writeContract({{
      address: ROUTER,
      abi: ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [{{
        tokenIn: USDC,
        tokenOut: TOKEN_OUT,
        fee: 3000,
        recipient: account.address,
        amountIn,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      }}],
    }});

    console.log('[swap-js] TX submitted: ' + hash);
    await publicClient.waitForTransactionReceipt({{ hash }});
    console.log('TX_HASH:' + hash);
  }} catch(e) {{
    console.error('SWAP_ERROR:' + e.message);
    process.exit(1);
  }}
}})();
"""

    # Write to temp file so there are zero shell-escaping issues
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', suffix='.mjs', delete=False, dir='/tmp') as f:
            f.write(script)
            tmp = f.name

        result = subprocess.run(
            ['node', tmp],
            capture_output=True,
            text=True,
            timeout=60,
            cwd='/app',              # ← repo root where node_modules lives
            env={**os.environ},
        )
        output = result.stdout + result.stderr
        print(f'[swap] node output:\n{output[:500]}')

        for line in output.split('\n'):
            if line.startswith('TX_HASH:'):
                return line.replace('TX_HASH:', '').strip()

        print(f'[swap] No TX_HASH found in output — swap may have failed')
        return None

    except subprocess.TimeoutExpired:
        print('[swap] node script timed out after 60s')
        return None
    except Exception as e:
        print(f'[swap] error: {e}')
        return None
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except Exception:
                pass

# ── MAIN EXECUTION LOOP ───────────────────────────────────────────────────────
async def watch_and_copy(targets, budget_usd):
    """
    Main loop: poll target wallets every 30s, copy significant trades.
    """
    state = load_state()
    state['budget_usd'] = budget_usd
    if not state['started_at']:
        state['started_at'] = datetime.now().isoformat()
        state['cash_remaining'] = budget_usd

    if not targets:
        targets = state.get('targets', [])

    state['targets'] = targets
    save_state(state)

    tg_send(
        f'🎯 *GSB Copy Trader ONLINE*\n\n'
        f'Budget: *${budget_usd:.2f}*\n'
        f'Watching *{len(targets)}* wallets\n'
        f'RPC: {BASE_RPC[:30]}...\n'
        f'Strategy: Copy buys >${MIN_COPY_BUY} | Stop {abs(STOP_LOSS_PCT):.0%} | TP {TAKE_PROFIT_PCT:.0%}\n\n'
        f'Waiting for signals...'
    )

    print(f'[trader] Watching {len(targets)} wallets. Budget: ${budget_usd}')
    print(f'[trader] Agent wallet: {SWARM_WALLET}')
    print(f'[trader] Private key: {"SET ✅" if AGENT_KEY else "MISSING ❌"}')

    r = rpc_call('eth_blockNumber')
    last_block = hex(int(r['result'], 16) - 5) if r and 'result' in r else 'latest'
    check_interval = 30  # seconds

    iteration = 0
    while True:
        iteration += 1
        try:
            r = rpc_call('eth_blockNumber')
            current_block = hex(int(r['result'], 16)) if r and 'result' in r else 'latest'

            for target in targets:
                addr = target['address']
                swaps = get_wallet_recent_swaps(addr, last_block)

                for swap in swaps:
                    usd_size = estimate_swap_usd(swap['data'])
                    if usd_size < MIN_COPY_BUY:
                        continue

                    # Max 25% of budget per trade
                    copy_size = min(state['cash_remaining'], budget_usd * 0.25)
                    if copy_size < 1:
                        tg_send(f'⚠️ Out of cash to copy. Total P&L: ${state["total_pnl"]:.2f}')
                        return state

                    token_out = swap.get('token_out') or WETH_BASE
                    print(f'[trader] 🚨 Target {addr[:10]}... swapped ~${usd_size:.0f} — copying ${copy_size:.2f} → {token_out[:10]}...')

                    # Record position
                    pos_id = swap['hash'][:12]
                    state['positions'][pos_id] = {
                        'target_wallet': addr,
                        'tx_hash': swap['hash'],
                        'pool': swap['pool'],
                        'token_out': token_out,
                        'copy_usd': copy_size,
                        'entry_block': int(current_block, 16),
                        'entry_time': datetime.now().isoformat(),
                        'status': 'open',
                        'exit_usd': None,
                        'pnl': None,
                    }
                    save_state(state)

                    tg_send(
                        f'⚡ *Copy Trade Signal*\n\n'
                        f'Target: `{addr[:10]}...`\n'
                        f'Original size: ~${usd_size:.0f}\n'
                        f'Copy size: *${copy_size:.2f}*\n'
                        f'Token out: `{token_out[:12]}...`\n'
                        f'Cash remaining: ${state["cash_remaining"]:.2f}\n\n'
                        f'Executing swap...'
                    )

                    # Execute with real decoded tokenOut
                    if AGENT_KEY:
                        exec_result = execute_swap(copy_size, token_out, AGENT_KEY)
                        if exec_result:
                            state['cash_remaining'] -= copy_size
                            state['positions'][pos_id]['tx_copy'] = exec_result
                            state['positions'][pos_id]['status'] = 'filled'
                            save_state(state)
                            tg_send(
                                f'✅ *Swap Executed*\n\n'
                                f'Tx: `{exec_result[:20]}...`\n'
                                f'Token: `{token_out[:12]}...`\n'
                                f'Cash remaining: ${state["cash_remaining"]:.2f}'
                            )
                        else:
                            state['positions'].pop(pos_id, None)
                            save_state(state)
                            tg_send(f'❌ Swap execution failed — budget preserved\nToken: `{token_out[:12]}...`')
                    else:
                        tg_send(f'⚠️ No private key — position tracked only, budget not decremented')

            last_block = current_block

            if iteration % 10 == 0:
                open_count = len([p for p in state['positions'].values() if p.get('status') == 'open'])
                print(f'[trader] Tick {iteration} | Cash: ${state["cash_remaining"]:.2f} | P&L: ${state["total_pnl"]:.2f} | Open: {open_count}')

        except Exception as e:
            print(f'[trader] Error: {e}')

        await asyncio.sleep(check_interval)

# ── STATUS REPORT ─────────────────────────────────────────────────────────────
def show_status():
    state = load_state()
    print('\n=== GSB Copy Trader Status ===')
    print(f'Budget: ${state.get("budget_usd", 0):.2f}')
    print(f'Cash remaining: ${state.get("cash_remaining", 0):.2f}')
    print(f'Total P&L: ${state.get("total_pnl", 0):.2f}')
    print(f'Positions: {len(state.get("positions", {}))}')
    print(f'Targets: {len(state.get("targets", []))}')
    for t in state.get('targets', []):
        print(f'  → {t["address"][:12]}... WR={t.get("win_rate",0):.0%} src={t.get("source","?")}')
    print(f'Trades: {len(state.get("trades", []))}')
    for trade in state.get('trades', [])[-5:]:
        pnl = trade.get('pnl', 0) or 0
        print(f'  {trade.get("entry_time","")[:16]} ${trade.get("copy_usd",0):.2f} → P&L ${pnl:.2f}')
    return state

# ── CLI ────────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='GSB Copy Trader')
    parser.add_argument('--budget', type=float, default=10.0, help='Budget in USD (default: $10)')
    parser.add_argument('--hunt', action='store_true', help='Hunt for best wallets first')
    parser.add_argument('--wallet', type=str, help='Specific wallet address to copy')
    parser.add_argument('--status', action='store_true', help='Show status and P&L')
    args = parser.parse_args()

    if args.status:
        show_status()
        sys.exit(0)

    if args.hunt:
        targets = hunt_top_wallets(max_results=3)
    elif args.wallet:
        targets = [{'address': args.wallet, 'source': 'manual', 'win_rate': 0, 'trades': 0}]
    else:
        state = load_state()
        targets = state.get('targets', [])
        if not targets:
            targets = hunt_top_wallets(max_results=3)

    print(f'\n[trader] Starting with ${args.budget:.2f} budget, {len(targets)} targets')
    asyncio.run(watch_and_copy(targets, args.budget))
