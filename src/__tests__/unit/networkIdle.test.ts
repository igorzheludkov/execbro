import { describe, it, expect } from "@jest/globals";
import { waitForNetworkIdle, withDeadline, IDLE_QUIET_MS, type IdleDeps } from "../../core/networkIdle.js";
import type { NetworkRequest } from "../../core/types.js";

/**
 * A fake clock: sleep advances now, and each request is described by when it starts
 * and when (if ever) it completes. The buffer read returns what exists at `now`.
 */
function fake(specs: Array<{ start: number; end?: number }>) {
    let now = 0;
    let refreshes = 0;
    const deps: IdleDeps = {
        now: () => now,
        sleep: async (ms) => {
            now += ms;
        },
        refresh: async () => {
            refreshes++;
        },
        requests: () =>
            specs
                .filter((s) => s.start <= now)
                .map((s, i) => ({
                    requestId: String(i), method: "GET", url: "http://x/y", headers: {}, epoch: 1,
                    timestamp: new Date(s.start),
                    completed: s.end !== undefined && s.end <= now,
                }) as NetworkRequest),
    };
    return { deps, now: () => now, refreshes: () => refreshes };
}

const opts = { since: 0, capAt: 3000, graceMs: 0 };

describe("waitForNetworkIdle", () => {
    it("returns immediately when nothing started", async () => {
        const f = fake([]);
        expect(await waitForNetworkIdle({ ...opts, graceMs: 300 }, f.deps)).toEqual({ pending: 0, capped: false });
        expect(f.now()).toBe(300);
        expect(f.refreshes()).toBe(1);
    });

    it("waits for an in-flight request and a quiet window", async () => {
        const f = fake([{ start: 0, end: 500 }]);
        expect(await waitForNetworkIdle(opts, f.deps)).toEqual({ pending: 0, capped: false });
        expect(f.now()).toBeGreaterThanOrEqual(500 + IDLE_QUIET_MS);
        expect(f.now()).toBeLessThan(3000);
    });

    it("a chained request joins the wait", async () => {
        // Login answers, then the product list loads.
        const f = fake([{ start: 0, end: 200 }, { start: 350, end: 900 }]);
        await waitForNetworkIdle(opts, f.deps);
        expect(f.now()).toBeGreaterThanOrEqual(900 + IDLE_QUIET_MS);
    });

    it("ignores requests that started before the action", async () => {
        // A long poll that was already open when the tap began must not hold every tap.
        const f = fake([{ start: -1 }]);
        expect(await waitForNetworkIdle(opts, f.deps)).toEqual({ pending: 0, capped: false });
        expect(f.refreshes()).toBe(1);
    });

    it("caps and reports pending", async () => {
        const f = fake([{ start: 0 }]);
        expect(await waitForNetworkIdle(opts, f.deps)).toEqual({ pending: 1, capped: true });
        expect(f.now()).toBeGreaterThanOrEqual(3000);
        expect(f.now()).toBeLessThan(3200);
    });
});

describe("withDeadline", () => {
    it("gives up on a call that does not answer in time", async () => {
        // The SDK mirror refresh has its own 5s timeout; on a wedged JS thread it must not
        // hold the idle wait past its cap.
        const t0 = Date.now();
        expect(await withDeadline(new Promise(() => {}), 20)).toBeUndefined();
        expect(Date.now() - t0).toBeLessThan(500);
    });

    it("returns the value of a call that answers in time", async () => {
        expect(await withDeadline(Promise.resolve(7), 1000)).toBe(7);
    });
});
