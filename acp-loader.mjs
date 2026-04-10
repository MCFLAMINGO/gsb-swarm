// ESM bridge — imports acp-node-v2 (pure ESM) and injects into globalThis for CJS workers
import { AcpAgent, AlchemyEvmProviderAdapter, AssetToken } from '@virtuals-protocol/acp-node-v2';
globalThis.__ACP_SDK__ = { AcpAgent, AlchemyEvmProviderAdapter, AssetToken };
console.log('[acp-loader] ACP SDK v2 loaded via ESM bridge');
