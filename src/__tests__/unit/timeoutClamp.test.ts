import { describe, expect, it } from "@jest/globals";
import { clampTimeoutMs, TIMEOUT_HARD_CAP_MS } from "../../core/jsExecute.js";

describe("clampTimeoutMs", () => {
    it("returns the value unchanged when below the cap", () => {
        expect(clampTimeoutMs(5000)).toEqual({ value: 5000 });
        expect(clampTimeoutMs(120000)).toEqual({ value: 120000 });
    });

    it("clamps absurd values to the cap and reports the original", () => {
        expect(clampTimeoutMs(3_000_000)).toEqual({ value: TIMEOUT_HARD_CAP_MS, clampedFrom: 3_000_000 });
    });

    it("clamps non-finite or non-positive values to a sensible floor", () => {
        expect(clampTimeoutMs(0)).toEqual({ value: 5000, clampedFrom: 0 });
        expect(clampTimeoutMs(-100)).toEqual({ value: 5000, clampedFrom: -100 });
        expect(clampTimeoutMs(Number.NaN)).toEqual({ value: 5000, clampedFrom: Number.NaN });
    });
});
