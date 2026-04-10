import { type Address, type TransactionReceipt } from "viem";
export type JobCreatedFilter = {
    provider?: string;
    evaluator?: string;
    expiredAt?: number | bigint;
    hook?: string;
};
/**
 * Extracts a `jobId` from a transaction receipt by decoding `JobCreated` event
 * logs emitted by the ACP contract.
 *
 * When multiple `JobCreated` events exist in a single receipt (batched calls),
 * pass a `filter` with the original `CreateJobParams` values to match the
 * correct event.
 */
export declare function parseJobIdFromReceipt(receipt: TransactionReceipt, contractAddress: Address, filter?: JobCreatedFilter): bigint | null;
//# sourceMappingURL=events.d.ts.map