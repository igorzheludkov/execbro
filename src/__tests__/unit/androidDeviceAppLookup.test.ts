import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import WebSocket from "ws";
import type { ConnectedApp } from "../../core/types.js";

const { connectedApps } = await import("../../core/state.js");
const { getConnectedAppByAndroidDeviceId } = await import("../../core/connection.js");

function makeAndroidApp(key: string, deviceName: string, adbSerial?: string): ConnectedApp {
    return {
        ws: { readyState: WebSocket.OPEN } as unknown as WebSocket,
        deviceInfo: {
            id: key,
            title: "Hermes React Native",
            description: "",
            appId: "com.test",
            type: "node",
            webSocketDebuggerUrl: `ws://localhost:8081/${key}`,
            deviceName
        },
        port: 8081,
        platform: "android",
        ...(adbSerial ? { adbSerial } : {})
    } as ConnectedApp;
}

describe("getConnectedAppByAndroidDeviceId", () => {
    beforeEach(() => connectedApps.clear());
    afterEach(() => connectedApps.clear());

    it("returns the sole connected Android app when no deviceId is given", () => {
        const app = makeAndroidApp("a", "sdk_gphone16k_arm64 - 17 - API 37", "emulator-5554");
        connectedApps.set("a", app);

        expect(getConnectedAppByAndroidDeviceId()).toBe(app);
    });

    it("still matches the connected emulator when its adb serial is passed", () => {
        // Regression guard: the fix must not break the normal path where the
        // caller passes the very serial the app is linked to.
        const app = makeAndroidApp("a", "sdk_gphone16k_arm64 - 17 - API 37", "emulator-5554");
        connectedApps.set("a", app);

        expect(getConnectedAppByAndroidDeviceId("emulator-5554")).toBe(app);
    });

    it("matches on the RN-reported device name with separator drift", () => {
        const app = makeAndroidApp("a", "SM-A356N - 15 - API 35", "R5CT30ABCDE");
        connectedApps.set("a", app);

        expect(getConnectedAppByAndroidDeviceId("SM_A356N")).toBe(app);
    });

    it("returns null for a device that has no connected app, instead of the only Android app", () => {
        // The 2026-08-22 live repro: handset RFCX20CLX3F on its launcher, RN app
        // only on the emulator. Enriching the handset screenshot from the emulator
        // hands the agent tap coordinates from the wrong device's layout.
        connectedApps.set("a", makeAndroidApp("a", "sdk_gphone16k_arm64 - 17 - API 37", "emulator-5554"));

        expect(getConnectedAppByAndroidDeviceId("RFCX20CLX3F")).toBeNull();
    });

    it("returns null when nothing Android is connected", () => {
        expect(getConnectedAppByAndroidDeviceId()).toBeNull();
        expect(getConnectedAppByAndroidDeviceId("emulator-5554")).toBeNull();
    });
});
