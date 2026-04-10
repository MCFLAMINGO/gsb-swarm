import type { TransportContext } from "./types";
export type AcpHttpClientOptions = {
    serverUrl?: string;
};
export declare class AcpHttpClient {
    protected ctx: TransportContext | null;
    protected token: string;
    protected readonly serverUrl: string;
    constructor(opts?: AcpHttpClientOptions);
    setContext(ctx: TransportContext): void;
    ensureAuthenticated(): Promise<void>;
    protected authenticate(): Promise<string>;
    /** Returns true if the token expiry is within 60 s (or unparseable). */
    protected isTokenExpiring(): boolean;
    protected refreshTokenIfNeeded(): Promise<void>;
    protected authedFetch(url: string, init?: RequestInit): Promise<Response>;
}
//# sourceMappingURL=acpHttpClient.d.ts.map