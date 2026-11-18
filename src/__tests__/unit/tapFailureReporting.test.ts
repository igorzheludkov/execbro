import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import WebSocket from "ws";
import type { ConnectedApp } from "../../core/types.js";

/**
 * Tap telemetry 2026-11-04..18: 689 failures, none with a failure kind. Coordinate
 * taps reported an empty "No element found matching ", a hung before-screenshot ate
 * the whole budget, and a text miss paid an empty-screen settle it did not need.
 */

const TARGET = "emulator-5556";
const ADB_TAP_ERROR = "Command failed: adb -s emulator-5556 shell input tap 300 600\nerror: device offline (the emulator stopped responding to input)";
let failInputTap = false;
const AXE_STDERR = "Error: Failed to send HID event: the simulator's HID connection was interrupted";
let failAxeTap = false;
let axeMissing = false;

const UI_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="Other" resource-id="other-btn" class="android.widget.Button"
        package="com.test" content-desc="" checkable="false" checked="false" clickable="true"
        enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="true"
        password="false" selected="false" bounds="[100,200][400,300]" />
</hierarchy>`;

jest.unstable_mockModule("../../core/exec.js", () => ({
    execFileAsync: async (file: string, args: string[]) => {
        if (axeMissing && file.endsWith("axe")) throw new Error("spawn axe ENOENT");
        if (failAxeTap && file.endsWith("axe") && args?.[0] === "tap") {
            throw Object.assign(new Error(`Command failed: /opt/homebrew/bin/axe tap -x 50 -y 60 --udid SIM-UDID\n${AXE_STDERR}`), { stderr: `${AXE_STDERR}\n` });
        }
        if (args?.[0] === "devices") {
            return { stdout: `List of devices attached\n${TARGET}\tdevice\n`, stderr: "" };
        }
        if (failInputTap && args?.some((a) => a.startsWith("input tap"))) throw new Error(ADB_TAP_ERROR);
        if (args?.some((a) => a.includes("cat /sdcard/ui_dump.xml"))) return { stdout: UI_XML, stderr: "" };
        if (args?.includes("wm density")) return { stdout: "Physical density: 160", stderr: "" };
        return { stdout: "", stderr: "" };
    },
    execAsync: async () => ({ stdout: "", stderr: "" }),
    quoteForDeviceShell: (v: string) => v,
    withCancelableTimeout: async <T>(p: Promise<T>) => p
}));

const OK_TARGET = {
    ok: true,
    target: { platform: "android" as const, androidSerial: TARGET, deviceName: "sdk_gphone64_arm64", source: "adb-serial" as const }
};
let resolution: unknown = OK_TARGET;

jest.unstable_mockModule("../../core/deviceResolver.js", () => ({
    resolveDeviceTarget: async () => resolution,
    formatResolverError: (e: { message: string }) => e.message
}));

let hangBeforeScreenshot = false;

jest.unstable_mockModule("../../pro/verifyAction.js", () => ({
    captureScreenshot: async () => hangBeforeScreenshot
        ? new Promise(() => {})
        : { buffer: Buffer.from("png"), width: 1080, height: 2400, scaleFactor: 1 },
    verifyAndCapture: async () => ({ screenshot: undefined, verification: undefined, afterWithMarkerBuffer: null }),
    burstCaptureAndVerify: async () => ({ screenshot: undefined, verification: undefined }),
    drawTapMarker: async (b: Buffer) => b,
    settleAndDiff: async () => null
}));

jest.unstable_mockModule("../../pro/overlayGuard.js", () => ({
    checkOverlayBlocking: async () => null
}));

let fiberResponse = "";
jest.unstable_mockModule("../../core/pressables.js", () => ({
    pressElement: async () => ({ success: true, result: fiberResponse }),
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

beforeEach(() => {
    connectedApps.clear();
    connectAndroidApp();
    failInputTap = false;
    failAxeTap = false;
    axeMissing = false;
    hangBeforeScreenshot = false;
    resolution = OK_TARGET;
});

describe("coordinate tap that fails", () => {
    it("reports the adb error in full, not an empty not-found", async () => {
        failInputTap = true;
        const r = await tap({ x: 300, y: 600, device: TARGET, screenshot: false, verify: false });
        expect(r.success).toBe(false);
        expect(r.error).not.toMatch(/No element found/);
        expect(r.error).toContain("device offline (the emulator stopped responding to input)");
    });

    it("does the same on the native path", async () => {
        failInputTap = true;
        const r = await tap({ x: 300, y: 600, native: true, device: TARGET, screenshot: false });
        expect(r.success).toBe(false);
        expect(r.error).toContain("device offline (the emulator stopped responding to input)");
    });
});

describe("axe tap that fails", () => {
    // The command line ate the 200-char telemetry message before the reason; keep the reason.
    it("reports axe's stderr, not the command line", async () => {
        failAxeTap = true;
        const { iosTap } = await import("../../core/ios.js");
        const r = await iosTap(50, 60, { udid: "SIM-UDID" });
        expect(r.error).toBe(`Failed to tap: ${AXE_STDERR}`);
    });
});

describe("before-screenshot that hangs", () => {
    it("is abandoned after a few seconds and the tap still runs", async () => {
        hangBeforeScreenshot = true;
        const started = Date.now();
        const r = await tap({ x: 300, y: 600, device: TARGET, screenshot: false });
        expect(r.success).toBe(true);
        expect(Date.now() - started).toBeLessThan(6000);
    }, 15000);
});

describe("failure kind", () => {
    it("tags multiple devices with none named as bad_arguments", async () => {
        resolution = { ok: false, error: { code: "MULTIPLE_DEVICES_MATCH", message: "Multiple devices available." } };
        expect((await tap({ text: "Go" })).failureKind).toBe("bad_arguments");
        expect((await tap({ x: 1, y: 2, native: true })).failureKind).toBe("bad_arguments");
    });

    it("tags no devices as no_devices_attached", async () => {
        resolution = { ok: false, error: { code: "NO_DEVICES_FOUND", message: "No devices found." } };
        expect((await tap({ text: "Go" })).failureKind).toBe("no_devices_attached");
    });

    // Fiber still runs without the driver, so this used to end as a plain not-found (or "Tap timed out").
    it("tags a missing iOS UI driver as driver_not_installed and says so", async () => {
        axeMissing = true;
        resolution = { ok: true, target: { platform: "ios", iosUdid: "SIM-UDID", deviceName: "iPhone 16", source: "udid" } };
        fiberResponse = JSON.stringify({ error: 'No pressable or focusable elements found matching: text="Go". The element is not present in the React tree on the current screen.', existsInTree: false });
        const r = await tap({ text: "Go", device: "SIM-UDID", screenshot: false, verify: false });
        expect(r.failureKind).toBe("driver_not_installed");
        expect(r.error).toContain("AXe is not installed");
    }, 20000);

    it("leaves a target-not-found untagged", async () => {
        fiberResponse = JSON.stringify({ error: 'No pressable or focusable elements found matching: testID="x". The element is not present in the React tree on the current screen.', existsInTree: false });
        const r = await tap({ testID: "x", device: TARGET, screenshot: false, verify: false });
        expect(r.success).toBe(false);
        expect(r.failureKind).toBeUndefined();
    }, 20000);
});

describe("empty-screen settle", () => {
    const settles = (r: { attempted?: Array<{ strategy: string; reason: string }> }) =>
        (r.attempted ?? []).filter((a) => a.strategy === "settle" && a.reason.startsWith("Screen had zero pressables"));

    it("is skipped on a text miss when the screen has pressables", async () => {
        fiberResponse = JSON.stringify({ error: 'No pressable or focusable elements found matching: text="Missing". The element is not present in the React tree on the current screen.', existsInTree: false });
        const r = await tap({ text: "Missing", device: TARGET, screenshot: false, verify: false });
        expect(settles(r)).toHaveLength(0);
    }, 20000);

    it("still runs when fiber saw no pressables at all", async () => {
        fiberResponse = JSON.stringify({ error: 'No pressable or focusable elements found. Searched for: text="Missing"' });
        const r = await tap({ text: "Missing", device: TARGET, screenshot: false, verify: false });
        expect(settles(r)).toHaveLength(1);
    }, 20000);
});
