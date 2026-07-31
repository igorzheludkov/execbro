import { jest } from "@jest/globals";

const executeInApp = jest.fn<any>();
jest.unstable_mockModule("../../core/executor.js", () => ({ executeInApp }));

const { mirrorOnce, __resetMirrorState } = await import("../../core/sdkMirrorPoller.js");
const { getLogBuffer, getNetworkBuffer, resetEpochs, bumpEpoch } = await import("../../core/state.js");
const { __resetLogSeq } = await import("../../core/logs.js");

const payload = (network: any[], console_: any[]) => ({
    success: true,
    result: JSON.stringify({ network, console: console_ }),
});

const netEntry = (id: string) => ({
    id,
    timestamp: Date.now(),
    method: "GET",
    url: `https://api.test/${id}`,
    status: 200,
    requestHeaders: {},
    responseHeaders: {},
    completed: true,
});

const logEntry = (id: string, message: string) => ({
    id,
    timestamp: Date.now(),
    level: "log",
    message,
});

describe("mirrorOnce", () => {
    beforeEach(() => {
        executeInApp.mockReset();
        __resetMirrorState();
        __resetLogSeq();
        resetEpochs();
        getLogBuffer("dev").clear();
        getNetworkBuffer("dev").clear();
    });

    it("copies SDK entries into the server buffers", async () => {
        executeInApp.mockResolvedValue(payload([netEntry("n1")], [logEntry("c1", "hello")]));
        const result = await mirrorOnce("dev");
        expect(result).toEqual({ logs: 1, network: 1 });
        expect(getNetworkBuffer("dev").size).toBe(1);
        expect(getLogBuffer("dev").getAll()[0].message).toBe("hello");
    });

    it("is idempotent across repeated polls", async () => {
        executeInApp.mockResolvedValue(payload([netEntry("n1")], [logEntry("c1", "hello")]));
        await mirrorOnce("dev");
        const second = await mirrorOnce("dev");
        expect(second).toEqual({ logs: 0, network: 0 });
        expect(getLogBuffer("dev").size).toBe(1);
        expect(getNetworkBuffer("dev").size).toBe(1);
    });

    it("re-mirrors the same SDK ids after an epoch bump", async () => {
        executeInApp.mockResolvedValue(payload([netEntry("n1")], [logEntry("c1", "hello")]));
        await mirrorOnce("dev");
        bumpEpoch("dev");
        const afterRestart = await mirrorOnce("dev");
        expect(afterRestart).toEqual({ logs: 1, network: 1 });
        expect(getNetworkBuffer("dev").size).toBe(2);
    });

    it("returns zeroes when the eval fails", async () => {
        executeInApp.mockResolvedValue({ success: false, error: "disconnected" });
        expect(await mirrorOnce("dev")).toEqual({ logs: 0, network: 0 });
    });

    it("returns zeroes on malformed JSON", async () => {
        executeInApp.mockResolvedValue({ success: true, result: "not json" });
        expect(await mirrorOnce("dev")).toEqual({ logs: 0, network: 0 });
    });

    it("swallows a thrown eval", async () => {
        executeInApp.mockRejectedValue(new Error("boom"));
        expect(await mirrorOnce("dev")).toEqual({ logs: 0, network: 0 });
    });
});
