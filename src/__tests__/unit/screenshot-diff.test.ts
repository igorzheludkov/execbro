import { describe, it, expect } from "@jest/globals";
import sharp from "sharp";
import { compareScreenshots, type ScreenshotDiffResult } from "../../pro/screenshot-diff.js";

// Helper: create a solid-color 100x100 PNG buffer
async function solidImage(r: number, g: number, b: number): Promise<Buffer> {
    return sharp({
        create: { width: 100, height: 100, channels: 3, background: { r, g, b } },
    })
        .png()
        .toBuffer();
}

describe("compareScreenshots", () => {
    it("returns not changed for identical images", async () => {
        const img = await solidImage(255, 0, 0);
        const result = await compareScreenshots(img, img);
        expect(result.changed).toBe(false);
        expect(result.changeRate).toBe(0);
        expect(result.changedPixels).toBe(0);
        expect(result.totalPixels).toBe(10000);
    });

    it("returns changed for completely different images", async () => {
        const red = await solidImage(255, 0, 0);
        const blue = await solidImage(0, 0, 255);
        const result = await compareScreenshots(red, blue);
        expect(result.changed).toBe(true);
        expect(result.changeRate).toBeGreaterThan(0.5);
        expect(result.changedPixels).toBe(10000);
    });

    it("detects small changes above threshold", async () => {
        // Create an image with a 10x10 changed region (1% of 100x100)
        const base = await solidImage(255, 255, 255);
        const modified = await sharp({
            create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 255, b: 255 } },
        })
            .composite([
                {
                    input: await sharp({
                        create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } },
                    })
                        .png()
                        .toBuffer(),
                    left: 0,
                    top: 0,
                },
            ])
            .png()
            .toBuffer();

        const result = await compareScreenshots(base, modified);
        expect(result.changed).toBe(true);
        expect(result.changeRate).toBeCloseTo(0.01, 1);
    });

    it("ignores changes below threshold", async () => {
        // Create images with very subtle difference (1 pixel)
        const base = await solidImage(200, 200, 200);
        // Change just slightly — within anti-aliasing tolerance
        const modified = await sharp({
            create: { width: 100, height: 100, channels: 3, background: { r: 201, g: 200, b: 200 } },
        })
            .png()
            .toBuffer();

        const result = await compareScreenshots(base, modified);
        // Pixelmatch with threshold 0.1 should tolerate very small color differences
        expect(result.changed).toBe(false);
    });

    it("handles JPEG buffers (not just PNG)", async () => {
        const jpg1 = await sharp({
            create: { width: 50, height: 50, channels: 3, background: { r: 100, g: 100, b: 100 } },
        })
            .jpeg()
            .toBuffer();
        const jpg2 = await sharp({
            create: { width: 50, height: 50, channels: 3, background: { r: 255, g: 0, b: 0 } },
        })
            .jpeg()
            .toBuffer();

        const result = await compareScreenshots(jpg1, jpg2);
        expect(result.changed).toBe(true);
        expect(result.totalPixels).toBe(2500);
    });

    it("handles images of different sizes by returning changed", async () => {
        const small = await sharp({
            create: { width: 50, height: 50, channels: 3, background: { r: 0, g: 0, b: 0 } },
        })
            .png()
            .toBuffer();
        const big = await sharp({
            create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 0 } },
        })
            .png()
            .toBuffer();

        const result = await compareScreenshots(small, big);
        // Different sizes = assume changed (can't diff properly)
        expect(result.changed).toBe(true);
        expect(result.changeRate).toBe(1);
    });
});
