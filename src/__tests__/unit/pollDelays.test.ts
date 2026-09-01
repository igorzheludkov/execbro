import { buildPollDelays } from "../../core/jsExecute.js";

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

describe("buildPollDelays", () => {
    it("never exceeds the budget", () => {
        for (const budget of [0, 50, 100, 999, 7000, 10000, 90000]) {
            expect(sum(buildPollDelays(budget))).toBeLessThanOrEqual(Math.max(budget, 50));
        }
    });

    it("keeps the original ~7s ladder at the old default", () => {
        expect(buildPollDelays(7000)).toEqual([100, 300, 600, 1000, 2000, 3000]);
    });

    it("extends with 3s steps so timeoutMs is actually honoured", () => {
        const d = buildPollDelays(90000);
        expect(sum(d)).toBeGreaterThan(85000);
        expect(d[d.length - 1]).toBe(3000);
    });

    it("always polls at least once", () => {
        expect(buildPollDelays(0).length).toBe(1);
    });
});
