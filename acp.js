// ACP Agent factory — shared across all workers
// SDK injected via --import ./acp-loader.mjs at startup
const { base } = require('viem/chains');

const RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const ACP_MAX_RETRIES = 3;

function getSDK() {
  if (!globalThis.__ACP_SDK__) throw new Error('[acp] SDK not loaded — check --import ./acp-loader.mjs');
  return globalThis.__ACP_SDK__;
}

async function buildAcpAgent({ privateKey, entityId, agentWalletAddress, onEntry }) {
  const { AcpAgent, AlchemyEvmProviderAdapter } = getSDK();
  const normalizedKey = privateKey && !privateKey.startsWith('0x') ? `0x${privateKey}` : privateKey;

  for (let attempt = 1; attempt <= ACP_MAX_RETRIES; attempt++) {
    try {
      const provider = await AlchemyEvmProviderAdapter.create({
        walletAddress: agentWalletAddress,
        privateKey: normalizedKey,
        entityId: Number(entityId),
        chains: [base],
        rpcUrl: RPC_URL,
      });
      const agent = await AcpAgent.create({ provider });
      agent.on('entry', onEntry);
      return agent;
    } catch (err) {
      if (attempt < ACP_MAX_RETRIES &&
          (err.message?.includes('rate limit') || err.message?.includes('RPC') || err.message?.includes('429'))) {
        console.warn(`[acp] RPC error attempt ${attempt}/${ACP_MAX_RETRIES}, retrying in ${attempt * 3}s...`);
        await new Promise(r => setTimeout(r, attempt * 3000));
      } else throw err;
    }
  }
}

// Proxy so AssetToken.usdc() works without eager SDK load
const AssetToken = new Proxy({}, {
  get(_, prop) { return getSDK().AssetToken[prop]; }
});

module.exports = { buildAcpAgent, AssetToken };
