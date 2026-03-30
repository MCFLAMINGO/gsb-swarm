// approve-swarm-usdc.js
// Approves ACP contract to spend USDC from the swarm wallet (EOA)
// Run once: node approve-swarm-usdc.js
require('dotenv').config();

const { createWalletClient, createPublicClient, http, parseUnits, erc20Abi } = require('viem');
const { base } = require('viem/chains');
const { privateKeyToAccount } = require('viem/accounts');

const SWARM_PRIVATE_KEY = process.env.AGENT_WALLET_PRIVATE_KEY;
const ACP_CONTRACT      = '0x6a1FE26D54ab0d3E1e3168f2e0c0cDa5cC0A0A4A';
const USDC              = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const VIRTUALS_RPC      = 'https://alchemy-proxy-prod.virtuals.io/api/proxy/rpc';
const APPROVE_AMOUNT    = parseUnits('1000', 6); // 1000 USDC

async function main() {
  if (!SWARM_PRIVATE_KEY) throw new Error('AGENT_WALLET_PRIVATE_KEY not set');

  const account = privateKeyToAccount(SWARM_PRIVATE_KEY);
  console.log('Swarm wallet:', account.address);

  const publicClient = createPublicClient({ chain: base, transport: http(VIRTUALS_RPC) });
  const walletClient = createWalletClient({ account, chain: base, transport: http(VIRTUALS_RPC) });

  // Check current allowance
  const current = await publicClient.readContract({
    address: USDC, abi: erc20Abi,
    functionName: 'allowance',
    args: [account.address, ACP_CONTRACT],
  });
  console.log(`Current allowance: ${Number(current) / 1e6} USDC`);

  if (current >= parseUnits('100', 6)) {
    console.log('✓ Already sufficient. No action needed.');
    return;
  }

  console.log(`Approving ${Number(APPROVE_AMOUNT) / 1e6} USDC for ACP contract...`);
  const hash = await walletClient.writeContract({
    address: USDC, abi: erc20Abi,
    functionName: 'approve',
    args: [ACP_CONTRACT, APPROVE_AMOUNT],
  });
  console.log(`Tx hash: ${hash}`);
  console.log('Waiting for confirmation...');
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`✓ Approved! Block: ${receipt.blockNumber}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
