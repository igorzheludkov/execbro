import { describe, it, expect } from "@jest/globals";

describe("verifyAction module", () => {
    it("exports the relocated helpers", async () => {
        const mod = await import("../../pro/verifyAction.js");
        expect(typeof mod.captureScreenshot).toBe("function");
        expect(typeof mod.verifyAndCapture).toBe("function");
        expect(typeof mod.burstCaptureAndVerify).toBe("function");
        expect(typeof mod.drawTapMarker).toBe("function");
        expect(typeof mod.SETTLE_DELAY_MS).toBe("number");
        expect(typeof mod.BURST_FRAME_COUNT).toBe("number");
        expect(typeof mod.BURST_FRAME_INTERVAL_MS).toBe("number");
    });

    it("verifyAndCapture accepts a source override and returns the skipped stub when both knobs are false", async () => {
        const { verifyAndCapture } = await import("../../pro/verifyAction.js");
        const result = await verifyAndCapture({
            platform: "ios",
            shouldVerify: false,
            shouldScreenshot: false,
            beforeBuffer: null,
            source: "swipe-verify",
        });
        expect(result.verification?.skipped).toBe(true);
        expect(result.verification?.skippedReason).toMatch(/screenshot=false/);
    });
});
