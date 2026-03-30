// ACP Client factory — shared across all workers
const { AcpContractClient, baseAcpConfig, default: AcpClient } = require('@virtuals-protocol/acp-node');

// Point ALL RPC paths to Virtuals' Alchemy proxy (no API key needed).
// This avoids rate limits on the public mainnet.base.org endpoint when
// all 4 workers start simultaneously.
const VIRTUALS_RPC = baseAcpConfig.alchemyRpcUrl; // https://alchemy-proxy-prod.virtuals.io/api/proxy/rpc

// Ensure rpcUrls.alchemy exists and points to the Virtuals proxy
if (!baseAcpConfig.chain.rpcUrls.alchemy) {
  baseAcpConfig.chain.rpcUrls.alchemy = { http: [VIRTUALS_RPC] };
} else {
  baseAcpConfig.chain.rpcUrls.alchemy.http = [VIRTUALS_RPC];
}

// Also override the default RPC so publicClient doesn't fall back to mainnet.base.org
baseAcpConfig.chain.rpcUrls.default.http = [VIRTUALS_RPC];

console.log('[acp] RPC endpoints patched to Virtuals proxy:', VIRTUALS_RPC);

async function buildAcpClient({ privateKey, entityId, agentWalletAddress, onNewTask, onEvaluate }) {
  const contractClient = await AcpContractClient.build(
    privateKey,
    entityId,
    agentWalletAddress
    // baseAcpConfig is the default 4th arg — it now uses the Virtuals proxy
  );

  const client = new AcpClient({
    acpContractClient: contractClient,
    onNewTask,
    onEvaluate,
  });

  return client;
}

module.exports = { buildAcpClient };
