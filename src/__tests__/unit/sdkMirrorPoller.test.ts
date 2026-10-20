import { jest } from "@jest/globals";

const executeInApp = jest.fn<any>();
jest.unstable_mockModule("../../core/executor.js", () => ({ executeInApp }));

const { mirrorOnce, __resetMirrorState, markCdpConsoleOpen, markCdpConsoleSeen, markCdpConsoleClosed, startSdkMirrorPoller, isSdkMirrorPollerRunning, ACTIVE_INTERVAL_MS, IDLE_INTERVAL_MS } = await import("../../core/sdkMirrorPoller.js");
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

    it("counts a restart CDP already bumped for only once", async () => {
        executeInApp.mockResolvedValue(payload([netEntry("n1")], [], "run-1"));
        await mirrorOnce("dev");
        bumpEpoch("dev"); // executionContextsCleared on reload_app
        executeInApp.mockResolvedValue(payload([netEntry("n1")], [], "run-2"));
        await mirrorOnce("dev");
        expect(getEpoch("dev")).toBe(2);
    });

    it("pairs an SDK entry with the mocked interceptor row for the same call, once", async () => {
        const ts = Date.now();
        const body = '{"operationName":"GetLicenseInfo"}';
        getNetworkBuffer("dev").set("js-1", {
            requestId: "js-1", timestamp: new Date(ts), method: "POST", url: "https://api.test/graphql",
            headers: {}, postData: body, completed: true, epoch: 1, capturedBy: "interceptor", mocked: true, mockId: "m1",
        });
        const sdk = (id: string, b: string) => ({ ...netEntry(id), timestamp: ts + 5, method: "POST", url: "https://api.test/graphql", requestBody: b });
        executeInApp.mockResolvedValue(payload([sdk("s1", body), sdk("s2", body), sdk("s3", '{"operationName":"GetUser"}')], []));
        const result = await mirrorOnce("dev");
        expect(result.network).toBe(2);
        expect(getNetworkBuffer("dev").getAll().map((r) => r.requestId).sort()).toEqual(["js-1", "s2", "s3"]);
        // A later poll does not resurrect the absorbed copy.
        expect((await mirrorOnce("dev")).network).toBe(0);
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

    // `failed` is what lets the poller tell a dead target from a quiet app —
    // both used to return a bare {logs:0, network:0}.
    it("reports a failed eval as a transport failure", async () => {
        executeInApp.mockResolvedValue({ success: false, error: "disconnected" });
        expect(await mirrorOnce("dev")).toEqual({ logs: 0, network: 0, failed: true });
    });

    // Garbage came back over a working socket: not a transport failure, so it
    // must not push the poller toward giving up.
    it("returns zeroes on malformed JSON without flagging a failure", async () => {
        executeInApp.mockResolvedValue({ success: true, result: "not json" });
        expect(await mirrorOnce("dev")).toEqual({ logs: 0, network: 0 });
    });

    it("swallows a thrown eval and reports it as a failure", async () => {
        executeInApp.mockRejectedValue(new Error("boom"));
        expect(await mirrorOnce("dev")).toEqual({ logs: 0, network: 0, failed: true });
    });
});

// Reproduced on a live iPhone Air simulator, 2026-10-14: with execbro-sdk on,
// 5 console calls produced 10 entries, one copy from Runtime.consoleAPICalled
// and one from this mirror. The mirror now skips SDK lines that fall inside a
// period when CDP was delivering console events.
describe("mirrorOnce console dedupe against CDP", () => {
    const T = 1_800_000_000_000;
    const at = (id: string, message: string, timestamp: number) => ({ id, timestamp, level: "log", message });
    const messages = () => getLogBuffer("dev").getAll().map((l) => l.message);
    const mirror = (console_: any[], now?: number) => {
        executeInApp.mockResolvedValue({ success: true, result: JSON.stringify({ runId: "run-1", now, network: [], console: console_ }) });
        return mirrorOnce("dev");
    };

    beforeEach(() => {
        executeInApp.mockReset();
        __resetMirrorState();
        __resetLogSeq();
        resetEpochs();
        getLogBuffer("dev").clear();
    });

    it("skips lines CDP already delivered and keeps pre-connect history", async () => {
        markCdpConsoleOpen("dev", T);
        markCdpConsoleSeen("dev");
        const result = await mirror([at("c1", "launch", T - 5000), at("c2", "live", T + 100)]);
        expect(result.logs).toBe(1);
        expect(messages()).toEqual(["launch"]);
    });

    it("keeps every repeat of an identical pre-connect line and drops every live one", async () => {
        markCdpConsoleOpen("dev", T);
        markCdpConsoleSeen("dev");
        await mirror([at("c1", "burst", T - 10), at("c2", "burst", T - 10), at("c3", "burst", T + 10), at("c4", "burst", T + 10)]);
        expect(messages()).toEqual(["burst", "burst"]);
    });

    // A socket whose console subscription is broken delivers nothing, so the
    // SDK copy is the only one and must stay.
    it("keeps lines while no CDP console event has arrived on the socket", async () => {
        markCdpConsoleOpen("dev", T);
        await mirror([at("c1", "only-sdk", T + 100)]);
        expect(messages()).toEqual(["only-sdk"]);
    });

    it("keeps lines logged in a reconnect gap and skips both live periods", async () => {
        markCdpConsoleOpen("dev", T);
        markCdpConsoleSeen("dev");
        markCdpConsoleClosed("dev", T + 1000);
        markCdpConsoleOpen("dev", T + 5000);
        markCdpConsoleSeen("dev");
        await mirror([at("c1", "first", T + 500), at("c2", "gap", T + 2000), at("c3", "second", T + 6000)]);
        expect(messages()).toEqual(["gap"]);
    });

    it("ends a superseded period when a new socket opens without a close", async () => {
        markCdpConsoleOpen("dev", T);
        markCdpConsoleOpen("dev", T + 5000);
        markCdpConsoleSeen("dev");
        await mirror([at("c1", "unarmed-period", T + 100), at("c2", "live", T + 6000)]);
        expect(messages()).toEqual(["unarmed-period"]);
    });

    // A phone or emulator clock can be far off the host's; the SDK stamps
    // lines on the device clock.
    it("maps device timestamps onto the server clock", async () => {
        const skew = 3_600_000; // device runs an hour ahead
        const now = Date.now();
        markCdpConsoleOpen("dev", now - 2000);
        markCdpConsoleSeen("dev");
        await mirror([at("c1", "before", now - 5000 + skew), at("c2", "live", now - 1000 + skew)], now + skew);
        expect(messages()).toEqual(["before"]);
    });
});

/**
 * The poller rescheduled forever no matter what came back. One unattended
 * install produced 2093 of the 2233 `_auto_reconnect` failures in a single
 * production week by polling a shut-down simulator every 3-10s from 19:23 to
 * 07:55 — nothing in the loop could ever conclude the target was gone.
 */
describe("startSdkMirrorPoller give-up", () => {
    const failedPoll = { success: false, error: "disconnected" };
    let errorSpy: any;

    beforeEach(() => {
        executeInApp.mockReset();
        __resetMirrorState();
        __resetLogSeq();
        resetEpochs();
        getLogBuffer("dev").clear();
        getNetworkBuffer("dev").clear();
        errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        jest.useFakeTimers();
    });

    afterEach(() => {
        __resetMirrorState();
        jest.useRealTimers();
        errorSpy.mockRestore();
    });

    it("stops the timer after five consecutive transport failures", async () => {
        executeInApp.mockResolvedValue(failedPoll);
        startSdkMirrorPoller("dev");

        await jest.advanceTimersByTimeAsync(ACTIVE_INTERVAL_MS);
        for (let i = 0; i < 3; i++) await jest.advanceTimersByTimeAsync(IDLE_INTERVAL_MS);
        expect(isSdkMirrorPollerRunning("dev")).toBe(true);
        expect(executeInApp).toHaveBeenCalledTimes(4);

        await jest.advanceTimersByTimeAsync(IDLE_INTERVAL_MS);
        expect(isSdkMirrorPollerRunning("dev")).toBe(false);
        expect(errorSpy.mock.calls.some((c: any[]) => String(c[0]).includes("SDK mirror poller stopped for dev"))).toBe(true);

        // And it really is stopped: no further polls, however long we wait.
        await jest.advanceTimersByTimeAsync(IDLE_INTERVAL_MS * 10);
        expect(executeInApp).toHaveBeenCalledTimes(5);
    });

    it("resets the counter on any poll that reaches the app", async () => {
        executeInApp
            .mockResolvedValueOnce(failedPoll)
            .mockResolvedValueOnce(failedPoll)
            .mockResolvedValueOnce(failedPoll)
            .mockResolvedValueOnce(failedPoll)
            .mockResolvedValueOnce(payload([netEntry("n1")], []))
            .mockResolvedValue(failedPoll);
        startSdkMirrorPoller("dev");

        await jest.advanceTimersByTimeAsync(ACTIVE_INTERVAL_MS);
        for (let i = 0; i < 4; i++) await jest.advanceTimersByTimeAsync(IDLE_INTERVAL_MS);
        // Poll 5 mirrored an entry, so the poller went back to the active cadence.
        expect(executeInApp).toHaveBeenCalledTimes(5);
        expect(isSdkMirrorPollerRunning("dev")).toBe(true);

        await jest.advanceTimersByTimeAsync(ACTIVE_INTERVAL_MS);
        await jest.advanceTimersByTimeAsync(IDLE_INTERVAL_MS);
        // Without the reset these would have been failures 5 and 6 and the
        // poller would already be stopped.
        expect(executeInApp).toHaveBeenCalledTimes(7);
        expect(isSdkMirrorPollerRunning("dev")).toBe(true);
    });
});
