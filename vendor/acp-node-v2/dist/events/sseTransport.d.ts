import type { AcpChatTransport, JobRoomEntry } from "./types";
import { AcpHttpClient, type AcpHttpClientOptions } from "./acpHttpClient";
export type SseTransportOptions = AcpHttpClientOptions;
export declare class SseTransport extends AcpHttpClient implements AcpChatTransport {
    private eventSource;
    private entryHandler;
    private lastEventTimestamp;
    private seenEntries;
    constructor(opts?: SseTransportOptions);
    connect(onConnected?: () => void): Promise<void>;
    disconnect(): Promise<void>;
    onEntry(handler: (entry: JobRoomEntry) => void): void;
    sendMessage(chainId: number, jobId: string, content: string, contentType?: string): void;
    postMessage(chainId: number, jobId: string, content: string, contentType?: string): Promise<void>;
    getHistory(chainId: number, jobId: string): Promise<JobRoomEntry[]>;
}
//# sourceMappingURL=sseTransport.d.ts.map