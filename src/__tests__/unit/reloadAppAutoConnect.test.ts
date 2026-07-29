import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";

// reload_app's auto-connect used to be unreachable whenever a `device`
// argument was supplied: the first resolve threw UserInputError before the
// fallback ran, so 35% of reload_app failures were "run scan_metro" told to
// agents the tool could have unblocked itself. These tests pin the recovery.

const scanMetroPortsMock = jest.fn<() => Promise<number[]>>();
const fetchDevicesMock = jest.fn<(port: number) => Promise<unknown[]>>();
const filterDebuggableDevicesMock = jest.fn<(devices: unknown[]) => unknown[]>();

jest.unstable_mockModule("../../core/metro.js", () => ({
    scanMetroPorts: scanMetroPortsMock,
    fetchDevices: fetchDevicesMock,
    filterDebuggableDevices: filterDebuggableDevicesMock,
    // Other importers in the graph (connection.js, bundle.js) resolve these at
    // import time, so the mock has to cover the module's full surface.
    COMMON_PORTS: [8081],
    isPortOpen: jest.fn(),
    selectMainDevice: jest.fn(),
    filterBridgelessDevices: jest.fn(),
    discoverMetroDevices: jest.fn(),
    checkMetroState: jest.fn()
}));

const { connectedApps } = await import("../../core/state.js");
const { reloadApp } = await import("../../core/debugGlobals.js");

describe("reloadApp auto-connect", () => {
    beforeEach(() => {
        connectedApps.clear();
        scanMetroPortsMock.mockReset();
        fetchDevicesMock.mockReset();
        filterDebuggableDevicesMock.mockReset();
        fetchDevicesMock.mockResolvedValue([]);
        filterDebuggableDevicesMock.mockReturnValue([]);
    });
    afterEach(() => connectedApps.clear());

    it("attempts auto-connect even when a device argument is supplied", async () => {
        scanMetroPortsMock.mockResolvedValue([8081]);

        const result = await reloadApp("iPhone 17 Pro");

        expect(result.success).toBe(false);
        // The regression: previously this threw before scanMetroPorts was reached.
        expect(scanMetroPortsMock).toHaveBeenCalled();
        expect(fetchDevicesMock).toHaveBeenCalledWith(8081);
    }, 15000);

    it("retries the sweep once before giving up (Metro's target list lags app start)", async () => {
        scanMetroPortsMock.mockResolvedValue([8081]);

        await reloadApp("iPhone 17 Pro");

        expect(fetchDevicesMock).toHaveBeenCalledTimes(2);
    }, 15000);

    it("returns a failure result rather than throwing, tagged for telemetry", async () => {
        scanMetroPortsMock.mockResolvedValue([8081]);

        const result = await reloadApp("iPhone 17 Pro");

        expect(result.success).toBe(false);
        expect(result.errorContext).toBe("connect_failed_with_device");
        // Metro was up but exposed no debuggable target — say so instead of
        // the opaque "could not connect to any device".
        expect(result.error).toContain("no debuggable targets");
    }, 15000);

    it("tags the no-Metro case separately", async () => {
        scanMetroPortsMock.mockResolvedValue([]);

        const result = await reloadApp("iPhone 17 Pro");

        expect(result.errorContext).toBe("no_metro");
        expect(result.error).toContain("Metro bundler is running");
    });
});
