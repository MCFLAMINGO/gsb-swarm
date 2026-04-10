import type { Address, Call, Log, TransactionReceipt } from "viem";
import type { GetLogsParams, IEvmProviderAdapter, ReadContractParams } from "../types";
export declare class ViemProviderAdapter implements IEvmProviderAdapter {
    readonly providerName: string;
    constructor(providerName: string);
    getAddress(): Promise<Address>;
    getSupportedChainIds(): Promise<number[]>;
    getNetworkContext(chainId: number): Promise<import("../..").NetworkContext>;
    sendCalls(_chainId: number, _calls: Call[]): Promise<Address | Address[]>;
    getTransactionReceipt(_chainId: number, _hash: Address): Promise<TransactionReceipt>;
    readContract(_chainId: number, _params: ReadContractParams): Promise<unknown>;
    getLogs(_chainId: number, _params: GetLogsParams): Promise<Log[]>;
    getBlockNumber(_chainId: number): Promise<bigint>;
    signMessage(_chainId: number, _message: string): Promise<string>;
    signTypedData(_chainId: number, _typedData: unknown): Promise<string>;
}
//# sourceMappingURL=viemProviderAdapter.d.ts.map