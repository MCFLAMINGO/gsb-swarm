// ACP Client factory — shared across all workers
const { AcpContractClient, baseAcpConfig, default: AcpClient } = require('@virtuals-protocol/acp-node');

// Ensure the chain has rpcUrls.alchemy — the old patch may have removed it
// by replacing @account-kit/infra with viem/chains. This fixes it at runtime.
if (!baseAcpConfig.chain.rpcUrls.alchemy) {
  baseAcpConfig.chain.rpcUrls.alchemy = {
    http: ['https://base-mainnet.g.alchemy.com/v2']
  };
  console.log('[acp] Restored rpcUrls.alchemy on chain config.');
}

async function buildAcpClient({ privateKey, entityId, agentWalletAddress, onNewTask, onEvaluate }) {
  const contractClient = await AcpContractClient.build(
    privateKey,
    entityId,
    agentWalletAddress
  );

  const client = new AcpClient({
    acpContractClient: contractClient,
    onNewTask,
    onEvaluate,
  });

  return client;
}

module.exports = { buildAcpClient };
