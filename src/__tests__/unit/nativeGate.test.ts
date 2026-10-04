process.env.RN_AI_DEVTOOLS_TEST_MODE = "1";

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import WebSocket from "ws";
import type { ConnectedApp } from "../../core/types.js";

const { connectedApps } = await import("../../core/state.js");
const { peekTargetApp, nativeAppFor, getFirstConnectedApp, getConnectedAppByAndroidDeviceId } = await import("../../core/connection.js");
const { NATIVE_TOOLS, nativeGate } = await import("../../core/nativeCapabilities.js");
const { toolRegistry } = await import("../../index.js");

function rnApp(id: string, deviceName: string): ConnectedApp {
    return {
        ws: { readyState: WebSocket.OPEN } as unknown as WebSocket,
        deviceInfo: { id, title: deviceName, description: "", appId: "", type: "node", webSocketDebuggerUrl: `ws://x/${id}`, deviceName },
        port: 8081,
        platform: "android"
    } as ConnectedApp;
}

function nativeApp(serial: string, pkg: string, label: string): ConnectedApp {
    return {
        ...rnApp(`native:${serial}:${pkg}`, label),
        adbSerial: serial,
        runtime: "native",
        nativePackage: pkg
    } as ConnectedApp;
}

describe("nativeGate", () => {
    it("lets allowlisted tools through on native", () => {
        for (const t of ["navigate", "list_debug_globals", "inspect_global", "run_app_command", "screenshot", "android_screenshot", "scan_metro"]) {
            expect(nativeGate(t, "native")).toBeNull();
        }
    });

    it("refuses other tools on native, naming the tool and pointing at what works", () => {
        const r = nativeGate("tap", "native");
        expect(r?.isError).toBe(true);
        expect(r?.content[0].text).toContain("tap");
        expect(r?.content[0].text).toContain("screenshot");
        expect(r?._failureKind).toBe("platform_mismatch");
    });

    it("never touches non-native targets", () => {
        expect(nativeGate("tap", undefined)).toBeNull();
    });

    it("allowlists only tools that actually exist", () => {
        const devOnly = new Set(["reset_telemetry"]);
        for (const name of NATIVE_TOOLS) if (!devOnly.has(name)) expect(toolRegistry.has(name)).toBe(true);
    });
});

describe("native target resolution", () => {
    beforeEach(() => connectedApps.clear());
    afterEach(() => connectedApps.clear());

    it("never hands a native app to the React Native lookup by adb serial", () => {
        connectedApps.set("n", nativeApp("emulator-5554", "com.example.app", "Example"));
        expect(getConnectedAppByAndroidDeviceId("emulator-5554")).toBeNull();
        expect(getConnectedAppByAndroidDeviceId()).toBeNull();
        const rn = { ...rnApp("rn", "Pixel 9"), adbSerial: "emulator-5554" } as ConnectedApp;
        connectedApps.set("rn", rn);
        expect(getConnectedAppByAndroidDeviceId("emulator-5554")).toBe(rn);
        expect(getConnectedAppByAndroidDeviceId()).toBe(rn);
    });

    it("matches a native app by package, label or serial", () => {
        connectedApps.set("rn", rnApp("rn", "Pixel 9"));
        connectedApps.set("n", nativeApp("emulator-5554", "com.ihorzheludkov.touchdisabler", "TouchDisabler"));
        expect(nativeAppFor("navigate", "com.ihorzheludkov.touchdisabler")?.nativePackage).toBe("com.ihorzheludkov.touchdisabler");
        expect(nativeAppFor("navigate", "TouchDisabler")?.runtime).toBe("native");
        expect(nativeAppFor("navigate", "Pixel 9")).toBeNull();
    });

    it("keeps the same package on two devices apart and fails open when ambiguous", () => {
        connectedApps.set("a", nativeApp("emulator-5554", "com.example.app", "Example"));
        connectedApps.set("b", nativeApp("emulator-5556", "com.example.app", "Example"));
        expect(peekTargetApp("navigate", "emulator-5556")?.adbSerial).toBe("emulator-5556");
        expect(peekTargetApp("navigate", "com.example.app")).toBeUndefined();
    });

    it("prefers a React Native app for a bare call, then a native one when nothing else is open", () => {
        connectedApps.set("n", nativeApp("emulator-5554", "com.example.app", "Example"));
        connectedApps.set("rn", rnApp("rn", "Pixel 9"));
        expect(getFirstConnectedApp()?.runtime).toBeUndefined();
        connectedApps.delete("rn");
        expect(getFirstConnectedApp()?.runtime).toBe("native");
    });

    it("keeps a chromium app ahead of a native one for a bare call, as before native support", () => {
        connectedApps.set("n", nativeApp("emulator-5554", "com.example.app", "Example"));
        connectedApps.set("c", { ...rnApp("c", "FluentTalk"), platform: "chromium", port: 9222 } as ConnectedApp);
        expect(getFirstConnectedApp()?.platform).toBe("chromium");
    });
});
