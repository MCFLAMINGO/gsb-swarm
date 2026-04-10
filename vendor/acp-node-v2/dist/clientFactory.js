import { EvmAcpClient } from "./clients/evmAcpClient.js";
import { SolanaAcpClient } from "./clients/solanaAcpClient.js";
import { ACP_CONTRACT_ADDRESSES } from "./core/constants.js";
export async function createAcpClient(input) {
    if (isEvmProvider(input.provider)) {
        return EvmAcpClient.create({
            contractAddresses: input.contractAddresses ?? ACP_CONTRACT_ADDRESSES,
            provider: input.provider,
        });
    }
    if (isSolanaProvider(input.provider)) {
        return SolanaAcpClient.create({
            contractAddresses: input.contractAddresses ?? ACP_CONTRACT_ADDRESSES,
            provider: input.provider,
        });
    }
    throw new Error(`Provider "${input.provider.providerName}" does not implement a known adapter interface.`);
}
function isEvmProvider(provider) {
    return ("sendCalls" in provider && typeof provider.sendCalls === "function");
}
function isSolanaProvider(provider) {
    return ("getCluster" in provider &&
        typeof provider.getCluster === "function" &&
        "sendInstructions" in provider &&
        typeof provider.sendInstructions === "function");
}
//# sourceMappingURL=clientFactory.js.map