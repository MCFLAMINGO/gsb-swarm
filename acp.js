// ACP Client factory — shared across all workers
// Uses AcpContractClientV2 (required for Graduation Evaluator and all graduated agents)
const {
  AcpContractClientV2,
  baseAcpConfigV2,
  default: AcpClient,
} = require('@virtuals-protocol/acp-node');

console.log('[acp] Using AcpContractClientV2 with baseAcpConfigV2');
console.log('[acp] RPC endpoint:', baseAcpConfigV2.rpcEndpoint || 'https://alchemy-proxy-prod.virtuals.io/api/proxy/rpc');

async function buildAcpClient({ privateKey, entityId, agentWalletAddress, onNewTask, onEvaluate }) {
  const contractClient = await AcpContractClientV2.build(
    privateKey,
    entityId,
    agentWalletAddress,
    baseAcpConfigV2
  );

  const client = new AcpClient({
    acpContractClient: contractClient,
    onNewTask,
    onEvaluate,
  });

  return client;
}

module.exports = { buildAcpClient };
