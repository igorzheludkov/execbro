import { describe, it, expect } from "@jest/globals";
import { matchesExpectedLaunch } from "../../core/connection.js";
import type { ConnectedApp } from "../../core/types.js";

/**
 * ensure_connection({ waitMs }) after a launch waits for the launched device,
 * not for any app: an Electron window already connected used to end the wait
 * before a USB iPhone had attached.
 */

const app = (over: Partial<ConnectedApp> & { deviceName: string }): ConnectedApp =>
    ({ platform: "ios", ...over, deviceInfo: { deviceName: over.deviceName } } as unknown as ConnectedApp);

describe("matchesExpectedLaunch", () => {
    it("matches a simulator by UDID and an emulator by serial", () => {
        expect(matchesExpectedLaunch(app({ deviceName: "iPhone Air", simulatorUdid: "SIM-1" }), { platform: "ios", id: "SIM-1" })).toBe(true);
        expect(matchesExpectedLaunch(app({ deviceName: "iPhone Air", simulatorUdid: "SIM-2" }), { platform: "ios", id: "SIM-1" })).toBe(false);
        expect(matchesExpectedLaunch(app({ platform: "android", deviceName: "sdk_gphone", adbSerial: "emulator-5554" }), { platform: "android", id: "emulator-5554" })).toBe(true);
    });

    it("matches a phone by name, never a simulator or a chromium window with that name", () => {
        const phone = { platform: "ios" as const, phoneName: "iPhone" };
        expect(matchesExpectedLaunch(app({ deviceName: "iPhone" }), phone)).toBe(true);
        expect(matchesExpectedLaunch(app({ deviceName: "iPhone", simulatorUdid: "SIM-1" }), phone)).toBe(false);
        expect(matchesExpectedLaunch(app({ platform: "chromium", deviceName: "iPhone" }), phone)).toBe(false);
    });
});
