import { Address } from "viem";
import type { AcpClient } from "../clientFactory";
export declare class AssetToken {
    readonly address: Address;
    readonly symbol: string;
    readonly decimals: number;
    readonly amount: number;
    readonly rawAmount: bigint;
    constructor(address: Address, symbol: string, decimals: number, amount: number);
    static create(address: Address, symbol: string, decimals: number, amount: number): AssetToken;
    static usdc(amount: number, chainId: number): AssetToken;
    static usdcFromRaw(rawAmount: bigint, chainId: number): AssetToken;
    static fromOnChain(address: Address, amount: number, chainId: number, client: AcpClient): Promise<AssetToken>;
    static fromOnChainRaw(address: Address, rawAmount: bigint, chainId: number, client: AcpClient): Promise<AssetToken>;
}
//# sourceMappingURL=assetToken.d.ts.map