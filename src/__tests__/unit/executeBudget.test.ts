import { describe, it, expect } from "@jest/globals";
import { applyResultBudget } from "../../core/truncate.js";

describe("applyResultBudget", () => {
    it("passes a small string result through unchanged", () => {
        const out = applyResultBudget("2", 25000);
        expect(out.text).toBe("2");
        expect(out.budget.truncated).toBe(false);
    });

    it("bounds an oversized JSON string result and reports the reduction", () => {
        const big = JSON.stringify({ rows: Array.from({ length: 4000 }, (_, i) => ({ i, pad: "xxxxxxxxxx" })) });
        const out = applyResultBudget(big, 2000);
        expect(out.budget.truncated).toBe(true);
        expect(out.text.length).toBeLessThanOrEqual(2000);
        expect(out.budget.originalBytes).toBeGreaterThan(2000);
    });

    it("leaves a non-JSON string alone rather than mangling it", () => {
        const out = applyResultBudget("restored", 25000);
        expect(out.text).toBe("restored");
        expect(out.budget.truncated).toBe(false);
    });

    it("hard-clips a non-JSON string that exceeds the budget", () => {
        const out = applyResultBudget("y".repeat(9000), 500);
        expect(out.text.length).toBeLessThanOrEqual(500);
        expect(out.budget.truncated).toBe(true);
    });
});
