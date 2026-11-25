import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { RawLogLine } from "../../core/logEvents.js";
import type { LogTarget } from "../../core/nativeLogs.js";

// Every device CLI behind the backfill is mocked: unit tests never reach a
// simulator, emulator or phone.
const isSDKInstalledMock = jest.fn<(device?: string) => Promise<boolean>>();
const resolveLogTargetsMock = jest.fn<(device?: string) => Promise<LogTarget[]>>();
const fetchIosLinesMock = jest.fn<(opts: Record<string, unknown>) => Promise<RawLogLine[]>>();
const resolveIosProcessNameMock = jest.fn<(udid: string, bundleId: string) => Promise<string | undefined>>();
const fetchAndroidLinesMock = jest.fn<(opts: Record<string, unknown>) => Promise<RawLogLine[]>>();
const resolveAndroidPidMock = jest.fn<(pkg: string, serial?: string) => Promise<number | undefined>>();

jest.unstable_mockModule("../../core/sdkBridge.js", () => ({ isSDKInstalled: isSDKInstalledMock }));
jest.unstable_mockModule("../../core/nativeLogs.js", () => ({ resolveLogTargets: resolveLogTargetsMock }));
jest.unstable_mockModule("../../core/logSourceIos.js", () => ({
    fetchIosLines: fetchIosLinesMock,
    resolveIosProcessName: resolveIosProcessNameMock,
}));
jest.unstable_mockModule("../../core/logSourceAndroid.js", () => ({
    fetchAndroidLines: fetchAndroidLinesMock,
    resolveAndroidPid: resolveAndroidPidMock,
}));

const { selectBackfillLines, startColdStartBackfill, awaitColdStartBackfill } = await import("../../core/coldStartBackfill.js");
const { markCdpConsoleOpen, markCdpConsoleClosed, previousCdpConsoleEnd, __resetMirrorState } = await import("../../core/sdkMirrorPoller.js");
const { getLogBuffer, logBuffers, resetEpochs, connectedApps } = await import("../../core/state.js");
import type { ConnectedApp } from "../../core/types.js";

// What the connect-time SDK probe loop leaves on the registry entry.
function registerApp(sdkPresent: boolean | undefined): void {
    connectedApps.set("8081-t1", { deviceInfo: { deviceName: "iPhone 17" }, platform: "ios", sdkPresent } as unknown as ConnectedApp);
}

// In the past: a read cuts at its own start when no live line exists.
const at = (s: number) => new Date(2026, 0, 5, 12, 0, s);
const line = (s: number, message: string, pid = 100, tid = 1): RawLogLine => ({
    ts: at(s), level: "info", pid, tid, tag: "com.facebook.react.log:javascript", message, raw: message,
});
const messages = (lines: RawLogLine[]) => lines.map((l) => l.message);

describe("selectBackfillLines", () => {
    it("keeps the current run: from the last Running line, before attach", () => {
        const out = selectBackfillLines(
            [line(1, "old run"), line(2, 'Running "App" with {}'), line(3, "mounted"), line(5, "after attach")],
            { until: at(4), platform: "ios" }
        );
        expect(messages(out)).toEqual(['Running "App" with {}', "mounted"]);
    });

    it("keeps only the latest process", () => {
        const out = selectBackfillLines(
            [line(1, 'Running "App"', 90), line(2, "dead", 90), line(3, 'Running "App"', 100), line(4, "live", 100)],
            { until: at(5), platform: "ios" }
        );
        expect(out.map((l) => l.pid)).toEqual([100, 100]);
    });

    it("keeps the latest process even when it never printed a Running line", () => {
        const out = selectBackfillLines([line(1, "dead", 90), line(2, "live", 100)], { until: at(5), platform: "ios" });
        expect(messages(out)).toEqual(["live"]);
    });

    it("notBefore drops what a previous connection already saw", () => {
        const out = selectBackfillLines([line(1, "seen"), line(3, "gap")], { until: at(4), notBefore: at(2), platform: "ios" });
        expect(messages(out)).toEqual(["gap"]);
    });

    it("joins Android continuation lines into one entry, not on iOS", () => {
        const split = [line(1, "Error: boom"), line(1, "    at foo")];
        expect(messages(selectBackfillLines(split, { until: at(2), platform: "android" }))).toEqual(["Error: boom\n    at foo"]);
        expect(selectBackfillLines(split, { until: at(2), platform: "ios" })).toHaveLength(2);
    });
});

describe("previousCdpConsoleEnd", () => {
    beforeEach(() => __resetMirrorState());

    it("is the end of the window before the latest one", () => {
        markCdpConsoleOpen("d", 1000);
        expect(previousCdpConsoleEnd("d")).toBeUndefined();
        markCdpConsoleClosed("d", 2000);
        markCdpConsoleOpen("d", 3000);
        expect(previousCdpConsoleEnd("d")).toBe(2000);
    });
});

describe("startColdStartBackfill", () => {
    const IOS_TARGET: LogTarget = {
        deviceKey: "U", deviceName: "iPhone 17", platform: "ios",
        identity: { deviceKey: "U", platform: "ios", appId: "org.x.App" },
        identitySource: "live",
    };

    beforeEach(() => {
        jest.clearAllMocks();
        __resetMirrorState();
        logBuffers.clear();
        resetEpochs();
        connectedApps.clear();
        isSDKInstalledMock.mockResolvedValue(false);
        resolveLogTargetsMock.mockResolvedValue([IOS_TARGET]);
        resolveIosProcessNameMock.mockResolvedValue("App");
        fetchIosLinesMock.mockResolvedValue([line(2, 'Running "App" with {}'), line(3, "mounted"), { ...line(0, "after the read"), ts: new Date(Date.now() + 60_000) }]);
    });

    it("iOS: reads the JS mirror of the app's process and inserts it", async () => {
        startColdStartBackfill("iPhone 17", at(10));
        await awaitColdStartBackfill("iPhone 17");
        expect(fetchIosLinesMock).toHaveBeenCalledWith(expect.objectContaining({ udid: "U", processName: "App", jsMirror: true }));
        expect(getLogBuffer("iPhone 17").getAll().map((e) => [e.message, e.origin])).toEqual([
            ['Running "App" with {}', "systemLog"],
            ["mounted", "systemLog"],
        ]);
    });

    it("Android: reads ReactNativeJS of the live pid", async () => {
        resolveLogTargetsMock.mockResolvedValue([{
            deviceKey: "emulator-5554", deviceName: "sdk_gphone - 16 - API 36", platform: "android", adbSerial: "emulator-5554",
            identity: { deviceKey: "emulator-5554", platform: "android", appId: "com.x.app" }, identitySource: "live",
        }]);
        resolveAndroidPidMock.mockResolvedValue(4242);
        fetchAndroidLinesMock.mockResolvedValue([line(3, "mounted", 4242)]);
        startColdStartBackfill("sdk_gphone - 16 - API 36", at(10));
        await awaitColdStartBackfill("sdk_gphone");
        expect(fetchAndroidLinesMock).toHaveBeenCalledWith(expect.objectContaining({ serial: "emulator-5554", pid: 4242, tags: ["ReactNativeJS"] }));
        expect(getLogBuffer("sdk_gphone - 16 - API 36").getAll().map((e) => e.message)).toEqual(["mounted"]);
    });

    it("starts the read no earlier than the previous connection's end", async () => {
        markCdpConsoleOpen("iPhone 17", at(5).getTime());
        markCdpConsoleClosed("iPhone 17", at(8).getTime());
        markCdpConsoleOpen("iPhone 17", at(10).getTime());
        startColdStartBackfill("iPhone 17", at(10));
        await awaitColdStartBackfill("iPhone 17");
        expect(fetchIosLinesMock).toHaveBeenCalledWith(expect.objectContaining({ sinceTs: at(8) }));
        expect(getLogBuffer("iPhone 17").getAll()).toEqual([]);
    });

    it("keeps lines logged after attach until the first live CDP line", async () => {
        // Seen on device: a line logged between the attach and Runtime.enable taking effect
        // reached neither source when the cut was the attach moment.
        const ms = (s: number) => new Date(at(0).getTime() + s * 1000);
        fetchIosLinesMock.mockImplementation(async () => {
            getLogBuffer("iPhone 17").add({ timestamp: ms(10.8), level: "log", message: "first live" });
            return [line(9, "before attach"), { ...line(10, "in the gap"), ts: ms(10.3) }, line(12, "after first live")];
        });
        startColdStartBackfill("iPhone 17", at(10));
        await awaitColdStartBackfill("iPhone 17");
        expect(getLogBuffer("iPhone 17").getAll().map((e) => e.message)).toEqual(["before attach", "in the gap", "first live"]);
    });

    it("without a live line yet, cuts at the moment the read starts", async () => {
        const now = Date.now();
        fetchIosLinesMock.mockResolvedValue([
            { ...line(0, "logged before the read"), ts: new Date(now - 1000) },
            { ...line(0, "from the future"), ts: new Date(now + 60_000) },
        ]);
        startColdStartBackfill("iPhone 17", new Date(now - 10_000));
        await awaitColdStartBackfill("iPhone 17");
        expect(getLogBuffer("iPhone 17").getAll().map((e) => e.message)).toEqual(["logged before the read"]);
    });

    it("skips when the connect-time probe found the SDK", async () => {
        registerApp(true);
        startColdStartBackfill("iPhone 17", at(10));
        await awaitColdStartBackfill("iPhone 17");
        expect(fetchIosLinesMock).not.toHaveBeenCalled();
    });

    it("waits for the probe's answer before deciding", async () => {
        registerApp(undefined);
        startColdStartBackfill("iPhone 17", at(10));
        setTimeout(() => registerApp(true), 150);
        await awaitColdStartBackfill("iPhone 17", 3000);
        expect(fetchIosLinesMock).not.toHaveBeenCalled();
    });

    it("reads when the probe found no SDK", async () => {
        registerApp(false);
        startColdStartBackfill("iPhone 17", at(10));
        await awaitColdStartBackfill("iPhone 17");
        expect(fetchIosLinesMock).toHaveBeenCalled();
    });

    it("never evaluates in the app to look for the SDK", async () => {
        // isSDKInstalled falls back to executeInApp, whose reconnect path scans
        // Metro: a background job must not trigger that.
        startColdStartBackfill("iPhone 17", at(10));
        await awaitColdStartBackfill("iPhone 17");
        expect(isSDKInstalledMock).not.toHaveBeenCalled();
    });

    it("skips without a live identity", async () => {
        resolveLogTargetsMock.mockResolvedValue([{ ...IOS_TARGET, identitySource: "memory" }]);
        startColdStartBackfill("iPhone 17", at(10));
        await awaitColdStartBackfill("iPhone 17");
        expect(fetchIosLinesMock).not.toHaveBeenCalled();
    });

    it("a read failure is swallowed", async () => {
        fetchIosLinesMock.mockRejectedValue(new Error("log show timed out"));
        startColdStartBackfill("iPhone 17", at(10));
        await expect(awaitColdStartBackfill("iPhone 17")).resolves.toBeUndefined();
    });

    it("awaitColdStartBackfill gives up after maxWaitMs", async () => {
        fetchIosLinesMock.mockReturnValue(new Promise(() => {}));
        startColdStartBackfill("iPhone 17", at(10));
        const started = Date.now();
        await awaitColdStartBackfill("iPhone 17", 50);
        expect(Date.now() - started).toBeLessThan(500);
    });
});
