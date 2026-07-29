import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import WebSocket from "ws";
import type { ConnectedApp } from "../../core/types.js";

const { connectedApps } = await import("../../core/state.js");
const {
    resolveConnectedAppByDevice,
    describeDeviceResolution,
    getConnectedAppByDevice
} = await import("../../core/connection.js");

function makeApp(
    key: string,
    deviceName: string,
    platform: "ios" | "android",
    ids: { simulatorUdid?: string; adbSerial?: string } = {}
): ConnectedApp {
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
        platform,
        ...ids
    } as ConnectedApp;
}

describe("resolveConnectedAppByDevice", () => {
    beforeEach(() => connectedApps.clear());
    afterEach(() => connectedApps.clear());

    it("reports kind=none instead of throwing when nothing is connected", () => {
        const resolution = resolveConnectedAppByDevice("iPhone 17 Pro");
        expect(resolution.kind).toBe("none");
        // The recoverable-miss contract: reload_app relies on this to run its
        // auto-connect sweep rather than aborting on the first resolve.
        expect(describeDeviceResolution(resolution)).toContain("No devices are currently connected");
    });

    it("matches on device name, simulator UDID, and adb serial", () => {
        connectedApps.set("a", makeApp("a", "iPhone 17 Pro", "ios", { simulatorUdid: "549D04C7-A774-4313-BFC0-F132FF609274" }));
        connectedApps.set("b", makeApp("b", "sdk_gphone16k_arm64 - 17 - API 37", "android", { adbSerial: "emulator-5554" }));

        expect(resolveConnectedAppByDevice("iphone 17")).toMatchObject({ kind: "ok", app: { platform: "ios" } });
        expect(resolveConnectedAppByDevice("549D04C7")).toMatchObject({ kind: "ok", app: { platform: "ios" } });
        expect(resolveConnectedAppByDevice("emulator-5554")).toMatchObject({ kind: "ok", app: { platform: "android" } });
    });

    it("prefers the exact name over a broader substring match", () => {
        connectedApps.set("a", makeApp("a", "iPhone 17 Pro", "ios"));
        connectedApps.set("b", makeApp("b", "iPhone 17 Pro Max", "ios"));

        const resolution = resolveConnectedAppByDevice("iPhone 17 Pro");
        expect(resolution).toMatchObject({ kind: "ok" });
        if (resolution.kind === "ok") {
            expect(resolution.app.deviceInfo.deviceName).toBe("iPhone 17 Pro");
        }
    });

    it("reports ambiguity when several devices match and none exactly", () => {
        connectedApps.set("a", makeApp("a", "iPhone 17 Pro", "ios"));
        connectedApps.set("b", makeApp("b", "iPhone 17 Pro Max", "ios"));

        const resolution = resolveConnectedAppByDevice("iPhone 17");
        expect(resolution.kind).toBe("ambiguous");
        expect(describeDeviceResolution(resolution)).toContain("Multiple devices match");
    });

    it("names the platform mismatch when only the other platform is attached", () => {
        connectedApps.set("b", makeApp("b", "sdk_gphone16k_arm64 - 17 - API 37", "android", { adbSerial: "emulator-5554" }));

        const message = describeDeviceResolution(resolveConnectedAppByDevice("iPhone 17 Pro"));
        expect(message).toContain("Only Android device(s) are attached");
        expect(message).toContain("ios_launch_app");
    });

    it("names the mismatch in the other direction too", () => {
        connectedApps.set("a", makeApp("a", "iPhone 17 Pro", "ios"));

        const message = describeDeviceResolution(resolveConnectedAppByDevice("Pixel 7 Pro"));
        expect(message).toContain("Only iOS device(s) are attached");
        expect(message).toContain("android_launch_app");
    });

    it("falls back to listing connected devices when the platform is unclear", () => {
        connectedApps.set("a", makeApp("a", "iPhone 17 Pro", "ios"));

        const message = describeDeviceResolution(resolveConnectedAppByDevice("Squadra"));
        expect(message).toContain('Connected devices: "iPhone 17 Pro"');
        expect(message).toContain("get_apps");
    });

    it("drops apps whose socket is no longer OPEN", () => {
        const stale = makeApp("a", "iPhone 17 Pro", "ios");
        (stale as { ws: { readyState: number } }).ws = { readyState: WebSocket.CLOSED };
        connectedApps.set("a", stale);

        expect(resolveConnectedAppByDevice("iPhone 17 Pro").kind).toBe("none");
        expect(connectedApps.size).toBe(0);
    });
});

describe("getConnectedAppByDevice", () => {
    beforeEach(() => connectedApps.clear());
    afterEach(() => connectedApps.clear());

    it("still throws UserInputError on a miss, now with a triage context", () => {
        connectedApps.set("a", makeApp("a", "iPhone 17 Pro", "ios"));
        try {
            getConnectedAppByDevice("Pixel 7 Pro");
            throw new Error("expected getConnectedAppByDevice to throw");
        } catch (error) {
            expect((error as Error).name).toBe("UserInputError");
            expect((error as { context?: string }).context).toBe("device_mismatch");
        }
    });

    it("tags the no-devices case distinctly", () => {
        try {
            getConnectedAppByDevice("Pixel 7 Pro");
            throw new Error("expected getConnectedAppByDevice to throw");
        } catch (error) {
            expect((error as { context?: string }).context).toBe("no_devices_connected");
        }
    });

    it("returns null (never throws) when no device argument is given", () => {
        expect(getConnectedAppByDevice()).toBeNull();
    });
});
