import { selectMainDevice } from "../../core/metro.js";
import { DeviceInfo } from "../../core/types.js";

function makeDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
    return {
        id: "test-id",
        title: "Test Device",
        description: "Test Description",
        appId: "com.test.app",
        type: "node",
        webSocketDebuggerUrl: "ws://localhost:8081/inspector/device?page=1",
        deviceName: "Test",
        ...overrides,
    };
}

describe("selectMainDevice", () => {
    it("returns null for empty list", () => {
        expect(selectMainDevice([])).toBeNull();
    });

    it("prefers Bridgeless device (Expo SDK 54+)", () => {
        const devices = [
            makeDevice({ id: "hermes", title: "Hermes React Native" }),
            makeDevice({ id: "bridgeless", description: "React Native Bridgeless [C++ (Hermes)]" }),
        ];
        expect(selectMainDevice(devices)?.id).toBe("bridgeless");
    });

    it("prefers Hermes when no Bridgeless available", () => {
        const devices = [
            makeDevice({ id: "generic", title: "React Native" }),
            makeDevice({ id: "hermes", title: "Hermes React Native" }),
        ];
        expect(selectMainDevice(devices)?.id).toBe("hermes");
    });

    it("selects Hermes by title containing 'Hermes'", () => {
        const devices = [
            makeDevice({ id: "hermes", title: "Some Hermes Runtime" }),
        ];
        expect(selectMainDevice(devices)?.id).toBe("hermes");
    });

    it("falls back to React Native excluding Reanimated", () => {
        const devices = [
            makeDevice({ id: "reanimated", title: "Reanimated React Native" }),
            makeDevice({ id: "rn", title: "React Native" }),
        ];
        expect(selectMainDevice(devices)?.id).toBe("rn");
    });

    it("excludes Experimental devices from React Native fallback", () => {
        const devices = [
            makeDevice({ id: "exp", title: "Experimental React Native" }),
            makeDevice({ id: "rn", title: "React Native" }),
        ];
        expect(selectMainDevice(devices)?.id).toBe("rn");
    });

    it("falls back to first device when no RN match", () => {
        const devices = [
            makeDevice({ id: "first", title: "Unknown Device" }),
            makeDevice({ id: "second", title: "Other Device" }),
        ];
        expect(selectMainDevice(devices)?.id).toBe("first");
    });
});
