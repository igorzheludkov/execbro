import { jest } from "@jest/globals";

const executeInApp = jest.fn<any>();
jest.unstable_mockModule("../../core/executor.js", () => ({ executeInApp }));

const { mirrorOnce, __resetMirrorState } = await import("../../core/sdkMirrorPoller.js");
const { getLogBuffer, getNetworkBuffer, resetEpochs, bumpEpoch, getEpoch, connectedApps, logBuffers, networkBuffers } = await import("../../core/state.js");
const { __resetLogSeq } = await import("../../core/logs.js");

const payload = (network: any[], console_: any[], runId = "run-1") => ({
    success: true,
    result: JSON.stringify({ runId, network, console: console_ }),
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

    // Reproduced on a live iPhone Air simulator, 2026-08-06: a request still in
    // flight when a poll fired stayed "pending" in the server buffer forever,
    // with no status and no body, while the app's own SDK buffer held the same
    // id completed with a 200 and 452 bytes. The SDK adds an entry at request
    // START (`completed:false`) and mutates it later via `buffer.update()`, but
    // the seen-set latched the id on first sight, so the completed version was
    // never read again. Repeated polls could not repair it — the latch is
    // per-epoch, so it survived until app restart.
    it("picks up the response when a request completes after being mirrored while pending", async () => {
        executeInApp.mockResolvedValue(payload([{ ...netEntry("n1"), completed: false, status: undefined }], []));
        await mirrorOnce("dev");
        expect(getNetworkBuffer("dev").get("n1")?.completed).toBe(false);

        executeInApp.mockResolvedValue(payload([{ ...netEntry("n1"), responseBody: '{"ok":true}' }], []));
        const second = await mirrorOnce("dev");

        expect(second.network).toBe(1);
        const stored = getNetworkBuffer("dev").get("n1");
        expect(stored?.completed).toBe(true);
        expect(stored?.status).toBe(200);
        expect(stored?.responseBody).toBe('{"ok":true}');
        // Updated in place, not duplicated as a second row.
        expect(getNetworkBuffer("dev").size).toBe(1);
    });

    it("latches a completed entry so steady-state polls stay no-ops", async () => {
        // The re-read above must not become an unconditional re-copy: that
        // would undo the idempotence the seen-set exists for.
        executeInApp.mockResolvedValue(payload([netEntry("n1")], []));
        await mirrorOnce("dev");
        expect((await mirrorOnce("dev")).network).toBe(0);
        expect((await mirrorOnce("dev")).network).toBe(0);
    });

    it("keeps re-reading an entry that stays pending across many polls", async () => {
        executeInApp.mockResolvedValue(payload([{ ...netEntry("n1"), completed: false, status: undefined }], []));
        await mirrorOnce("dev");
        // Still in flight two polls later — must remain readable, or its
        // eventual completion is lost the same way.
        expect((await mirrorOnce("dev")).network).toBe(1);
        expect((await mirrorOnce("dev")).network).toBe(1);
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

    it("bumps the epoch when the runtime nonce changes", async () => {
        // The only reliable restart signal: Metro's inspector proxy reuses the
        // CDP target id after a process kill, and a dead runtime emits no
        // executionContextsCleared. A fresh globalThis is direct proof.
        executeInApp.mockResolvedValue(payload([netEntry("n1")], [], "run-1"));
        await mirrorOnce("dev");
        expect(getEpoch("dev")).toBe(1);

        // Same SDK id, new runtime: must land as a distinct entry, not overwrite.
        executeInApp.mockResolvedValue(payload([netEntry("n1")], [], "run-2"));
        const afterRestart = await mirrorOnce("dev");
        expect(getEpoch("dev")).toBe(2);
        expect(afterRestart).toEqual({ logs: 0, network: 1 });
        expect(getNetworkBuffer("dev").size).toBe(2);
    });

    it("does not bump while the runtime nonce is stable", async () => {
        executeInApp.mockResolvedValue(payload([netEntry("n1")], [], "run-1"));
        await mirrorOnce("dev");
        await mirrorOnce("dev");
        await mirrorOnce("dev");
        expect(getEpoch("dev")).toBe(1);
    });

    it("mirrors into the connected device's buffer key, not the caller's substring", async () => {
        // Tools pass a user-facing substring ("iPhone"); the buffer key is the
        // full device name. Using the substring as the key mirrors into a
        // phantom buffer that device-scoped reads never resolve to, so the
        // SDK data silently goes missing for exactly those calls.
        connectedApps.set("8081-abc", {
            ws: {} as any,
            deviceInfo: { deviceName: "iPhone 17 Pro", title: "app", id: "abc" } as any,
            port: 8081,
            platform: "ios",
        });
        try {
            executeInApp.mockResolvedValue(payload([netEntry("n1")], [logEntry("c1", "hi")]));
            await mirrorOnce("iPhone");

            expect(getNetworkBuffer("iPhone 17 Pro").size).toBe(1);
            expect(getLogBuffer("iPhone 17 Pro").size).toBe(1);
            expect(logBuffers.has("iPhone")).toBe(false);
            expect(networkBuffers.has("iPhone")).toBe(false);
        } finally {
            connectedApps.delete("8081-abc");
            getNetworkBuffer("iPhone 17 Pro").clear();
            getLogBuffer("iPhone 17 Pro").clear();
        }
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
