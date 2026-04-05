/**
 * One-time USDC approval for Uniswap v3 router on Base.
 * Run this ONCE and the copy trader can swap instantly forever.
 *
 * Usage: node scripts/approve_usdc.js
 */

const { createWalletClient, createPublicClient, http, maxUint256 } = require('viem');
const { base } = require('viem/chains');
const { privateKeyToAccount } = require('viem/accounts');

const USDC          = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const UNISWAP_V3    = '0x2626664c2603336E57B271c5C0b26F421741e481';
const BASE_RPC      = process.env.BASE_RPC_URL || 'https://base.drpc.org';
const PRIVATE_KEY   = process.env.AGENT_WALLET_PRIVATE_KEY;

const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'allowance',
    type: 'function',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
];

async function main() {
  if (!PRIVATE_KEY) {
    console.error('ERROR: AGENT_WALLET_PRIVATE_KEY not set');
    process.exit(1);
  }

  const account = privateKeyToAccount(PRIVATE_KEY);
  const walletClient  = createWalletClient({ account, chain: base, transport: http(BASE_RPC) });
  const publicClient  = createPublicClient({ chain: base, transport: http(BASE_RPC) });

  console.log('Wallet:', account.address);

  // Check current allowance
  const allowance = await publicClient.readContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [account.address, UNISWAP_V3],
  });

  console.log('Current USDC allowance for Uniswap v3:', allowance.toString());

  if (allowance >= BigInt('1000000000000')) { // already approved plenty
    console.log('✅ Already approved — no action needed. Copy trader can swap instantly.');
    process.exit(0);
  }

  console.log('Sending approval transaction...');
  const hash = await walletClient.writeContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [UNISWAP_V3, maxUint256],
  });

  console.log('Approval tx sent:', hash);
  console.log('Waiting for confirmation...');

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log('✅ APPROVED — block:', receipt.blockNumber.toString());
  console.log('Copy trader will now swap instantly with zero approval overhead.');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
