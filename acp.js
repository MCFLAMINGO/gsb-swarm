// ACP Client factory — shared across all workers
const { AcpContractClient, default: AcpClient } = require('@virtuals-protocol/acp-node');

async function buildAcpClient({ privateKey, entityId, agentWalletAddress, onNewTask, onEvaluate }) {
  // Build the on-chain contract client using Virtuals' default Base mainnet config
  // (no 4th arg — baseAcpConfig already targets Base mainnet via Virtuals' Alchemy proxy)
  const contractClient = await AcpContractClient.build(
    privateKey,
    entityId,
    agentWalletAddress
  );

  // AcpClient constructor calls init() internally — do NOT call client.init() again
  const client = new AcpClient({
    acpContractClient: contractClient,
    onNewTask,
    onEvaluate,
  });

  return client;
}

module.exports = { buildAcpClient };
