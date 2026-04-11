// ESM bridge — imports vendored acp-node-v2 (patched for Node 22 ESM resolution)
import { AcpAgent, AlchemyEvmProviderAdapter, PrivyAlchemyEvmProviderAdapter, AssetToken } from './vendor/acp-node-v2/dist/index.js';
globalThis.__ACP_SDK__ = { AcpAgent, AlchemyEvmProviderAdapter, PrivyAlchemyEvmProviderAdapter, AssetToken };
console.log('[acp-loader] ACP SDK v2 loaded via ESM bridge');
