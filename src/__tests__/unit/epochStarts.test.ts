import { describe, it, expect, beforeEach } from "@jest/globals";
import { bumpEpoch, epochStarts, resetEpochs } from "../../core/state.js";

describe("epochStarts", () => {
    beforeEach(() => resetEpochs());

    it("records when each new app run began, per device", () => {
        const before = Date.now();
        bumpEpoch("iPhone 17 Pro");
        bumpEpoch("iPhone 17 Pro");
        bumpEpoch("Pixel 9");
        const after = Date.now();

        const iphone = epochStarts("iPhone 17 Pro");
        expect(iphone.map((e) => e.epoch)).toEqual([2, 3]);
        for (const e of iphone) {
            expect(e.at).toBeGreaterThanOrEqual(before);
            expect(e.at).toBeLessThanOrEqual(after);
        }
        expect(epochStarts("Pixel 9").map((e) => e.epoch)).toEqual([2]);
    });

    it("is empty for a device that never restarted", () => {
        expect(epochStarts("never")).toEqual([]);
    });

    it("keeps the last 50 starts", () => {
        for (let i = 0; i < 60; i++) bumpEpoch("d");
        const starts = epochStarts("d");
        expect(starts).toHaveLength(50);
        expect(starts[starts.length - 1].epoch).toBe(61);
    });

    it("is cleared by resetEpochs", () => {
        bumpEpoch("d");
        resetEpochs();
        expect(epochStarts("d")).toEqual([]);
    });
});
