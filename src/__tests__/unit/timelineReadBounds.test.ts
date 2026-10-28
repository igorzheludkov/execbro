import { describe, it, expect } from "@jest/globals";
import { makeSourceDeps } from "../../core/timelineSources.js";

// A read tool must not stall on a wedged JS thread or reconnect over another
// debugger: every in-app call the timeline makes is bounded and non-reconnecting.
describe("timeline in-app reads", () => {
    it("never retry, never reconnect, and give up within 3s", async () => {
        const calls: Record<string, unknown>[] = [];
        const deps = makeSourceDeps(async (_expr, _await, options) => {
            calls.push(options);
            return { success: true, result: "null" };
        });
        await deps.readRoutes("iPhone").catch(() => undefined);
        await deps.readRefresh("iPhone").catch(() => undefined);
        await deps.probeDeviceNow("iPhone").catch(() => undefined);
        expect(calls.length).toBeGreaterThanOrEqual(3);
        for (const o of calls) {
            expect(o.maxRetries).toBe(0);
            expect(o.autoReconnect).toBe(false);
            expect(o.timeoutMs as number).toBeLessThanOrEqual(3000);
        }
    });
});
