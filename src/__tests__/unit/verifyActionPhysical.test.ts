import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * Tap verification frames for a USB iPhone must come from pymobiledevice3:
 * simctl does not know the phone, so the before/after diff would otherwise
 * compare frames of whichever simulator is booted.
 */

const PHONE = "00008030-001D69C00192802E";
const SIM = "F93612A3-0042-4BDC-855F-8CAB1BDD76C6";

// exec.js, not ios.js, is mocked: half the codebase imports ios.js, and the
// simulator path only has to show that it went to simctl, not succeed.
const execMock = jest.fn(async (_file: string, _args: string[]) => ({ stdout: "", stderr: "" }));
const physicalIosScreenshotMock = jest.fn(async (_udid: string) => ({
    success: true,
    data: Buffer.from("x"),
    originalWidth: 828,
    originalHeight: 1792,
    scaleFactor: 1,
}));

jest.unstable_mockModule("../../core/exec.js", () => ({
    execFileAsync: execMock,
    execAsync: async () => ({ stdout: "", stderr: "" }),
    quoteForDeviceShell: (v: string) => v,
}));
jest.unstable_mockModule("../../core/iosPhysical.js", () => ({
    isPhysicalIosUdid: (u: string) => u === PHONE,
    physicalIosScreenshot: physicalIosScreenshotMock,
    physicalIosOrientation: jest.fn(),
    // Reached through tap.ts -> physicalTap.ts, never called here.
    physicalIosTap: jest.fn(),
    resolvePhysicalIosDevice: jest.fn(),
    toHidPoint: jest.fn(),
    IOS_HID_MIN_MAJOR: 27,
}));

const { captureScreenshot } = await import("../../pro/verifyAction.js");

beforeEach(() => {
    execMock.mockClear();
    physicalIosScreenshotMock.mockClear();
});

describe("captureScreenshot on a physical iPhone", () => {
    it("captures a physical iPhone through pymobiledevice3, not simctl", async () => {
        await expect(captureScreenshot("ios", PHONE)).resolves.toEqual({
            buffer: Buffer.from("x"),
            width: 828,
            height: 1792,
            scaleFactor: 1,
        });
        expect(physicalIosScreenshotMock).toHaveBeenCalledWith(PHONE);
        expect(execMock).not.toHaveBeenCalled();
    });

    it("still captures a simulator through simctl", async () => {
        await captureScreenshot("ios", SIM);
        expect(execMock.mock.calls.some(([file, args]) => file === "xcrun" && args.includes("simctl"))).toBe(true);
        expect(physicalIosScreenshotMock).not.toHaveBeenCalled();
    });
});
