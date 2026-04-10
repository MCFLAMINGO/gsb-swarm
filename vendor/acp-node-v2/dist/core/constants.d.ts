import { Address } from "viem";
export declare const USDC_ADDRESSES: Record<number, string>;
export declare const ACP_CONTRACT_ADDRESSES: Record<number, string>;
export declare const FUND_TRANSFER_HOOK_ADDRESSES: Record<number, string>;
export declare const USDC_DECIMALS: Record<number, number>;
export declare function getAddressForChain(registry: Record<number, string>, chainId: number, label: string): Address;
export declare const USDC_SYMBOL = "USDC";
export declare const ACP_SERVER_URL = "https://api.acp.virtuals.io";
export declare const ACP_TESTNET_SERVER_URL = "https://api-dev.acp.virtuals.io";
export declare const PRIVY_APP_ID = "cltsev9j90f67yhyw4sngtrpv";
export declare const TESTNET_PRIVY_APP_ID = "clsakj3e205soyepnl23x2itv";
export declare const ALCHEMY_POLICY_ID = "186aaa4a-5f57-4156-83fb-e456365a8820";
export declare const SUPPORTED_CHAINS: ({
    id: 84532;
    name: "Base Sepolia";
} | {
    id: 97;
    name: "BNB Smart Chain Testnet";
} | {
    id: 8453;
    name: "Base";
})[];
export declare const MIN_SLA_MINS = 5;
export declare const BUFFER_SECONDS = 30;
//# sourceMappingURL=constants.d.ts.map