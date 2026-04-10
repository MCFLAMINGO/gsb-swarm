import { createSolanaNetworkContext } from "../../core/chains.js";
export class SolanaProviderAdapter {
    constructor(providerName) {
        this.providerName = providerName;
    }
    async getAddress() {
        throw new Error("getAddress() not implemented. Override in subclass.");
    }
    async getCluster() {
        throw new Error("getCluster() not implemented. Override in subclass.");
    }
    async getSupportedChainIds() {
        throw new Error("getSupportedChainIds() not implemented. Override in subclass.");
    }
    async getNetworkContext(_chainId) {
        const cluster = await this.getCluster();
        return createSolanaNetworkContext(cluster);
    }
    async sendInstructions(_instructions) {
        throw new Error("sendInstructions() not implemented. Override in subclass.");
    }
}
//# sourceMappingURL=solanaProviderAdapter.js.map