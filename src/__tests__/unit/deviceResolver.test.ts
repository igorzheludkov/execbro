import { describe, it, expect, jest, beforeEach } from "@jest/globals";

type ConnectedAppRegistryEntry = {
    key?: string;
    isConnected?: boolean;
    app: {
        platform: "ios" | "android";
        simulatorUdid?: string;
        adbSerial?: string;
        deviceInfo: { deviceName: string };
    };
};

const getConnectedAppsMock = jest.fn<() => ConnectedAppRegistryEntry[]>();
const listAllDevicesMock = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule("../../core/connection.js", () => ({
    getConnectedApps: getConnectedAppsMock,
    // Minimal extras the setup chain may reach via state.js/bundle.js
    createWebSocketWithOriginFallback: jest.fn(),
    getConnectedAppByDevice: jest.fn(),
    getConnectedAppBySimulatorUdid: jest.fn(),
    getConnectedAppByAndroidDeviceId: jest.fn(),
    getFirstConnectedApp: jest.fn(),
    connectToDevice: jest.fn(),
    clearReconnectionSuppression: jest.fn(),
    purgeStaleConnectionsForPorts: jest.fn()
}));
jest.unstable_mockModule("../../core/deviceDiscovery.js", () => ({
    listAllDevices: listAllDevicesMock,
    resetDeviceDiscoveryCache: jest.fn()
}));

const recordDeviceMock = jest.fn();
const listDevicesMock = jest.fn<() => Array<{ identifier: string; name: string; platform: "ios" | "android"; lastUsedAt: number }>>();
jest.unstable_mockModule("../../core/projectMemory.js", () => ({
    recordDevice: recordDeviceMock,
    listDevices: listDevicesMock,
    recordScreenMetrics: jest.fn(),
}));

const { resolveDeviceTarget } = await import("../../core/deviceResolver.js");

function emptyDiscovery() {
    return {
        ios: { available: true, simulators: [] },
        android: { available: true, emulators: [], physical: [] },
        summary: { booted: 0, total: 0 }
    };
}

describe("resolveDeviceTarget", () => {
    beforeEach(() => {
        getConnectedAppsMock.mockReset();
        listAllDevicesMock.mockReset();
        getConnectedAppsMock.mockReturnValue([]);
        listAllDevicesMock.mockResolvedValue(emptyDiscovery());
        recordDeviceMock.mockReset();
        listDevicesMock.mockReset();
        listDevicesMock.mockReturnValue([]);
    });

    it("resolves an iOS simulator UDID directly to a booted iOS target", async () => {
        listAllDevicesMock.mockResolvedValue({
            ...emptyDiscovery(),
            ios: {
                available: true,
                simulators: [
                    { name: "iPhone 17 Pro", udid: "12345678-1234-1234-1234-123456789012", state: "booted", runtime: "iOS 17.4" }
                ]
            }
        });

        const r = await resolveDeviceTarget("12345678-1234-1234-1234-123456789012");
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.target.platform).toBe("ios");
            expect(r.target.iosUdid).toBe("12345678-1234-1234-1234-123456789012");
            expect(r.target.source).toBe("udid");
        }
    });

    it("errors with SIMULATOR_NOT_BOOTED when a shutdown sim UDID is passed", async () => {
        listAllDevicesMock.mockResolvedValue({
            ...emptyDiscovery(),
            ios: {
                available: true,
                simulators: [
                    { name: "iPhone SE", udid: "ABCDEF12-3456-7890-ABCD-EF1234567890", state: "shutdown", runtime: "iOS 17.4" }
                ]
            }
        });

        const r = await resolveDeviceTarget("ABCDEF12-3456-7890-ABCD-EF1234567890");
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error.code).toBe("SIMULATOR_NOT_BOOTED");
            expect(r.error.message).toMatch(/ios_boot_simulator/);
        }
    });

    it("resolves an emulator-NNNN serial to Android", async () => {
        listAllDevicesMock.mockResolvedValue({
            ...emptyDiscovery(),
            android: {
                available: true,
                emulators: [{ name: "Pixel_7_API_34", serial: "emulator-5554", state: "running" }],
                physical: []
            }
        });

        const r = await resolveDeviceTarget("emulator-5554");
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.target.platform).toBe("android");
            expect(r.target.androidSerial).toBe("emulator-5554");
            expect(r.target.source).toBe("adb-serial");
        }
    });

    it("matches the RN registry by deviceName substring (iOS)", async () => {
        getConnectedAppsMock.mockReturnValue([
            {
                app: {
                    platform: "ios",
                    simulatorUdid: "12345678-1234-1234-1234-123456789012",
                    deviceInfo: { deviceName: "iPhone 17 Pro" }
                }
            }
        ]);

        const r = await resolveDeviceTarget("17 Pro");
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.target.platform).toBe("ios");
            expect(r.target.iosUdid).toBe("12345678-1234-1234-1234-123456789012");
            expect(r.target.source).toBe("registry");
        }
    });

    it("matches the RN registry across punctuation drift (SM_A356N vs SM-A356N - 15 - API 35)", async () => {
        getConnectedAppsMock.mockReturnValue([
            {
                app: {
                    platform: "android",
                    adbSerial: "RFCX90KEYBM",
                    deviceInfo: { deviceName: "SM-A356N - 15 - API 35" }
                }
            }
        ]);

        const r = await resolveDeviceTarget("SM_A356N");
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.target.platform).toBe("android");
            expect(r.target.androidSerial).toBe("RFCX90KEYBM");
            expect(r.target.source).toBe("registry");
        }
    });

    it("OS-level match survives punctuation drift on Android model names", async () => {
        listAllDevicesMock.mockResolvedValue({
            ...emptyDiscovery(),
            android: {
                available: true,
                emulators: [],
                physical: [{ serial: "RFCX90KEYBM", model: "SM-A356N - 15 - API 35", state: "device" }]
            }
        });

        const r = await resolveDeviceTarget("SM_A356N");
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.target.platform).toBe("android");
            expect(r.target.androidSerial).toBe("RFCX90KEYBM");
            expect(r.target.source).toBe("name-match");
        }
    });

    it("matches the RN registry by deviceName substring (Android)", async () => {
        getConnectedAppsMock.mockReturnValue([
            {
                app: {
                    platform: "android",
                    adbSerial: "emulator-5554",
                    deviceInfo: { deviceName: "sdk_gphone64_arm64" }
                }
            }
        ]);

        const r = await resolveDeviceTarget("gphone");
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.target.platform).toBe("android");
            expect(r.target.androidSerial).toBe("emulator-5554");
            expect(r.target.source).toBe("registry");
        }
    });

    it("errors with MULTIPLE_DEVICES_MATCH when registry has two matches", async () => {
        getConnectedAppsMock.mockReturnValue([
            {
                app: {
                    platform: "ios",
                    simulatorUdid: "12345678-1234-1234-1234-123456789012",
                    deviceInfo: { deviceName: "iPhone 17 Pro" }
                }
            },
            {
                app: {
                    platform: "android",
                    adbSerial: "emulator-5554",
                    deviceInfo: { deviceName: "iPhone-named-Android" }
                }
            }
        ]);

        const r = await resolveDeviceTarget("iPhone");
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error.code).toBe("MULTIPLE_DEVICES_MATCH");
            expect(r.error.candidates).toHaveLength(2);
        }
    });

    it("falls back to OS-level name match when registry is empty", async () => {
        listAllDevicesMock.mockResolvedValue({
            ...emptyDiscovery(),
            ios: {
                available: true,
                simulators: [
                    { name: "iPhone 17 Pro", udid: "12345678-1234-1234-1234-123456789012", state: "booted", runtime: "iOS 17.4" }
                ]
            }
        });

        const r = await resolveDeviceTarget("17 Pro");
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.target.source).toBe("name-match");
            expect(r.target.iosUdid).toBe("12345678-1234-1234-1234-123456789012");
        }
    });

    it("defaults to the single available device when no arg is passed", async () => {
        listAllDevicesMock.mockResolvedValue({
            ...emptyDiscovery(),
            ios: {
                available: true,
                simulators: [
                    { name: "iPhone 17 Pro", udid: "12345678-1234-1234-1234-123456789012", state: "booted", runtime: "iOS 17.4" }
                ]
            }
        });

        const r = await resolveDeviceTarget();
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.target.source).toBe("default");
            expect(r.target.platform).toBe("ios");
        }
    });

    it("errors with MULTIPLE_DEVICES_MATCH when no arg + multiple booted devices", async () => {
        listAllDevicesMock.mockResolvedValue({
            ...emptyDiscovery(),
            ios: {
                available: true,
                simulators: [
                    { name: "iPhone 17 Pro", udid: "12345678-1234-1234-1234-123456789012", state: "booted", runtime: "iOS 17.4" }
                ]
            },
            android: {
                available: true,
                emulators: [{ name: "Pixel_7_API_34", serial: "emulator-5554", state: "running" }],
                physical: []
            }
        });

        const r = await resolveDeviceTarget();
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error.code).toBe("MULTIPLE_DEVICES_MATCH");
        }
    });

    it("errors with NO_DEVICES_FOUND when nothing is running and no arg is passed", async () => {
        const r = await resolveDeviceTarget();
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error.code).toBe("NO_DEVICES_FOUND");
        }
    });

    it("errors with DEVICE_NOT_FOUND when arg matches nothing", async () => {
        listAllDevicesMock.mockResolvedValue({
            ...emptyDiscovery(),
            ios: {
                available: true,
                simulators: [
                    { name: "iPhone 17 Pro", udid: "12345678-1234-1234-1234-123456789012", state: "booted", runtime: "iOS 17.4" }
                ]
            }
        });

        const r = await resolveDeviceTarget("Pixel");
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error.code).toBe("DEVICE_NOT_FOUND");
        }
    });

    it("records the device on a successful UDID resolution", async () => {
        listAllDevicesMock.mockResolvedValue({
            ios: { available: true, simulators: [{ udid: "ABCDEF12-3456-7890-ABCD-EF1234567890", name: "iPhone Air", state: "booted" }] },
            android: { available: true, emulators: [], physical: [] },
            summary: { booted: 1, total: 1 },
        });
        const r = await resolveDeviceTarget("ABCDEF12-3456-7890-ABCD-EF1234567890");
        expect(r.ok).toBe(true);
        expect(recordDeviceMock).toHaveBeenCalledWith(expect.objectContaining({
            identifier: "ABCDEF12-3456-7890-ABCD-EF1234567890", platform: "ios", name: "iPhone Air",
        }));
    });

    it("auto-defaults to the most-recent still-connected device on no-hint ambiguity", async () => {
        listAllDevicesMock.mockResolvedValue({
            ios: { available: true, simulators: [{ udid: "AAAAAAAA-0000-0000-0000-000000000001", name: "iPhone Air", state: "booted" }] },
            android: { available: true, emulators: [{ serial: "emulator-5554", name: "Pixel", state: "running" }], physical: [] },
            summary: { booted: 1, total: 2 },
        });
        listDevicesMock.mockReturnValue([
            { identifier: "AAAAAAAA-0000-0000-0000-000000000001", name: "iPhone Air", platform: "ios", lastUsedAt: 5000 },
            { identifier: "emulator-5554", name: "Pixel", platform: "android", lastUsedAt: 1000 },
        ]);
        const r = await resolveDeviceTarget();
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.target.iosUdid).toBe("AAAAAAAA-0000-0000-0000-000000000001");
            expect(r.note).toContain("pass device=");
        }
    });

    it("still errors on no-hint ambiguity when no remembered device is connected", async () => {
        listAllDevicesMock.mockResolvedValue({
            ios: { available: true, simulators: [{ udid: "AAAAAAAA-0000-0000-0000-000000000001", name: "iPhone Air", state: "booted" }] },
            android: { available: true, emulators: [{ serial: "emulator-5554", name: "Pixel", state: "running" }], physical: [] },
            summary: { booted: 1, total: 2 },
        });
        listDevicesMock.mockReturnValue([
            { identifier: "OLD-DISCONNECTED-UDID", name: "Gone", platform: "ios", lastUsedAt: 9000 },
        ]);
        const r = await resolveDeviceTarget();
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("MULTIPLE_DEVICES_MATCH");
    });
});
