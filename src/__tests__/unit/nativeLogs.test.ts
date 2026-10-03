import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { AppIdentity, RawLogLine } from "../../core/logEvents.js";
import type { DeviceMemoryEntry, RecordDeviceInput } from "../../core/projectMemory.js";
import type { ConnectedApp } from "../../core/types.js";
import type { ListAllDevicesResult } from "../../core/deviceDiscovery.js";

const listDevicesMock = jest.fn<() => DeviceMemoryEntry[]>();
const recordDeviceMock = jest.fn<(input: RecordDeviceInput) => void>();
jest.unstable_mockModule("../../core/projectMemory.js", () => ({
    listDevices: listDevicesMock,
    recordDevice: recordDeviceMock,
    recordScreenMetrics: jest.fn(),
}));

const connectedAppsMock = new Map<string, ConnectedApp>();
jest.unstable_mockModule("../../core/state.js", () => ({
    connectedApps: connectedAppsMock,
}));

const listAllDevicesMock = jest.fn<() => Promise<ListAllDevicesResult>>();
jest.unstable_mockModule("../../core/deviceDiscovery.js", () => ({
    listAllDevices: listAllDevicesMock,
}));

const execAsyncMock = jest.fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>>();
jest.unstable_mockModule("../../core/exec.js", () => ({
    execFileAsync: execAsyncMock,
    quoteForDeviceShell: (v: string) => `'${v.replace(/'/g, `'"'"'`)}'`,
    // logSourceAndroid.js / logSourceIos.js wrap their subprocess in this.
    // A passthrough keeps the timeout out of the way while letting the
    // collectNativeEvents tests below actually reach the mocked exec.
    withCancelableTimeout: (fn: (signal?: AbortSignal) => unknown) => fn(undefined),
}));

const { runNativePipeline, identityFromMemory, resolveLogTargets, collectNativeEvents } = await import("../../core/nativeLogs.js");
const { __resetIosProcessNameCache } = await import("../../core/logSourceIos.js");
const { __resetNativeLogBuffers } = await import("../../core/logEvents.js");

function emptyDiscovery(): ListAllDevicesResult {
    return {
        ios: { available: true, simulators: [] },
        android: { available: true, emulators: [], physical: [] },
        summary: { booted: 0, total: 0 },
    };
}

const APP: AppIdentity = {
    deviceKey: "emulator-5554",
    platform: "android",
    appId: "com.rndebuggertestapp",
    pid: 23325,
};

let clock = 0;
function line(over: Partial<RawLogLine>): RawLogLine {
    clock += 1;
    return {
        ts: new Date(Date.UTC(2026, 6, 29, 22, 11, 5, clock)),
        level: "info", pid: 23325, tid: 23325, tag: "X", message: "", raw: "x",
        ...over,
    };
}

/** Minimal DeviceMemoryEntry builder — only the fields the lookup reads matter. */
function memoryRow(over: Partial<DeviceMemoryEntry>): DeviceMemoryEntry {
    return {
        identifier: "emulator-5554",
        name: "Pixel",
        platform: "android",
        firstSeenAt: 0,
        lastUsedAt: 0,
        useCount: 1,
        ...over,
    };
}

describe("runNativePipeline", () => {
    beforeEach(() => {
        __resetNativeLogBuffers();
        listDevicesMock.mockReset();
        listDevicesMock.mockReturnValue([]);
    });

    it("drops foreign lines, noise, and keeps the crash", () => {
        const lines = [
            line({ pid: 998, tag: "MMKV", message: "open /data/data/com.rndebuggertestapp/files/mmkv" }),
            line({ pid: 23325, tag: "nativeloader", level: "debug", message: "Load librnscreens.so: ok" }),
            line({ pid: 22617, tid: 22617, tag: "DEBUG", level: "fatal", subject: "com.rndebuggertestapp", message: "Cmdline: com.rndebuggertestapp" }),
            line({ pid: 22617, tid: 22617, tag: "DEBUG", level: "fatal", message: "signal 6 (SIGABRT), code -1" }),
        ];
        const { events } = runNativePipeline(lines, APP, "Pixel", { minLevel: "warn" });
        expect(events).toHaveLength(1);
        expect(events[0].kind).toBe("crash");
        expect(events[0].id).toMatch(/^n\d+$/);
    });

    it("is idempotent across an inclusive refetch", () => {
        const lines = [
            line({ pid: 22617, tid: 22617, tag: "DEBUG", level: "fatal", subject: "com.rndebuggertestapp", message: "Cmdline: com.rndebuggertestapp" }),
        ];
        expect(runNativePipeline(lines, APP, "Pixel", { minLevel: "warn" }).events).toHaveLength(1);
        expect(runNativePipeline(lines, APP, "Pixel", { minLevel: "warn" }).events).toHaveLength(0);
    });

    it("keeps two devices sharing one appId separate", () => {
        const other: AppIdentity = { ...APP, deviceKey: "emulator-5556" };
        const mk = () => [line({ pid: 22617, tid: 22617, tag: "DEBUG", level: "fatal", subject: "com.rndebuggertestapp", message: "Cmdline: com.rndebuggertestapp" })];
        const a = runNativePipeline(mk(), APP, "Pixel A", { minLevel: "warn" });
        const b = runNativePipeline(mk(), other, "Pixel B", { minLevel: "warn" });
        expect(a.events).toHaveLength(1);
        expect(b.events).toHaveLength(1);          // NOT deduped against device A
        expect(a.events[0].id).not.toBe(b.events[0].id);
    });

    it("reports what the floor dropped when it leaves nothing", () => {
        // iOS os_log `Default` lands on level "log", which ranks below "info".
        // A caller asking for minLevel="info" therefore gets an empty result
        // that is indistinguishable from a silent device — the pipeline has to
        // say that it fetched something and the floor ate it.
        const lines = [
            line({ pid: 23325, tag: "default", level: "log", message: "Identity resolved as app<com.boardwise.app>" }),
            line({ pid: 23325, tag: "default", level: "log", message: "kExcludedFromBackupXattrName set on path: /HTTPStorages" }),
            line({ pid: 23325, tag: "nativeloader", level: "debug", message: "Load librnscreens.so: ok" }),
        ];
        const { events, belowFloor } = runNativePipeline(lines, APP, "iPad Air", { minLevel: "info" });
        expect(events).toEqual([]);
        // suggestedLevel is the HIGHEST dropped tier: the lowest floor that
        // still admits something, so following the hint cannot return nothing.
        expect(belowFloor).toEqual({ count: 3, suggestedLevel: "log" });
    });

    it("stays silent about the floor when events survived it", () => {
        const lines = [
            line({ pid: 23325, tag: "default", level: "log", message: "Identity resolved as app<com.boardwise.app>" }),
            line({ pid: 23325, tag: "X", level: "warn", message: "Something worth showing" }),
        ];
        const { events, belowFloor } = runNativePipeline(lines, APP, "iPad Air", { minLevel: "warn" });
        expect(events).toHaveLength(1);
        expect(belowFloor).toBeUndefined();
    });

    it("stays silent about the floor when the device produced nothing to drop", () => {
        // A genuinely quiet device must not be told to lower its floor —
        // that would send the caller chasing logs that do not exist.
        const { events, belowFloor } = runNativePipeline([], APP, "iPad Air", { minLevel: "info" });
        expect(events).toEqual([]);
        expect(belowFloor).toBeUndefined();
    });

    it("does not blame the floor for lines dropped by ownership", () => {
        // A foreign line never reached the floor; reporting it as filtered
        // would suggest a retry that returns exactly the same emptiness.
        const lines = [line({ pid: 998, tag: "MMKV", level: "log", message: "open /data/data/com.other.app/files/mmkv" })];
        const { events, belowFloor } = runNativePipeline(lines, APP, "iPad Air", { minLevel: "info" });
        expect(events).toEqual([]);
        expect(belowFloor).toBeUndefined();
    });
});

describe("collectNativeEvents — iOS os_log Default floor", () => {
    // The reported bug, end to end: os_log `Default` is the tier a plain
    // os_log() call emits, and every one of these records is dropped by
    // minLevel="info". The read then looks exactly like a silent device.
    const IOS_NDJSON = [
        { messageType: "Default", eventMessage: "Identity resolved as app<com.boardwise.app((null))>" },
        { messageType: "Default", eventMessage: "kExcludedFromBackupXattrName set on path: /HTTPStorages/com.boardwise.app" },
    ]
        .map((rec, i) => JSON.stringify({
            ...rec,
            timestamp: `2026-07-30 16:12:2${i}.000000+0000`,
            processID: 91219,
            threadID: 91219,
            subsystem: "",
            category: "",
        }))
        .join("\n");

    beforeEach(() => {
        __resetNativeLogBuffers();
        __resetIosProcessNameCache();
        listDevicesMock.mockReset();
        recordDeviceMock.mockReset();
        connectedAppsMock.clear();
        execAsyncMock.mockReset();
        listAllDevicesMock.mockReset();

        listAllDevicesMock.mockResolvedValue({
            ...emptyDiscovery(),
            ios: {
                available: true,
                simulators: [{ udid: "SIM-1", name: "iPad Air 13-inch (M3)", state: "booted" }],
            },
            summary: { booted: 1, total: 1 },
        } as ListAllDevicesResult);
        listDevicesMock.mockReturnValue([
            memoryRow({ identifier: "SIM-1", name: "iPad Air 13-inch (M3)", platform: "ios", appId: "com.boardwise.app" }),
        ]);
        execAsyncMock.mockImplementation(async (_file: string, args: string[]) => {
            if (args.includes("get_app_container")) return { stdout: "/x/Boardwise.app\n", stderr: "" };
            return { stdout: IOS_NDJSON, stderr: "" };
        });
    });

    it("tells the caller the floor hid everything, and which floor to retry with", async () => {
        const { events, notes } = await collectNativeEvents({ minLevel: "info" });

        expect(events).toEqual([]);
        expect(notes.join("\n")).toContain('2 events fetched, all below minLevel="info" — retry with minLevel="log"');
    });

    it("keeps the stale-identity warning alongside the floor hint", async () => {
        // Both notes describe a different reason the read could be empty;
        // dropping either one sends the caller down the wrong path.
        const { notes } = await collectNativeEvents({ minLevel: "info" });
        const joined = notes.join("\n");
        expect(joined).toContain("came from project memory");
        expect(joined).toContain("retry with minLevel=");
    });

    it("surfaces the floor verdict structurally, not only as prose", async () => {
        // get_logs has to label this empty read as a FILTER outcome rather
        // than a capture failure, and it cannot do that by parsing its own
        // note text.
        const { belowFloor } = await collectNativeEvents({ minLevel: "info" });
        expect(belowFloor).toEqual({ count: 2, suggestedLevel: "log" });
    });

    it("returns those same records once the floor is lowered to log", async () => {
        // Proves the suggestion is honest: following it actually yields events.
        const { events } = await collectNativeEvents({ minLevel: "log" });
        expect(events).toHaveLength(2);
        expect(events[0].title).toContain("Identity resolved");
    });
});

describe("identityFromMemory", () => {
    beforeEach(() => {
        listDevicesMock.mockReset();
    });

    it("finds a remembered appId keyed by device NAME, not just serial", () => {
        // projectMemory can hold two rows for one physical device: one keyed by
        // the adb serial (from one call path) with no appId, and one keyed by
        // the RN deviceName (from another) that carries it. Looking up by
        // serial alone made this fallback dead on Android.
        listDevicesMock.mockReturnValue([
            memoryRow({ identifier: "emulator-5554", appId: undefined }),
            memoryRow({
                identifier: "sdk_gphone16k_arm64 - 16 - API 36",
                name: "sdk_gphone16k_arm64 - 16 - API 36",
                appId: "com.gifted.production",
            }),
        ]);

        const identity = identityFromMemory(
            "emulator-5554",
            "android",
            "sdk_gphone16k_arm64 - 16 - API 36"
        );

        expect(identity).toEqual({
            deviceKey: "emulator-5554",
            platform: "android",
            appId: "com.gifted.production",
        });
    });

    it("ignores a matching row whose appId is undefined", () => {
        // The serial-keyed row exists but has no appId, and no deviceName is
        // supplied to fall back to — the empty row must not produce a false
        // "found" result.
        listDevicesMock.mockReturnValue([
            memoryRow({ identifier: "emulator-5554", appId: undefined }),
        ]);

        expect(identityFromMemory("emulator-5554", "android")).toBeUndefined();
    });
});

describe("resolveLogTargets", () => {
    beforeEach(() => {
        connectedAppsMock.clear();
        listAllDevicesMock.mockReset();
        recordDeviceMock.mockReset();
        listDevicesMock.mockReset();
        listDevicesMock.mockReturnValue([]);
        execAsyncMock.mockReset();
    });

    it("records live identity under the device key so it survives a later crash", async () => {
        // projectMemory's appId row is keyed by the RN deviceName on Android,
        // which nothing links back to the adb serial — so identity must be
        // written under the buffer key (the serial) while the app is still
        // alive, or the post-crash lookup in identityFromMemory has nothing
        // to find.
        const app = {
            deviceInfo: {
                deviceName: "sdk_gphone16k_arm64 - 16 - API 36",
                appId: "com.gifted.production",
            },
            platform: "android",
            adbSerial: "emulator-5554",
        } as unknown as ConnectedApp;
        connectedAppsMock.set("emulator-5554", app);

        listAllDevicesMock.mockResolvedValue({
            ...emptyDiscovery(),
            android: {
                available: true,
                // Discovery's own name for the row is the AVD name — a third,
                // unrelated value that also cannot bridge serial -> RN name.
                emulators: [{ name: "Pixel_9_-_16kb", serial: "emulator-5554", state: "running" }],
                physical: [],
            },
        });

        await resolveLogTargets();

        expect(recordDeviceMock).toHaveBeenCalledWith({
            identifier: "emulator-5554",
            name: "sdk_gphone16k_arm64 - 16 - API 36",
            platform: "android",
            appId: "com.gifted.production",
        });
    });

    it("matches an Android app with a null adbSerial via the model prefix", async () => {
        // ConnectedApp.adbSerial is frequently null (only set when
        // getAdbIdForAvd happens to match at connect time), so the
        // serial-keyed lookup in `connected` misses this app entirely. The
        // model-prefix fallback is what recovers live identity here.
        const app = {
            deviceInfo: {
                deviceName: "sdk_gphone16k_arm64 - 16 - API 36",
                appId: "com.rndebuggertestapp",
            },
            platform: "android",
            adbSerial: null,
        } as unknown as ConnectedApp;
        connectedAppsMock.set("some-registry-key", app);

        execAsyncMock.mockResolvedValue({ stdout: "sdk_gphone16k_arm64\n", stderr: "" });

        listAllDevicesMock.mockResolvedValue({
            ...emptyDiscovery(),
            android: {
                available: true,
                emulators: [{ name: "Pixel_9_-_16kb", serial: "emulator-5554", state: "running" }],
                physical: [],
            },
        });

        const targets = await resolveLogTargets();

        expect(execAsyncMock).toHaveBeenCalledWith("adb", [
            "-s",
            "emulator-5554",
            "shell",
            "getprop ro.product.model"
        ]);
        expect(targets).toHaveLength(1);
        expect(targets[0].identitySource).toBe("live");
        expect(targets[0].identity).toEqual({
            deviceKey: "emulator-5554",
            platform: "android",
            appId: "com.rndebuggertestapp",
        });
    });

    it("keeps the React Native app's identity when a native SDK app shares the device", async () => {
        // A native (execbro-sdk-android) app always carries adbSerial, so the
        // serial-keyed lookup would pick it over the RN app whose adbSerial is
        // null, and logcat would be attributed to the wrong package.
        const rn = {
            deviceInfo: { deviceName: "sdk_gphone16k_arm64 - 16 - API 36", appId: "com.rndebuggertestapp" },
            platform: "android",
            adbSerial: null,
        } as unknown as ConnectedApp;
        const native = {
            deviceInfo: { deviceName: "TouchDisabler", appId: "com.ihorzheludkov.touchdisabler" },
            platform: "android",
            adbSerial: "emulator-5554",
            runtime: "native",
            nativePackage: "com.ihorzheludkov.touchdisabler",
        } as unknown as ConnectedApp;
        connectedAppsMock.set("native:emulator-5554:com.ihorzheludkov.touchdisabler", native);
        connectedAppsMock.set("rn-key", rn);

        execAsyncMock.mockResolvedValue({ stdout: "sdk_gphone16k_arm64\n", stderr: "" });
        listAllDevicesMock.mockResolvedValue({
            ...emptyDiscovery(),
            android: {
                available: true,
                emulators: [{ name: "Pixel_9_-_16kb", serial: "emulator-5554", state: "running" }],
                physical: [],
            },
        });

        const targets = await resolveLogTargets();

        expect(targets).toHaveLength(1);
        expect(targets[0].identity?.appId).toBe("com.rndebuggertestapp");
    });

    it("yields no live identity when the model does not match any connected app", async () => {
        const app = {
            deviceInfo: {
                deviceName: "some_other_device - 14 - API 34",
                appId: "com.someother.app",
            },
            platform: "android",
            adbSerial: null,
        } as unknown as ConnectedApp;
        connectedAppsMock.set("some-registry-key", app);

        execAsyncMock.mockResolvedValue({ stdout: "sdk_gphone16k_arm64\n", stderr: "" });

        listAllDevicesMock.mockResolvedValue({
            ...emptyDiscovery(),
            android: {
                available: true,
                emulators: [{ name: "Pixel_9_-_16kb", serial: "emulator-5554", state: "running" }],
                physical: [],
            },
        });

        const targets = await resolveLogTargets();

        expect(targets).toHaveLength(1);
        expect(targets[0].identitySource).not.toBe("live");
        expect(targets[0].identity).toBeUndefined();
    });
});
