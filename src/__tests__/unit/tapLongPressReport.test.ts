import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import WebSocket from "ws";
import type { ConnectedApp } from "../../core/types.js";

/**
 * A hold delivered to an element with no `onLongPress` looks exactly like a
 * successful long press in the tool output: adb accepted it, pixels may even
 * have changed (RN fires the element's `onPress` on release). The agent then
 * concludes the handler is broken and goes looking for a bug that is not there.
 *
 * Only the fiber strategy can tell the difference — accessibility, OCR and
 * coordinate taps never see the handlers — so the report distinguishes
 * "no handler" from "not knowable", and never claims the second is the first.
 */

const TARGET = "emulator-5556";
const HOLD_MS = 800;

jest.unstable_mockModule("../../core/exec.js", () => ({
    execFileAsync: async (_file: string, args: string[]) => {
        if (args?.[0] === "devices") {
            return { stdout: `List of devices attached\n${TARGET}\tdevice\n`, stderr: "" };
        }
        if (args?.some((a) => a.includes("cat /sdcard/ui_dump.xml"))) {
            return {
                stdout: `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="Gift card" resource-id="gift-card" class="android.widget.Button"
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

let hasLongPress = true;
const pressElementArgs: Array<Record<string, unknown>> = [];

jest.unstable_mockModule("../../core/pressables.js", () => ({
    pressElement: async (opts: Record<string, unknown>) => {
        pressElementArgs.push(opts);
        return {
            success: true,
            result: JSON.stringify({
                needsNativeTap: true,
                nativeTapTarget: { x: 100, y: 200, unit: "points" },
                pressed: "GiftCard",
                totalMatches: 1,
                text: "Gift card",
                testID: "gift-card",
                path: "App > GiftCard",
                isInput: false,
                hasLongPress
            })
        };
    },
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

const fiberTap = (extra: Record<string, unknown> = {}) =>
    tap({
        testID: "gift-card",
        device: TARGET,
        strategy: "fiber" as const,
        screenshot: false,
        verify: false,
        ...extra
    });

describe("what a long press reports", () => {
    beforeEach(() => {
        pressElementArgs.length = 0;
        connectedApps.clear();
        hasLongPress = true;
    });

    it("says nothing about long press when none was requested", async () => {
        connectAndroidApp();
        const result = await fiberTap();

        expect(result.longPress).toBeUndefined();
        // The fiber search must stay narrow for an ordinary tap.
        expect(pressElementArgs[0].longPress).toBe(false);
    });

    it("confirms the element has a long-press handler", async () => {
        connectAndroidApp();
        const result = await fiberTap({ duration: HOLD_MS });

        expect(result.success).toBe(true);
        expect(result.longPress).toMatchObject({ durationMs: HOLD_MS, handlerFound: true });
        expect(result.longPress?.warning).toBeUndefined();
        expect(pressElementArgs[0].longPress).toBe(true);
    });

    it("warns when the element has no long-press handler, without failing the tap", async () => {
        hasLongPress = false;
        connectAndroidApp();
        const result = await fiberTap({ duration: HOLD_MS });

        // The gesture was delivered — that is the fact being reported. Calling it
        // a failure would be a claim about the app that the tool cannot make.
        expect(result.success).toBe(true);
        expect(result.longPress?.handlerFound).toBe(false);
        expect(result.longPress?.warning).toMatch(/onLongPress/);
        expect(result.longPress?.warning).toMatch(/GiftCard/);
    });

    it("admits it cannot know on an accessibility tap either", async () => {
        connectAndroidApp();
        const result = await tap({
            text: "Gift card",
            device: TARGET,
            strategy: "accessibility",
            duration: HOLD_MS,
            screenshot: false,
            verify: false
        });

        // uiautomator reports `long-clickable`, but that is the *native* view's flag,
        // not the React element's onLongPress — treating it as an answer would be a
        // guess dressed as a finding. This path reports "not knowable".
        expect(result.success).toBe(true);
        expect(result.method).toBe("accessibility");
        expect(result.longPress).toMatchObject({ durationMs: HOLD_MS, handlerFound: null });
    });

    it("admits it cannot know on a coordinate tap", async () => {
        const result = await tap({
            x: 300,
            y: 600,
            native: true,
            device: TARGET,
            duration: HOLD_MS,
            screenshot: false
        });

        expect(result.success).toBe(true);
        expect(result.longPress).toMatchObject({ durationMs: HOLD_MS, handlerFound: null });
        // No warning: nothing was inspected, so there is nothing to warn about.
        expect(result.longPress?.warning).toBeUndefined();
    });
});
