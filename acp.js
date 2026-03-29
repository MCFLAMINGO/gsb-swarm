// ACP Client factory — shared across all workers
import AcpClient, { AcpContractClient } from '@virtuals-protocol/acp-node';

export async function buildAcpClient({ privateKey, entityId, agentWalletAddress, onNewTask, onEvaluate }) {
  const contractClient = await AcpContractClient.build(
    privateKey,
    entityId,
    agentWalletAddress,
    process.env.BASE_RPC_URL || 'https://mainnet.base.org'
  );

  const client = new AcpClient({
    acpContractClient: contractClient,
    onNewTask,
    onEvaluate,
  });

  await client.init();
  return client;
}
