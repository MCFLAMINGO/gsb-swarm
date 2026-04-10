import { encodeAbiParameters, zeroAddress } from "viem";
import Ajv from "ajv";
import { createAcpClient, } from "./clientFactory.js";
import { EvmAcpClient } from "./clients/evmAcpClient.js";
import { FUND_TRANSFER_HOOK_ADDRESSES, getAddressForChain, MIN_SLA_MINS, BUFFER_SECONDS, } from "./core/constants.js";
import { AssetToken } from "./core/assetToken.js";
import { JobSession } from "./jobSession.js";
import { AcpApiClient } from "./events/acpApiClient.js";
import { AcpHttpClient } from "./events/acpHttpClient.js";
import { SseTransport } from "./events/sseTransport.js";
// ---------------------------------------------------------------------------
// AcpAgent
// ---------------------------------------------------------------------------
export class AcpAgent {
    constructor(client, transport, api) {
        this.started = false;
        this.entryHandler = null;
        this.sessions = new Map();
        this.address = null;
        this.client = client;
        this.transport = transport;
        this.api = api;
    }
    static async create(input) {
        const { transport = new SseTransport(), api = new AcpApiClient(), ...clientInput } = input;
        const client = await createAcpClient(clientInput);
        const agent = new AcpAgent(client, transport, api);
        const ctx = await agent.buildTransportContext();
        if (transport instanceof AcpHttpClient)
            transport.setContext(ctx);
        if (api instanceof AcpHttpClient)
            api.setContext(ctx);
        return agent;
    }
    getClient() {
        return this.client;
    }
    getTransport() {
        return this.transport;
    }
    getApi() {
        return this.api;
    }
    getSupportedChainIds() {
        return this.client.getSupportedChainIds();
    }
    async browseAgents(keyword, params) {
        const chainIds = this.client.getSupportedChainIds();
        const queryParams = {
            ...params,
            walletAddressToExclude: this.address ?? "",
        };
        return await this.api.browseAgents(keyword, chainIds, queryParams);
    }
    async getAgentByWalletAddress(walletAddress) {
        return this.api.getAgentByWalletAddress(walletAddress);
    }
    async getAddress() {
        if (!this.address) {
            this.address = await this.client.getAddress();
        }
        return this.address;
    }
    // -------------------------------------------------------------------------
    // Single entry handler
    // -------------------------------------------------------------------------
    on(_event, handler) {
        this.entryHandler = handler;
        return this;
    }
    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------
    async buildTransportContext() {
        if (!this.address) {
            this.address = await this.client.getAddress();
        }
        const providerChainIds = this.client instanceof EvmAcpClient
            ? await this.client.getProvider().getSupportedChainIds()
            : [];
        return {
            agentAddress: this.address,
            contractAddresses: this.client.getContractAddresses(),
            providerSupportedChainIds: providerChainIds,
            client: this.client,
            signMessage: (chainId, msg) => {
                if (this.client instanceof EvmAcpClient) {
                    return this.client.getProvider().signMessage(chainId, msg);
                }
                throw new Error("signMessage is not supported for this provider");
            },
        };
    }
    async start(onConnected) {
        if (this.started) {
            throw new Error("Agent already started. Call stop() first.");
        }
        this.started = true;
        this.transport.onEntry((entry) => this.dispatch(entry).catch(console.error));
        await this.transport.connect(onConnected);
        await this.hydrateSessions();
    }
    async stop() {
        if (this.started) {
            await this.transport.disconnect();
            this.started = false;
        }
        this.sessions.clear();
    }
    // -------------------------------------------------------------------------
    // Session hydration (on startup, catch up with existing rooms)
    // -------------------------------------------------------------------------
    async hydrateSessions() {
        if (!this.started)
            return;
        const jobs = await this.api.getActiveJobs();
        for (const job of jobs) {
            const entries = await this.transport.getHistory(job.chainId, job.onChainJobId);
            if (entries.length === 0)
                continue;
            const session = this.getOrCreateSession(job.onChainJobId, job.chainId, entries);
            await session.fetchJob();
            this.fireHandler(session, entries[entries.length - 1]);
        }
    }
    // -------------------------------------------------------------------------
    // Session management
    // -------------------------------------------------------------------------
    getSessionKey(chainId, jobId) {
        return `${chainId}-${jobId}`;
    }
    getSession(chainId, jobId) {
        return this.sessions.get(this.getSessionKey(chainId, jobId));
    }
    getOrCreateSession(jobId, chainId, initialEntries = []) {
        let session = this.sessions.get(this.getSessionKey(chainId, jobId));
        if (session)
            return session;
        const roles = this.inferRoles(initialEntries);
        session = new JobSession(this, this.address, jobId, chainId, roles, initialEntries);
        this.sessions.set(this.getSessionKey(chainId, jobId), session);
        return session;
    }
    inferRoles(entries) {
        const addr = this.address.toLowerCase();
        for (const entry of entries) {
            if (entry.kind === "system" && entry.event.type === "job.created") {
                const event = entry.event;
                const roles = [];
                if (event.client?.toLowerCase() === addr)
                    roles.push("client");
                if (event.provider?.toLowerCase() === addr)
                    roles.push("provider");
                if (event.evaluator?.toLowerCase() === addr)
                    roles.push("evaluator");
                if (roles.length > 0)
                    return roles;
            }
        }
        return ["provider"];
    }
    // -------------------------------------------------------------------------
    // Dispatch
    // -------------------------------------------------------------------------
    async dispatch(entry) {
        const jobId = entry.onChainJobId;
        const chainId = entry.chainId;
        const session = this.getOrCreateSession(jobId, chainId, []);
        if (session.entries.length === 0 || !session.entries.includes(entry)) {
            session.appendEntry(entry);
        }
        if (entry.kind === "system" && entry.event.type === "job.created") {
            const roles = this.inferRoles([entry]);
            const rolesChanged = roles.length !== session.roles.length ||
                roles.some((r, i) => r !== session.roles[i]);
            if (rolesChanged) {
                const newSession = new JobSession(this, this.address, jobId, chainId, roles, session.entries);
                this.sessions.set(this.getSessionKey(chainId, jobId), newSession);
                await newSession.fetchJob();
                this.fireHandler(newSession, entry);
                return;
            }
        }
        await session.fetchJob();
        this.fireHandler(session, entry);
    }
    fireHandler(session, entry) {
        if (!this.entryHandler)
            return;
        if (!session.shouldRespond(entry))
            return;
        try {
            const result = this.entryHandler(session, entry);
            if (result && typeof result.catch === "function") {
                result.catch((err) => {
                    console.error(`[AcpAgent] entry handler error:`, err);
                });
            }
        }
        catch (err) {
            console.error(`[AcpAgent] entry handler error:`, err);
        }
    }
    // -------------------------------------------------------------------------
    // Messaging (delegates to transport)
    // -------------------------------------------------------------------------
    sendJobMessage(chainId, jobId, content, contentType = "text") {
        if (!this.started)
            throw new Error("Agent not started");
        this.transport.sendMessage(chainId, jobId, content, contentType);
    }
    /**
     * One-shot message send via REST. Does not require start()/stop().
     * Authenticates, POSTs the message, and returns.
     */
    async sendMessage(chainId, jobId, content, contentType = "text") {
        await this.transport.postMessage(chainId, jobId, content, contentType);
    }
    // -------------------------------------------------------------------------
    // Token helpers
    // -------------------------------------------------------------------------
    async resolveAssetToken(address, amount, chainId) {
        return AssetToken.fromOnChain(address, amount, chainId, this.client);
    }
    async resolveRawAssetToken(address, rawAmount, chainId) {
        return AssetToken.fromOnChainRaw(address, rawAmount, chainId, this.client);
    }
    // -------------------------------------------------------------------------
    // Job creation (on-chain, room is created by the observer)
    // -------------------------------------------------------------------------
    async createJob(chainId, params) {
        const prepared = await this.client.createJob(chainId, params);
        const result = await this.client.submitPrepared(chainId, [prepared]);
        const txHash = Array.isArray(result) ? result[0] : result;
        const jobId = await this.client.getJobIdFromTxHash(chainId, txHash);
        if (!jobId)
            throw new Error("Failed to extract job ID from transaction");
        return jobId;
    }
    async createFundTransferJob(chainId, params) {
        const defaultHook = getAddressForChain(FUND_TRANSFER_HOOK_ADDRESSES, chainId, "FundTransferHook");
        return this.createJob(chainId, {
            ...params,
            hookAddress: params.hookAddress ?? defaultHook,
        });
    }
    async createJobFromOffering(chainId, offering, providerAddress, requirementData, opts) {
        // Validate requirement data against JSON schema if requirements is an object
        if (offering.requirements &&
            typeof offering.requirements === "object" &&
            typeof requirementData === "object") {
            const ajv = new Ajv({ allErrors: true });
            const validate = ajv.compile(offering.requirements);
            if (!validate(requirementData)) {
                throw new Error(`Requirement validation failed: ${ajv.errorsText(validate.errors)}`);
            }
        }
        const buffer = offering.slaMinutes === MIN_SLA_MINS ? BUFFER_SECONDS : 0;
        const expiredAt = Math.floor(Date.now() / 1000) + offering.slaMinutes * 60 + buffer;
        const jobParams = {
            providerAddress,
            evaluatorAddress: opts?.evaluatorAddress ?? zeroAddress,
            expiredAt,
            description: offering.name,
            ...(opts?.hookAddress ? { hookAddress: opts.hookAddress } : {}),
        };
        const jobId = offering.requiredFunds
            ? await this.createFundTransferJob(chainId, jobParams)
            : await this.createJob(chainId, jobParams);
        // Send first message with requirement data.
        // The chat room may not be ready immediately after on-chain job creation,
        // so retry a few times with a short delay.
        const maxRetries = 5;
        const retryDelayMs = 2000;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await this.sendMessage(chainId, jobId.toString(), JSON.stringify(requirementData), "requirement");
                break;
            }
            catch (err) {
                if (attempt === maxRetries)
                    throw err;
                await new Promise((r) => setTimeout(r, retryDelayMs));
            }
        }
        return jobId;
    }
    async createJobByOfferingName(chainId, offeringName, providerAddress, requirementData, opts) {
        const agent = await this.api.getAgentByWalletAddress(providerAddress);
        if (!agent) {
            throw new Error(`No agent found for wallet address: ${providerAddress}`);
        }
        const matchingOfferings = agent.offerings.filter((o) => o.name === offeringName);
        if (matchingOfferings.length === 0) {
            const available = agent.offerings.map((o) => o.name).join(", ");
            throw new Error(`Offering "${offeringName}" not found. Available offerings: ${available || "none"}`);
        }
        if (matchingOfferings.length > 1) {
            throw new Error(`Multiple offerings named "${offeringName}" found. Use createJobFromOffering with the full offering object instead.`);
        }
        return this.createJobFromOffering(chainId, matchingOfferings[0], providerAddress, requirementData, opts);
    }
    // -------------------------------------------------------------------------
    // Internal on-chain actions (called by JobSession)
    // -------------------------------------------------------------------------
    /** @internal */
    async internalSetBudget(chainId, params) {
        const prepared = await this.client.setBudget(chainId, {
            jobId: params.jobId,
            amount: params.amount.rawAmount,
            optParams: params.optParams ?? "0x",
        });
        return this.client.submitPrepared(chainId, [prepared]);
    }
    /** @internal */
    async internalFund(chainId, params) {
        const approvePrepared = await this.client.approveAllowance(chainId, {
            tokenAddress: params.amount.address,
            spenderAddress: this.client.getContractAddress(chainId),
            amount: params.amount.rawAmount,
        });
        const fundPrepared = await this.client.fund(chainId, {
            jobId: params.jobId,
            expectedBudget: params.amount.rawAmount,
        });
        return this.client.submitPrepared(chainId, [approvePrepared, fundPrepared]);
    }
    /** @internal */
    async internalSubmit(chainId, params) {
        await this.api.postDeliverable(chainId, params.jobId.toString(), params.deliverable);
        const prepared = await this.client.submit(chainId, params);
        return this.client.submitPrepared(chainId, [prepared]);
    }
    /** @internal */
    async internalComplete(chainId, params) {
        const prepared = await this.client.complete(chainId, params);
        return this.client.submitPrepared(chainId, [prepared]);
    }
    /** @internal */
    async internalReject(chainId, params) {
        const prepared = await this.client.reject(chainId, params);
        return this.client.submitPrepared(chainId, [prepared]);
    }
    /** @internal */
    async internalSetBudgetWithFundRequest(chainId, params) {
        const optParams = encodeAbiParameters([
            { type: "address", name: "token" },
            { type: "uint256", name: "amount" },
            { type: "address", name: "destination" },
        ], [
            params.transferAmount.address,
            params.transferAmount.rawAmount,
            params.destination,
        ]);
        return this.internalSetBudget(chainId, {
            jobId: params.jobId,
            amount: params.amount,
            optParams,
        });
    }
    /** @internal */
    async internalFundWithTransfer(chainId, params) {
        const approveAcp = await this.client.approveAllowance(chainId, {
            tokenAddress: params.amount.address,
            spenderAddress: this.client.getContractAddress(chainId),
            amount: params.amount.rawAmount,
        });
        const hookAddr = params.hookAddress ??
            getAddressForChain(FUND_TRANSFER_HOOK_ADDRESSES, chainId, "FundTransferHook");
        const approveHook = await this.client.approveAllowance(chainId, {
            tokenAddress: params.transferAmount.address,
            spenderAddress: hookAddr,
            amount: params.transferAmount.rawAmount,
        });
        const optParams = encodeAbiParameters([
            { type: "address", name: "expectedToken" },
            { type: "uint256", name: "expectedAmount" },
            { type: "address", name: "expectedRecipient" },
        ], [
            params.transferAmount.address,
            params.transferAmount.rawAmount,
            params.destination,
        ]);
        const fundPrepared = await this.client.fund(chainId, {
            jobId: params.jobId,
            expectedBudget: params.amount.rawAmount,
            optParams,
        });
        return this.client.submitPrepared(chainId, [
            approveAcp,
            approveHook,
            fundPrepared,
        ]);
    }
    /** @internal */
    async internalSubmitWithTransfer(chainId, params) {
        await this.api.postDeliverable(chainId, params.jobId.toString(), params.deliverable);
        const hookAddr = params.hookAddress ??
            getAddressForChain(FUND_TRANSFER_HOOK_ADDRESSES, chainId, "FundTransferHook");
        const approvePrepared = await this.client.approveAllowance(chainId, {
            tokenAddress: params.transferAmount.address,
            spenderAddress: hookAddr,
            amount: params.transferAmount.rawAmount,
        });
        const optParams = encodeAbiParameters([
            { type: "address", name: "token" },
            { type: "uint256", name: "amount" },
        ], [
            params.transferAmount.address,
            params.transferAmount.rawAmount,
        ]);
        const submitPrepared = await this.client.submit(chainId, {
            jobId: params.jobId,
            deliverable: params.deliverable,
            optParams,
        });
        return this.client.submitPrepared(chainId, [
            approvePrepared,
            submitPrepared,
        ]);
    }
}
//# sourceMappingURL=acpAgent.js.map