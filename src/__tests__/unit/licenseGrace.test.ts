import { describe, it, expect } from "@jest/globals";
import { computeOfflineUsage, GRACE_WINDOW_MS, type UsageInfo } from "../../core/license.js";

function base(over: Partial<UsageInfo> = {}): UsageInfo {
    return {
        used: 100,
        limit: 600,
        monthKey: "2026-08",
        creditsRemaining: null,
        canUse: true,
        capActive: true,
        ...over,
    };
}

const NOW = 1_000_000_000_000;

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
});
