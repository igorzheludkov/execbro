import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { TouchPoint } from "../../core/emulatorGrpc.js";

const resolveEmulatorBridgeMock = jest.fn<(serial: string) => Promise<any>>();
const sendTouchFramesMock =
    jest.fn<(bridge: unknown, frames: TouchPoint[][], delay: number) => Promise<{ success: boolean; error?: string }>>();
const androidGetScreenSizeMock = jest.fn<(id?: string) => Promise<any>>();
const getDefaultAndroidDeviceMock = jest.fn<() => Promise<string | null>>();

jest.unstable_mockModule("../../core/emulatorBridge.js", () => ({
    resolveEmulatorBridge: resolveEmulatorBridgeMock,
}));
jest.unstable_mockModule("../../core/emulatorGrpc.js", () => ({
    sendTouchFrames: sendTouchFramesMock,
}));
jest.unstable_mockModule("../../core/android.js", () => ({
    androidGetScreenSize: androidGetScreenSizeMock,
    getDefaultAndroidDevice: getDefaultAndroidDeviceMock,
}));

const { androidPinch } = await import("../../core/androidPinch.js");

const OPTS = {
    focalX: 540,
    focalY: 1200,
    direction: "out" as const,
    scale: 3,
    angleDeg: 0,
    durationMs: 300,
    serial: "emulator-5554",
};

describe("androidPinch", () => {
    beforeEach(() => {
        resolveEmulatorBridgeMock.mockReset();
        sendTouchFramesMock.mockReset();
        androidGetScreenSizeMock.mockReset();
        getDefaultAndroidDeviceMock.mockReset();

        resolveEmulatorBridgeMock.mockResolvedValue({
            ok: true,
            bridge: { port: 8554, token: "t" },
        });
        androidGetScreenSizeMock.mockResolvedValue({ success: true, width: 1080, height: 2424 });
        sendTouchFramesMock.mockResolvedValue({ success: true });
    });

    it("sends frames and reports the counts", async () => {
        const res = await androidPinch(OPTS);
        expect(res.success).toBe(true);
        expect(sendTouchFramesMock).toHaveBeenCalled();
        expect(res.frameCount).toBeGreaterThan(2);
        expect(res.gestureCount).toBe(1);
    });

    it("surfaces the bridge failure message unchanged", async () => {
        resolveEmulatorBridgeMock.mockResolvedValue({
            ok: false,
            reason: "not-emulator",
            message: "physical devices do not expose the bridge",
        });
        const res = await androidPinch(OPTS);
        expect(res.success).toBe(false);
        expect(res.error).toContain("physical devices do not expose the bridge");
        expect(sendTouchFramesMock).not.toHaveBeenCalled();
    });

    it("refuses a gesture the geometry marks unviable", async () => {
        const res = await androidPinch({ ...OPTS, scale: 1 });
        expect(res.success).toBe(false);
        expect(res.error).toContain("scale");
        expect(sendTouchFramesMock).not.toHaveBeenCalled();
    });

    it("releases both pointers when a frame send fails midway", async () => {
        sendTouchFramesMock.mockResolvedValueOnce({ success: false, error: "connection reset" });
        const res = await androidPinch(OPTS);
        expect(res.success).toBe(false);
        // A release-only call must follow the failed gesture.
        const last = sendTouchFramesMock.mock.calls[sendTouchFramesMock.mock.calls.length - 1];
        const releaseFrames = last[1];
        expect(releaseFrames.flat().every((p) => p.pressure === 0)).toBe(true);
    });

    it("falls back to the default device when no serial is given", async () => {
        getDefaultAndroidDeviceMock.mockResolvedValue("emulator-5556");
        await androidPinch({ ...OPTS, serial: undefined });
        expect(resolveEmulatorBridgeMock).toHaveBeenCalledWith("emulator-5556");
    });

    it("errors when no device is connected at all", async () => {
        getDefaultAndroidDeviceMock.mockResolvedValue(null);
        const res = await androidPinch({ ...OPTS, serial: undefined });
        expect(res.success).toBe(false);
        expect(res.error).toContain("No Android device");
    });

    it("pauses between chained sub-gestures", async () => {
        const res = await androidPinch({ ...OPTS, scale: 40 });
        expect(res.gestureCount).toBeGreaterThan(1);
        expect(sendTouchFramesMock.mock.calls.length).toBe(res.gestureCount);
    });
});
