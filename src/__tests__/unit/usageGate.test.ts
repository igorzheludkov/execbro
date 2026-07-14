import { describe, it, expect, beforeEach } from "@jest/globals";
import {
    freezeSessionVerdict,
    refreezeSessionVerdict,
    isToolBlocked,
    usageWarningLine,
    resetGateForTests,
} from "../../pro/usageGate.js";
import type { UsageInfo } from "../../core/license.js";

function usage(over: Partial<UsageInfo> = {}): UsageInfo {
    return {
        used: 100,
        limit: 600,
        monthKey: "2026-08",
        creditsRemaining: null,
        canUse: true,
        capActive: true,
        warnThreshold: 0.8,
        resetsAt: "2026-09-01T00:00:00Z",
        ...over,
    };
}

beforeEach(() => resetGateForTests());

describe("session verdict freeze", () => {
    it("under cap: nothing blocked", () => {
        freezeSessionVerdict(usage({ used: 100, canUse: true }));
        expect(isToolBlocked("tap").blocked).toBe(false);
    });

    it("over cap: non-exempt tools blocked with a relay message", () => {
        freezeSessionVerdict(usage({ used: 600, canUse: false }));
        const r = isToolBlocked("tap");
        expect(r.blocked).toBe(true);
        expect(r.message).toMatch(/limit reached|monthly limit/i);
        expect(r.message).toMatch(/upgrade/);
    });

    it("exempt tools never blocked even over cap", () => {
        freezeSessionVerdict(usage({ used: 600, canUse: false }));
        expect(isToolBlocked("get_license_status").blocked).toBe(false);
        expect(isToolBlocked("activate_license").blocked).toBe(false);
    });

    it("deferred user (capActive:false) never blocked", () => {
        freezeSessionVerdict(usage({ used: 900, capActive: false, canUse: true }));
        expect(isToolBlocked("tap").blocked).toBe(false);
    });

    it("before freeze (null verdict): allow", () => {
        expect(isToolBlocked("tap").blocked).toBe(false);
    });

    it("freeze is idempotent — stays blocked", () => {
        freezeSessionVerdict(usage({ used: 600, canUse: false }));
        expect(isToolBlocked("tap").blocked).toBe(true);
        freezeSessionVerdict(usage({ used: 100, canUse: true }));
        expect(isToolBlocked("tap").blocked).toBe(true);
    });

    it("freeze is idempotent — stays unblocked", () => {
        freezeSessionVerdict(usage({ used: 100, canUse: true }));
        expect(isToolBlocked("tap").blocked).toBe(false);
        freezeSessionVerdict(usage({ used: 600, canUse: false }));
        expect(isToolBlocked("tap").blocked).toBe(false);
    });

    it("refreezeSessionVerdict lifts a frozen block after mid-session upgrade", () => {
        freezeSessionVerdict(usage({ used: 600, canUse: false }));
        expect(isToolBlocked("tap").blocked).toBe(true);
        refreezeSessionVerdict(usage({ used: 0, canUse: true, limit: null }));
        expect(isToolBlocked("tap").blocked).toBe(false);
    });
});

describe("warning line", () => {
    it("below 80%: no warning", () => {
        expect(usageWarningLine(usage({ used: 100 }))).toBeNull();
    });
    it("at/above 80%: warning with remaining + reset date", () => {
        const line = usageWarningLine(usage({ used: 500 }))!;
        expect(line).toMatch(/100/); // 600-500 remaining
        expect(line).toMatch(/ExecBro/);
    });
    it("deferred or uncapped: no warning", () => {
        expect(usageWarningLine(usage({ capActive: false }))).toBeNull();
        expect(usageWarningLine(usage({ limit: null }))).toBeNull();
    });
    it("invalid resetsAt falls back to 'next month'", () => {
        const line = usageWarningLine(usage({ used: 500, resetsAt: "not-a-date" }))!;
        expect(line).toMatch(/next month/);
    });
});
