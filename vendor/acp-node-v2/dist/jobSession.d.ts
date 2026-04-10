import type { JobRoomEntry, AgentMessage, AcpTool, AgentRole } from "./events/types";
import type { AcpAgent } from "./acpAgent";
import { AcpJob } from "./acpJob";
import { AssetToken } from "./core/assetToken";
import { Address } from "viem";
type DerivedStatus = "open" | "budget_set" | "funded" | "submitted" | "completed" | "rejected" | "expired";
export declare class JobSession {
    readonly jobId: string;
    readonly chainId: number;
    readonly roles: AgentRole[];
    readonly entries: JobRoomEntry[];
    private _job;
    private readonly agent;
    private readonly agentAddress;
    constructor(agent: AcpAgent, agentAddress: string, jobId: string, chainId: number, roles: AgentRole[], initialEntries?: JobRoomEntry[]);
    get job(): AcpJob | null;
    fetchJob(): Promise<AcpJob>;
    appendEntry(entry: JobRoomEntry): void;
    get status(): DerivedStatus;
    shouldRespond(entry: JobRoomEntry): boolean;
    availableTools(): AcpTool[];
    executeTool(name: string, args: Record<string, unknown>): Promise<void>;
    sendMessage(content: string, contentType?: AgentMessage["contentType"]): Promise<void>;
    setBudget(amount: AssetToken): Promise<void>;
    setBudgetWithFundRequest(amount: AssetToken, transferAmount: AssetToken, destination: Address): Promise<void>;
    fund(amount?: AssetToken): Promise<void>;
    submit(deliverable: string, transferAmount?: AssetToken): Promise<void>;
    complete(reason: string): Promise<void>;
    reject(reason: string): Promise<void>;
    toContext(): Promise<string>;
    toMessages(): Promise<{
        role: "system" | "user" | "assistant";
        content: string;
    }[]>;
}
export {};
//# sourceMappingURL=jobSession.d.ts.map