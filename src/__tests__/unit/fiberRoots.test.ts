import { describe, it, expect, afterEach } from "@jest/globals";
import { FIBER_ROOTS_JS } from "../../core/injected/fiberRoots.js";

type Roots = Array<{ current: unknown }>;
const run = (all: boolean): Roots => new Function(`${FIBER_ROOTS_JS}; return __eb_fiberRoots(${all});`)() as Roots;
const g = globalThis as Record<string, unknown>;

afterEach(() => {
    delete g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    delete g.document;
});

function fakeDocument(el: Record<string, unknown> | null, bodyChildren: unknown[] = []) {
    g.document = { getElementById: (id: string) => (id === "root" ? el : null), body: { children: bodyChildren } };
}

describe("__eb_fiberRoots — hook path (unchanged behaviour)", () => {
    it("returns renderer 1's roots", () => {
        const r1 = { current: { tag: 3 } };
        g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { renderers: new Map([[1, {}]]), getFiberRoots: (id: number) => new Set(id === 1 ? [r1] : []) };
        expect(run(false)).toEqual([r1]);
    });

    it("falls through to the first renderer with roots when 1 is empty", () => {
        const r2 = { current: { tag: 3 } };
        const r3 = { current: { tag: 3 } };
        g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
            renderers: new Map([[2, {}], [3, {}]]),
            getFiberRoots: (id: number) => new Set(id === 2 ? [r2] : id === 3 ? [r3] : []),
        };
        expect(run(false)).toEqual([r2]);
        expect(run(true)).toEqual([r2, r3]);
    });

    it("prefers the hook over the DOM when the hook has roots", () => {
        const r1 = { current: { tag: 3 } };
        g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { renderers: new Map([[1, {}]]), getFiberRoots: () => new Set([r1]) };
        fakeDocument({ "__reactContainer$x": { tag: 3 } });
        expect(run(false)).toEqual([r1]);
    });
});

describe("__eb_fiberRoots — DOM fallback", () => {
    it("reads #root's container fiber when Vite's stub hook has no renderers", () => {
        const liveRoot: { current: unknown } = { current: null };
        const hostFiber = { tag: 3, stateNode: liveRoot };
        liveRoot.current = { tag: 3, child: { type: "PopoverApp" } };
        g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { renderers: new Map() }; // stub: no getFiberRoots
        fakeDocument({ "__reactContainer$abc123": hostFiber });
        const roots = run(false);
        expect(roots).toHaveLength(1);
        // The live FiberRoot, not the possibly-stale fiber stored at createRoot.
        expect(roots[0]).toBe(liveRoot);
    });

    it("shims { current: fiber } when the fiber has no FiberRoot stateNode", () => {
        const hostFiber = { tag: 3 };
        fakeDocument(null, [{ "__reactContainer$k": hostFiber }]);
        expect(run(false)).toEqual([{ current: hostFiber }]);
    });

    it("works with no hook at all (plain Chrome, no DevTools)", () => {
        const hostFiber = { tag: 3 };
        fakeDocument({ "__reactContainer$k": hostFiber });
        expect(run(true)).toEqual([{ current: hostFiber }]);
    });

    it("returns [] when there is no document (Hermes)", () => {
        expect(run(false)).toEqual([]);
    });
});
