import { describe, it, expect } from "@jest/globals";
import sharp from "sharp";
import { analyzeBurstFrames } from "../../pro/tap.js";

async function solidImage(r: number, g: number, b: number, size = 100): Promise<Buffer> {
    return sharp({
        create: { width: size, height: size, channels: 3, background: { r, g, b } },
    }).png().toBuffer();
}

describe("analyzeBurstFrames", () => {
    it("detects no change when all frames are identical", async () => {
        const frame = await solidImage(200, 200, 200);
        const result = await analyzeBurstFrames([frame, frame, frame, frame, frame]);
        expect(result.transientChangeDetected).toBe(false);
        expect(result.peakChangeRate).toBeLessThan(0.005);
        expect(result.persistentChangeRate).toBeLessThan(0.005);
        expect(result.meaningful).toBe(false);
    });

    it("detects persistent change (last frame differs from first)", async () => {
        const before = await solidImage(200, 200, 200);
        const after = await solidImage(255, 0, 0);
        const result = await analyzeBurstFrames([before, before, before, after, after]);
        expect(result.meaningful).toBe(true);
        expect(result.persistentChangeRate).toBeGreaterThan(0.005);
    });

    it("detects transient change (middle frame differs, last matches first)", async () => {
        const normal = await solidImage(200, 200, 200);
        const highlight = await solidImage(255, 0, 0);
        const result = await analyzeBurstFrames([normal, highlight, normal, normal, normal]);
        expect(result.transientChangeDetected).toBe(true);
        expect(result.meaningful).toBe(true);
        expect(result.peakFrame).toBe(1);
        expect(result.peakChangeRate).toBeGreaterThan(0.5);
        expect(result.persistentChangeRate).toBeLessThan(0.005);
    });

    it("handles 2 frames (minimum)", async () => {
        const a = await solidImage(200, 200, 200);
        const b = await solidImage(255, 0, 0);
        const result = await analyzeBurstFrames([a, b]);
        expect(result.meaningful).toBe(true);
        expect(result.persistentChangeRate).toBeGreaterThan(0.5);
    });

    it("returns correct framesWithChange indices", async () => {
        const normal = await solidImage(200, 200, 200);
        const highlight = await solidImage(255, 0, 0);
        const result = await analyzeBurstFrames([normal, highlight, highlight, normal, normal]);
        expect(result.framesWithChange).toContain(1);
        expect(result.framesWithChange).toContain(3);
    });
});
