import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * A launch is the agent saying "this is the device I am working on". Before this,
 * android_launch_app did not record it, so a bare screenshot() right after picked
 * whichever device project memory last saw (a booted iOS simulator's home screen).
 */

const recordDevice = jest.fn<(input: unknown) => void>();

jest.unstable_mockModule("../../core/projectMemory.js", () => ({
    recordDevice,
    recordScreenMetrics: jest.fn(),
    listDevices: () => [],
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

    it("never throws when recording fails", () => {
        recordDevice.mockImplementation(() => {
            throw new Error("disk full");
        });
        expect(() => rememberLaunchedDevice("ios", "UDID-1", "org.example.app")).not.toThrow();
    });
});
