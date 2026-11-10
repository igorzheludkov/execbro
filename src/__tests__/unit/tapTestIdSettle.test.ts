import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import WebSocket from "ws";
import type { ConnectedApp } from "../../core/types.js";

/**
 * Opus benchmark: 20 tap({ testID }) calls failed with "No element found
 * matching testID", mostly right after a navigation. A testID miss now settles
 * once and re-reads, and a testID that sits on an unfocused route is named.
 */

const TARGET = "emulator-5556";

jest.unstable_mockModule("../../core/exec.js", () => ({
    execFileAsync: async (_file: string, args: string[]) => {
        if (args?.[0] === "devices") {
            return { stdout: `List of devices attached\n${TARGET}\tdevice\n`, stderr: "" };
        }
        if (args?.some((a) => a.includes("cat /sdcard/ui_dump.xml"))) {
            return {
                stdout: `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="Other" resource-id="other-btn" class="android.widget.Button"
        package="com.test" content-desc="" checkable="false" checked="false" clickable="true"
        enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="true"
        password="false" selected="false" bounds="[100,200][400,300]" />
</hierarchy>`,
                stderr: ""
            };
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

const NOT_FOUND = JSON.stringify({
    error: 'No pressable or focusable elements found matching: testID="place-order". The element is not present in the React tree on the current screen.',
    existsInTree: false
});
const FOUND = JSON.stringify({
    needsNativeTap: true,
    nativeTapTarget: { x: 100, y: 200, unit: "points" },
    pressed: "Button",
    totalMatches: 1,
    text: "Place order",
    testID: "place-order",
    path: "App > Button",
    isInput: false
});
let responses: string[] = [];
let pressElementCalls = 0;

jest.unstable_mockModule("../../core/pressables.js", () => ({
    pressElement: async () => {
        const r = responses[Math.min(pressElementCalls, responses.length - 1)];
        pressElementCalls++;
        return { success: true, result: r };
    },
    findPressableElements: async () => ({ success: true, result: "[]" })
}));

const { tap, TESTID_SETTLE_MS } = await import("../../pro/tap.js");
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

const tapPlaceOrder = () => tap({ testID: "place-order", device: TARGET, screenshot: false, verify: false });

// One fiber strategy run reads the tree up to three times (depth 15, 30, 45) on a miss.
const FIBER_READS_PER_MISS = 3;

describe("tap by testID on a screen that is still settling", () => {
    beforeEach(() => {
        connectedApps.clear();
        connectAndroidApp();
        pressElementCalls = 0;
    });

    it("re-reads once after a settle when a testID is not found", async () => {
        // A tap that finds the element at once: its fiber reads, post-tap reads included.
        responses = [FOUND];
        await tapPlaceOrder();
        const foundAtOnce = pressElementCalls;
        pressElementCalls = 0;

        responses = [...Array(FIBER_READS_PER_MISS).fill(NOT_FOUND), FOUND];
        const result = await tapPlaceOrder();

        expect(result.success).toBe(true);
        // One missed fiber run, then exactly one re-read that found it.
        expect(pressElementCalls).toBe(FIBER_READS_PER_MISS + foundAtOnce);
    }, 20000);

    it("does not settle for a testID that stays missing", async () => {
        responses = [NOT_FOUND];
        const started = Date.now();

        const result = await tapPlaceOrder();

        expect(result.success).toBe(false);
        expect(result.attempted?.filter((a) => a.strategy === "settle")).toHaveLength(1);
        expect(pressElementCalls).toBe(FIBER_READS_PER_MISS * 2);
        expect(Date.now() - started).toBeGreaterThanOrEqual(TESTID_SETTLE_MS);
    }, 20000);

    it("names the route that holds a pruned testID", async () => {
        responses = [JSON.stringify({ ...JSON.parse(NOT_FOUND), prunedRoute: "Checkout" })];

        const result = await tapPlaceOrder();

        expect(result.suggestion).toContain('testID "place-order" exists on route "Checkout", which is not focused. navigate({ to: "Checkout" }) first.');
    }, 20000);
});
