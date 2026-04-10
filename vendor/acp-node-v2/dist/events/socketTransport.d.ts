import type { AcpChatTransport, JobRoomEntry } from "./types";
import { AcpHttpClient, type AcpHttpClientOptions } from "./acpHttpClient";
export type SocketTransportOptions = AcpHttpClientOptions;
export declare class SocketTransport extends AcpHttpClient implements AcpChatTransport {
    private socket;
    private heartbeatInterval;
    private entryHandler;
    private lastEventTimestamp;
    private seenEntries;
    constructor(opts?: SocketTransportOptions);
    connect(onConnected?: () => void): Promise<void>;
    disconnect(): Promise<void>;
    onEntry(handler: (entry: JobRoomEntry) => void): void;
    sendMessage(chainId: number, jobId: string, content: string, contentType?: string): void;
    postMessage(chainId: number, jobId: string, content: string, contentType?: string): Promise<void>;
    getHistory(chainId: number, jobId: string): Promise<JobRoomEntry[]>;
}
//# sourceMappingURL=socketTransport.d.ts.map