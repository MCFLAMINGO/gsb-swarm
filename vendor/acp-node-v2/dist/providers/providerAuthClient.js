import { ACP_SERVER_URL } from "../core/constants.js";
export class ProviderAuthClient {
    constructor(opts) {
        this.token = "";
        this.serverUrl = (opts.serverUrl ?? ACP_SERVER_URL).replace(/\/$/, "");
        this.walletAddress = opts.walletAddress;
        this._signMessage = opts.signMessage;
        this.chainId = opts.chainId;
    }
    async getAuthToken() {
        if (!this.token || this.isTokenExpiring()) {
            this.token = await this.authenticate();
        }
        return this.token;
    }
    async authenticate() {
        const message = `acp-auth:${Date.now()}`;
        const signature = await this._signMessage(message);
        const res = await fetch(`${this.serverUrl}/auth/agent`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                walletAddress: this.walletAddress,
                signature,
                message,
                chainId: this.chainId,
            }),
        });
        if (!res.ok) {
            throw new Error(`Agent auth failed: ${res.status} ${res.statusText}`);
        }
        const body = (await res.json());
        return body.data.token;
    }
    isTokenExpiring() {
        try {
            const parts = this.token.split(".");
            if (!parts[1])
                return true;
            const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
            return (payload.exp ?? 0) * 1000 - Date.now() < 60000;
        }
        catch {
            return true;
        }
    }
}
//# sourceMappingURL=providerAuthClient.js.map