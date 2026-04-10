export interface ProviderAuthClientOptions {
    serverUrl?: string;
    walletAddress: string;
    signMessage: (message: string) => Promise<string>;
    chainId: number;
}
export declare class ProviderAuthClient {
    private token;
    private readonly serverUrl;
    private readonly walletAddress;
    private readonly _signMessage;
    private readonly chainId;
    constructor(opts: ProviderAuthClientOptions);
    getAuthToken(): Promise<string>;
    private authenticate;
    private isTokenExpiring;
}
//# sourceMappingURL=providerAuthClient.d.ts.map