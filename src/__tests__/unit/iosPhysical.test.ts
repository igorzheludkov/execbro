import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * The physical-device path is a fallback that only fires when simctl has
 * already said "Invalid device", so a wrong match here silently screenshots
 * the wrong phone rather than erroring. These cover the two things that can
 * go wrong without any device attached: parsing `usbmux list` and matching a
 * hint against it.
 *
 * No device contact: execFileAsync is mocked, so the suite never shells out.
 */

const execAsyncMock = jest.fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>>();
jest.unstable_mockModule("../../core/exec.js", () => ({
    execFileAsync: execAsyncMock,
}));

jest.unstable_mockModule("../../core/ios.js", () => ({
    defaultScreenshotPath: () => "/tmp/unused.png",
    finalizeScreenshotFile: jest.fn(),
}));

const { listPhysicalIosDevices, resolvePhysicalIosDevice, physicalMissReason } = await import("../../core/iosPhysical.js");

const USBMUX_LIST = JSON.stringify([
    {
        BuildVersion: "19H422",
        ConnectionType: "USB",
        DeviceClass: "iPhone",
        DeviceName: "iPhone - Ihor Zheludkov",
        Identifier: "fdc2d1b5937ce66395b17a9c540b3a45bbd54431",
        ProductType: "iPhone8,2",
        ProductVersion: "15.8.8",
    },
]);

beforeEach(() => {
    execAsyncMock.mockReset();
});

describe("listPhysicalIosDevices", () => {
    it("parses a usbmux listing", async () => {
        execAsyncMock.mockResolvedValue({ stdout: USBMUX_LIST, stderr: "" });
        const devices = await listPhysicalIosDevices();
        expect(devices).toEqual([
            {
                udid: "fdc2d1b5937ce66395b17a9c540b3a45bbd54431",
                name: "iPhone - Ihor Zheludkov",
                version: "15.8.8",
                productType: "iPhone8,2",
            },
        ]);
    });

    it("returns an empty list when pymobiledevice3 is missing", async () => {
        const err = new Error("spawn pymobiledevice3 ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        execAsyncMock.mockRejectedValue(err);
        await expect(listPhysicalIosDevices()).resolves.toEqual([]);
    });

    it("returns an empty list rather than throwing on non-JSON output", async () => {
        execAsyncMock.mockResolvedValue({ stdout: "Usage: pymobiledevice3 ...", stderr: "" });
        await expect(listPhysicalIosDevices()).resolves.toEqual([]);
    });
});

describe("resolvePhysicalIosDevice", () => {
    beforeEach(() => {
        execAsyncMock.mockResolvedValue({ stdout: USBMUX_LIST, stderr: "" });
    });

    it("matches an exact UDID case-insensitively", async () => {
        const d = await resolvePhysicalIosDevice("FDC2D1B5937CE66395B17A9C540B3A45BBD54431");
        expect(d?.udid).toBe("fdc2d1b5937ce66395b17a9c540b3a45bbd54431");
    });

    it("matches a device-name substring", async () => {
        const d = await resolvePhysicalIosDevice("ihor");
        expect(d?.name).toBe("iPhone - Ihor Zheludkov");
    });

    it("returns null for a hint that matches nothing, so the simulator error stands", async () => {
        await expect(resolvePhysicalIosDevice("Pixel_9")).resolves.toBeNull();
    });

    it("maps a devicectl CoreDevice identifier to the usbmux UDID", async () => {
        const DEVICECTL = JSON.stringify({
            result: { devices: [{ identifier: "922236A0-C7BD-5E25-9751-639615E97848", hardwareProperties: { udid: "FDC2D1B5937CE66395B17A9C540B3A45BBD54431" } }] },
        });
        execAsyncMock.mockImplementation(async (file) => ({ stdout: file === "xcrun" ? DEVICECTL : USBMUX_LIST, stderr: "" }));
        const d = await resolvePhysicalIosDevice("922236A0-C7BD-5E25-9751-639615E97848");
        expect(d?.udid).toBe("fdc2d1b5937ce66395b17a9c540b3a45bbd54431");
        await expect(resolvePhysicalIosDevice("00000000-0000-0000-0000-000000000000")).resolves.toBeNull();
    });
});

describe("physicalMissReason", () => {
    // 19 production rows (2026-11) were phone UDIDs answered with a generic "did not match", because a failed listing looked exactly like no phone.
    const PHONE = "00008110-001A2B3C4D5E6F70";

    it("names a missing pymobiledevice3 as driver_not_installed", async () => {
        execAsyncMock.mockRejectedValue(Object.assign(new Error("spawn pymobiledevice3 ENOENT"), { code: "ENOENT" }));
        await resolvePhysicalIosDevice(PHONE);
        const why = physicalMissReason(PHONE, false);
        expect(why?.kind).toBe("driver_not_installed");
        expect(why?.message).toContain("pipx install pymobiledevice3");
    });

    it("says the phone is not on USB when the listing worked", async () => {
        execAsyncMock.mockResolvedValue({ stdout: "[]", stderr: "" });
        await resolvePhysicalIosDevice(PHONE);
        const why = physicalMissReason(PHONE, false);
        expect(why?.kind).toBe("no_devices_attached");
        expect(why?.message).toMatch(/USB/);
    });

    it("passes the listing's own error through when usbmux fails", async () => {
        execAsyncMock.mockRejectedValue(Object.assign(new Error("Command failed"), { stderr: "usbmuxd not running", code: 1 }));
        await resolvePhysicalIosDevice(PHONE);
        expect(physicalMissReason(PHONE, false)?.message).toContain("usbmuxd not running");
    });

    it("stays out of a simulator-name typo", async () => {
        execAsyncMock.mockRejectedValue(Object.assign(new Error("spawn pymobiledevice3 ENOENT"), { code: "ENOENT" }));
        await resolvePhysicalIosDevice("iPhone 71");
        expect(physicalMissReason("iPhone 71", false)).toBeNull();
    });

    it("answers for a name the registry knows is a phone", async () => {
        execAsyncMock.mockResolvedValue({ stdout: "[]", stderr: "" });
        await resolvePhysicalIosDevice("Ihor's iPhone");
        expect(physicalMissReason("Ihor's iPhone", true)?.kind).toBe("no_devices_attached");
    });
});
