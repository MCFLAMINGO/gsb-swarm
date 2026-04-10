import { type Address, type Hex } from "viem";
import { type AcpClient, type CreateAcpClientInput } from "./clientFactory";
import type { CompleteParams, CreateJobParams, RejectParams, SubmitParams } from "./core/operations";
import { AssetToken } from "./core/assetToken";
import { JobSession } from "./jobSession";
import type { AcpAgentDetail, AcpAgentOffering, AcpChatTransport, AcpJobApi, BrowseAgentParams, JobRoomEntry } from "./events/types";
export type EntryHandler = (session: JobSession, entry: JobRoomEntry) => void | Promise<void>;
export type CreateAgentInput = CreateAcpClientInput & {
    transport?: AcpChatTransport;
    api?: AcpJobApi;
};
export type SetBudgetParams = {
    jobId: bigint;
    amount: AssetToken;
    optParams?: Hex;
};
export type FundJobParams = {
    jobId: bigint;
    amount: AssetToken;
};
export type SetBudgetWithFundRequestParams = {
    jobId: bigint;
    amount: AssetToken;
    transferAmount: AssetToken;
    destination: Address;
};
export type FundWithTransferParams = {
    jobId: bigint;
    amount: AssetToken;
    transferAmount: AssetToken;
    destination: Address;
    hookAddress?: string;
};
export type SubmitWithTransferParams = {
    jobId: bigint;
    deliverable: string;
    transferAmount: AssetToken;
    hookAddress?: string;
};
export declare class AcpAgent {
    private readonly client;
    private readonly transport;
    private readonly api;
    private started;
    private entryHandler;
    private sessions;
    private address;
    constructor(client: AcpClient, transport: AcpChatTransport, api: AcpJobApi);
    static create(input: CreateAgentInput): Promise<AcpAgent>;
    getClient(): AcpClient;
    getTransport(): AcpChatTransport;
    getApi(): AcpJobApi;
    getSupportedChainIds(): number[];
    browseAgents(keyword: string, params?: BrowseAgentParams): Promise<Array<AcpAgentDetail>>;
    getAgentByWalletAddress(walletAddress: string): Promise<AcpAgentDetail | null>;
    getAddress(): Promise<string>;
    on(_event: "entry", handler: EntryHandler): this;
    private buildTransportContext;
    start(onConnected?: () => void): Promise<void>;
    stop(): Promise<void>;
    private hydrateSessions;
    private getSessionKey;
    getSession(chainId: number, jobId: string): JobSession | undefined;
    private getOrCreateSession;
    private inferRoles;
    private dispatch;
    private fireHandler;
    sendJobMessage(chainId: number, jobId: string, content: string, contentType?: string): void;
    /**
     * One-shot message send via REST. Does not require start()/stop().
     * Authenticates, POSTs the message, and returns.
     */
    sendMessage(chainId: number, jobId: string, content: string, contentType?: string): Promise<void>;
    resolveAssetToken(address: Address, amount: number, chainId: number): Promise<AssetToken>;
    resolveRawAssetToken(address: Address, rawAmount: bigint, chainId: number): Promise<AssetToken>;
    createJob(chainId: number, params: CreateJobParams): Promise<bigint>;
    createFundTransferJob(chainId: number, params: CreateJobParams): Promise<bigint>;
    createJobFromOffering(chainId: number, offering: AcpAgentOffering, providerAddress: string, requirementData: Record<string, unknown> | string, opts?: {
        evaluatorAddress?: string;
        hookAddress?: string;
    }): Promise<bigint>;
    createJobByOfferingName(chainId: number, offeringName: string, providerAddress: string, requirementData: Record<string, unknown> | string, opts?: {
        evaluatorAddress?: string;
        hookAddress?: string;
    }): Promise<bigint>;
    /** @internal */
    internalSetBudget(chainId: number, params: SetBudgetParams): Promise<string | string[]>;
    /** @internal */
    internalFund(chainId: number, params: FundJobParams): Promise<string | string[]>;
    /** @internal */
    internalSubmit(chainId: number, params: SubmitParams): Promise<string | string[]>;
    /** @internal */
    internalComplete(chainId: number, params: CompleteParams): Promise<string | string[]>;
    /** @internal */
    internalReject(chainId: number, params: RejectParams): Promise<string | string[]>;
    /** @internal */
    internalSetBudgetWithFundRequest(chainId: number, params: SetBudgetWithFundRequestParams): Promise<string | string[]>;
    /** @internal */
    internalFundWithTransfer(chainId: number, params: FundWithTransferParams): Promise<string | string[]>;
    /** @internal */
    internalSubmitWithTransfer(chainId: number, params: SubmitWithTransferParams): Promise<string | string[]>;
}
//# sourceMappingURL=acpAgent.d.ts.map