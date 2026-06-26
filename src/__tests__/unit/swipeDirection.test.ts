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
