import { io } from "socket.io-client";
import { AcpHttpClient } from "./acpHttpClient.js";
export class SocketTransport extends AcpHttpClient {
    constructor(opts = {}) {
        super(opts);
        this.socket = null;
        this.heartbeatInterval = null;
        this.entryHandler = null;
        this.lastEventTimestamp = null;
        this.seenEntries = new Set();
    }
    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------
    async connect(onConnected) {
        await this.ensureAuthenticated();
        this.socket = io(this.serverUrl, {
            transports: ["websocket"],
            extraHeaders: {
                "x-supported-chains": JSON.stringify(this.ctx?.providerSupportedChainIds ?? []),
            },
            auth: async (cb) => {
                try {
                    await this.refreshTokenIfNeeded();
                }
                catch {
                    /* proceed with current token */
                }
                cb({
                    token: this.token,
                    lastEventTimestamp: this.lastEventTimestamp,
                });
            },
        });
        await new Promise((resolve, reject) => {
            this.socket.on("connect", resolve);
            this.socket.on("connect_error", reject);
        });
        onConnected?.();
        this.socket.on("disconnect", (reason) => {
            if (reason === "io server disconnect") {
                this.socket?.connect();
            }
        });
        this.socket.on("job:entry", (data) => {
            const entry = data;
            const key = `${entry.timestamp}:${entry.kind}:${"from" in entry ? entry.from : ""}:${"content" in entry ? entry.content : entry.event?.type}`;
            if (this.seenEntries.has(key))
                return;
            this.seenEntries.add(key);
            this.lastEventTimestamp = Math.max(this.lastEventTimestamp ?? 0, entry.timestamp);
            if (this.entryHandler) {
                this.entryHandler(entry);
            }
        });
        this.heartbeatInterval = setInterval(() => {
            this.socket?.emit("heartbeat");
        }, 30000);
    }
    async disconnect() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
        this.ctx = null;
        this.entryHandler = null;
        this.lastEventTimestamp = null;
        this.seenEntries.clear();
    }
    // -------------------------------------------------------------------------
    // Entry handler
    // -------------------------------------------------------------------------
    onEntry(handler) {
        this.entryHandler = handler;
    }
    // -------------------------------------------------------------------------
    // Messaging (real-time via socket)
    // -------------------------------------------------------------------------
    sendMessage(chainId, jobId, content, contentType = "text") {
        if (!this.socket)
            throw new Error("Transport not connected");
        this.socket.emit("job:message", {
            chainId,
            onChainJobId: jobId,
            content,
            contentType,
        });
    }
    // -------------------------------------------------------------------------
    // One-shot REST messaging (no socket connection needed)
    // -------------------------------------------------------------------------
    async postMessage(chainId, jobId, content, contentType = "text") {
        await this.ensureAuthenticated();
        const res = await this.authedFetch(`${this.serverUrl}/chats/${chainId}/${jobId}/message`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content, contentType }),
        });
        if (!res.ok) {
            throw new Error(`postMessage failed: ${res.status} ${res.statusText}`);
        }
    }
    // -------------------------------------------------------------------------
    // Chat history
    // -------------------------------------------------------------------------
    async getHistory(chainId, jobId) {
        await this.ensureAuthenticated();
        const res = await this.authedFetch(`${this.serverUrl}/chats/${chainId}/${jobId}/history`);
        const data = (await res.json());
        return data.entries;
    }
}
//# sourceMappingURL=socketTransport.js.map