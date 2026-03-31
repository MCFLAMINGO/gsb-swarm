// chains.js — shared chain config for GSB Intelligence Swarm
// All workers import from here so chain definitions stay in one place.

const CHAIN_CONFIG = {
  base: {
    id: 'base',
    name: 'Base',
    dexscreenerId: 'base',
    blockscoutUrl: 'https://base.blockscout.com/api/v2',
    geckoTerminalId: 'base',
    nativeToken: 'ETH',
    isEVM: true,
  },
  ethereum: {
    id: 'ethereum',
    name: 'Ethereum',
    dexscreenerId: 'ethereum',
    blockscoutUrl: 'https://eth.blockscout.com/api/v2',
    geckoTerminalId: 'eth',
    nativeToken: 'ETH',
    isEVM: true,
  },
  arbitrum: {
    id: 'arbitrum',
    name: 'Arbitrum',
    dexscreenerId: 'arbitrum',
    blockscoutUrl: 'https://arbitrum.blockscout.com/api/v2',
    geckoTerminalId: 'arbitrum',
    nativeToken: 'ETH',
    isEVM: true,
  },
  polygon: {
    id: 'polygon',
    name: 'Polygon',
    dexscreenerId: 'polygon',
    blockscoutUrl: 'https://polygon.blockscout.com/api/v2',
    geckoTerminalId: 'polygon_pos',
    nativeToken: 'POL',
    isEVM: true,
  },
  bsc: {
    id: 'bsc',
    name: 'BNB Chain',
    dexscreenerId: 'bsc',
    blockscoutUrl: 'https://bsc.blockscout.com/api/v2',
    geckoTerminalId: 'bsc',
    nativeToken: 'BNB',
    isEVM: true,
  },
  avalanche: {
    id: 'avalanche',
    name: 'Avalanche',
    dexscreenerId: 'avalanche',
    blockscoutUrl: 'https://avalanche.blockscout.com/api/v2',
    geckoTerminalId: 'avax',
    nativeToken: 'AVAX',
    isEVM: true,
  },
  optimism: {
    id: 'optimism',
    name: 'Optimism',
    dexscreenerId: 'optimism',
    blockscoutUrl: 'https://optimism.blockscout.com/api/v2',
    geckoTerminalId: 'optimism',
    nativeToken: 'ETH',
    isEVM: true,
  },
  solana: {
    id: 'solana',
    name: 'Solana',
    dexscreenerId: 'solana',
    blockscoutUrl: null,
    geckoTerminalId: 'solana',
    nativeToken: 'SOL',
    isEVM: false,
    solscanUrl: 'https://public-api.solscan.io',
  },
};

// Aliases — what users type → canonical chain ID
const CHAIN_ALIASES = {
  'base': 'base', 'b': 'base',
  'ethereum': 'ethereum', 'eth': 'ethereum', 'mainnet': 'ethereum',
  'arbitrum': 'arbitrum', 'arb': 'arbitrum', 'arbitrum one': 'arbitrum',
  'polygon': 'polygon', 'matic': 'polygon', 'pol': 'polygon',
  'bsc': 'bsc', 'binance': 'bsc', 'bnb': 'bsc', 'bnb chain': 'bsc',
  'avalanche': 'avalanche', 'avax': 'avalanche',
  'optimism': 'optimism', 'op': 'optimism',
  'solana': 'solana', 'sol': 'solana',
};

const SUPPORTED_CHAINS = Object.keys(CHAIN_CONFIG);

function resolveChain(input) {
  if (!input) return 'base';
  const normalized = input.toLowerCase().trim();
  return CHAIN_ALIASES[normalized] || (CHAIN_CONFIG[normalized] ? normalized : null);
}

module.exports = { CHAIN_CONFIG, CHAIN_ALIASES, SUPPORTED_CHAINS, resolveChain };
