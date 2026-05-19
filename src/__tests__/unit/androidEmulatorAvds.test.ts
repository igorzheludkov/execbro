import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// Mock execAsync before importing the module under test
const execAsyncMock = jest.fn<(cmd: string, opts?: unknown) => Promise<{ stdout: string; stderr: string }>>();
jest.unstable_mockModule("../../core/exec.js", () => ({
    execAsync: execAsyncMock
}));

const { getAndroidEmulatorAvds, getAdbIdForAvd, resetAdbAvailabilityCache } =
    await import("../../core/android.js");

describe("getAndroidEmulatorAvds", () => {
    beforeEach(() => {
        execAsyncMock.mockReset();
        resetAdbAvailabilityCache();
    });

    it("parses AVD names from emulator -list-avds output", async () => {
        // adb availability probe
        execAsyncMock.mockResolvedValueOnce({ stdout: "Android Debug Bridge", stderr: "" });
        // emulator binary probe (emulator -help)
        execAsyncMock.mockResolvedValueOnce({ stdout: "Android Emulator usage", stderr: "" });
        // emulator -list-avds
        execAsyncMock.mockResolvedValueOnce({
            stdout: "Pixel_7_API_34\nTablet_API_33\n",
            stderr: ""
        });

        const avds = await getAndroidEmulatorAvds();
        expect(avds).toEqual(["Pixel_7_API_34", "Tablet_API_33"]);
    });

    it("filters out empty lines and the 'Storing crashdata' noise line", async () => {
        execAsyncMock.mockResolvedValueOnce({ stdout: "Android Debug Bridge", stderr: "" });
        execAsyncMock.mockResolvedValueOnce({ stdout: "Android Emulator usage", stderr: "" });
        execAsyncMock.mockResolvedValueOnce({
            stdout: "Pixel_7_API_34\n\nStoring crashdata in: /tmp/foo\nTablet_API_33\n",
            stderr: ""
        });

        const avds = await getAndroidEmulatorAvds();
        expect(avds).toEqual(["Pixel_7_API_34", "Tablet_API_33"]);
    });

    it("returns [] when emulator binary is missing", async () => {
        execAsyncMock.mockResolvedValueOnce({ stdout: "Android Debug Bridge", stderr: "" });
        // emulator -help fails everywhere (PATH + each candidate)
        execAsyncMock.mockRejectedValue(new Error("command not found: emulator"));

        const avds = await getAndroidEmulatorAvds();
        expect(avds).toEqual([]);
    });
});

describe("getAdbIdForAvd", () => {
    beforeEach(() => {
        execAsyncMock.mockReset();
        resetAdbAvailabilityCache();
    });

    it("matches a running emulator's adb serial to its AVD name", async () => {
        // adb availability probe
        execAsyncMock.mockResolvedValueOnce({ stdout: "Android Debug Bridge", stderr: "" });
        // adb devices
        execAsyncMock.mockResolvedValueOnce({
            stdout: "List of devices attached\nemulator-5554\tdevice\n",
            stderr: ""
        });
        // adb -s emulator-5554 emu avd name
        execAsyncMock.mockResolvedValueOnce({
            stdout: "Pixel_7_API_34\nOK\n",
            stderr: ""
        });

        const serial = await getAdbIdForAvd("Pixel_7_API_34");
        expect(serial).toBe("emulator-5554");
    });

    it("returns null when no running emulator matches the AVD name", async () => {
        execAsyncMock.mockResolvedValueOnce({ stdout: "Android Debug Bridge", stderr: "" });
        execAsyncMock.mockResolvedValueOnce({
            stdout: "List of devices attached\nemulator-5554\tdevice\n",
            stderr: ""
        });
        execAsyncMock.mockResolvedValueOnce({ stdout: "Other_AVD\nOK\n", stderr: "" });

        const serial = await getAdbIdForAvd("Pixel_7_API_34");
        expect(serial).toBeNull();
    });

    it("returns null when adb devices fails", async () => {
        execAsyncMock.mockResolvedValueOnce({ stdout: "Android Debug Bridge", stderr: "" });
        execAsyncMock.mockRejectedValueOnce(new Error("adb daemon not running"));

        const serial = await getAdbIdForAvd("Pixel_7_API_34");
        expect(serial).toBeNull();
    });

    it("skips physical devices (serials that don't match emulator-NNNN)", async () => {
        execAsyncMock.mockResolvedValueOnce({ stdout: "Android Debug Bridge", stderr: "" });
        execAsyncMock.mockResolvedValueOnce({
            stdout: "List of devices attached\nR58M12345\tdevice\nemulator-5554\tdevice\n",
            stderr: ""
        });
        // Only the emulator-5554 line should trigger an `emu avd name` call
        execAsyncMock.mockResolvedValueOnce({
            stdout: "Pixel_7_API_34\nOK\n",
            stderr: ""
        });

        const serial = await getAdbIdForAvd("Pixel_7_API_34");
        expect(serial).toBe("emulator-5554");
        // 3 calls total: adb-version probe + adb devices + one emu avd name
        expect(execAsyncMock).toHaveBeenCalledTimes(3);
    });
});
