import { describe, test, expect, jest, beforeEach } from "@jest/globals";
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
    test("exactly 80% boundary → 80", () => expect(nextThreshold(usage({ limit: 600, used: 480 }))).toBe(80));
    test("just below 80% boundary → null", () => expect(nextThreshold(usage({ limit: 600, used: 479 }))).toBeNull());
    test("exactly 100% boundary → 100", () => expect(nextThreshold(usage({ limit: 600, used: 600 }))).toBe(100));
    test("deferred/uncapped → null", () => {
        expect(nextThreshold(usage({ capActive: false, used: 600 }))).toBeNull();
        expect(nextThreshold(usage({ limit: null, used: 9999 }))).toBeNull();
    });
});

// The 100%-cap banner must reach the human every session even in a month it
// already fired in — a prior session's tool-response block text isn't visible
// to them the way a fresh LogBox push is. See usageNotifications.ts.
describe("maybeNotifyUsage — 100% cap banner fires once per session", () => {
    const pushLogBoxMock = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);

    jest.unstable_mockModule("../../core/logbox.js", () => ({
        pushLogBox: pushLogBoxMock,
        getLastLogBoxError: jest.fn(),
        detectLogBox: jest.fn(),
        dismissLogBox: jest.fn(),
        addLogBoxIgnorePatterns: jest.fn(),
        formatLogBoxWarning: jest.fn(),
        formatDismissedEntries: jest.fn(),
        notifyDriverMissing: jest.fn()
    }));
    let maybeNotifyUsage: typeof import("../../pro/usageNotifications.js").maybeNotifyUsage;

    beforeEach(async () => {
        pushLogBoxMock.mockClear();
        // Fresh module instance per test = fresh in-memory sessionCapNotified,
        // i.e. simulates a new process/session each time.
        jest.resetModules();
        const actualFs = await import("fs");
        jest.unstable_mockModule("fs", () => ({
            ...actualFs,
            // Simulate "already notified this month" persisted from a prior session.
            existsSync: () => true,
            readFileSync: () => JSON.stringify({ monthKey: "2026-08", lastThreshold: 100 }),
            writeFileSync: jest.fn(),
            mkdirSync: jest.fn()
        }));
        ({ maybeNotifyUsage } = await import("../../pro/usageNotifications.js"));
    });

    test("still pushes the banner on a fresh process despite monthly dedup already recorded", async () => {
        await maybeNotifyUsage(usage({ monthKey: "2026-08", used: 600 }));
        expect(pushLogBoxMock).toHaveBeenCalledTimes(1);
    });

    test("does not repeat within the same session", async () => {
        await maybeNotifyUsage(usage({ monthKey: "2026-08", used: 600 }));
        await maybeNotifyUsage(usage({ monthKey: "2026-08", used: 600 }));
        expect(pushLogBoxMock).toHaveBeenCalledTimes(1);
    });
});
