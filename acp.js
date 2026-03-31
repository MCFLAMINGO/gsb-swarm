// ACP Client factory — shared across all workers
// Uses AcpContractClientV2 (required for Graduation Evaluator and all graduated agents)
const {
  AcpContractClientV2,
  baseAcpConfigV2,
  default: AcpClient,
} = require('@virtuals-protocol/acp-node');

// Override RPC to avoid rate limits on default public endpoint
const RPC_URL = process.env.BASE_RPC_URL || 'https://base.drpc.org';
if (baseAcpConfigV2.chain && baseAcpConfigV2.chain.rpcUrls) {
  baseAcpConfigV2.chain.rpcUrls.default.http = [RPC_URL];
}
if (baseAcpConfigV2.rpcEndpoint !== undefined) {
  baseAcpConfigV2.rpcEndpoint = RPC_URL;
}

console.log('[acp] Using AcpContractClientV2 with baseAcpConfigV2');
console.log('[acp] RPC endpoint:', RPC_URL);

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
