// ACP Client factory — shared across all workers
const { AcpContractClient, default: AcpClient } = require('@virtuals-protocol/acp-node');

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
