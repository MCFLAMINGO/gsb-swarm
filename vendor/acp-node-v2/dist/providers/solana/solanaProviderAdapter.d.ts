import { type SolanaCluster } from "../../core/chains";
import type { ISolanaProviderAdapter, SolanaInstructionLike } from "../types";
export declare class SolanaProviderAdapter implements ISolanaProviderAdapter {
    readonly providerName: string;
    constructor(providerName: string);
    getAddress(): Promise<string>;
    getCluster(): Promise<SolanaCluster>;
    getSupportedChainIds(): Promise<number[]>;
    getNetworkContext(_chainId: number): Promise<import("../..").NetworkContext>;
    sendInstructions(_instructions: SolanaInstructionLike[]): Promise<string | string[]>;
}
//# sourceMappingURL=solanaProviderAdapter.d.ts.map