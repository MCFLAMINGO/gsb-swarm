import { createEvmNetworkContext } from "../../core/chains.js";
export class ViemProviderAdapter {
    constructor(providerName) {
        this.providerName = providerName;
    }
    async getAddress() {
        throw new Error("getAddress() not implemented. Override in subclass.");
    }
    async getSupportedChainIds() {
        throw new Error("getSupportedChainIds() not implemented. Override in subclass.");
    }
    async getNetworkContext(chainId) {
        return createEvmNetworkContext(chainId);
    }
    async sendCalls(_chainId, _calls) {
        throw new Error("sendCalls() not implemented. Override in subclass.");
    }
    async getTransactionReceipt(_chainId, _hash) {
        throw new Error("getTransactionReceipt() not implemented. Override in subclass.");
    }
    async readContract(_chainId, _params) {
        throw new Error("readContract() not implemented. Override in subclass.");
    }
    async getLogs(_chainId, _params) {
        throw new Error("getLogs() not implemented. Override in subclass.");
    }
    async getBlockNumber(_chainId) {
        throw new Error("getBlockNumber() not implemented. Override in subclass.");
    }
    async signMessage(_chainId, _message) {
        throw new Error("signMessage() not implemented. Override in subclass.");
    }
    async signTypedData(_chainId, _typedData) {
        throw new Error("signTypedData() not implemented. Override in subclass.");
    }
}
//# sourceMappingURL=viemProviderAdapter.js.map