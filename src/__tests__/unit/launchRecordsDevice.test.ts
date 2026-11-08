import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * A launch is the agent saying "this is the device I am working on". Before this,
 * android_launch_app did not record it, so a bare screenshot() right after picked
 * whichever device project memory last saw (a booted iOS simulator's home screen).
 */

const recordDevice = jest.fn<(input: unknown) => void>();
let remembered: Array<{ identifier: string; name: string }> = [];

jest.unstable_mockModule("../../core/projectMemory.js", () => ({
    recordDevice,
    recordScreenMetrics: jest.fn(),
    listDevices: () => remembered,
    mergeDeviceLists: (a: unknown[]) => a,
}));

const { rememberLaunchedDevice } = await import("../../tools/deviceTools.js");

describe("rememberLaunchedDevice", () => {
    beforeEach(() => {
        recordDevice.mockReset();
    });

    it("records the launched device so it becomes the default target", () => {
        rememberLaunchedDevice("android", "emulator-5554", "com.rndebuggertestapp");
        expect(recordDevice).toHaveBeenCalledWith({
            identifier: "emulator-5554",
            name: "emulator-5554",
            platform: "android",
            appId: "com.rndebuggertestapp",
        });
    });

    it("keeps the name project memory already has instead of overwriting it with the serial", () => {
        // Otherwise the next default-device note reads "emulator-5554 (emulator-5554)".
        remembered = [{ identifier: "emulator-5554", name: "Pixel_9_-_16kb" }];
        rememberLaunchedDevice("android", "emulator-5554", "com.rndebuggertestapp");
        expect(recordDevice).toHaveBeenCalledWith(expect.objectContaining({ identifier: "emulator-5554", name: "Pixel_9_-_16kb" }));
        remembered = [];
    });

    it("never throws when recording fails", () => {
        recordDevice.mockImplementation(() => {
            throw new Error("disk full");
        });
        expect(() => rememberLaunchedDevice("ios", "UDID-1", "org.example.app")).not.toThrow();
    });
});
