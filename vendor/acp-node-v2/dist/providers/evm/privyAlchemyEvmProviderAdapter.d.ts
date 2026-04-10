import { type Address, type Call, type Chain, type Log, type TransactionReceipt } from "viem";
import type { GetLogsParams, IEvmProviderAdapter, ReadContractParams } from "../types";
export type SignFn = (payload: Uint8Array) => Promise<string>;
export interface PrivyAlchemyChainConfig {
    chains?: Chain[];
    walletAddress: Address;
    walletId: string;
    signerPrivateKey?: string;
    signFn?: SignFn;
    serverUrl?: string;
    privyAppId?: string;
}
export declare class PrivyAlchemyEvmProviderAdapter implements IEvmProviderAdapter {
    readonly providerName: string;
    readonly address: Address;
    private readonly chainClients;
    private readonly signer;
    private constructor();
    static create(params: PrivyAlchemyChainConfig): Promise<PrivyAlchemyEvmProviderAdapter>;
    private getClients;
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
//# sourceMappingURL=privyAlchemyEvmProviderAdapter.d.ts.map