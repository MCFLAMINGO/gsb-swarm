export var JobStatus;
(function (JobStatus) {
    JobStatus[JobStatus["OPEN"] = 0] = "OPEN";
    JobStatus[JobStatus["FUNDED"] = 1] = "FUNDED";
    JobStatus[JobStatus["SUBMITTED"] = 2] = "SUBMITTED";
    JobStatus[JobStatus["COMPLETED"] = 3] = "COMPLETED";
    JobStatus[JobStatus["REJECTED"] = 4] = "REJECTED";
    JobStatus[JobStatus["EXPIRED"] = 5] = "EXPIRED";
})(JobStatus || (JobStatus = {}));
export var AgentSort;
(function (AgentSort) {
    AgentSort["SUCCESSFUL_JOB_COUNT"] = "successfulJobCount";
    AgentSort["SUCCESS_RATE"] = "successRate";
    AgentSort["UNIQUE_BUYER_COUNT"] = "uniqueBuyerCount";
    AgentSort["MINS_FROM_LAST_ONLINE"] = "minsFromLastOnlineTime";
})(AgentSort || (AgentSort = {}));
export var OnlineStatus;
(function (OnlineStatus) {
    OnlineStatus["ALL"] = "all";
    OnlineStatus["ONLINE"] = "online";
    OnlineStatus["OFFLINE"] = "offline";
})(OnlineStatus || (OnlineStatus = {}));
export class BaseAcpClient {
    constructor(contractAddresses) {
        this.contractAddresses = contractAddresses;
    }
    getContractAddress(chainId) {
        const addr = this.contractAddresses[chainId];
        if (!addr)
            throw new Error(`No contract address configured for chainId ${chainId}`);
        return addr;
    }
    getContractAddresses() {
        return this.contractAddresses;
    }
    getSupportedChainIds() {
        return Object.keys(this.contractAddresses).map(Number);
    }
}
//# sourceMappingURL=baseAcpClient.js.map