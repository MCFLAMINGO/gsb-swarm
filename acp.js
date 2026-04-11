// ACP Agent factory — shared across all workers
// SDK injected via --import ./acp-loader.mjs at startup
// Uses PrivyAlchemyEvmProviderAdapter — agent wallets are Privy-custodied (created via Virtuals dashboard)
const { base } = require('viem/chains');

const ACP_MAX_RETRIES = 3;

function getSDK() {
  if (!globalThis.__ACP_SDK__) throw new Error('[acp] SDK not loaded — check --import ./acp-loader.mjs');
  return globalThis.__ACP_SDK__;
}

// params: { signerPrivateKey, walletId, entityId, agentWalletAddress, onEntry }
async function buildAcpAgent({ signerPrivateKey, walletId, entityId, agentWalletAddress, onEntry }) {
  const { AcpAgent, PrivyAlchemyEvmProviderAdapter } = getSDK();

  if (!signerPrivateKey) throw new Error('[acp] signerPrivateKey is required (P256 key from Virtuals dashboard)');
  if (!walletId)         throw new Error('[acp] walletId is required (Privy wallet ID from Virtuals dashboard)');
  if (!agentWalletAddress) throw new Error('[acp] agentWalletAddress is required');

  for (let attempt = 1; attempt <= ACP_MAX_RETRIES; attempt++) {
    try {
      const provider = await PrivyAlchemyEvmProviderAdapter.create({
        walletAddress: agentWalletAddress,
        walletId,
        signerPrivateKey,
        chains: [base],
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
