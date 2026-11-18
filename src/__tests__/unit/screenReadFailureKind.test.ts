import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * get_screen_state / get_screen_layout failed with "no fiber roots" or "DevTools hook missing" and never said which, so every such row counted as a tool defect. get_screen_state also gave up on the first hook miss, where get_screen_layout waits 400ms and asks again.
 */

let dispatchAnswers: Array<Record<string, unknown>> = [];
let dispatches = 0;

jest.unstable_mockModule("../../core/jsExecute.js", () => ({
    delay: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    executeInApp: async (expression: string) => {
        if (expression.includes("var pending = 0")) return { success: true, result: "0" };
        if (expression.includes("__REACT_DEVTOOLS_GLOBAL_HOOK__") && !expression.includes("__layoutFibers;\n            var meta")) {
            const answer = dispatchAnswers[Math.min(dispatches, dispatchAnswers.length - 1)];
            dispatches++;
            return { success: true, result: JSON.stringify(answer) };
        }
        return { success: true, result: JSON.stringify({ error: "stop here" }) };
    },
}));

const { getScreenState } = await import("../../core/screenState.js");
const { getScreenLayout } = await import("../../core/screenLayout.js");

const HOOK = "React DevTools hook not found. Make sure you are running a development build.";
const NO_ROOTS = "No fiber roots found. The app may not have rendered yet.";
const NO_BUNDLE = "The JS bundle has not run yet (still downloading or starting up, e.g. right after reload_app). Retry in a few seconds.";

beforeEach(() => {
    dispatches = 0;
});

describe("get_screen_state", () => {
    it("retries once when the DevTools hook is not registered yet", async () => {
        dispatchAnswers = [{ error: HOOK }, { count: 0, overlayCount: 0 }];
        const r = await getScreenState();
        expect(dispatches).toBe(2);
        expect(r.error).toBe("stop here");
    });

    it.each([
        [HOOK, "devtools_hook_missing"],
        [NO_BUNDLE, "devtools_hook_missing"],
        [NO_ROOTS, "no_fiber_roots"],
    ])("tags %s", async (error, kind) => {
        dispatchAnswers = [{ error }];
        const r = await getScreenState();
        expect(r.success).toBe(false);
        expect(r.failureKind).toBe(kind);
    });
});

describe("get_screen_layout", () => {
    it.each([
        [HOOK, "devtools_hook_missing"],
        [NO_ROOTS, "no_fiber_roots"],
    ])("tags %s", async (error, kind) => {
        dispatchAnswers = [{ error }];
        const r = await getScreenLayout({});
        expect(r.success).toBe(false);
        expect(r.failureKind).toBe(kind);
    });
});
