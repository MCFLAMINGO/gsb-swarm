require('dotenv').config();
const AcpClient = require('@virtuals-protocol/acp-node').default;
const { AcpContractClient } = require('@virtuals-protocol/acp-node');

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

  await client.init();
  return client;
}

module.exports = { buildAcpClient };
