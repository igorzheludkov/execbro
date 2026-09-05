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

// Paint opaque rectangles onto a black 200x200 base. Composite beats hand-
// writing raw pixels here: it keeps each test's intent (a widget changed at
// these coordinates) legible.
async function withRects(rects: Array<{ x: number; y: number; w: number; h: number }>): Promise<Buffer> {
    const base = sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 0, g: 0, b: 0 } } });
    if (rects.length === 0) return base.png().toBuffer();
    return base
        .composite(
            rects.map(({ x, y, w, h }) => ({
                input: { create: { width: w, height: h, channels: 3, background: { r: 255, g: 255, b: 255 } } },
                left: x,
                top: y,
            }))
        )
        .png()
        .toBuffer();
}

describe("compareScreenshots regions", () => {
    it("is absent unless asked for — the tap burst loop must not pay for it", async () => {
        const before = await withRects([]);
        const after = await withRects([{ x: 20, y: 30, w: 40, h: 20 }]);
        expect((await compareScreenshots(before, after)).regions).toBeUndefined();
        expect((await compareScreenshots(before, after, { regions: true })).regions).toBeDefined();
    });

    it("boxes a single changed widget", async () => {
        const before = await withRects([]);
        const after = await withRects([{ x: 32, y: 48, w: 32, h: 16 }]);
        const { regions } = await compareScreenshots(before, after, { regions: true });

        expect(regions).toHaveLength(1);
        const [box] = regions!;
        // The grid is 16px, so a box is the changed area snapped outward to
        // cell edges — never smaller than the real change.
        expect(box.x).toBeLessThanOrEqual(32);
        expect(box.y).toBeLessThanOrEqual(48);
        expect(box.x + box.width).toBeGreaterThanOrEqual(64);
        expect(box.y + box.height).toBeGreaterThanOrEqual(64);
        expect(box.changedPixels).toBe(32 * 16);
    });

    // The reason regions exist at all. One box spanning both changes would
    // cover mostly unchanged screen and tell the agent nothing useful.
    it("keeps two distant changes as two boxes", async () => {
        const before = await withRects([]);
        const after = await withRects([
            { x: 0, y: 0, w: 32, h: 32 },
            { x: 160, y: 160, w: 32, h: 32 },
        ]);
        const { regions } = await compareScreenshots(before, after, { regions: true });

        expect(regions).toHaveLength(2);
        for (const box of regions!) {
            expect(box.width).toBeLessThanOrEqual(48);
            expect(box.height).toBeLessThanOrEqual(48);
        }
    });

    it("orders by size, so the first box is the main change", async () => {
        const before = await withRects([]);
        const after = await withRects([
            { x: 0, y: 0, w: 16, h: 16 },
            { x: 96, y: 96, w: 64, h: 64 },
        ]);
        const { regions } = await compareScreenshots(before, after, { regions: true });
        expect(regions![0].changedPixels).toBe(64 * 64);
        expect(regions![1].changedPixels).toBe(16 * 16);
    });

    it("reports boxes in full-screenshot coordinates, not cropped ones", async () => {
        // A caller cropping the status bar still has to be able to hand the box
        // back to tap, which works in full-screenshot pixels.
        const before = await withRects([]);
        const after = await withRects([{ x: 64, y: 96, w: 32, h: 32 }]);
        const cropped = await compareScreenshots(before, after, { regions: true, statusBarHeight: 48 });
        const uncropped = await compareScreenshots(before, after, { regions: true });
        expect(cropped.regions![0].y).toBe(uncropped.regions![0].y);
    });

    it("treats a size change as one whole-frame box rather than inventing detail", async () => {
        const small = await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
        const big = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
        const { regions } = await compareScreenshots(small, big, { regions: true });
        expect(regions).toEqual([{ x: 0, y: 0, width: 200, height: 200, changedPixels: 200 * 200 }]);
    });

    it("returns no regions when nothing changed", async () => {
        const img = await withRects([{ x: 10, y: 10, w: 20, h: 20 }]);
        const result = await compareScreenshots(img, img, { regions: true });
        expect(result.changed).toBe(false);
        expect(result.regions).toBeUndefined();
    });
});
