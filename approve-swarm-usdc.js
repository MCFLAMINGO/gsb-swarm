// approve-swarm-usdc.js
// Sets ACP contract allowance from swarm wallet to exactly 5 USDC
// (enough for 12 graduation jobs totaling ~$3 USDC)
// Run: node --experimental-require-module approve-swarm-usdc.js
require('dotenv').config();

const { createWalletClient, createPublicClient, http, parseUnits, erc20Abi } = require('viem');
const { base } = require('viem/chains');
const { privateKeyToAccount } = require('viem/accounts');

const SWARM_PRIVATE_KEY = process.env.AGENT_WALLET_PRIVATE_KEY;
const ACP_CONTRACT      = '0x6a1FE26D54ab0d3E1e3168f2e0c0cDa5cC0A0A4A';
const USDC              = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const VIRTUALS_RPC      = 'https://alchemy-proxy-prod.virtuals.io/api/proxy/rpc';
const APPROVE_AMOUNT    = parseUnits('5', 6); // exactly 5 USDC

async function main() {
  if (!SWARM_PRIVATE_KEY) throw new Error('AGENT_WALLET_PRIVATE_KEY not set');

  const account = privateKeyToAccount(SWARM_PRIVATE_KEY);
  console.log('Swarm wallet:', account.address);

  const publicClient = createPublicClient({ chain: base, transport: http(VIRTUALS_RPC) });
  const walletClient = createWalletClient({ account, chain: base, transport: http(VIRTUALS_RPC) });

  const current = await publicClient.readContract({
    address: USDC, abi: erc20Abi,
    functionName: 'allowance',
    args: [account.address, ACP_CONTRACT],
  });
  console.log(`Current allowance: ${Number(current) / 1e6} USDC`);

  console.log(`Setting allowance to exactly ${Number(APPROVE_AMOUNT) / 1e6} USDC...`);
  const hash = await walletClient.writeContract({
    address: USDC, abi: erc20Abi,
    functionName: 'approve',
    args: [ACP_CONTRACT, APPROVE_AMOUNT],
  });
  console.log(`Tx hash: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`✓ Allowance set to 5 USDC. Block: ${receipt.blockNumber}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
