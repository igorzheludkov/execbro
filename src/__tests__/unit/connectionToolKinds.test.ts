process.env.EXECBRO_TEST_MODE = "1";

import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const scanMetroPorts = jest.fn<any>(async () => []);

jest.unstable_mockModule("../../core/metro.js", () => ({
    scanMetroPorts,
    fetchDevices: jest.fn<any>(async () => []),
    filterDebuggableDevices: (d: any) => d,
    COMMON_PORTS: [8081],
    isPortOpen: jest.fn(),
    selectMainDevice: jest.fn(),
    selectConnectTargets: jest.fn(),
    filterBridgelessDevices: jest.fn(),
    discoverMetroDevices: jest.fn(),
    checkMetroState: jest.fn(),
    chromiumScanPorts: jest.fn(),
    isChromiumListing: jest.fn(),
    isChromiumTarget: () => false,
    otherAppsOnDevice: jest.fn(),
    pickReconnectTarget: jest.fn(),
    pinChromiumName: (d: any) => d.deviceName,
}));

// Registered against a stub server: importing index.js would validate the license over the network.
const { toolRegistry } = await import("../../core/register.js");
const { registerConnectionTools } = await import("../../tools/connectionTools.js");
registerConnectionTools({ registerTool: () => undefined } as never);
const { connectedApps } = await import("../../core/state.js");
const { recordDeviceSeen, resetDevicesSeenThisSession } = await import("../../core/connection.js");

const call = (tool: string, args: Record<string, unknown>) => toolRegistry.get(tool)!.handler(args);

beforeEach(() => {
    connectedApps.clear();
    resetDevicesSeenThisSession();
});

describe("reload_app", () => {
    // 56 reload_app failures in 2026-11-04..18 had a kind computed by reloadApp and dropped by the handler.
    it("forwards the failure kind reloadApp computed", async () => {
        const r = await call("reload_app", {});
        expect(r.isError).toBe(true);
        expect(r._failureKind).toBe("no_metro_server");
    });
});

describe("disconnect_metro on a device that already dropped off", () => {
    beforeEach(() => {
        connectedApps.set("8081-pixel", {
            ws: { readyState: 1, close() {} },
            port: 8081,
            platform: "android",
            deviceInfo: { id: "pixel", title: "App (Pixel 8)", deviceName: "Pixel 8", webSocketDebuggerUrl: "" },
        } as any);
    });

    it("succeeds, since the device is already disconnected", async () => {
        recordDeviceSeen("iPhone 17 Pro");
        const r = await call("disconnect_metro", { device: "iPhone 17 Pro" });
        expect(r.isError).toBeUndefined();
        expect(r.content[0].text).toMatch(/already disconnected/);
        expect(connectedApps.size).toBe(1);
    });

    it("does not read an ambiguous name as dropped", async () => {
        for (const n of ["iPhone 16", "iPhone 17"]) {
            connectedApps.set(`8081-${n}`, { ws: { readyState: 1, close() {} }, port: 8081, platform: "ios", deviceInfo: { id: n, title: `App (${n})`, deviceName: n, webSocketDebuggerUrl: "" } } as any);
            recordDeviceSeen(n);
        }
        await expect(call("disconnect_metro", { device: "iPhone" })).rejects.toThrow(/Multiple devices/);
        expect(connectedApps.size).toBe(3);
    });

    it("still refuses a name that was never connected", async () => {
        await expect(call("disconnect_metro", { device: "Galaxy" })).rejects.toThrow(/Galaxy/);
    });
});
