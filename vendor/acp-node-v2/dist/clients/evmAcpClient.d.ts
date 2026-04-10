import { type Address, type Call } from "viem";
import { BaseAcpClient } from "./baseAcpClient";
import type { ApproveAllowanceParams, CapabilityFlags, CompleteParams, CreateJobParams, FundParams, OnChainJob, PreparedEvmTx, PreparedTxInput, RejectParams, SetBudgetParams, SubmitParams } from "../core/operations";
import type { IEvmProviderAdapter } from "../providers/types";
import { type JobCreatedFilter } from "../utils/events";
export declare class EvmAcpClient extends BaseAcpClient<Call[]> {
    private readonly provider;
    private constructor();
    static create(input: {
        contractAddresses: Record<number, string>;
        provider: IEvmProviderAdapter;
    }): Promise<EvmAcpClient>;
    getAddress(): Promise<Address>;
    getProvider(): IEvmProviderAdapter;
    getCapabilities(): CapabilityFlags;
    execute(chainId: number, calls: Call[]): Promise<Address | Address[]>;
    submitPrepared(chainId: number, prepared: PreparedTxInput): Promise<string | string[]>;
    createJob(chainId: number, params: CreateJobParams): Promise<PreparedEvmTx>;
    setBudget(chainId: number, params: SetBudgetParams): Promise<PreparedEvmTx>;
    approveAllowance(chainId: number, params: ApproveAllowanceParams): Promise<PreparedEvmTx>;
    fund(chainId: number, params: FundParams): Promise<PreparedEvmTx>;
    submit(chainId: number, params: SubmitParams): Promise<PreparedEvmTx>;
    complete(chainId: number, params: CompleteParams): Promise<PreparedEvmTx>;
    reject(chainId: number, params: RejectParams): Promise<PreparedEvmTx>;
    getJobIdFromTxHash(chainId: number, txHash: string, filter?: JobCreatedFilter): Promise<bigint | null>;
    getJob(chainId: number, jobId: bigint): Promise<OnChainJob | null>;
    getTokenDecimals(chainId: number, tokenAddress: string): Promise<number>;
    getTokenSymbol(chainId: number, tokenAddress: string): Promise<string>;
    private static toBytes32;
    private buildContractCall;
    private wrap;
}
//# sourceMappingURL=evmAcpClient.d.ts.map