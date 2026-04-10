import { base, baseSepolia, bscTestnet } from "viem/chains";
export const EVM_MAINNET_CHAINS = [base];
export const EVM_TESTNET_CHAINS = [baseSepolia, bscTestnet];
export const EVM_CHAINS = [
    ...EVM_MAINNET_CHAINS,
    ...EVM_TESTNET_CHAINS,
];
export const EVM_CHAIN_NAMES = [
    ...EVM_CHAINS.map((chain) => chain.name),
];
export const SOLANA_CLUSTERS = {
    devnet: "devnet",
    testnet: "testnet",
    "mainnet-beta": "mainnet-beta",
};
export function isEvmNetworkContext(context) {
    return context.family === "evm";
}
export function isSolanaNetworkContext(context) {
    return context.family === "solana";
}
export function getEvmChainByChainId(chainId) {
    const chain = EVM_CHAINS.find((chain) => chain.id === chainId);
    if (!chain) {
        return null;
    }
    return chain;
}
export function createEvmNetworkContext(chainId) {
    const chain = getEvmChainByChainId(chainId);
    if (!chain) {
        throw new Error(`Unsupported EVM chainId: ${chainId}`);
    }
    return {
        family: "evm",
        network: chain.name,
        chainId: chain.id,
        label: `${chain.name}:${chainId}`,
    };
}
export function createSolanaNetworkContext(cluster) {
    return {
        family: "solana",
        network: cluster,
        cluster,
        label: `solana:${cluster}`,
    };
}
//# sourceMappingURL=chains.js.map