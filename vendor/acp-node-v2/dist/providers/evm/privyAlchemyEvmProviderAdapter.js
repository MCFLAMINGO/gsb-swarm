import { createPublicClient, http, toHex, } from "viem";
import { getTransactionReceipt, readContract, getLogs, getBlockNumber, } from "viem/actions";
import { createEvmNetworkContext, EVM_MAINNET_CHAINS } from "../../core/chains.js";
import { formatRequestForAuthorizationSignature, generateAuthorizationSignature, } from "@privy-io/node";
import { createSmartWalletClient, alchemyWalletTransport, } from "@alchemy/wallet-apis";
import { ACP_SERVER_URL, ALCHEMY_POLICY_ID, PRIVY_APP_ID, } from "../../core/constants.js";
import { ProviderAuthClient } from "../providerAuthClient.js";
function encodeSignableMessage(message) {
    if (typeof message === "string") {
        if (message.startsWith("0x")) {
            return { message: message.slice(2), encoding: "hex" };
        }
        return { message, encoding: "utf-8" };
    }
    const raw = typeof message.raw === "string" ? message.raw : toHex(message.raw);
    const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
    return { message: hex, encoding: "hex" };
}
function buildSignInput(walletId, body, privyAppId = PRIVY_APP_ID) {
    return {
        version: 1,
        method: "POST",
        url: `https://api.privy.io/v1/wallets/${walletId}/rpc`,
        body,
        headers: { "privy-app-id": privyAppId },
    };
}
async function serverPost(path, body, serverUrl) {
    const base = serverUrl.replace(/\/$/, "");
    const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
        throw new Error(data?.detail ?? data?.error ?? `Server error ${res.status}`);
    }
    return data;
}
async function signedServerCall(executePath, walletId, rpcBody, payload, signerPrivateKey, serverUrl, privyAppId = PRIVY_APP_ID, signFn) {
    const input = buildSignInput(walletId, rpcBody, privyAppId);
    let authorizationSignature;
    if (signFn) {
        const formatted = formatRequestForAuthorizationSignature(input);
        authorizationSignature = await signFn(formatted);
    }
    else if (signerPrivateKey) {
        authorizationSignature = generateAuthorizationSignature({
            authorizationPrivateKey: signerPrivateKey,
            input,
        });
    }
    else {
        throw new Error("PrivyAlchemyEvmProviderAdapter: either signerPrivateKey or signFn must be provided");
    }
    return serverPost(executePath, { ...payload, authorizationSignature }, serverUrl);
}
function replaceBigInts(obj, replacer) {
    if (typeof obj === "bigint")
        return replacer(obj);
    if (Array.isArray(obj))
        return obj.map((x) => replaceBigInts(x, replacer));
    if (obj && typeof obj === "object")
        return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, replaceBigInts(v, replacer)]));
    return obj;
}
function createRemoteSigner(params) {
    const { address, walletId, signerPrivateKey, signFn, serverUrl, privyAppId } = params;
    return {
        type: "local",
        source: "privy-remote",
        address,
        publicKey: "0x",
        signMessage: async ({ message }) => {
            const encoded = encodeSignableMessage(message);
            const rpcBody = {
                method: "personal_sign",
                chain_type: "ethereum",
                params: { message: encoded.message, encoding: encoded.encoding },
            };
            const result = await signedServerCall("/wallets/sign-message", walletId, rpcBody, { walletAddress: address, walletId, ...encoded }, signerPrivateKey, serverUrl, privyAppId, signFn);
            return result.signature;
        },
        signTypedData: async (typedDataDef) => {
            const { domain, types, primaryType, message } = replaceBigInts(typedDataDef, toHex);
            const typedData = {
                domain: domain ?? {},
                types: types ?? {},
                primary_type: primaryType,
                message: message ?? {},
            };
            const rpcBody = {
                method: "eth_signTypedData_v4",
                chain_type: "ethereum",
                params: { typed_data: typedData },
            };
            const result = await signedServerCall("/wallets/sign-typed-data", walletId, rpcBody, { walletAddress: address, walletId, typedData }, signerPrivateKey, serverUrl, privyAppId, signFn);
            return result.signature;
        },
        signTransaction: async () => {
            throw new Error("signTransaction not supported — use sendCalls instead");
        },
        signAuthorization: async (unsignedAuth) => {
            const contract = unsignedAuth.contractAddress ?? unsignedAuth.address;
            const chainId = unsignedAuth.chainId;
            const nonce = unsignedAuth.nonce;
            const rpcBody = {
                method: "eth_sign7702Authorization",
                chain_type: "ethereum",
                params: {
                    contract,
                    chain_id: chainId,
                    ...(nonce != null ? { nonce } : {}),
                },
            };
            const result = await signedServerCall("/wallets/sign-authorization", walletId, rpcBody, {
                walletAddress: address,
                walletId,
                contract,
                chainId,
                ...(nonce != null ? { nonce } : {}),
            }, signerPrivateKey, serverUrl, privyAppId, signFn);
            return result.authorization;
        },
    };
}
export class PrivyAlchemyEvmProviderAdapter {
    constructor(address, chainClients, signer) {
        this.providerName = "Privy Alchemy";
        this.address = address;
        this.chainClients = chainClients;
        this.signer = signer;
    }
    static async create(params) {
        if (!params.signerPrivateKey && !params.signFn) {
            throw new Error("PrivyAlchemyEvmProviderAdapter: either signerPrivateKey or signFn must be provided");
        }
        const chainClients = new Map();
        const { chains = EVM_MAINNET_CHAINS } = params;
        const serverUrl = (params.serverUrl ?? ACP_SERVER_URL).replace(/\/$/, "");
        const signer = createRemoteSigner({
            address: params.walletAddress,
            walletId: params.walletId,
            signerPrivateKey: params.signerPrivateKey,
            signFn: params.signFn,
            serverUrl,
            privyAppId: params.privyAppId ?? PRIVY_APP_ID,
        });
        const authClient = new ProviderAuthClient({
            serverUrl,
            walletAddress: params.walletAddress,
            signMessage: (msg) => signer.signMessage({ message: msg }),
            chainId: chains[0].id,
        });
        const getToken = () => authClient.getAuthToken();
        const authedFetch = async (input, init) => {
            const token = await getToken();
            return fetch(input, {
                ...init,
                headers: {
                    ...init?.headers,
                    Authorization: `Bearer ${token}`,
                },
            });
        };
        for (const chain of chains) {
            const smartWalletClient = createSmartWalletClient({
                transport: alchemyWalletTransport({
                    url: `${serverUrl}/wallets/alchemy-rpc`,
                    fetchFn: authedFetch,
                }),
                chain,
                signer,
                account: params.walletAddress,
                paymaster: { policyId: ALCHEMY_POLICY_ID },
            });
            const publicClient = createPublicClient({
                chain,
                transport: http(`${serverUrl}/wallets/alchemy-rpc/${chain.id}`, {
                    fetchFn: authedFetch,
                }),
            });
            chainClients.set(chain.id, { smartWalletClient, publicClient });
        }
        return new PrivyAlchemyEvmProviderAdapter(params.walletAddress, chainClients, signer);
    }
    getClients(chainId) {
        const c = this.chainClients.get(chainId);
        if (!c)
            throw new Error(`PrivyAlchemyEvmProviderAdapter: no clients configured for chainId ${chainId}`);
        return c;
    }
    async getAddress() {
        return this.address;
    }
    async getSupportedChainIds() {
        return Array.from(this.chainClients.keys());
    }
    async getNetworkContext(chainId) {
        return createEvmNetworkContext(chainId);
    }
    getRandomNonce(bits = 152) {
        const bytes = bits / 8;
        const array = new Uint8Array(bytes);
        crypto.getRandomValues(array);
        const hex = Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
        return `0x${hex}`;
    }
    async sendCalls(chainId, _calls) {
        const { smartWalletClient } = this.getClients(chainId);
        const { id } = await smartWalletClient.sendCalls({
            calls: _calls.map((call) => ({
                to: call.to,
                data: call.data ?? "0x",
                value: call.value ?? 0n,
            })),
            capabilities: {
                nonceOverride: {
                    nonceKey: this.getRandomNonce(),
                },
            },
        });
        const status = await smartWalletClient.waitForCallsStatus({ id });
        if (!status.receipts?.[0]?.transactionHash) {
            throw new Error("Transaction failed");
        }
        return status.receipts?.[0]?.transactionHash;
    }
    async getTransactionReceipt(chainId, hash) {
        return getTransactionReceipt(this.getClients(chainId).publicClient, {
            hash,
        });
    }
    async readContract(chainId, params) {
        return readContract(this.getClients(chainId).publicClient, params);
    }
    async getLogs(chainId, params) {
        return getLogs(this.getClients(chainId).publicClient, params);
    }
    async getBlockNumber(chainId) {
        return getBlockNumber(this.getClients(chainId).publicClient);
    }
    async signMessage(chainId, _message) {
        return this.signer.signMessage({
            message: _message,
        });
    }
    async signTypedData(chainId, typedData) {
        return this.signer.signTypedData(typedData);
    }
}
//# sourceMappingURL=privyAlchemyEvmProviderAdapter.js.map