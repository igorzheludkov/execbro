import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import WebSocket from "ws";
import type { ConnectedApp } from "../../core/types.js";

/**
 * The Android adb serial resolved by `tap` must reach every device-touching
 * call it makes — the UI dump, the screenshot, the tap itself, and the
 * before/after verification frames.
 *
 * Before this suite, `resolveDeviceTarget` produced `androidSerial` and `tap`
 * used it for exactly two things (the registry lookup and the overlay guard).
 * Every real device call fell through to `getDefaultAndroidDevice()`, so on a
 * two-emulator setup `tap({device: "emulator-5556"})` resolved coordinates
 * against one device and delivered the touch to another. iOS never had this
 * bug because `targetUdid` was threaded through the same call chain.
 *
 * Assertions are on the adb argv, not on a helper's parameter list: `-s <serial>`
 * is what actually decides which device gets the touch, and it stays true however
 * the plumbing is shaped. Nothing here contacts a device — the exec layer is
 * stubbed (per CLAUDE.md, no test may drive a simulator or emulator).
 */

const TARGET = "emulator-5556";
const DEFAULT = "emulator-5554";

const adbCalls: string[][] = [];
const verifyCalls: Array<Record<string, unknown>> = [];

jest.unstable_mockModule("../../core/exec.js", () => ({
    execFileAsync: async (file: string, args: string[]) => {
        if (file === "adb") adbCalls.push(args);
        // Two emulators attached, DEFAULT first — the exact setup the bug needs.
        // With no `-s`, adb picks DEFAULT, so a tap meant for TARGET lands on
        // the other screen and every assertion below can actually observe it.
        if (args?.[0] === "devices") {
            return { stdout: `List of devices attached\n${DEFAULT}\tdevice\n${TARGET}\tdevice\n`, stderr: "" };
        }
        if (args?.includes("wm density")) return { stdout: "Physical density: 160", stderr: "" };
        return { stdout: "", stderr: "" };
    },
    execAsync: async () => ({ stdout: "", stderr: "" }),
    quoteForDeviceShell: (v: string) => v,
    withCancelableTimeout: async <T>(p: Promise<T>) => p
}));

jest.unstable_mockModule("../../core/deviceResolver.js", () => ({
    resolveDeviceTarget: async () => ({
        ok: true,
        target: {
            platform: "android" as const,
            androidSerial: TARGET,
            deviceName: "sdk_gphone64_arm64",
            source: "adb-serial" as const
        }
    }),
    formatResolverError: (e: { message: string }) => e.message
}));

jest.unstable_mockModule("../../pro/verifyAction.js", () => ({
    captureScreenshot: async (platform: string, udid?: string, deviceId?: string) => {
        verifyCalls.push({ fn: "captureScreenshot", platform, udid, deviceId });
        return { buffer: Buffer.from("png"), width: 1080, height: 2400, scaleFactor: 1 };
    },
    verifyAndCapture: async (args: Record<string, unknown>) => {
        verifyCalls.push({ fn: "verifyAndCapture", ...args });
        return { screenshot: undefined, verification: undefined, afterWithMarkerBuffer: null };
    },
    burstCaptureAndVerify: async (args: Record<string, unknown>) => {
        verifyCalls.push({ fn: "burstCaptureAndVerify", ...args });
        return { screenshot: undefined, verification: undefined };
    },
    drawTapMarker: async (b: Buffer) => b,
    settleAndDiff: async () => null
}));

jest.unstable_mockModule("../../pro/overlayGuard.js", () => ({
    checkOverlayBlocking: async () => null
}));

jest.unstable_mockModule("../../core/pressables.js", () => ({
    pressElement: async () => ({
        success: true,
        result: JSON.stringify({
            needsNativeTap: true,
            nativeTapTarget: { x: 100, y: 200, unit: "points" },
            pressed: "Button",
            totalMatches: 1,
            text: "Submit",
            testID: "submit-btn",
            path: "App > Button",
            isInput: false
        })
    }),
    findPressableElements: async () => ({ success: true, result: "[]" })
}));

const { tap } = await import("../../pro/tap.js");
const { connectedApps } = await import("../../core/state.js");

function connectAndroidApp(): void {
    connectedApps.set("android-1", {
        ws: { readyState: WebSocket.OPEN } as unknown as WebSocket,
        deviceInfo: {
            id: "android-1",
            title: "Hermes React Native",
            description: "",
            appId: "com.test",
            type: "node",
            webSocketDebuggerUrl: "ws://localhost:8081/android-1",
            deviceName: "sdk_gphone64_arm64"
        },
        port: 8081,
        platform: "android",
        adbSerial: TARGET
    } as ConnectedApp);
}

/** adb invocations whose argv contains the given fragment. */
function adbCallsMatching(fragment: string): string[][] {
    return adbCalls.filter((args) => args.some((a) => a.includes(fragment)));
}

function targetsTheResolvedDevice(args: string[]): boolean {
    const i = args.indexOf("-s");
    return i !== -1 && args[i + 1] === TARGET;
}

describe("tap threads the Android serial to the device", () => {
    beforeEach(() => {
        adbCalls.length = 0;
        verifyCalls.length = 0;
        connectedApps.clear();
    });

    it("sends a native coordinate tap to the resolved emulator, not the default one", async () => {
        await tap({ x: 300, y: 600, native: true, device: TARGET, screenshot: false });

        const taps = adbCallsMatching("input tap");
        expect(taps).toHaveLength(1);
        expect(targetsTheResolvedDevice(taps[0])).toBe(true);
    });

    it("captures the verification frames from the resolved emulator", async () => {
        await tap({ x: 300, y: 600, native: true, device: TARGET, screenshot: false });

        // Before- and after-frames both have to name the target: diffing two
        // frames of the wrong device reports a confident false "no visual
        // change" for a tap that actually worked.
        expect(verifyCalls.length).toBeGreaterThan(0);
        for (const call of verifyCalls) {
            expect(call.deviceId).toBe(TARGET);
        }
    });

    it("sends a fiber-resolved tap to the resolved emulator", async () => {
        connectAndroidApp();
        await tap({ testID: "submit-btn", device: TARGET, screenshot: false, verify: false });

        const taps = adbCallsMatching("input tap");
        expect(taps).toHaveLength(1);
        expect(targetsTheResolvedDevice(taps[0])).toBe(true);
        // Density converts fiber's dp to pixels — read it off the wrong device
        // and the coordinates are scaled by the wrong factor.
        const density = adbCallsMatching("wm density");
        expect(density.length).toBeGreaterThan(0);
        expect(density.every(targetsTheResolvedDevice)).toBe(true);
    });

    it("dumps the accessibility tree from the resolved emulator", async () => {
        connectAndroidApp();
        await tap({
            text: "Submit",
            device: TARGET,
            strategy: "accessibility",
            screenshot: false,
            verify: false
        });

        const dumps = adbCallsMatching("uiautomator dump");
        expect(dumps.length).toBeGreaterThan(0);
        expect(dumps.every(targetsTheResolvedDevice)).toBe(true);
    });

    it("screenshots the resolved emulator for OCR", async () => {
        connectAndroidApp();
        await tap({
            text: "Submit",
            device: TARGET,
            strategy: "ocr",
            screenshot: false,
            verify: false
        });

        const caps = adbCallsMatching("screencap");
        expect(caps.length).toBeGreaterThan(0);
        expect(caps.every(targetsTheResolvedDevice)).toBe(true);
    });

    it("leaves adb on its default device when no device is named", async () => {
        // The resolver still answers with a serial here (it picks the only
        // device), so this guards the inverse: threading must not invent a
        // `-s` for calls that were always meant to be device-agnostic, like
        // the `adb version` probe.
        await tap({ x: 300, y: 600, native: true, screenshot: false, verify: false });

        const version = adbCalls.filter((args) => args[0] === "version");
        expect(version.every((args) => !args.includes("-s"))).toBe(true);
    });
});

/**
 * `swipe` and `pinch` already hand the resolved serial to their gesture driver,
 * but their before/after verification frames came from `captureScreenshot`
 * without one — so on two emulators the gesture ran on the right device and was
 * judged against the wrong one. Same root cause as the tap sites above.
 */
describe("swipe verification frames come from the resolved emulator", () => {
    beforeEach(() => {
        adbCalls.length = 0;
        verifyCalls.length = 0;
        connectedApps.clear();
    });

    it("captures before/after frames from the target, not adb's default", async () => {
        const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
        jest.unstable_mockModule("../../core/register.js", () => ({
            registerToolWithTelemetry: (
                _s: unknown,
                name: string,
                _c: unknown,
                handler: (args: Record<string, unknown>) => Promise<unknown>
            ) => {
                handlers.set(name, handler);
            },
            toolRegistry: new Map()
        }));

        const { registerInteractionTools } = await import("../../tools/interactionTools.js");
        registerInteractionTools({ registerTool: () => {} } as never);

        await handlers.get("swipe")!({ direction: "up", device: TARGET, screenshot: false });

        expect(verifyCalls.length).toBeGreaterThan(0);
        for (const call of verifyCalls) {
            expect(call.deviceId).toBe(TARGET);
        }
    });
});
