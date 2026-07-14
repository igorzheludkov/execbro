import { describe, it, expect } from "@jest/globals";
import { computeOfflineUsage, GRACE_WINDOW_MS, type UsageInfo } from "../../core/license.js";

const NOW = 1_000_000_000_000;

// Default monthKey matches NOW's UTC month so existing tests (which aren't
// exercising month-rollover behavior) don't unintentionally cross a month
// boundary between the cached verdict and the "now" they're evaluated at.
function currentMonthKeyFor(ts: number): string {
    const d = new Date(ts);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function base(over: Partial<UsageInfo> = {}): UsageInfo {
    return {
        used: 100,
        limit: 600,
        monthKey: currentMonthKeyFor(NOW),
        creditsRemaining: null,
        canUse: true,
        capActive: true,
        ...over,
    };
}

describe("computeOfflineUsage (fail-closed after grace)", () => {
    it("null cache stays null (fail-open when never seen)", () => {
        expect(computeOfflineUsage(null, NOW)).toBeNull();
    });

    it("within grace: trusts the cached verdict, including canUse:false", () => {
        const cached = base({ used: 700, canUse: false, verdictFreshUntil: new Date(NOW + 1000).toISOString() });
        const out = computeOfflineUsage(cached, NOW)!;
        expect(out.canUse).toBe(false);
    });

    it("past grace + last-known under cap: allow", () => {
        const cached = base({ used: 100, canUse: true, verdictFreshUntil: new Date(NOW - 1000).toISOString() });
        expect(computeOfflineUsage(cached, NOW)!.canUse).toBe(true);
    });

    it("past grace + last-known over cap: block", () => {
        const cached = base({ used: 650, canUse: false, verdictFreshUntil: new Date(NOW - 1000).toISOString() });
        expect(computeOfflineUsage(cached, NOW)!.canUse).toBe(false);
    });

    it("past grace but capActive:false (deferred user): allow", () => {
        const cached = base({
            used: 900,
            capActive: false,
            canUse: true,
            verdictFreshUntil: new Date(NOW - 1000).toISOString(),
        });
        expect(computeOfflineUsage(cached, NOW)!.canUse).toBe(true);
    });

    it("GRACE_WINDOW_MS is 72h", () => {
        expect(GRACE_WINDOW_MS).toBe(72 * 60 * 60 * 1000);
    });

    it("past grace + over cap but month has rolled over: allow (monthly counter reset)", () => {
        const cached = base({
            used: 650,
            canUse: false,
            monthKey: "2026-05",
            verdictFreshUntil: new Date(NOW - 1000).toISOString(),
        });
        const laterMonth = Date.UTC(2026, 5, 15); // June 2026, well past May
        expect(computeOfflineUsage(cached, laterMonth)!.canUse).toBe(true);
    });
});
