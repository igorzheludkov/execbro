import { describe, it, expect } from "@jest/globals";
import { computeSwipeFromDirection } from "../../pro/tap.js";

const W = 1000;
const H = 2000;

describe("computeSwipeFromDirection — default distance (33% of axis)", () => {
    it("up: finger travels bottom→top, centered on X, 33% of height", () => {
        const r = computeSwipeFromDirection("up", undefined, W, H);
        expect(r.startX).toBe(500);
        expect(r.endX).toBe(500);
        expect(r.startY).toBeGreaterThan(r.endY); // finger moves up
        expect(r.startY - r.endY).toBe(Math.round(0.33 * H)); // 660
        expect((r.startY + r.endY) / 2).toBe(H / 2); // centered
    });

    it("down: finger travels top→bottom, mirror of up", () => {
        const r = computeSwipeFromDirection("down", undefined, W, H);
        expect(r.endY).toBeGreaterThan(r.startY);
        expect(r.endY - r.startY).toBe(Math.round(0.33 * H));
        expect(r.startX).toBe(500);
    });

    it("left: finger travels right→left, 33% of width, centered on Y", () => {
        const r = computeSwipeFromDirection("left", undefined, W, H);
        expect(r.startX).toBeGreaterThan(r.endX);
        expect(r.startX - r.endX).toBe(Math.round(0.33 * W)); // 330
        expect(r.startY).toBe(1000);
        expect(r.endY).toBe(1000);
    });

    it("right: finger travels left→right, mirror of left", () => {
        const r = computeSwipeFromDirection("right", undefined, W, H);
        expect(r.endX).toBeGreaterThan(r.startX);
        expect(r.endX - r.startX).toBe(Math.round(0.33 * W));
        expect(r.startY).toBe(1000);
    });
});

describe("computeSwipeFromDirection — explicit distance", () => {
    it("honors an explicit pixel distance", () => {
        const r = computeSwipeFromDirection("up", 500, W, H);
        expect(r.startY - r.endY).toBe(500);
        expect((r.startY + r.endY) / 2).toBe(H / 2);
    });
});

describe("computeSwipeFromDirection — clamping to 10%–90% margin", () => {
    it("clamps an over-large distance so endpoints stay on-screen", () => {
        const r = computeSwipeFromDirection("up", 99999, W, H);
        expect(r.endY).toBeGreaterThanOrEqual(Math.round(0.1 * H));
        expect(r.startY).toBeLessThanOrEqual(Math.round(0.9 * H));
    });

    it("works on a tiny screen without producing off-screen coords", () => {
        const r = computeSwipeFromDirection("down", undefined, 100, 100);
        expect(r.startY).toBeGreaterThanOrEqual(Math.round(0.1 * 100));
        expect(r.endY).toBeLessThanOrEqual(Math.round(0.9 * 100));
    });
});

describe("computeSwipeFromDirection — odd distance and one-sided clamp", () => {
    it("odd explicit distance preserves exact travel length", () => {
        // d=333 is odd; Math.round(333/2)=167, so near-far would be 334 with the buggy code
        const r = computeSwipeFromDirection("up", 333, W, H);
        expect(r.startY - r.endY).toBe(333);
    });

    it("over-large distance collapses band to full margin span", () => {
        // d=1700 > span=1600 (hi=1800, lo=200); both sides overflow after shift
        // correct behavior: collapse to [lo, hi] giving travel = hi - lo = 1600
        const lo = Math.round(0.1 * H); // 200
        const hi = Math.round(0.9 * H); // 1800
        const r = computeSwipeFromDirection("up", 1700, W, H);
        expect(r.startY - r.endY).toBe(hi - lo);
        expect(r.startY).toBeLessThanOrEqual(hi);
        expect(r.endY).toBeGreaterThanOrEqual(lo);
    });
});

describe("computeSwipeFromDirection — system-bar safe band", () => {
    // A swipe whose first contact lands in Android's home-gesture strip is taken by the
    // system: the app goes to the background while the tool reports success, and the next
    // tap — aimed with pre-swipe coordinates — lands on the launcher.
    const band = { top: 140, bottom: 150 };

    it("keeps a vertical gesture clear of the bottom strip when the band is stricter", () => {
        // A short screen: 10% of the axis (60) does not clear a 150px strip.
        const r = computeSwipeFromDirection("up", 500, 400, 600, band);
        expect(r.startY).toBeLessThanOrEqual(600 - band.bottom);
        expect(r.endY).toBeGreaterThanOrEqual(band.top);
    });

    it("keeps the 10% margin when it is the stricter of the two", () => {
        // 10% of 2000 is 200, already past a 150px strip — the band must not loosen it.
        const withBand = computeSwipeFromDirection("up", 5000, W, H, band);
        const without = computeSwipeFromDirection("up", 5000, W, H);
        expect(withBand.startY).toBe(without.startY);
        expect(withBand.endY).toBe(without.endY);
    });

    it("clamps a distance large enough to push past the strip", () => {
        const r = computeSwipeFromDirection("up", 100000, W, H, band);
        expect(r.startY).toBeLessThanOrEqual(H - band.bottom);
        expect(r.startY).toBeGreaterThan(r.endY);
    });

    it("leaves horizontal gestures alone — the band is a vertical constraint", () => {
        const withBand = computeSwipeFromDirection("left", 400, W, H, band);
        const without = computeSwipeFromDirection("left", 400, W, H);
        expect(withBand).toEqual(without);
    });

    it("falls back to the plain margin when the band would swallow the axis", () => {
        // Insets taller than the screen must not invert the range into start < end.
        const r = computeSwipeFromDirection("up", 200, 400, 300, { top: 200, bottom: 200 });
        expect(r.startY).toBeGreaterThan(r.endY);
        expect(r.startY).toBeLessThanOrEqual(300);
        expect(r.endY).toBeGreaterThanOrEqual(0);
    });
});
