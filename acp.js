// ACP Client factory — shared across all workers
// Uses AcpContractClientV2 (required for Graduation Evaluator and all graduated agents)
const {
  AcpContractClientV2,
  baseAcpConfigV2,
  default: AcpClient,
} = require('@virtuals-protocol/acp-node');

// Override RPC to avoid rate limits on default public endpoint
const RPC_URL = process.env.BASE_RPC_URL || 'https://base.drpc.org';

// Deep-clone config so SDK internal reads see our override
const acpConfig = JSON.parse(JSON.stringify(baseAcpConfigV2));

// Patch every known RPC field on the clone
if (acpConfig.chain?.rpcUrls?.default?.http) acpConfig.chain.rpcUrls.default.http = [RPC_URL];
if (acpConfig.chain?.rpcUrls?.public?.http) acpConfig.chain.rpcUrls.public.http = [RPC_URL];
if (acpConfig.rpcEndpoint !== undefined) acpConfig.rpcEndpoint = RPC_URL;

// Also patch the original — some SDK versions read from the imported object directly
if (baseAcpConfigV2.chain?.rpcUrls?.default?.http) baseAcpConfigV2.chain.rpcUrls.default.http = [RPC_URL];
if (baseAcpConfigV2.chain?.rpcUrls?.public?.http) baseAcpConfigV2.chain.rpcUrls.public.http = [RPC_URL];
if (baseAcpConfigV2.rpcEndpoint !== undefined) baseAcpConfigV2.rpcEndpoint = RPC_URL;

console.log('[acp] Using AcpContractClientV2 with baseAcpConfigV2');
console.log('[acp] RPC endpoint:', RPC_URL);

const ACP_MAX_RETRIES = 3;

async function buildAcpClient({ privateKey, entityId, agentWalletAddress, onNewTask, onEvaluate }) {
  for (let attempt = 1; attempt <= ACP_MAX_RETRIES; attempt++) {
    try {
      const contractClient = await AcpContractClientV2.build(
        privateKey,
        entityId,
        agentWalletAddress,
        acpConfig
      );

      const client = new AcpClient({
        acpContractClient: contractClient,
        onNewTask,
        onEvaluate,
      });

      return client;
    } catch (err) {
      if (attempt < ACP_MAX_RETRIES && (err.message?.includes('rate limit') || err.message?.includes('RPC') || err.message?.includes('429'))) {
        console.warn(`[acp] RPC error on attempt ${attempt}/${ACP_MAX_RETRIES}, retrying in ${attempt * 3}s...`, err.message);
        await new Promise(r => setTimeout(r, attempt * 3000));
      } else {
        throw err;
      }
    }
  }
}

module.exports = { buildAcpClient };
