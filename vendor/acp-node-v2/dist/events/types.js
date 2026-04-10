// ---------------------------------------------------------------------------
// ACP job status
// ---------------------------------------------------------------------------
export var AcpJobStatus;
(function (AcpJobStatus) {
    AcpJobStatus[AcpJobStatus["REQUEST"] = 0] = "REQUEST";
    AcpJobStatus[AcpJobStatus["NEGOTIATION"] = 1] = "NEGOTIATION";
    AcpJobStatus[AcpJobStatus["TRANSACTION"] = 2] = "TRANSACTION";
    AcpJobStatus[AcpJobStatus["EVALUATION"] = 3] = "EVALUATION";
    AcpJobStatus[AcpJobStatus["COMPLETED"] = 4] = "COMPLETED";
    AcpJobStatus[AcpJobStatus["REJECTED"] = 5] = "REJECTED";
})(AcpJobStatus || (AcpJobStatus = {}));
//# sourceMappingURL=types.js.map