import { Chain } from "viem/chains";
export type ChainFamily = "evm" | "solana";
export declare const EVM_MAINNET_CHAINS: Chain[];
export declare const EVM_TESTNET_CHAINS: Chain[];
export declare const EVM_CHAINS: readonly Chain[];
export declare const EVM_CHAIN_NAMES: readonly string[];
export type EvmNetworkName = keyof typeof EVM_CHAIN_NAMES;
export type EvmChainId = (typeof EVM_CHAIN_NAMES)[EvmNetworkName];
export declare const SOLANA_CLUSTERS: {
    readonly devnet: "devnet";
    readonly testnet: "testnet";
    readonly "mainnet-beta": "mainnet-beta";
};
export type SolanaCluster = keyof typeof SOLANA_CLUSTERS;
export type SupportedNetwork = EvmNetworkName | SolanaCluster;
export type NetworkContext = {
    family: "evm";
    network: EvmNetworkName;
    chainId: EvmChainId;
    label: string;
} | {
    family: "solana";
    network: SolanaCluster;
    cluster: SolanaCluster;
    label: string;
};
export declare function isEvmNetworkContext(context: NetworkContext): context is Extract<NetworkContext, {
    family: "evm";
}>;
export declare function isSolanaNetworkContext(context: NetworkContext): context is Extract<NetworkContext, {
    family: "solana";
}>;
export declare function getEvmChainByChainId(chainId: number): Chain | null;
export declare function createEvmNetworkContext(chainId: number): NetworkContext;
export declare function createSolanaNetworkContext(cluster: SolanaCluster): NetworkContext;
//# sourceMappingURL=chains.d.ts.map