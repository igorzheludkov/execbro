import { describe, it, expect, jest } from "@jest/globals";

/**
 * tap({ native: true, screenshot: false }) attached a full after-frame (~1MB) anyway:
 * every other tap path drops it unless the tap changed nothing (then the frame is the
 * evidence). Seen on device, 2026-11-09.
 */

const TARGET = "emulator-5556";
const adbCalls: string[][] = [];
const adbOptions: Array<Record<string, unknown>> = [];
const axeCalls: string[][] = [];
let meaningful = true;

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
    // verifyAndCapture hands back the after-frame whenever it verified, whatever
    // shouldScreenshot said; each caller decides whether the agent gets it.
    verifyAndCapture: async () => ({
        screenshot: { image: "base64", width: 1080, height: 2400, scaleFactor: 1 },
        verification: { meaningful, explanation: "" },
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

describe("tap native:true with screenshot:false", () => {
    it("does not attach the after-frame when the screen changed", async () => {
        meaningful = true;
        const r = await tap({ x: 300, y: 600, native: true, device: TARGET, screenshot: false });
        expect(r.success).toBe(true);
        expect(r.screenshot).toBeUndefined();
    });

    it("keeps it when nothing changed, as the other paths do: it is the evidence", async () => {
        meaningful = false;
        const r = await tap({ x: 300, y: 600, native: true, device: TARGET, screenshot: false });
        expect(r.screenshot).toBeDefined();
    });
});
