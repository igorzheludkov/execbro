import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import WebSocket from "ws";
import type { ConnectedApp } from "../../core/types.js";

/**
 * `tap({duration})` holds the touch instead of releasing it, so long-press
 * handlers (context menus, drag starts, multi-select) can be reached by
 * testID/text/component rather than only by raw coordinates through
 * `android_long_press`.
 *
 * Every strategy ends at the same two native calls, so the risk here is a
 * partial thread-through: one strategy silently delivering a short tap while
 * the others hold. That degradation is invisible in tool output, which is why
 * each dispatch site is asserted separately, on the real argv.
 *
 * adb has no hold verb — a same-point `input swipe` with a duration is the
 * hold, which is what `android_long_press` has always done. On iOS, AXe's
 * `touch --down --up --delay` is the equivalent.
 */

const TARGET = "emulator-5556";
const HOLD_MS = 800;

const adbCalls: string[][] = [];
const adbOptions: Array<Record<string, unknown>> = [];
const axeCalls: string[][] = [];

const UI_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="Submit" resource-id="submit-btn" class="android.widget.Button"
        package="com.test" content-desc="" checkable="false" checked="false" clickable="true"
        enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="true"
        password="false" selected="false" bounds="[100,200][400,300]" />
</hierarchy>`;

jest.unstable_mockModule("../../core/exec.js", () => ({
    execFileAsync: async (file: string, args: string[], options?: Record<string, unknown>) => {
        if (file === "adb") {
            adbCalls.push(args);
            adbOptions.push(options ?? {});
        }
        if (file.endsWith("axe")) axeCalls.push(args);
        if (args?.[0] === "devices") {
            return { stdout: `List of devices attached\n${TARGET}\tdevice\n`, stderr: "" };
        }
        if (args?.some((a) => a.includes("cat /sdcard/ui_dump.xml"))) {
            return { stdout: UI_XML, stderr: "" };
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
    captureScreenshot: async () => ({
        buffer: Buffer.from("png"),
        width: 1080,
        height: 2400,
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

let pressElementResult: Record<string, unknown> = {
    needsNativeTap: true,
    nativeTapTarget: { x: 100, y: 200, unit: "points" },
    pressed: "Button",
    totalMatches: 1,
    text: "Submit",
    testID: "submit-btn",
    path: "App > Button",
    isInput: false
};
const pressElementArgs: Array<Record<string, unknown>> = [];

jest.unstable_mockModule("../../core/pressables.js", () => ({
    pressElement: async (opts: Record<string, unknown>) => {
        pressElementArgs.push(opts);
        return { success: true, result: JSON.stringify(pressElementResult) };
    },
    findPressableElements: async () => ({ success: true, result: "[]" })
}));

const { tap } = await import("../../pro/tap.js");
const { androidTap } = await import("../../core/android.js");
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

/** The `input ...` shell command adb was asked to run, if any. */
function inputCommands(): string[] {
    return adbCalls
        .map((args) => args.find((a) => a.startsWith("input ")))
        .filter((c): c is string => !!c);
}

describe("tap duration — Android", () => {
    beforeEach(() => {
        adbCalls.length = 0;
        adbOptions.length = 0;
        pressElementArgs.length = 0;
        connectedApps.clear();
    });

    it("holds via a same-point swipe, and gives adb time to finish it", async () => {
        await androidTap(10, 20, TARGET, HOLD_MS);

        expect(inputCommands()).toEqual([`input swipe 10 20 10 20 ${HOLD_MS}`]);
        // The exec timeout has to outlast the hold, or a long press kills its own
        // subprocess and reports an adb timeout — which reads as a device fault.
        const swipeCall = adbOptions[adbCalls.findIndex((a) => a.some((s) => s.startsWith("input swipe")))];
        expect(swipeCall.timeout as number).toBeGreaterThan(HOLD_MS);
    });

    it("still sends a plain tap when no duration is given", async () => {
        await androidTap(10, 20, TARGET);

        expect(inputCommands()).toEqual(["input tap 10 20"]);
    });

    it("holds on the native coordinate path", async () => {
        await tap({ x: 300, y: 600, native: true, device: TARGET, duration: HOLD_MS, screenshot: false });

        expect(inputCommands()).toEqual([`input swipe 300 600 300 600 ${HOLD_MS}`]);
    });

    it("holds on the fiber path", async () => {
        connectAndroidApp();
        // strategy is pinned: for a testID query `auto` tries accessibility first
        // (resource-id is a cheaper lookup than a fiber walk), so without this the
        // test would assert the fiber path while exercising the accessibility one.
        await tap({ testID: "submit-btn", device: TARGET, strategy: "fiber", duration: HOLD_MS, screenshot: false, verify: false });

        expect(inputCommands()).toEqual([`input swipe 100 200 100 200 ${HOLD_MS}`]);
    });

    it("holds on the accessibility path", async () => {
        connectAndroidApp();
        await tap({
            text: "Submit",
            device: TARGET,
            strategy: "accessibility",
            duration: HOLD_MS,
            screenshot: false,
            verify: false
        });

        expect(inputCommands()).toEqual([`input swipe 250 250 250 250 ${HOLD_MS}`]);
    });

    it("leaves every path on a plain tap when duration is omitted", async () => {
        connectAndroidApp();
        await tap({ testID: "submit-btn", device: TARGET, strategy: "fiber", screenshot: false, verify: false });

        expect(inputCommands()).toEqual(["input tap 100 200"]);
    });
});

describe("tap duration — iOS", () => {
    beforeEach(() => {
        axeCalls.length = 0;
        connectedApps.clear();
    });

    it("passes the hold to the driver as a delay in seconds", async () => {
        const { iosTap } = await import("../../core/ios.js");
        await iosTap(50, 60, { duration: HOLD_MS, udid: "SIM-UDID" });

        const touch = axeCalls.find((a) => a[0] === "touch");
        expect(touch).toBeDefined();
        expect(touch).toEqual(expect.arrayContaining(["--down", "--up", "--delay", "0.8"]));
    });
});
