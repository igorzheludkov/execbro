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
const findDisconnectedDeviceNameMock =
    jest.fn<(device: string) => { name: string; lastSeenAt: number } | null>(() => null);

jest.unstable_mockModule("../../core/connection.js", () => ({
    getConnectedApps: getConnectedAppsMock,
    findDisconnectedDeviceName: findDisconnectedDeviceNameMock,
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

    it("never throws when a matched remembered device has a non-numeric lastUsedAt (regression)", async () => {
        listAllDevicesMock.mockResolvedValue({
            ios: { available: true, simulators: [{ udid: "AAAAAAAA-0000-0000-0000-000000000001", name: "iPhone Air", state: "booted" }] },
            android: { available: true, emulators: [{ serial: "emulator-5554", name: "Pixel", state: "running" }], physical: [] },
            summary: { booted: 1, total: 2 },
        });
        listDevicesMock.mockReturnValue([
            { identifier: "AAAAAAAA-0000-0000-0000-000000000001", name: "iPhone Air", platform: "ios", lastUsedAt: undefined as any },
        ]);
        let r: Awaited<ReturnType<typeof resolveDeviceTarget>> | undefined;
        await expect((async () => { r = await resolveDeviceTarget(); })()).resolves.not.toThrow();
        expect(r?.ok).toBe(true);
        if (r?.ok) {
            expect(r.target.iosUdid).toBe("AAAAAAAA-0000-0000-0000-000000000001");
            expect(r.note).toContain("last used unknown");
        }
    });

    it("skips a disconnected most-recent remembered device and falls through to the next connected one (spec §7.3)", async () => {
        listAllDevicesMock.mockResolvedValue({
            ios: { available: true, simulators: [{ udid: "AAAAAAAA-0000-0000-0000-000000000001", name: "iPhone Air", state: "booted" }] },
            android: { available: true, emulators: [{ serial: "emulator-5554", name: "Pixel", state: "running" }], physical: [] },
            summary: { booted: 1, total: 2 },
        });
        listDevicesMock.mockReturnValue([
            { identifier: "DISCONNECTED-UDID", name: "Gone", platform: "ios", lastUsedAt: 9000 },
            { identifier: "emulator-5554", name: "Pixel", platform: "android", lastUsedAt: 1000 },
        ]);
        const r = await resolveDeviceTarget();
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.target.platform).toBe("android");
            expect(r.target.androidSerial).toBe("emulator-5554");
        }
    });

    // B1 (2026-08-22): ios_boot_simulator resolved its own UDID through the
    // booted gate, so the tool that boots shut-down simulators was told to boot
    // the simulator first — 10 of its 11 calls failed on that circular error.
    // The pair below is the contract: the boot path opts out of the gate, every
    // other tool keeps it.
    describe("allowShutdown (ios_boot_simulator path)", () => {
        const shutdownSim = {
            ios: {
                available: true,
                simulators: [
                    { name: "iPhone 17", udid: "ABCDEF12-3456-7890-ABCD-EF1234567890", state: "shutdown", runtime: "iOS 26.0" }
                ]
            },
            android: { available: true, emulators: [], physical: [] },
            summary: { booted: 0, total: 1 }
        };

        it("resolves a shut-down simulator UDID when allowShutdown is set", async () => {
            listAllDevicesMock.mockResolvedValue(shutdownSim);

            const r = await resolveDeviceTarget("ABCDEF12-3456-7890-ABCD-EF1234567890", { allowShutdown: true });
            expect(r.ok).toBe(true);
            if (r.ok) {
                expect(r.target.platform).toBe("ios");
                expect(r.target.iosUdid).toBe("ABCDEF12-3456-7890-ABCD-EF1234567890");
                expect(r.target.deviceName).toBe("iPhone 17");
                expect(r.target.source).toBe("udid");
            }
        });

        it("still errors SIMULATOR_NOT_BOOTED for the same simulator without the flag", async () => {
            listAllDevicesMock.mockResolvedValue(shutdownSim);

            const r = await resolveDeviceTarget("ABCDEF12-3456-7890-ABCD-EF1234567890");
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.error.code).toBe("SIMULATOR_NOT_BOOTED");
        });

        it("still errors DEVICE_NOT_FOUND on a typo'd UDID even with allowShutdown", async () => {
            listAllDevicesMock.mockResolvedValue(shutdownSim);

            const r = await resolveDeviceTarget("11111111-2222-3333-4444-555555555555", { allowShutdown: true });
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.error.code).toBe("DEVICE_NOT_FOUND");
        });
    });

    // B2 (2026-08-22): step 2 was gated on /^emulator-\d+$/, so a real serial
    // skipped serial resolution entirely and died in name matching.
    describe("physical Android serials", () => {
        it("resolves an exact physical serial to an adb-serial target", async () => {
            listAllDevicesMock.mockResolvedValue({
                ...emptyDiscovery(),
                android: {
                    available: true,
                    emulators: [],
                    physical: [{ serial: "P2228K000422", model: "Pixel 8", state: "device" }]
                }
            });

            const r = await resolveDeviceTarget("P2228K000422");
            expect(r.ok).toBe(true);
            if (r.ok) {
                expect(r.target.platform).toBe("android");
                expect(r.target.androidSerial).toBe("P2228K000422");
                expect(r.target.deviceName).toBe("Pixel 8");
                expect(r.target.source).toBe("adb-serial");
            }
        });

        it("prefers the RN registry deviceName for a physical serial, as it already does for emulators", async () => {
            listAllDevicesMock.mockResolvedValue({
                ...emptyDiscovery(),
                android: {
                    available: true,
                    emulators: [],
                    physical: [{ serial: "29091FDH30061X", model: "Pixel 6a", state: "device" }]
                }
            });
            getConnectedAppsMock.mockReturnValue([
                {
                    app: {
                        platform: "android",
                        adbSerial: "29091FDH30061X",
                        deviceInfo: { deviceName: "Pixel 6a - 14 - API 34" }
                    }
                }
            ]);

            const r = await resolveDeviceTarget("29091FDH30061X");
            expect(r.ok).toBe(true);
            if (r.ok) {
                expect(r.target.deviceName).toBe("Pixel 6a - 14 - API 34");
                expect(r.target.source).toBe("adb-serial");
            }
        });

        it("errors DEVICE_NOT_FOUND on an unknown physical serial", async () => {
            listAllDevicesMock.mockResolvedValue({
                ...emptyDiscovery(),
                android: {
                    available: true,
                    emulators: [],
                    physical: [{ serial: "P2228K000422", model: "Pixel 8", state: "device" }]
                }
            });

            const r = await resolveDeviceTarget("P2228K000499");
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.error.code).toBe("DEVICE_NOT_FOUND");
        });

        it("keeps the precise serial error for an unknown emulator-NNNN argument", async () => {
            const r = await resolveDeviceTarget("emulator-5559");
            expect(r.ok).toBe(false);
            if (!r.ok) {
                expect(r.error.code).toBe("DEVICE_NOT_FOUND");
                expect(r.error.message).toMatch(/No Android device with serial/);
            }
        });
    });
});
