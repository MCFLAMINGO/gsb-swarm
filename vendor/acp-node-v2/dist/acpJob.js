import { AssetToken } from "./core/assetToken.js";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export class AcpIntent {
    constructor(data) {
        this.intentId = data.intentId;
        this.actor = data.actor;
        this.isEscrow = data.isEscrow;
        this.isSigned = data.isSigned;
        this.fromAddress = data.fromAddress;
        this.recipientAddress = data.recipientAddress;
        this.rawAmount = data.amount != null ? BigInt(data.amount) : null;
        this.tokenAddress = data.tokenAddress;
    }
    async resolveAmount(chainId, client) {
        if (this.rawAmount == null || this.tokenAddress == null)
            return null;
        return AssetToken.fromOnChainRaw(this.tokenAddress, this.rawAmount, chainId, client);
    }
}
export class AcpJob {
    constructor(chainId, data, intents = [], deliverable = null) {
        this.chainId = chainId;
        this.id = data.id;
        this.clientAddress = data.client;
        this.providerAddress = data.provider;
        this.evaluatorAddress = data.evaluator;
        this.description = data.description;
        this.budget = AssetToken.usdcFromRaw(data.budget, chainId);
        this.expiredAt = data.expiredAt;
        this.status = data.status;
        this.hookAddress = data.hook;
        this.intents = intents;
        this.deliverable = deliverable;
    }
    getFundRequestIntent() {
        const intent = this.intents.find((i) => !i.isEscrow);
        if (intent == null)
            return null;
        return intent;
    }
    getFundTransferIntent() {
        const intent = this.intents.find((i) => i.isEscrow);
        if (intent == null)
            return null;
        return intent;
    }
    static fromOffChain(data) {
        const intents = (data.intents ?? []).map((i) => new AcpIntent(i));
        return new AcpJob(data.chainId, {
            id: BigInt(data.onChainJobId),
            client: data.clientAddress,
            provider: data.providerAddress,
            evaluator: data.evaluatorAddress,
            description: data.description ?? "",
            budget: BigInt(data.budget ?? "0"),
            expiredAt: BigInt(Math.floor(new Date(data.expiredAt).getTime() / 1000)),
            status: data.jobStatus,
            hook: data.hookAddress ?? ZERO_ADDRESS,
        }, intents, data.deliverable ?? null);
    }
}
//# sourceMappingURL=acpJob.js.map