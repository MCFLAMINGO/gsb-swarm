import { LocalAccountSigner } from "@aa-sdk/core";
import { alchemy, defineAlchemyChain } from "@account-kit/infra";
import { createModularAccountV2Client, } from "@account-kit/smart-contracts";
import { createEvmNetworkContext, EVM_MAINNET_CHAINS } from "../../core/chains.js";
export class AlchemyEvmProviderAdapter {
    constructor(address, clients) {
        this.providerName = "Alchemy";
        this.address = address;
        this.clients = clients;
    }
    static async create(params) {
        const clients = new Map();
        const { chains = EVM_MAINNET_CHAINS } = params;
        const alchemyChains = chains.map((chain) => defineAlchemyChain({
            chain: chain,
            rpcBaseUrl: `https://alchemy-proxy.virtuals.io/api/proxy/rpc?chainId=${chain.id}`,
        }));
        for (const chain of alchemyChains) {
            const signer = LocalAccountSigner.privateKeyToAccountSigner(params.privateKey);
            const client = await createModularAccountV2Client({
                chain: chain,
                transport: alchemy({
                    rpcUrl: "https://alchemy-proxy.virtuals.io/api/proxy/rpc",
                }),
                signer,
                policyId: "186aaa4a-5f57-4156-83fb-e456365a8820",
                accountAddress: params.walletAddress,
                signerEntity: {
                    entityId: params.entityId,
                    isGlobalValidation: true,
                },
            });
            clients.set(client.chain.id, client);
        }
        const address = params.walletAddress;
        return new AlchemyEvmProviderAdapter(address, clients);
    }
    getClient(chainId) {
        const c = this.clients.get(chainId);
        if (!c)
            throw new Error(`AlchemyEvmProviderAdapter: no client configured for chainId ${chainId}`);
        return c;
    }
    async getAddress() {
        return this.address;
    }
    async getSupportedChainIds() {
        return Array.from(this.clients.keys());
    }
    async getNetworkContext(chainId) {
        return createEvmNetworkContext(chainId);
    }
    getRandomNonce(bits = 152) {
        const bytes = bits / 8;
        const array = new Uint8Array(bytes);
        crypto.getRandomValues(array);
        let hex = Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
        return BigInt("0x" + hex);
    }
    async sendCalls(chainId, _calls) {
        const client = this.getClient(chainId);
        const { hash } = await client.sendUserOperation({
            uo: _calls.map((call) => ({
                target: call.to,
                data: call.data ?? "0x",
                ...(call.value != null && { value: call.value }),
            })),
            overrides: {
                nonceKey: this.getRandomNonce(),
            },
        });
        const receiptHash = await client.waitForUserOperationTransaction({
            hash,
            tag: "pending",
            retries: {
                intervalMs: 200,
                multiplier: 1.1,
                maxRetries: 10,
            },
        });
        return receiptHash;
    }
    async getTransactionReceipt(chainId, hash) {
        return this.getClient(chainId).getTransactionReceipt({ hash });
    }
    async readContract(chainId, params) {
        return this.getClient(chainId).readContract(params);
    }
    async getLogs(chainId, params) {
        const client = this.getClient(chainId);
        return client.getFilterLogs({
            filter: await client.createEventFilter({
                address: params.address,
                events: params.events,
                fromBlock: params.fromBlock,
                toBlock: params.toBlock ?? "latest",
            }),
        });
    }
    async getBlockNumber(chainId) {
        return this.getClient(chainId).getBlockNumber();
    }
    async signMessage(chainId, _message) {
        return this.getClient(chainId).signMessage({ message: _message });
    }
    async signTypedData(chainId, typedData) {
        return this.getClient(chainId).signTypedData(typedData);
    }
}
//# sourceMappingURL=alchemyEvmProviderAdapter.js.map