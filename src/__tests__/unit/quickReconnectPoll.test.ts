import { jest, describe, it, expect, beforeEach } from "@jest/globals";

/**
 * The auto-reconnect used to scan Metro once and give up in 12-45ms, while Metro's target list lags a reload or launch: 32 of 66 `_auto_reconnect` scan failures (2026-11-04..18) had the app back within 30s. It also took "Connection already in progress" as attached and retried before the app was in connectedApps.
 */

const scanMetroPorts = jest.fn<any>(async () => [8081]);
const fetchDevices = jest.fn<any>(async () => []);

jest.unstable_mockModule("../../core/metro.js", () => ({
    scanMetroPorts,
    fetchDevices,
    selectMainDevice: (devices: any[]) => devices[0] ?? null,
    filterDebuggableDevices: (d: any) => d,
    isChromiumTarget: () => false,
    pickReconnectTarget: jest.fn(),
    pinChromiumName: (d: any) => d.deviceName,
}));

const { attemptQuickReconnect } = await import("../../core/jsExecute.js");
const { connectedApps } = await import("../../core/state.js");

const device = { id: "d1", title: "App (iPhone)", deviceName: "iPhone", webSocketDebuggerUrl: "" };
const attach = () => connectedApps.set("8081-d1", { ws: { readyState: 1 }, port: 8081, deviceInfo: device } as any);

describe("attemptQuickReconnect", () => {
    beforeEach(() => {
        connectedApps.clear();
        scanMetroPorts.mockClear();
        fetchDevices.mockReset();
        fetchDevices.mockResolvedValue([]);
    });

    it("keeps looking until Metro lists the target", async () => {
        fetchDevices.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValue([device]);
        const connect = jest.fn<any>(async () => { attach(); return "Connected"; });

        expect(await attemptQuickReconnect(8081, 3000, connect)).toBe(true);
        expect(fetchDevices).toHaveBeenCalledTimes(3);
    });

    it("does not count an attach still in progress as connected", async () => {
        fetchDevices.mockResolvedValue([device]);
        const started = Date.now();
        setTimeout(attach, 800);
        const connect = jest.fn<any>(async () => connectedApps.size ? "Already connected to iPhone" : "Connection already in progress for App (iPhone)");

        expect(await attemptQuickReconnect(8081, 3000, connect)).toBe(true);
        expect(Date.now() - started).toBeGreaterThanOrEqual(700);
        expect(connectedApps.size).toBe(1);
    });

    it("gives up once the budget is spent", async () => {
        const connect = jest.fn<any>(async () => "Connection already in progress for App (iPhone)");
        fetchDevices.mockResolvedValue([device]);
        expect(await attemptQuickReconnect(8081, 1000, connect)).toBe(false);
        expect(connect.mock.calls.length).toBeGreaterThan(1);
    });

    it("looks once without a budget", async () => {
        expect(await attemptQuickReconnect(8081, 0)).toBe(false);
        expect(fetchDevices).toHaveBeenCalledTimes(1);
    });

    it("does not wait when no Metro is running", async () => {
        scanMetroPorts.mockResolvedValueOnce([]);
        expect(await attemptQuickReconnect(8081, 3000)).toBe(false);
        expect(fetchDevices).not.toHaveBeenCalled();
    });
});
