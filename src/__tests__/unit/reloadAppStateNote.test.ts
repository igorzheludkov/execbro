import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import WebSocket from "ws";

// Sonnet suite Cs, C2: the agent reproduced the bug, called reload_app, then
// checked the fix in the reset app (no toast, so no bug) and called it tested.
// The success result now says the in-memory state was reset.

const fetchDevicesMock = jest.fn<(port: number) => Promise<unknown[]>>();
const connectToDeviceMock = jest.fn<(dev: { id: string }, port: number) => Promise<string>>();

const app = {
    ws: { readyState: WebSocket.OPEN, send: jest.fn(), close: jest.fn() } as unknown as WebSocket,
    deviceInfo: { id: "dev-1", title: "App (iPhone Air)", deviceName: "iPhone Air" },
    port: 8090,
    platform: "ios"
};

jest.unstable_mockModule("../../core/metro.js", () => ({
    scanMetroPorts: jest.fn(),
    fetchDevices: fetchDevicesMock,
    filterDebuggableDevices: jest.fn(),
    COMMON_PORTS: [8081],
    isPortOpen: jest.fn(),
    selectMainDevice: jest.fn(),
    filterBridgelessDevices: jest.fn(),
    discoverMetroDevices: jest.fn(),
    checkMetroState: jest.fn(),
    isChromiumTarget: () => false,
    pickReconnectTarget: jest.fn(),
    pinChromiumName: (d: { deviceName: string }) => d.deviceName
}));
jest.unstable_mockModule("../../core/connection.js", () => ({
    resolveConnectedAppByDevice: () => ({ kind: "ok", app }),
    describeDeviceResolution: jest.fn(),
    failureKindForResolution: jest.fn(),
    connectToDevice: connectToDeviceMock,
    autoConnectSweep: jest.fn(),
    describeConnectionFailure: jest.fn(),
    getFirstConnectedApp: jest.fn(),
    getConnectedAppByDevice: jest.fn(),
    getConnectedAppBySimulatorUdid: jest.fn(),
    getConnectedAppByAndroidDeviceId: jest.fn(),
    clearReconnectionSuppression: jest.fn(),
    purgeStaleConnectionsForPorts: jest.fn(),
    createWebSocketWithOriginFallback: jest.fn()
}));

const { connectedApps } = await import("../../core/state.js");
const { reloadApp, RELOAD_STATE_NOTE } = await import("../../core/debugGlobals.js");

describe("reload_app result", () => {
    beforeEach(() => {
        connectedApps.clear();
        fetchDevicesMock.mockReset();
        connectToDeviceMock.mockReset();
    });

    it("success result tells the agent the app state was reset", async () => {
        fetchDevicesMock.mockResolvedValue([app.deviceInfo]);
        connectToDeviceMock.mockImplementation(async (dev, port) => {
            connectedApps.set(`${port}-${dev.id}`, app as never);
            return "connected";
        });

        const result = await reloadApp();

        expect(result.success).toBe(true);
        expect(result.result).toContain("App reloaded and reconnected to iPhone Air");
        expect(result.result).toContain(RELOAD_STATE_NOTE);
    }, 15000);

    it("a reload that did not reconnect keeps its current text", async () => {
        fetchDevicesMock.mockResolvedValue([]);

        const result = await reloadApp();

        expect(result.result).toBe("App reloaded but could not auto-reconnect. Run 'scan_metro' to reconnect.");
    }, 15000);
});
