import { BaseAcpClient } from "./baseAcpClient";
import type { ApproveAllowanceParams, CapabilityFlags, CompleteParams, CreateJobParams, FundParams, OnChainJob, PreparedSolanaTx, PreparedTxInput, RejectParams, SetBudgetParams, SubmitParams } from "../core/operations";
import type { ISolanaProviderAdapter, SolanaInstructionLike } from "../providers/types";
export declare class SolanaAcpClient extends BaseAcpClient<SolanaInstructionLike[]> {
    private readonly provider;
    private constructor();
    static create(input: {
        contractAddresses: Record<number, string>;
        provider: ISolanaProviderAdapter;
    }): Promise<SolanaAcpClient>;
    getAddress(): Promise<string>;
    getCapabilities(): CapabilityFlags;
    execute(instructions: SolanaInstructionLike[]): Promise<string | string[]>;
    submitPrepared(_chainId: number, prepared: PreparedTxInput): Promise<string | string[]>;
    createJob(chainId: number, params: CreateJobParams): Promise<PreparedSolanaTx>;
    setBudget(chainId: number, params: SetBudgetParams): Promise<PreparedSolanaTx>;
    approveAllowance(_chainId: number, _params: ApproveAllowanceParams): Promise<PreparedSolanaTx>;
    fund(chainId: number, params: FundParams): Promise<PreparedSolanaTx>;
    submit(chainId: number, params: SubmitParams): Promise<PreparedSolanaTx>;
    complete(chainId: number, params: CompleteParams): Promise<PreparedSolanaTx>;
    reject(chainId: number, params: RejectParams): Promise<PreparedSolanaTx>;
    getJobIdFromTxHash(_chainId: number): Promise<bigint | null>;
    getJob(_chainId: number, _jobId: bigint): Promise<OnChainJob | null>;
    getTokenDecimals(_chainId: number, _tokenAddress: string): Promise<number>;
    getTokenSymbol(_chainId: number, _tokenAddress: string): Promise<string>;
    private makeIx;
    private wrap;
}
//# sourceMappingURL=solanaAcpClient.d.ts.map