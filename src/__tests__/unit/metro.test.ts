import { describe, it, expect } from "@jest/globals";
import { selectMainDevice, COMMON_PORTS } from "../../core/metro.js";
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

describe("default scan range", () => {
    it("covers ten contiguous ports from 8081", () => {
        expect(COMMON_PORTS[0]).toBe(8081);
        expect(COMMON_PORTS).toHaveLength(10);
        expect(COMMON_PORTS[COMMON_PORTS.length - 1]).toBe(8090);
    });

    it("is contiguous, so no port in the range is silently skipped", () => {
        // The previous list jumped 8082 -> 19000, which made a third Metro on
        // 8083 invisible to a default scan while still reporting success.
        for (let i = 1; i < COMMON_PORTS.length; i++) {
            expect(COMMON_PORTS[i] - COMMON_PORTS[i - 1]).toBe(1);
        }
    });

    it("no longer probes the Expo 19xxx ports", () => {
        expect(COMMON_PORTS.some((p) => p >= 19000)).toBe(false);
    });
});
