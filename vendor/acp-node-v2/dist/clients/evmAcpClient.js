import { encodeFunctionData, erc20Abi, keccak256, pad, toHex, zeroAddress, } from "viem";
import { BaseAcpClient } from "./baseAcpClient.js";
import { ACP_ABI } from "../core/acpAbi.js";
import { parseJobIdFromReceipt } from "../utils/events.js";
export class EvmAcpClient extends BaseAcpClient {
    constructor(contractAddresses, provider) {
        super(contractAddresses);
        this.provider = provider;
    }
    static async create(input) {
        return new EvmAcpClient(input.contractAddresses, input.provider);
    }
    async getAddress() {
        return this.provider.getAddress();
    }
    getProvider() {
        return this.provider;
    }
    getCapabilities() {
        return {
            supportsBatch: true,
            supportsAllowance: true,
        };
    }
    async execute(chainId, calls) {
        return this.provider.sendCalls(chainId, calls);
    }
    async submitPrepared(chainId, prepared) {
        const evmCalls = [];
        for (const item of prepared) {
            if (item.chain !== "evm") {
                throw new Error(`Prepared transaction chain mismatch: expected "evm" but received "${item.chain}".`);
            }
            evmCalls.push(...item.tx);
        }
        return this.execute(chainId, evmCalls);
    }
    async createJob(chainId, params) {
        const call = this.buildContractCall(chainId, "createJob", [
            params.providerAddress,
            params.evaluatorAddress,
            BigInt(params.expiredAt),
            params.description,
            (params.hookAddress ?? zeroAddress),
        ]);
        return this.wrap(chainId, call);
    }
    async setBudget(chainId, params) {
        return this.wrap(chainId, this.buildContractCall(chainId, "setBudget", [
            BigInt(params.jobId),
            params.amount,
            params.optParams ?? "0x",
        ]));
    }
    async approveAllowance(chainId, params) {
        const data = encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [params.spenderAddress, params.amount],
        });
        return this.wrap(chainId, {
            to: params.tokenAddress,
            data,
            value: 0n,
        });
    }
    async fund(chainId, params) {
        return this.wrap(chainId, this.buildContractCall(chainId, "fund", [
            BigInt(params.jobId),
            params.expectedBudget,
            params.optParams ?? "0x",
        ]));
    }
    async submit(chainId, params) {
        return this.wrap(chainId, this.buildContractCall(chainId, "submit", [
            BigInt(params.jobId),
            keccak256(toHex(params.deliverable)),
            params.optParams ?? "0x",
        ]));
    }
    async complete(chainId, params) {
        return this.wrap(chainId, this.buildContractCall(chainId, "complete", [
            BigInt(params.jobId),
            EvmAcpClient.toBytes32(params.reason),
            params.optParams ?? "0x",
        ]));
    }
    async reject(chainId, params) {
        return this.wrap(chainId, this.buildContractCall(chainId, "reject", [
            BigInt(params.jobId),
            EvmAcpClient.toBytes32(params.reason),
            params.optParams ?? "0x",
        ]));
    }
    async getJobIdFromTxHash(chainId, txHash, filter) {
        const receipt = await this.provider.getTransactionReceipt(chainId, txHash);
        return parseJobIdFromReceipt(receipt, this.getContractAddress(chainId), filter);
    }
    async getJob(chainId, jobId) {
        const result = await this.provider.readContract(chainId, {
            address: this.getContractAddress(chainId),
            abi: ACP_ABI,
            functionName: "getJob",
            args: [jobId],
        });
        const raw = result;
        return {
            id: jobId,
            client: raw.client,
            provider: raw.provider,
            evaluator: raw.evaluator,
            description: raw.description,
            budget: raw.budget,
            expiredAt: raw.expiredAt,
            status: raw.status,
            hook: raw.hook,
        };
    }
    async getTokenDecimals(chainId, tokenAddress) {
        const result = await this.provider.readContract(chainId, {
            address: tokenAddress,
            abi: erc20Abi,
            functionName: "decimals",
        });
        return Number(result);
    }
    async getTokenSymbol(chainId, tokenAddress) {
        const result = await this.provider.readContract(chainId, {
            address: tokenAddress,
            abi: erc20Abi,
            functionName: "symbol",
        });
        return result;
    }
    static toBytes32(value) {
        if (value.startsWith("0x") && value.length === 66)
            return value;
        const hex = toHex(value);
        if (hex.length <= 66)
            return pad(hex, { size: 32, dir: "right" });
        return keccak256(hex);
    }
    buildContractCall(chainId, functionName, args) {
        const data = encodeFunctionData({
            abi: ACP_ABI,
            functionName,
            args: args,
        });
        return {
            to: this.getContractAddress(chainId),
            data,
            value: 0n,
        };
    }
    async wrap(chainId, call) {
        const context = await this.provider.getNetworkContext(chainId);
        return {
            tx: [call],
            chain: "evm",
            network: context.network,
        };
    }
}
//# sourceMappingURL=evmAcpClient.js.map