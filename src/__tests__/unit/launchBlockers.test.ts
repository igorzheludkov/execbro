import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { RawLogLine } from "../../core/logEvents.js";

// Every device CLI behind the check is mocked: unit tests never reach a device.
const execMock = jest.fn<(file: string, args: string[], opts?: unknown) => Promise<{ stdout: string; stderr: string }>>();
const fetchAndroidLinesMock = jest.fn<(opts: Record<string, unknown>) => Promise<RawLogLine[]>>();
const resolveAndroidPidMock = jest.fn<(pkg: string, serial?: string, signal?: AbortSignal) => Promise<number | undefined>>();
const fetchIosLinesMock = jest.fn<(opts: Record<string, unknown>) => Promise<RawLogLine[]>>();
const resolveIosProcessNameMock = jest.fn<(udid: string, bundleId: string, signal?: AbortSignal) => Promise<string | undefined>>();
const androidForegroundPackageMock = jest.fn<(id?: string) => Promise<string | null>>();

jest.unstable_mockModule("../../core/exec.js", () => ({
    execFileAsync: execMock,
    quoteForDeviceShell: (v: string) => v,
    withCancelableTimeout: <T,>(make: (signal: AbortSignal) => Promise<T>) => make(new AbortController().signal),
}));
jest.unstable_mockModule("../../core/logSourceAndroid.js", () => ({
    fetchAndroidLines: fetchAndroidLinesMock,
    resolveAndroidPid: resolveAndroidPidMock,
}));
jest.unstable_mockModule("../../core/logSourceIos.js", () => ({
    fetchIosLines: fetchIosLinesMock,
    resolveIosProcessName: resolveIosProcessNameMock,
}));
jest.unstable_mockModule("../../core/androidForeground.js", () => ({
    androidForegroundPackage: androidForegroundPackageMock,
}));

const { androidScreenState, bundleFailureIn, metroUrlsTried, iosAppPid, launchBlocker, blockerWatch, LOOKBACK_MS } =
    await import("../../core/launchBlockers.js");

const raw = (message: string, tag = "unknown:ReactNative", level: RawLogLine["level"] = "error"): RawLogLine => ({
    ts: new Date(), level, pid: 7243, tag, message, raw: message,
});

// Verbatim from the devices, 2026-11-26.
const POWER_ASLEEP = "  mWakefulness=Asleep\n";
const POWER_AWAKE = "  mWakefulness=Awake\n";
const WINDOW_LOCKED = "    mShowingDream=false mDreamingLockscreen=true\n    isKeyguardShowing=true\n";
const WINDOW_OPEN = "    mShowingDream=false mDreamingLockscreen=false\n    isKeyguardShowing=false\n";
const ANDROID_FAILURE = "ReactHost{0}.raiseSoftException(getOrCreateDestroyTask()): Destroy: ReactInstance task faulted. Stage: 1: Starting destroy. Fault reason: Unable to load script.";
const IOS_FAILURE = "No script URL provided. Make sure the packager is running or you have embedded a JS bundle in your application bundle.";
const IOS_CFNETWORK = 'Task <ED6AEE0D>.<1> finished with error [-1004] Error Domain=NSURLErrorDomain Code=-1004 "Could not connect to the server." UserInfo={NSErrorFailingURLStringKey=http://localhost:8090/status, NSErrorFailingURLKey=http://localhost:8090/status}';

describe("androidScreenState", () => {
    it("reads a sleeping screen", () => {
        expect(androidScreenState(POWER_ASLEEP + WINDOW_LOCKED)).toBe("asleep");
    });
    it("reads an awake but locked screen", () => {
        expect(androidScreenState(POWER_AWAKE + WINDOW_LOCKED)).toBe("locked");
    });
    it("reads an awake, unlocked screen as no blocker", () => {
        expect(androidScreenState(POWER_AWAKE + WINDOW_OPEN)).toBeNull();
    });
    it("reads nothing from an empty answer", () => {
        expect(androidScreenState("")).toBeNull();
    });
});

describe("bundleFailureIn", () => {
    it("finds the Android failure", () => {
        // Quoted as RN's sentence only: the logcat line around it is a stack of ReactHost internals.
        expect(bundleFailureIn([raw("some other error"), raw(`BridgelessReact: ${ANDROID_FAILURE}`, "unknown")])).toBe("Unable to load script.");
    });
    it("finds the iOS failure", () => {
        expect(bundleFailureIn([raw(IOS_FAILURE, "com.facebook.react.log:native")])).toBe("No script URL provided.");
    });
    it("finds nothing in ordinary errors", () => {
        expect(bundleFailureIn([raw("nw_socket_handle_socket_event Socket SO_ERROR [61: Connection refused]")])).toBeUndefined();
    });
});

describe("iosAppPid", () => {
    it("reads the app's pid from launchctl list", () => {
        const list = "91000\t0\tUIKitApplication:com.other.App[aa11][rb-legacy]\n91114\t0\tUIKitApplication:org.reactjs.native.example.RnDebuggerTestApp[b3f7][rb-legacy]\n";
        expect(iosAppPid(list, "org.reactjs.native.example.RnDebuggerTestApp")).toBe(91114);
    });
    it("is undefined when the app is not running", () => {
        expect(iosAppPid("-\t0\tUIKitApplication:org.x.App[b3f7][rb-legacy]\n", "org.x.App")).toBeUndefined();
    });
});

describe("metroUrlsTried", () => {
    it("names each status URL the app tried, once", () => {
        const lines = [raw(IOS_CFNETWORK, "com.apple.CFNetwork:Default"), raw(IOS_CFNETWORK.replace(/8090/g, "8081"), "com.apple.CFNetwork:Default"), raw(IOS_CFNETWORK, "com.apple.CFNetwork:Default")];
        expect(metroUrlsTried(lines)).toEqual(["http://localhost:8090/status", "http://localhost:8081/status"]);
    });
});

describe("launchBlocker", () => {
    const ANDROID = { platform: "android" as const, id: "emulator-5554", appId: "com.rndebuggertestapp", label: "emulator-5554", launchedAt: Date.now() - 10_000 };
    const IOS = { platform: "ios" as const, id: "F936", appId: "org.x.RnDebuggerTestApp", label: "F936", launchedAt: Date.now() - 10_000 };

    beforeEach(() => {
        jest.clearAllMocks();
        execMock.mockImplementation(async (_f, args) => {
            const cmd = args.join(" ");
            if (cmd.includes("reverse")) return { stdout: "host-15 tcp:8081 tcp:8090\n", stderr: "" };
            if (cmd.includes("launchctl")) return { stdout: "7243\t0\tUIKitApplication:org.x.RnDebuggerTestApp[b3f7][rb-legacy]\n", stderr: "" };
            return { stdout: POWER_AWAKE + WINDOW_OPEN, stderr: "" };
        });
        resolveAndroidPidMock.mockResolvedValue(7243);
        fetchAndroidLinesMock.mockResolvedValue([]);
        androidForegroundPackageMock.mockResolvedValue("com.rndebuggertestapp");
        resolveIosProcessNameMock.mockResolvedValue("RnDebuggerTestApp");
        fetchIosLinesMock.mockResolvedValue([]);
    });

    it("Android: a sleeping screen is named with the way to wake it", async () => {
        execMock.mockResolvedValue({ stdout: POWER_ASLEEP + WINDOW_LOCKED, stderr: "" });
        const msg = await launchBlocker(ANDROID);
        expect(msg).toMatch(/screen.*off/i);
        expect(msg).toContain("KEYCODE_WAKEUP");
        expect(fetchAndroidLinesMock).not.toHaveBeenCalled();
    });

    it("Android: a locked screen is named with the way to unlock it", async () => {
        execMock.mockResolvedValue({ stdout: POWER_AWAKE + WINDOW_LOCKED, stderr: "" });
        expect(await launchBlocker(ANDROID)).toContain("dismiss-keyguard");
    });

    it("Android: a bundle failure is quoted, with the adb reverse table", async () => {
        fetchAndroidLinesMock.mockResolvedValue([raw(ANDROID_FAILURE, "unknown:ReactHost")]);
        const msg = await launchBlocker(ANDROID);
        expect(msg).toContain("Unable to load script");
        expect(msg).toContain("tcp:8081 tcp:8090");
        // Looks back before the launch: launching an app already on its red box logs nothing new.
        expect(fetchAndroidLinesMock).toHaveBeenCalledWith(expect.objectContaining({ serial: "emulator-5554", pid: 7243, sinceTs: new Date(ANDROID.launchedAt - LOOKBACK_MS) }));
    });

    it("Android: another app in front is named", async () => {
        androidForegroundPackageMock.mockResolvedValue("com.google.android.apps.nexuslauncher");
        expect(await launchBlocker(ANDROID)).toContain("com.google.android.apps.nexuslauncher");
    });

    it("Android: the foreground is not judged in the first seconds of a launch", async () => {
        androidForegroundPackageMock.mockResolvedValue("com.google.android.apps.nexuslauncher");
        expect(await launchBlocker({ ...ANDROID, launchedAt: Date.now() - 1000 })).toBeNull();
    });

    it("Android: a healthy launch has no blocker", async () => {
        expect(await launchBlocker(ANDROID)).toBeNull();
    });

    it("Android: without a running process there is nothing to read", async () => {
        resolveAndroidPidMock.mockResolvedValue(undefined);
        expect(await launchBlocker(ANDROID)).toBeNull();
        expect(fetchAndroidLinesMock).not.toHaveBeenCalled();
    });

    it("iOS: a failure of an earlier process of the app is not this launch's", async () => {
        fetchIosLinesMock.mockResolvedValue([{ ...raw(IOS_FAILURE, "com.facebook.react.log:native"), pid: 80000 }]);
        expect(await launchBlocker(IOS)).toBeNull();
    });

    it("iOS: a bundle failure is quoted with the Metro URLs the app tried", async () => {
        fetchIosLinesMock.mockResolvedValue([raw(IOS_CFNETWORK, "com.apple.CFNetwork:Default"), raw(IOS_FAILURE, "com.facebook.react.log:native")]);
        const msg = await launchBlocker(IOS);
        expect(msg).toContain("No script URL provided");
        expect(msg).toContain("http://localhost:8090/status");
        expect(fetchIosLinesMock).toHaveBeenCalledWith(expect.objectContaining({ udid: "F936", processName: "RnDebuggerTestApp", minMessageType: "error", sinceTs: new Date(IOS.launchedAt - LOOKBACK_MS) }));
    });

    it("a launch with no device id (USB iPhone) is not probed", async () => {
        expect(await launchBlocker({ ...IOS, id: undefined })).toBeNull();
        expect(fetchIosLinesMock).not.toHaveBeenCalled();
    });

    it("a failing device read is no blocker, never an error", async () => {
        execMock.mockRejectedValue(new Error("device offline"));
        fetchAndroidLinesMock.mockRejectedValue(new Error("logcat timed out"));
        await expect(launchBlocker(ANDROID)).resolves.toBeNull();
    });
});

describe("blockerWatch", () => {
    it("asks the device at most once per interval", async () => {
        jest.clearAllMocks();
        execMock.mockResolvedValue({ stdout: POWER_AWAKE + WINDOW_OPEN, stderr: "" });
        resolveAndroidPidMock.mockResolvedValue(undefined);
        fetchAndroidLinesMock.mockResolvedValue([]);
        androidForegroundPackageMock.mockResolvedValue("com.rndebuggertestapp");
        const check = blockerWatch({ platform: "android", id: "emulator-5554", appId: "com.rndebuggertestapp", label: "emulator-5554", launchedAt: Date.now() - 10_000 }, 60_000);
        await check();
        await check();
        // One dumpsys read per check that reaches the device.
        expect(execMock).toHaveBeenCalledTimes(1);
    });
});
