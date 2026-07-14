import { describe, test, expect } from "@jest/globals";
import { nextThreshold } from "../../pro/usageNotifications.js";
import type { UsageInfo } from "../../core/license.js";

function usage(over: Partial<UsageInfo> = {}): UsageInfo {
    return {
        used: 0,
        limit: 600,
        monthKey: "2026-08",
        creditsRemaining: null,
        canUse: true,
        capActive: true,
        warnThreshold: 0.8,
        ...over,
    };
}

describe("nextThreshold", () => {
    test("below 80% → null", () => expect(nextThreshold(usage({ used: 100 }))).toBeNull());
    test("80–99% → 80", () => expect(nextThreshold(usage({ used: 500 }))).toBe(80));
    test("100%+ → 100", () => expect(nextThreshold(usage({ used: 600 }))).toBe(100));
    test("deferred/uncapped → null", () => {
        expect(nextThreshold(usage({ capActive: false, used: 600 }))).toBeNull();
        expect(nextThreshold(usage({ limit: null, used: 9999 }))).toBeNull();
    });
});
