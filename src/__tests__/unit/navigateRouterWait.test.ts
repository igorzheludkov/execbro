import { describe, it, expect, jest } from "@jest/globals";
import type { ExecutionResult } from "../../core/types.js";

// "No router resolved" failed in 15-90ms, and about half of those came within 10s of reload_app or scan_metro: the app was still mounting.

let respond: (expression: string) => ExecutionResult = () => ({ success: true, result: "{}" });
const calls: string[] = [];
jest.unstable_mockModule("../../core/jsExecute.js", () => ({
    executeInApp: async (expression: string) => {
        calls.push(expression);
        return respond(expression);
    }
}));

const { performNavigation } = await import("../../core/navigate.js");

const rnRef = {
    navigate: () => undefined,
    resetRoot: () => undefined,
    getCurrentRoute: () => ({ name: "Home", key: "Home" }),
    getRootState: () => ({ routeNames: ["Home", "Settings"], index: 0, routes: [{ name: "Home" }] })
};
const run = (expression: string, stub: Record<string, unknown>): ExecutionResult =>
    ({ success: true, result: new Function("globalThis", "return " + expression)(stub) });

describe("navigate while the app is still mounting", () => {
    it("waits for a router to appear instead of refusing at once", async () => {
        calls.length = 0;
        respond = (e) => run(e, calls.length > 2 ? { __EB_TEST_FIBER_NAV__: rnRef } : {});
        const r = await performNavigation({ action: "navigate", to: "Settings" });
        expect(r.success).toBe(true);
    }, 10000);

    it("tags an empty fiber tree as no_fiber_roots once the wait runs out", async () => {
        calls.length = 0;
        respond = (e) => run(e, {});
        const started = Date.now();
        const r = await performNavigation({ action: "navigate", to: "Settings" });
        expect(r.success).toBe(false);
        expect(r.failureKind).toBe("no_fiber_roots");
        // Bounded: about 3s, not forever.
        expect(Date.now() - started).toBeLessThan(5000);
        expect(calls.length).toBeGreaterThan(2);
    }, 10000);

    it("forwards the failure kind of a failed evaluation", async () => {
        respond = () => ({ success: false, error: "No apps connected", failureKind: "no_apps_connected" });
        const r = await performNavigation({ action: "navigate", to: "Settings" });
        expect(r.success).toBe(false);
        expect(r.failureKind).toBe("no_apps_connected");
    });
});
