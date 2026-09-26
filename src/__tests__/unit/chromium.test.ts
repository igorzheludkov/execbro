import { describe, it, expect } from "@jest/globals";
import { pxPerCss, CHROMIUM_MAX_DIMENSION } from "../../core/chromium.js";

describe("pxPerCss", () => {
    it("is devicePixelRatio when the raw capture fits the cap (FluentTalk popover, 380x600 @2)", () => {
        expect(pxPerCss({ w: 380, h: 600, dpr: 2 })).toBe(2);
    });

    it("is 1 on a non-retina window under the cap", () => {
        expect(pxPerCss({ w: 1280, h: 800, dpr: 1 })).toBe(1);
    });

    it("drops below dpr so the longest side lands exactly on the cap (1440x900 @2 = 2880 raw)", () => {
        const k = pxPerCss({ w: 1440, h: 900, dpr: 2 });
        expect(k).toBeCloseTo(CHROMIUM_MAX_DIMENSION / 1440);
        expect(Math.round(1440 * k)).toBe(CHROMIUM_MAX_DIMENSION);
    });

    it("uses the longest side for a portrait window", () => {
        expect(Math.round(1200 * pxPerCss({ w: 700, h: 1200, dpr: 2 }))).toBe(CHROMIUM_MAX_DIMENSION);
    });

    it("round-trips a delivered pixel to CSS and back within half a pixel", () => {
        const vp = { w: 1440, h: 900, dpr: 2 };
        const k = pxPerCss(vp);
        const px = { x: 1234, y: 567 };
        const css = { x: px.x / k, y: px.y / k };
        expect(Math.abs(Math.round(css.x * k) - px.x)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(Math.round(css.y * k) - px.y)).toBeLessThanOrEqual(0.5);
    });
});
