import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const listIOSSimulatorsMock = jest.fn<() => Promise<{ success: boolean; simulators?: Array<{ name: string; udid: string; state: string; runtime: string }>; error?: string }>>();
const listAndroidDevicesMock = jest.fn<() => Promise<{ success: boolean; devices?: Array<{ id: string; status: string; model?: string }>; error?: string }>>();
const getAndroidEmulatorAvdsMock = jest.fn<() => Promise<string[]>>();
const getAdbIdForAvdMock = jest.fn<(name: string) => Promise<string | null>>();

// Minimal stubs for symbols reached transitively by the jest afterEach setup
// (state.js → bundle.js → connection.js → ios.js/android.js). Only the named
// exports actually imported by those modules need to exist on the mocked
// surface; anything else can be omitted.
jest.unstable_mockModule("../../core/ios.js", () => ({
    listIOSSimulators: listIOSSimulatorsMock,
    findSimulatorByName: jest.fn()
}));
jest.unstable_mockModule("../../core/android.js", () => ({
    listAndroidDevices: listAndroidDevicesMock,
    getAndroidEmulatorAvds: getAndroidEmulatorAvdsMock,
    getAdbIdForAvd: getAdbIdForAvdMock
}));

const { listAllDevices, resetDeviceDiscoveryCache } =
    await import("../../core/deviceDiscovery.js");

describe("listAllDevices", () => {
    beforeEach(() => {
        listIOSSimulatorsMock.mockReset();
        listAndroidDevicesMock.mockReset();
        getAndroidEmulatorAvdsMock.mockReset();
        getAdbIdForAvdMock.mockReset();
        resetDeviceDiscoveryCache();
    });

    it("returns booted+shutdown iOS sims with normalized state", async () => {
        listIOSSimulatorsMock.mockResolvedValue({
            success: true,
            simulators: [
                { name: "iPhone 17 Pro", udid: "ABC-123", state: "Booted", runtime: "iOS 17.4" },
                { name: "iPhone SE", udid: "DEF-456", state: "Shutdown", runtime: "iOS 17.4" }
            ]
        });
        listAndroidDevicesMock.mockResolvedValue({ success: true, devices: [] });
        getAndroidEmulatorAvdsMock.mockResolvedValue([]);

        const result = await listAllDevices();
        expect(result.ios.available).toBe(true);
        expect(result.ios.simulators).toEqual([
            { name: "iPhone 17 Pro", udid: "ABC-123", state: "booted", runtime: "iOS 17.4" },
            { name: "iPhone SE", udid: "DEF-456", state: "shutdown", runtime: "iOS 17.4" }
        ]);
    });

    it("merges running+stopped Android emulators, with serial filled in for running", async () => {
        listIOSSimulatorsMock.mockResolvedValue({ success: true, simulators: [] });
        listAndroidDevicesMock.mockResolvedValue({
            success: true,
            devices: [{ id: "emulator-5554", status: "device" }]
        });
        getAndroidEmulatorAvdsMock.mockResolvedValue(["Pixel_7_API_34", "Tablet_API_33"]);
        getAdbIdForAvdMock.mockImplementation(async (name) =>
            name === "Pixel_7_API_34" ? "emulator-5554" : null
        );

        const result = await listAllDevices();
        expect(result.android.emulators).toEqual([
            { name: "Pixel_7_API_34", serial: "emulator-5554", state: "running" },
            { name: "Tablet_API_33", serial: null, state: "stopped" }
        ]);
    });

    it("separates physical Android devices from emulators", async () => {
        listIOSSimulatorsMock.mockResolvedValue({ success: true, simulators: [] });
        listAndroidDevicesMock.mockResolvedValue({
            success: true,
            devices: [
                { id: "R58M12345", status: "device", model: "Pixel_7" },
                { id: "emulator-5554", status: "device" }
            ]
        });
        getAndroidEmulatorAvdsMock.mockResolvedValue([]);
        getAdbIdForAvdMock.mockResolvedValue(null);

        const result = await listAllDevices();
        expect(result.android.physical).toEqual([
            { model: "Pixel_7", serial: "R58M12345", state: "device" }
        ]);
        expect(result.android.emulators).toEqual([]);
    });

    it("reports ios.available=false when listIOSSimulators fails", async () => {
        listIOSSimulatorsMock.mockResolvedValue({ success: false, error: "xcrun not found" });
        listAndroidDevicesMock.mockResolvedValue({ success: true, devices: [] });
        getAndroidEmulatorAvdsMock.mockResolvedValue([]);

        const result = await listAllDevices();
        expect(result.ios.available).toBe(false);
        expect(result.ios.error).toMatch(/xcrun/);
        expect(result.ios.simulators).toEqual([]);
    });

    it("returns cached result within the TTL window", async () => {
        listIOSSimulatorsMock.mockResolvedValue({ success: true, simulators: [] });
        listAndroidDevicesMock.mockResolvedValue({ success: true, devices: [] });
        getAndroidEmulatorAvdsMock.mockResolvedValue([]);

        await listAllDevices();
        await listAllDevices();
        expect(listIOSSimulatorsMock).toHaveBeenCalledTimes(1);
    });

    it("bypasses the cache when refresh=true", async () => {
        listIOSSimulatorsMock.mockResolvedValue({ success: true, simulators: [] });
        listAndroidDevicesMock.mockResolvedValue({ success: true, devices: [] });
        getAndroidEmulatorAvdsMock.mockResolvedValue([]);

        await listAllDevices();
        await listAllDevices({ refresh: true });
        expect(listIOSSimulatorsMock).toHaveBeenCalledTimes(2);
    });

    it("computes booted/total summary across platforms", async () => {
        listIOSSimulatorsMock.mockResolvedValue({
            success: true,
            simulators: [
                { name: "A", udid: "1", state: "Booted", runtime: "iOS 17.4" },
                { name: "B", udid: "2", state: "Shutdown", runtime: "iOS 17.4" }
            ]
        });
        listAndroidDevicesMock.mockResolvedValue({
            success: true,
            devices: [{ id: "emulator-5554", status: "device" }]
        });
        getAndroidEmulatorAvdsMock.mockResolvedValue(["Pixel_7_API_34", "Tablet_API_33"]);
        getAdbIdForAvdMock.mockImplementation(async (n) => (n === "Pixel_7_API_34" ? "emulator-5554" : null));

        const result = await listAllDevices();
        expect(result.summary).toEqual({ booted: 2, total: 4 });
    });
});
