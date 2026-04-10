import type { Address, Call, Chain, Hex, Log, TransactionReceipt } from "viem";
import type { GetLogsParams, IEvmProviderAdapter, ReadContractParams } from "../types";
export interface AlchemyChainConfig {
    chains?: Chain[];
    walletAddress: Address;
    privateKey: Hex;
    entityId: number;
}
export declare class AlchemyEvmProviderAdapter implements IEvmProviderAdapter {
    readonly providerName: string;
    readonly address: Address;
    private readonly clients;
    private constructor();
    static create(params: AlchemyChainConfig): Promise<AlchemyEvmProviderAdapter>;
    private getClient;
    getAddress(): Promise<Address>;
    getSupportedChainIds(): Promise<number[]>;
    getNetworkContext(chainId: number): Promise<import("../..").NetworkContext>;
    private getRandomNonce;
    sendCalls(chainId: number, _calls: Call[]): Promise<Address | Address[]>;
    getTransactionReceipt(chainId: number, hash: Address): Promise<TransactionReceipt>;
    readContract(chainId: number, params: ReadContractParams): Promise<unknown>;
    getLogs(chainId: number, params: GetLogsParams): Promise<Log[]>;
    getBlockNumber(chainId: number): Promise<bigint>;
    signMessage(chainId: number, _message: string): Promise<string>;
    signTypedData(chainId: number, typedData: unknown): Promise<string>;
}
//# sourceMappingURL=alchemyEvmProviderAdapter.d.ts.map