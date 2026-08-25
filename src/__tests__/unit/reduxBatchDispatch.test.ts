import { describe, it, expect, jest } from "@jest/globals";

/**
 * Restoring a settings slice to its defaults was 17 sequential redux_dispatch
 * calls, one per field — 17 fiber walks to find the same store. The injected
 * body now loops, so a batch is one round trip. This drives the generated JS
 * against a fake store to assert order and count, not the shape of the string.
 */

const evaluated: string[] = [];

jest.unstable_mockModule("../../core/executor.js", () => ({
    executeInApp: async (expression: string) => {
        evaluated.push(expression);
        return { success: true, result: run(expression) };
    }
}));

const dispatched: unknown[] = [];
const store = {
    dispatch: (a: unknown) => dispatched.push(a),
    getState: () => ({ settings: { a: 1 } }),
    subscribe: () => {}
};

function run(expression: string): string {
    const globalThisStub = {
        __REACT_DEVTOOLS_GLOBAL_HOOK__: {
            renderers: new Map([[1, {}]]),
            getFiberRoots: () => new Set([{ current: { type: { name: "Provider" }, memoizedProps: { store } } }])
        }
    };
    return new Function("globalThis", `return (${expression.trim()});`)(globalThisStub) as string;
}

const { reduxDispatch } = await import("../../core/redux.js");

describe("redux_dispatch batching", () => {
    it("dispatches an array in order in a single round trip", async () => {
        dispatched.length = 0;
        evaluated.length = 0;

        const result = await reduxDispatch({
            action: [
                { type: "settings/setA", payload: false },
                { type: "settings/setB", payload: true }
            ],
            returnPath: "settings"
        });

        expect(evaluated).toHaveLength(1);
        expect(dispatched).toEqual([
            { type: "settings/setA", payload: false },
            { type: "settings/setB", payload: true }
        ]);
        expect(result.success).toBe(true);
        expect(result.state).toEqual({ a: 1 });
    });

    it("still accepts a single action object", async () => {
        dispatched.length = 0;

        const result = await reduxDispatch({ action: { type: "app/setIsLoading", payload: true } });

        expect(dispatched).toEqual([{ type: "app/setIsLoading", payload: true }]);
        expect(result.previousAction).toEqual({ type: "app/setIsLoading", payload: true });
    });
});
