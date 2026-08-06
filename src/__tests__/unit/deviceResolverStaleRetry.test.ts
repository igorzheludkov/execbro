import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * The device inventory cache was raised from 5s to 30s so back-to-back taps stop
 * re-shelling `simctl list` / `adb devices`. That is only safe because a failed
 * resolution retries once against a freshly queried inventory — these tests pin
 * that contract.
 */
const listAllDevices = jest.fn<() => Promise<unknown>>();
const resetDeviceDiscoveryCache = jest.fn<() => void>();

jest.unstable_mockModule("../../core/deviceDiscovery.js", () => ({
    listAllDevices,
    resetDeviceDiscoveryCache,
}));
jest.unstable_mockModule("../../core/connection.js", () => ({
    getConnectedApps: () => [],
    findDisconnectedDeviceName: () => null,
}));
jest.unstable_mockModule("../../core/projectMemory.js", () => ({
    listDevices: () => [],
    recordDevice: () => undefined,
}));

const empty = {
    ios: { available: true, simulators: [] },
    android: { available: true, emulators: [], physical: [] },
    summary: { booted: 0, total: 0 },
};

const withBootedSim = {
    ios: {
        available: true,
        simulators: [
            { name: "iPhone Air", udid: "F93612A3-0042-4BDC-855F-8CAB1BDD76C6", state: "booted", runtime: "iOS 26.0" },
        ],
    },
    android: { available: true, emulators: [], physical: [] },
    summary: { booted: 1, total: 1 },
};

const { resolveDeviceTarget } = await import("../../core/deviceResolver.js");

describe("resolveDeviceTarget stale-inventory retry", () => {
    beforeEach(() => {
        listAllDevices.mockReset();
        resetDeviceDiscoveryCache.mockReset();
    });

    it("re-queries a fresh inventory when the device wasn't found", async () => {
        // First pass: cached inventory is stale and has nothing. Second pass:
        // the simulator that was booted moments ago shows up.
        listAllDevices
            .mockResolvedValueOnce(empty)
            .mockResolvedValue(withBootedSim);

        const result = await resolveDeviceTarget("F93612A3-0042-4BDC-855F-8CAB1BDD76C6");

        expect(resetDeviceDiscoveryCache).toHaveBeenCalledTimes(1);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.target.deviceName).toBe("iPhone Air");
    });

    it("does not pay for a refresh when resolution succeeds first time", async () => {
        listAllDevices.mockResolvedValue(withBootedSim);

        const result = await resolveDeviceTarget("F93612A3-0042-4BDC-855F-8CAB1BDD76C6");

        expect(result.ok).toBe(true);
        expect(resetDeviceDiscoveryCache).not.toHaveBeenCalled();
    });

    it("still reports the failure when a fresh inventory also has no match", async () => {
        listAllDevices.mockResolvedValue(empty);

        const result = await resolveDeviceTarget("F93612A3-0042-4BDC-855F-8CAB1BDD76C6");

        expect(result.ok).toBe(false);
        expect(resetDeviceDiscoveryCache).toHaveBeenCalledTimes(1);
        if (!result.ok) expect(result.error.code).toBe("DEVICE_NOT_FOUND");
    });
});
