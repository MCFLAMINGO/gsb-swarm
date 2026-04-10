import { EventSource } from "eventsource";
import { AcpHttpClient } from "./acpHttpClient.js";
export class SseTransport extends AcpHttpClient {
    constructor(opts = {}) {
        super(opts);
        this.eventSource = null;
        this.entryHandler = null;
        this.lastEventTimestamp = null;
        this.seenEntries = new Set();
    }
    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------
    async connect(onConnected) {
        await this.ensureAuthenticated();
        this.eventSource = new EventSource(`${this.serverUrl}/chats/stream`, {
            fetch: async (url, init) => {
                await this.refreshTokenIfNeeded();
                return fetch(url, {
                    ...init,
                    headers: {
                        ...init?.headers,
                        Authorization: `Bearer ${this.token}`,
                        "x-supported-chains": JSON.stringify(this.ctx?.providerSupportedChainIds ?? []),
                    },
                });
            },
        });
        await new Promise((resolve, reject) => {
            this.eventSource.onopen = () => resolve();
            this.eventSource.onerror = (err) => {
                if (this.eventSource.readyState === EventSource.CONNECTING)
                    return;
                reject(err);
            };
        });
        onConnected?.();
        this.eventSource.onmessage = (event) => {
            if (!event.data)
                return;
            let entry;
            try {
                entry = JSON.parse(event.data);
            }
            catch {
                return;
            }
            const key = `${entry.timestamp}:${entry.kind}:${"from" in entry ? entry.from : ""}:${"content" in entry ? entry.content : entry.event?.type}`;
            if (this.seenEntries.has(key))
                return;
            this.seenEntries.add(key);
            this.lastEventTimestamp = Math.max(this.lastEventTimestamp ?? 0, entry.timestamp);
            if (this.entryHandler) {
                this.entryHandler(entry);
            }
        };
    }
    async disconnect() {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
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
    // Messaging (via REST — SSE is server→client only)
    // -------------------------------------------------------------------------
    sendMessage(chainId, jobId, content, contentType = "text") {
        this.postMessage(chainId, jobId, content, contentType).catch(console.error);
    }
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
//# sourceMappingURL=sseTransport.js.map