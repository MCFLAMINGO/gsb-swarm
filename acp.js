// ACP Agent factory — shared across all workers
// Uses AcpAgent.create() from acp-node-v2 (V2 SDK)
const { AcpAgent, AlchemyEvmProviderAdapter, AssetToken } = require('@virtuals-protocol/acp-node-v2');
const { base } = require('viem/chains');

const RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

const ACP_MAX_RETRIES = 3;

/**
 * Build an AcpAgent (V2) for a provider/evaluator worker.
 *
 * @param {object} opts
 * @param {string} opts.privateKey          - Agent wallet private key (0x-prefixed or raw)
 * @param {number} opts.entityId            - Virtuals entity ID (use 1 for V2 self-hosted)
 * @param {string} opts.agentWalletAddress  - On-chain agent wallet address
 * @param {Function} opts.onEntry           - async (session, entry) => void  — handles all lifecycle events
 *
 * Returns the started AcpAgent instance.
 */
async function buildAcpAgent({ privateKey, entityId, agentWalletAddress, onEntry }) {
  // Normalize private key — SDK requires 0x-prefixed hex string
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
      if (
        attempt < ACP_MAX_RETRIES &&
        (err.message?.includes('rate limit') || err.message?.includes('RPC') || err.message?.includes('429'))
      ) {
        console.warn(`[acp] RPC error on attempt ${attempt}/${ACP_MAX_RETRIES}, retrying in ${attempt * 3}s...`, err.message);
        await new Promise(r => setTimeout(r, attempt * 3000));
      } else {
        throw err;
      }
    }
  }
}

module.exports = { buildAcpAgent, AssetToken };
