import { AssetToken } from "./core/assetToken";
import type { AcpClient } from "./clientFactory";
import type { OnChainJob } from "./core/operations";
import type { AcpJobStatus, OffChainIntent, OffChainJob } from "./events/types";
export declare class AcpIntent {
    readonly intentId: string;
    readonly actor: string;
    readonly isEscrow: boolean;
    readonly isSigned: boolean;
    readonly fromAddress: string;
    readonly recipientAddress: string;
    readonly rawAmount: bigint | null;
    readonly tokenAddress: string | null;
    constructor(data: OffChainIntent);
    resolveAmount(chainId: number, client: AcpClient): Promise<AssetToken | null>;
}
export declare class AcpJob {
    readonly chainId: number;
    readonly id: bigint;
    readonly clientAddress: string;
    readonly providerAddress: string;
    readonly evaluatorAddress: string;
    readonly description: string;
    readonly budget: AssetToken;
    readonly expiredAt: bigint;
    readonly status: AcpJobStatus;
    readonly hookAddress: string;
    readonly intents: AcpIntent[];
    readonly deliverable: string | null;
    constructor(chainId: number, data: OnChainJob, intents?: AcpIntent[], deliverable?: string | null);
    getFundRequestIntent(): AcpIntent | null;
    getFundTransferIntent(): AcpIntent | null;
    static fromOffChain(data: OffChainJob): AcpJob;
}
//# sourceMappingURL=acpJob.d.ts.map