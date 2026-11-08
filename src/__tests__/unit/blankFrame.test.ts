import { describe, it, expect } from "@jest/globals";
import sharp from "sharp";
import { isNearUniform } from "../../core/blankFrame.js";

// Seen on device right after a cold launch: the capture landed before the first
// paint and came back a flat #fafafa frame, while the element list beside it (read
// from the React tree) was full.
const solid = () =>
    sharp({ create: { width: 100, height: 200, channels: 3, background: "#fafafa" } }).jpeg().toBuffer();

describe("isNearUniform", () => {
    it("is true for a flat frame", async () => {
        expect(await isNearUniform(await solid())).toBe(true);
    });

    it("ignores the system bars, which the OS paints before the app does", async () => {
        // On device the blank frame still had the status bar icons and the nav bar.
        const bar = await sharp({ create: { width: 100, height: 12, channels: 3, background: "#202020" } }).png().toBuffer();
        const framed = await sharp(await solid())
            .composite([{ input: bar, left: 0, top: 0 }, { input: bar, left: 0, top: 188 }])
            .jpeg()
            .toBuffer();
        expect(await isNearUniform(framed)).toBe(true);
    });

    it("is false once anything is painted", async () => {
        const square = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#000000" } }).png().toBuffer();
        const painted = await sharp(await solid()).composite([{ input: square, left: 30, top: 80 }]).jpeg().toBuffer();
        expect(await isNearUniform(painted)).toBe(false);
    });
});
