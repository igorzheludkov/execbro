import { describe, it, expect } from "@jest/globals";
import { classifyNavigationOutcome, POLL_DELAYS_MS } from "../../core/navigate.js";

describe("classifyNavigationOutcome", () => {
    it("reports changed when the route moved", () => {
        const out = classifyNavigationOutcome("Home", "TarotScreen", true);
        expect(out.changed).toBe(true);
        expect(out.indeterminate).toBe(false);
    });

    it("reports unchanged when the route settled without moving", () => {
        const out = classifyNavigationOutcome("Home", "Home", true);
        expect(out.changed).toBe(false);
        expect(out.indeterminate).toBe(false);
    });

    it("reports indeterminate when polling never settled", () => {
        // Distinct from a confirmed no-move: the caller must not read this as
        // "a route guard bounced me".
        const out = classifyNavigationOutcome("Home", "Home", false);
        expect(out.changed).toBe(false);
        expect(out.indeterminate).toBe(true);
    });

    it("polls with a schedule long enough for an async dispatch to land", () => {
        // A same-evaluation read-back reported changed:false on a navigation
        // that had succeeded (AppC), so the first poll must not be
        // immediate. AppA read fresh, so the schedule must also exit early —
        // that is covered by performNavigation, not the schedule itself.
        expect(POLL_DELAYS_MS[0]).toBeGreaterThanOrEqual(100);
        expect(POLL_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1500);
    });
});
