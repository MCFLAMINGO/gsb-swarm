import { keccak256, toHex } from "viem";
import { BaseAcpClient } from "./baseAcpClient.js";
export class SolanaAcpClient extends BaseAcpClient {
    constructor(contractAddresses, provider) {
        super(contractAddresses);
        this.provider = provider;
    }
    static async create(input) {
        return new SolanaAcpClient(input.contractAddresses, input.provider);
    }
    async getAddress() {
        return this.provider.getAddress();
    }
    getCapabilities() {
        return {
            supportsBatch: true,
            supportsAllowance: false,
        };
    }
    async execute(instructions) {
        return this.provider.sendInstructions(instructions);
    }
    async submitPrepared(_chainId, prepared) {
        const instructions = [];
        for (const item of prepared) {
            if (item.chain !== "solana") {
                throw new Error(`Prepared transaction chain mismatch: expected "solana" but received "${item.chain}".`);
            }
            instructions.push(...item.tx);
        }
        return this.execute(instructions);
    }
    async createJob(chainId, params) {
        return this.wrap(chainId, this.makeIx(chainId, "createJob", {
            providerAddress: params.providerAddress,
            evaluatorAddress: params.evaluatorAddress,
            expiredAt: params.expiredAt,
            description: params.description,
            hookAddress: params.hookAddress,
        }));
    }
    async setBudget(chainId, params) {
        return this.wrap(chainId, this.makeIx(chainId, "setBudget", {
            jobId: params.jobId,
            amount: params.amount.toString(),
        }));
    }
    async approveAllowance(_chainId, _params) {
        throw new Error("approveAllowance is not supported by SolanaAcpClient. Check capability flags first.");
    }
    async fund(chainId, params) {
        return this.wrap(chainId, this.makeIx(chainId, "fund", {
            jobId: params.jobId,
        }));
    }
    async submit(chainId, params) {
        return this.wrap(chainId, this.makeIx(chainId, "submit", {
            jobId: params.jobId,
            deliverable: keccak256(toHex(params.deliverable)),
        }));
    }
    async complete(chainId, params) {
        return this.wrap(chainId, this.makeIx(chainId, "complete", {
            jobId: params.jobId,
            reason: params.reason,
        }));
    }
    async reject(chainId, params) {
        return this.wrap(chainId, this.makeIx(chainId, "reject", {
            jobId: params.jobId,
            reason: params.reason,
        }));
    }
    async getJobIdFromTxHash(_chainId) {
        throw new Error("getJobIdFromTxHash is not implemented for SolanaAcpClient.");
    }
    async getJob(_chainId, _jobId) {
        throw new Error("getJob is not implemented for SolanaAcpClient.");
    }
    async getTokenDecimals(_chainId, _tokenAddress) {
        throw new Error("getTokenDecimals is only supported on EVM. Use Erc20Token.create with explicit decimals for Solana.");
    }
    async getTokenSymbol(_chainId, _tokenAddress) {
        throw new Error("getTokenSymbol is only supported on EVM. Use Erc20Token.create with explicit symbol for Solana.");
    }
    makeIx(chainId, method, payload) {
        return {
            programId: this.getContractAddress(chainId),
            keys: [],
            data: JSON.stringify({ method, payload }),
        };
    }
    async wrap(chainId, instruction) {
        const context = await this.provider.getNetworkContext(chainId);
        return {
            tx: [instruction],
            chain: "solana",
            network: context.network,
        };
    }
}
//# sourceMappingURL=solanaAcpClient.js.map