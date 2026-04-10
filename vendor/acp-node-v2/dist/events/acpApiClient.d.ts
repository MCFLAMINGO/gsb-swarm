import type { AcpAgentDetail, AcpJobApi, BrowseAgentParams, OffChainJob } from "./types";
import { AcpHttpClient, type AcpHttpClientOptions } from "./acpHttpClient";
export declare class AcpApiClient extends AcpHttpClient implements AcpJobApi {
    constructor(opts?: AcpHttpClientOptions);
    getActiveJobs(): Promise<OffChainJob[]>;
    getJob(chainId: number, jobId: string): Promise<OffChainJob | null>;
    postDeliverable(chainId: number, jobId: string, deliverable: string): Promise<void>;
    browseAgents(keyword: string, chainIds: number[], params?: BrowseAgentParams): Promise<Array<AcpAgentDetail>>;
    getAgentByWalletAddress(walletAddress: string): Promise<AcpAgentDetail | null>;
}
//# sourceMappingURL=acpApiClient.d.ts.map