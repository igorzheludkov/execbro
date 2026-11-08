import { describe, it, expect, jest } from "@jest/globals";

/**
 * `swipe` drives the device through adb/simctl and needs no React Native
 * connection. Its no-op *diagnosis* does — it hit-tests the fiber tree — and
 * `executeInApp` throws (rather than returning a failed result) when an
 * explicit device matches no connected app: `getConnectedAppByDevice` at
 * jsExecute.ts:1058 is unguarded on the reconnect path.
 *
 * The result was that swiping a non-RN screen returned
 * `No connected device matches "emulator-5556"` — the gesture had already been
 * delivered, and an optional explanation of why it changed nothing replaced the
 * successful result with an error. Observed on a launcher home screen with two
 * emulators attached, 2026-08-13.
 *
 * Optional enrichment must never fail the operation it was describing.
 */

const execCalls: unknown[][] = [];
const delays: number[] = [];
let execBehaviour: () => never | Promise<unknown> = async () => ({ success: false });

jest.unstable_mockModule("../../core/jsExecute.js", () => ({
    executeInApp: async (...args: unknown[]) => {
        execCalls.push(args);
        return execBehaviour();
    },
    delay: async (ms: number) => {
        delays.push(ms);
    }
}));

const { probeScrollAt, explainNoOpSwipe } = await import("../../core/swipeDiagnosis.js");

describe("probeScrollAt without a React Native connection", () => {
    it("reports the probe as unavailable instead of throwing", async () => {
        execCalls.length = 0;
        execBehaviour = () => {
            throw new Error('No connected device matches "emulator-5556"');
        };

        const probe = await probeScrollAt(446, 1330, "emulator-5556");

        expect(probe.found).toBe(false);
        expect(probe.unavailable).toBe(true);
    });

    it("does not claim the gesture missed a scroll view when it could not look", async () => {
        // `found: false` alone reads as "there is no scroll view there", which
        // is a statement about the screen. Not being able to inspect the screen
        // is a statement about the connection — different problem, different fix.
        const unavailable = explainNoOpSwipe({ found: false, unavailable: true }, { x: 446, y: 1330 });
        expect(unavailable).toMatch(/no React Native connection|could not/i);
        expect(unavailable).not.toMatch(/did not land on a scrollable surface/);

        const genuinelyMissed = explainNoOpSwipe({ found: false }, { x: 446, y: 1330 });
        expect(genuinelyMissed).toMatch(/did not land on a scrollable surface/);
    });

    it("treats a failed probe the same as a thrown one — both mean we could not look", async () => {
        execCalls.length = 0;
        execBehaviour = async () => ({ success: false, error: "Not connected to any app" });

        const probe = await probeScrollAt(446, 1330, "emulator-5556");

        expect(probe.found).toBe(false);
        expect(probe.unavailable).toBe(true);
    });

    it("still reports a real miss when the app answers", async () => {
        execCalls.length = 0;
        execBehaviour = async () => ({ success: true, result: JSON.stringify({ found: false }) });

        const probe = await probeScrollAt(446, 1330, "emulator-5556");

        expect(probe.found).toBe(false);
        expect(probe.unavailable).toBeUndefined();
    });
});

describe("probeScrollAt timing", () => {
    it("reads as soon as the measurements are in, not after a fixed 250ms", async () => {
        // The probe now runs before and after every connected swipe; a fixed wait made
        // a swipe ~1.1s slower than before (3.3s vs 2.2s median, measured on device).
        execCalls.length = 0;
        delays.length = 0;
        const found = JSON.stringify({ found: true, horizontal: false, offset: 473, maxOffset: 758, component: "ScrollView" });
        let resolves = 0;
        execBehaviour = async () => {
            const expr = String(execCalls[execCalls.length - 1][0]);
            if (expr.includes("dispatched")) return { success: true, result: JSON.stringify({ dispatched: 1 }) };
            resolves++;
            return { success: true, result: resolves === 1 ? JSON.stringify({ notReady: true }) : found };
        };
        const probe = await probeScrollAt(446, 1330, "emulator-5554");
        expect(probe).toMatchObject({ found: true, offset: 473 });
        expect(delays.reduce((a, b) => a + b, 0)).toBeLessThan(250);
    });

    it("reads with bounded options: no retry, no reconnect", async () => {
        execCalls.length = 0;
        execBehaviour = async () => ({ success: true, result: JSON.stringify({ found: false }) });
        await probeScrollAt(446, 1330, "emulator-5554");
        expect(execCalls[0][2]).toMatchObject({ maxRetries: 0, autoReconnect: false });
    });
});
