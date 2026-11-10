import { describe, it, expect, jest } from "@jest/globals";

// get_screen_state slept a flat 400ms + 2ms per node between dispatching measureInWindow
// and reading the results (532 to 878ms on the benchmark app), on every call and inside
// every tap's overlay guard. It now polls until every measurement has landed.

const calls: string[] = [];
let pendingAnswers: number[] = [];

jest.unstable_mockModule("../../core/jsExecute.js", () => ({
    delay: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    executeInApp: async (expression: string) => {
        if (expression.includes("var pending = 0")) {
            calls.push("probe");
            return { success: true, result: String(pendingAnswers.length > 1 ? pendingAnswers.shift() : pendingAnswers[0]) };
        }
        if (calls.length === 0) {
            calls.push("dispatch");
            return { success: true, result: JSON.stringify({ count: 200, overlayCount: 0 }) };
        }
        calls.push("resolve");
        return { success: true, result: JSON.stringify({ error: "stop here" }) };
    },
}));

const { getScreenState } = await import("../../core/screenState.js");

describe("get_screen_state measurement wait", () => {
    it("reads back as soon as every measurement landed", async () => {
        calls.length = 0;
        pendingAnswers = [0];
        const t0 = Date.now();

        await getScreenState();

        expect(calls).toEqual(["dispatch", "probe", "resolve"]);
        expect(Date.now() - t0).toBeLessThan(300);
    });

    it("waits out the node budget when a measurement never lands", async () => {
        calls.length = 0;
        pendingAnswers = [1];
        const t0 = Date.now();

        await getScreenState();

        // 400ms + 2ms per node, the old flat wait, is now the deadline.
        expect(Date.now() - t0).toBeGreaterThanOrEqual(800);
        expect(calls[calls.length - 1]).toBe("resolve");
    }, 10000);
});
