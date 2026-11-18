import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * The screenshot tool's failures carried no structured kind, so telemetry could not tell "no device attached" from "wrong name" from a capture defect. Nothing here touches a device: the capture functions and the resolver are stubbed.
 */

type Handler = (args: Record<string, unknown>) => Promise<any>;
const handlers = new Map<string, Handler>();
jest.unstable_mockModule("../../core/register.js", () => ({
    registerToolWithTelemetry: (_s: unknown, name: string, _c: unknown, handler: Handler) => {
        handlers.set(name, handler);
    },
}));

const resolveMock = jest.fn<(device?: string) => Promise<any>>();
jest.unstable_mockModule("../../core/deviceResolver.js", () => ({
    resolveDeviceTarget: resolveMock,
    formatResolverError: (e: { message: string }) => e.message,
}));

const iosShot = jest.fn<(...a: unknown[]) => Promise<any>>();
const androidShot = jest.fn<(...a: unknown[]) => Promise<any>>();
const bootedSim = jest.fn<() => Promise<string | null>>();
jest.unstable_mockModule("../../core/index.js", () => ({
    iosScreenshot: iosShot,
    androidScreenshot: androidShot,
    detectLogBox: async () => null,
    formatLogBoxWarning: () => "",
    getScreenState: async () => null,
    formatScreenStateSummary: () => "",
    imageBuffer: { add: () => {} },
    getActiveOrBootedSimulatorUdid: bootedSim,
    connectedApps: new Map(),
    getConnectedAppBySimulatorUdid: () => null,
    getConnectedAppByAndroidDeviceId: () => null,
    iosDescribeAll: async () => null,
    detectIOSSystemOverlay: async () => null,
    formatIOSSystemOverlayWarning: () => "",
    androidGetStatusBarHeight: async () => null,
    androidGetDensity: async () => null,
}));

const missReason = jest.fn<(hint: string, knownPhysical: boolean) => { message: string; kind: string } | null>();
jest.unstable_mockModule("../../core/iosPhysical.js", () => ({
    resolvePhysicalIosDevice: async () => null,
    physicalIosScreenshot: jest.fn(),
    physicalMissReason: missReason,
}));
jest.unstable_mockModule("../../pro/physicalTap.js", () => ({
    physicalTargetFor: async () => null,
}));
jest.unstable_mockModule("../../core/connection.js", () => ({
    chromiumAppFor: () => null,
    findDisconnectedDeviceName: () => null,
}));
jest.unstable_mockModule("../../core/chromium.js", () => ({ chromiumCapture: jest.fn() }));
jest.unstable_mockModule("../../core/chromiumScreen.js", () => ({ chromiumScreenState: jest.fn() }));

const { registerScreenshotTools } = await import("../../tools/screenshotTools.js");
registerScreenshotTools({} as never);
const screenshot = (args: Record<string, unknown> = {}) => handlers.get("screenshot")!(args);
const iosLegacy = (args: Record<string, unknown>) => handlers.get("ios_screenshot")!(args);
const androidLegacy = (args: Record<string, unknown>) => handlers.get("android_screenshot")!(args);

const fail = (code: string, message = "nope") => ({ ok: false, error: { code, message } });
const ok = (platform: "ios" | "android") => ({
    ok: true,
    target: platform === "ios"
        ? { platform, iosUdid: "F93612A3-0042-4BDC-855F-8CAB1BDD76C6", deviceName: "iPhone 17", source: "default" }
        : { platform, androidSerial: "emulator-5554", deviceName: "Pixel", source: "default" },
});

beforeEach(() => {
    resolveMock.mockReset();
    iosShot.mockReset();
    androidShot.mockReset();
    missReason.mockReset();
    missReason.mockReturnValue(null);
    bootedSim.mockReset();
    bootedSim.mockResolvedValue(null);
});

describe("screenshot failure kinds", () => {
    it.each([
        ["NO_DEVICES_FOUND", "no_devices_attached"],
        ["SIMULATOR_NOT_BOOTED", "no_ios_simulator"],
        ["DEVICE_NOT_FOUND", "bad_arguments"],
    ])("resolver %s -> %s", async (code, kind) => {
        resolveMock.mockResolvedValue(fail(code));
        const r = await screenshot({ device: "whatever" });
        expect(r.isError).toBe(true);
        expect(r._failureKind).toBe(kind);
    });

    it("leaves an ambiguous name untagged, like failureKindForResolution", async () => {
        resolveMock.mockResolvedValue(fail("MULTIPLE_DEVICES_MATCH"));
        const r = await screenshot({ device: "iPhone" });
        expect(r._failureKind).toBeUndefined();
    });

    it("forwards the iOS capture's kind", async () => {
        resolveMock.mockResolvedValue(ok("ios"));
        iosShot.mockResolvedValue({ success: false, error: "No iOS simulator is currently running.", failureKind: "no_ios_simulator" });
        const r = await screenshot();
        expect(r._failureKind).toBe("no_ios_simulator");
    });

    it("forwards the Android capture's kind", async () => {
        resolveMock.mockResolvedValue(ok("android"));
        androidShot.mockResolvedValue({ success: false, error: "No Android device connected.", failureKind: "no_android_device" });
        const r = await screenshot();
        expect(r._failureKind).toBe("no_android_device");
    });

    it("returns the image and says so when the copy to outputPath failed", async () => {
        resolveMock.mockResolvedValue(ok("android"));
        androidShot.mockResolvedValue({
            success: true, data: Buffer.from("jpg"), originalWidth: 10, originalHeight: 20, scaleFactor: 1, result: "/tmp/x.png",
            saveError: "Could not save to /nope/a.png: EACCES",
        });
        const r = await screenshot({ outputPath: "/nope/a.png" });
        expect(r.isError).toBeFalsy();
        expect(r.content[0].text).toContain("Could not save to /nope/a.png");
        expect(r.content.some((c: { type: string }) => c.type === "image")).toBe(true);
    });

    it("explains a phone UDID that could not be reached instead of a generic miss", async () => {
        resolveMock.mockResolvedValue(fail("DEVICE_NOT_FOUND", `"00008110-001A2B3C4D5E6F70" did not match any connected RN app`));
        missReason.mockReturnValue({ message: "pymobiledevice3 is not installed.", kind: "driver_not_installed" });
        const r = await screenshot({ device: "00008110-001A2B3C4D5E6F70" });
        expect(r.content[0].text).toContain("pymobiledevice3 is not installed");
        expect(r._failureKind).toBe("driver_not_installed");
    });

    it("explains a connected phone the USB lookup could not see, instead of capturing a simulator", async () => {
        resolveMock.mockResolvedValue({ ok: true, target: { platform: "ios", deviceName: "Ihor's iPhone", source: "default" } });
        missReason.mockReturnValue({ message: "No iPhone attached over USB.", kind: "no_devices_attached" });
        const r = await screenshot();
        expect(iosShot).not.toHaveBeenCalled();
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toContain("No iPhone attached over USB");
        expect(r._failureKind).toBe("no_devices_attached");
    });

    it("keeps capturing the booted simulator when an app's simulator UDID is not known yet", async () => {
        resolveMock.mockResolvedValue({ ok: true, target: { platform: "ios", deviceName: "iPhone 17", source: "default" } });
        bootedSim.mockResolvedValue("F93612A3-0042-4BDC-855F-8CAB1BDD76C6");
        missReason.mockReturnValue({ message: "No iPhone attached over USB.", kind: "no_devices_attached" });
        iosShot.mockResolvedValue({ success: false, error: "capture stub" });
        await screenshot();
        expect(iosShot).toHaveBeenCalled();
    });
});

describe("legacy screenshot tools", () => {
    it.each([
        ["NO_DEVICES_FOUND", "no_devices_attached"],
        ["DEVICE_NOT_FOUND", "bad_arguments"],
    ])("android_screenshot resolver %s -> %s", async (code, kind) => {
        resolveMock.mockResolvedValue(fail(code));
        const r = await androidLegacy({ deviceId: "nope" });
        expect(r.isError).toBe(true);
        expect(r._failureKind).toBe(kind);
    });

    it("ios_screenshot pointed at an Android device is platform_mismatch", async () => {
        resolveMock.mockResolvedValue(ok("android"));
        const r = await iosLegacy({ udid: "Pixel" });
        expect(r._failureKind).toBe("platform_mismatch");
    });

    it("ios_screenshot explains a phone UDID the USB lookup could not see", async () => {
        resolveMock.mockResolvedValue(fail("DEVICE_NOT_FOUND", `"00008110-001A2B3C4D5E6F70" did not match`));
        missReason.mockReturnValue({ message: "pymobiledevice3 is not installed.", kind: "driver_not_installed" });
        const r = await iosLegacy({ udid: "00008110-001A2B3C4D5E6F70" });
        expect(r.content[0].text).toContain("pymobiledevice3 is not installed");
        expect(r._failureKind).toBe("driver_not_installed");
    });
});
