import { describe, it, expect } from "@jest/globals";
import {
    waitForMeasurements,
    buildPendingMeasurementExpression,
    MEASURE_POLL_SCHEDULE_MS,
    MEASURE_POLL_DEADLINE_MS,
} from "../../core/pressables.js";

function harness(pendingSequence: (number | null)[]) {
    let clock = 0;
    let calls = 0;
    return {
        get elapsed() { return clock; },
        get calls() { return calls; },
        args: {
            evaluatePending: async () => {
                const v = pendingSequence[Math.min(calls, pendingSequence.length - 1)];
                calls++;
                clock += 15; // measured cost of the probe eval on device
                return v;
            },
            now: () => clock,
            sleep: async (ms: number) => { clock += ms; },
        },
    };
}

describe("waitForMeasurements", () => {
    it("returns after the first poll when every callback already landed", async () => {
        const h = harness([0]);
        const result = await waitForMeasurements(h.args);

        expect(result.pending).toBe(0);
        expect(h.calls).toBe(1);
        // The whole wait costs one short sleep + one probe — far below the old
        // flat 300ms delay this replaced.
        expect(h.elapsed).toBe(MEASURE_POLL_SCHEDULE_MS[0] + 15);
    });

    it("keeps polling while measurements are still outstanding", async () => {
        const h = harness([4, 2, 0]);
        const result = await waitForMeasurements(h.args);

        expect(result.pending).toBe(0);
        expect(h.calls).toBe(3);
        expect(result.polls).toBe(3);
    });

    it("stops at the deadline when a callback never fires", async () => {
        const h = harness([1]); // permanently pending
        const result = await waitForMeasurements(h.args);

        expect(result.pending).toBe(1);
        // Never waits materially longer than the flat delay it replaced.
        expect(h.elapsed).toBeLessThanOrEqual(MEASURE_POLL_DEADLINE_MS + 200);
        expect(h.calls).toBeLessThanOrEqual(MEASURE_POLL_SCHEDULE_MS.length);
    });

    it("gives up immediately when the probe itself fails", async () => {
        const h = harness([null]);
        const result = await waitForMeasurements(h.args);

        expect(result.pending).toBeNull();
        expect(h.calls).toBe(1);
    });
});

describe("buildPendingMeasurementExpression", () => {
    it("counts unfilled slots across every named global", () => {
        const expr = buildPendingMeasurementExpression(["__a", "__b"]);
        expect(expr).toContain("globalThis.__a");
        expect(expr).toContain("globalThis.__b");

        // The expression must be valid, self-contained JS that reports the
        // number of null slots — evaluate it against a stub global.
        const globalThisStub = { __a: [{ x: 1 }, null], __b: [null] };
        const value = new Function("globalThis", `return ${expr};`)(globalThisStub);
        expect(value).toBe(2);
    });

    it("treats a missing global as nothing to wait for", () => {
        const expr = buildPendingMeasurementExpression(["__missing"]);
        expect(new Function("globalThis", `return ${expr};`)({})).toBe(0);
    });
});
