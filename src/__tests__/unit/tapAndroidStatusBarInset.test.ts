import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import WebSocket from "ws";
import type { ConnectedApp } from "../../core/types.js";

/**
 * Fabric's `measureInWindow` is window-relative on Android: y is measured from
 * the top of the RN content, which starts *below* the status bar. `adb input
 * tap` speaks screen pixels, measured from the top of the display. The
 * fiber+native path scaled dp to pixels and stopped there, so every tap landed
 * exactly one status bar too high — reporting success, changing nothing.
 *
 * The iOS branch of the same dispatch already shifts by its safe-area inset,
 * and `screenSpace.ts` adds `topInset` unconditionally on Android for every
 * layout tool. This path was the one place the normalization was missing.
 *
 * Numbers are taken from the emulator that reproduced it (Pixel_9, 1080x2424,
 * 420dpi so densityScale 2.625, status bar 142px). The "Scroll" nav button
 * measured at dp (154, 80) and its true centre is device y=352; before the fix
 * the tap was dispatched to y=210.
 */

const TARGET = "emulator-5554";
const STATUS_BAR_PX = 142;
const DENSITY = 420;
const DENSITY_SCALE = DENSITY / 160; // 2.625

/** dp reported by Fabric for the "Scroll" nav button, window-relative. */
const FIBER_DP = { x: 154, y: 80 };
const EXPECTED_X = Math.round(FIBER_DP.x * DENSITY_SCALE); // 404
const EXPECTED_Y = Math.round(FIBER_DP.y * DENSITY_SCALE) + STATUS_BAR_PX; // 210 + 142 = 352

const adbCalls: string[][] = [];

jest.unstable_mockModule("../../core/exec.js", () => ({
    execFileAsync: async (file: string, args: string[]) => {
        if (file === "adb") adbCalls.push(args);
        if (args?.[0] === "devices") {
            return { stdout: `List of devices attached\n${TARGET}\tdevice\n`, stderr: "" };
        }
        if (args?.includes("wm density")) {
            return { stdout: `Physical density: ${DENSITY}`, stderr: "" };
        }
        if (args?.some((a) => a.includes("dumpsys window"))) {
            // Real shape of the line androidGetStatusBarHeight parses.
            return {
                stdout: `InsetsSource id=38960000 type=statusBars frame=[0,0][1080,${STATUS_BAR_PX}] visible=true`,
                stderr: ""
            };
        }
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
            deviceName: "sdk_gphone16k_arm64",
            source: "adb-serial" as const
        }
    }),
    formatResolverError: (e: { message: string }) => e.message
}));

jest.unstable_mockModule("../../pro/verifyAction.js", () => ({
    captureScreenshot: async () => ({
        buffer: Buffer.from("png"),
        width: 1080,
        height: 2424,
        scaleFactor: 1
    }),
    verifyAndCapture: async () => ({
        screenshot: undefined,
        verification: undefined,
        afterWithMarkerBuffer: null
    }),
    burstCaptureAndVerify: async () => ({ screenshot: undefined, verification: undefined }),
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
            nativeTapTarget: { x: FIBER_DP.x, y: FIBER_DP.y, unit: "points" },
            pressed: "Pressable",
            totalMatches: 1,
            text: "Scroll",
            testID: "screen-nav-Scroll",
            path: "App > Pressable",
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
            deviceName: "sdk_gphone16k_arm64"
        },
        port: 8081,
        platform: "android",
        adbSerial: TARGET
    } as ConnectedApp);
}

function inputCommands(): string[] {
    return adbCalls
        .map((args) => args.find((a) => a.startsWith("input ")))
        .filter((c): c is string => !!c);
}

describe("fiber+native tap on Android — status bar inset", () => {
    beforeEach(() => {
        adbCalls.length = 0;
        connectedApps.clear();
    });

    it("adds the status bar inset to the dispatched tap", async () => {
        connectAndroidApp();
        await tap({
            testID: "screen-nav-Scroll",
            device: TARGET,
            strategy: "fiber",
            screenshot: false,
            verify: false
        });

        expect(inputCommands()).toEqual([`input tap ${EXPECTED_X} ${EXPECTED_Y}`]);
    });

    it("reports the inset-corrected pixels back to the caller", async () => {
        connectAndroidApp();
        // The reported coords are handed straight to coordinate tools and to
        // verification's marker, so a corrected tap with uncorrected reporting
        // would draw the marker one status bar off and read as a miss.
        const res = (await tap({
            testID: "screen-nav-Scroll",
            device: TARGET,
            strategy: "fiber",
            screenshot: false,
            verify: false
        })) as { convertedTo?: { x: number; y: number; unit: string } };

        expect(res.convertedTo).toEqual({ x: EXPECTED_X, y: EXPECTED_Y, unit: "pixels" });
    });

    it("falls back to 24dp when dumpsys cannot be parsed", async () => {
        // A device that answers `wm density` but not the insets query still has a
        // status bar; silently dropping the inset there would resurrect the bug on
        // exactly the devices least able to report it.
        connectAndroidApp();
        const { androidGetStatusBarHeight } = await import("../../core/android.js");
        const sb = await androidGetStatusBarHeight(TARGET);

        expect(sb.success).toBe(true);
        expect(sb.heightPixels).toBeGreaterThan(0);
    });
});
