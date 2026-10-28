import { describe, expect, it } from "@jest/globals";
import vm from "node:vm";
import { COMMIT_RECORDER_JS } from "../../core/injected/commitRecorder.js";

/**
 * The recorder only ever runs inside the app's JS context, so these tests run
 * it for real in a `vm` context against a fake DevTools hook and hand-built
 * fibers, the way networkInterceptorXhr.test.ts drives the interceptor.
 */

interface Commit {
    t: number;
    duration: number | null;
    slowest: string | null;
    slowestMs: number | null;
}

interface Fiber {
    tag: number;
    type?: unknown;
    flags?: number;
    selfBaseDuration?: number;
    child?: Fiber | null;
    sibling?: Fiber | null;
    alternate?: { child: Fiber | null | undefined } | null;
}

function makeContext(): vm.Context {
    let clock = 1000;
    const ctx = vm.createContext({ nativePerformanceNow: () => (clock += 1) });
    vm.runInContext(
        `var __calls = []; var __hook = { onCommitFiberRoot: function (id, root) { __calls.push(root); return 'orig-result'; } };`,
        ctx
    );
    return ctx;
}

function installHookNow(ctx: vm.Context): void {
    vm.runInContext(`globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = __hook;`, ctx);
}

/** react-devtools-core's installHook, reduced to the part that matters. */
const INSTALL_HOOK = `
if (!globalThis.hasOwnProperty('__REACT_DEVTOOLS_GLOBAL_HOOK__')) {
    Object.defineProperty(globalThis, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
        configurable: false, enumerable: false, get: function () { return __hook; }
    });
}`;

const evalRecorder = (ctx: vm.Context) => vm.runInContext(COMMIT_RECORDER_JS, ctx);
const commit = (ctx: vm.Context, root: unknown) => ctx.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, root);
const commits = (ctx: vm.Context): Commit[] => ctx.__eb_commits;
const rootOf = (child: Fiber | null, actualDuration: number | undefined = 10) => ({
    current: { tag: 3, actualDuration, child, alternate: null },
});
const fn = (name: string) => ({ [name]: function () {} })[name];

describe("COMMIT_RECORDER_JS", () => {
    it("wraps an existing hook and records a commit", () => {
        const ctx = makeContext();
        installHookNow(ctx);
        evalRecorder(ctx);
        expect(commit(ctx, rootOf(null, 54))).toBe("orig-result");
        expect(ctx.__calls.length).toBe(1);
        expect(commits(ctx).length).toBe(1);
        expect(commits(ctx)[0].duration).toBe(54);
    });

    it("installs through the defineProperty trap and restores it", () => {
        const ctx = makeContext();
        const original = vm.runInContext("Object.defineProperty", ctx);
        evalRecorder(ctx);
        expect(vm.runInContext("Object.defineProperty", ctx)).not.toBe(original);
        vm.runInContext(INSTALL_HOOK, ctx);
        expect(ctx.__REACT_DEVTOOLS_GLOBAL_HOOK__).toBe(ctx.__hook);
        expect(vm.runInContext("Object.defineProperty", ctx)).toBe(original);
        expect(ctx.__eb_dp_orig).toBeUndefined();
        commit(ctx, rootOf(null));
        expect(commits(ctx).length).toBe(1);
        expect(ctx.__calls.length).toBe(1);
    });

    it("leaves other defineProperty calls working", () => {
        const ctx = makeContext();
        const original = vm.runInContext("Object.defineProperty", ctx);
        evalRecorder(ctx);
        expect(vm.runInContext("Object.defineProperty({}, 'x', { value: 1 }).x", ctx)).toBe(1);
        expect(vm.runInContext("Object.defineProperty", ctx)).not.toBe(original);
    });

    it("is idempotent", () => {
        const ctx = makeContext();
        installHookNow(ctx);
        evalRecorder(ctx);
        evalRecorder(ctx);
        commit(ctx, rootOf(null));
        expect(commits(ctx).length).toBe(1);
        expect(ctx.__calls.length).toBe(1);
    });

    it("keeps the trap single when injected twice before the hook exists", () => {
        const ctx = makeContext();
        const original = vm.runInContext("Object.defineProperty", ctx);
        evalRecorder(ctx);
        evalRecorder(ctx);
        vm.runInContext(INSTALL_HOOK, ctx);
        expect(vm.runInContext("Object.defineProperty", ctx)).toBe(original);
        commit(ctx, rootOf(null));
        expect(commits(ctx).length).toBe(1);
    });

    it("removes a leftover trap when injected again with the hook present", () => {
        const ctx = makeContext();
        const original = vm.runInContext("Object.defineProperty", ctx);
        evalRecorder(ctx);
        vm.runInContext("globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = __hook;", ctx);
        evalRecorder(ctx);
        expect(vm.runInContext("Object.defineProperty", ctx)).toBe(original);
        expect(ctx.__eb_dp_orig).toBeUndefined();
        commit(ctx, rootOf(null));
        expect(commits(ctx).length).toBe(1);
    });

    it("leaves a defineProperty that someone replaced after the trap alone", () => {
        const ctx = makeContext();
        evalRecorder(ctx);
        vm.runInContext("var theirs = function () {}; Object.defineProperty = theirs; globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = __hook;", ctx);
        evalRecorder(ctx);
        expect(vm.runInContext("Object.defineProperty === theirs", ctx)).toBe(true);
        expect(ctx.__eb_dp_orig).toBeUndefined();
    });

    it("timestamps the commit before the original handler runs", () => {
        const ctx = makeContext();
        vm.runInContext(`var __origAt; __hook.onCommitFiberRoot = function () { __origAt = nativePerformanceNow(); };`, ctx);
        installHookNow(ctx);
        evalRecorder(ctx);
        commit(ctx, rootOf(null));
        expect(commits(ctx)[0].t).toBeLessThan(ctx.__origAt);
    });

    it("uses nativePerformanceNow even when it appears after injection", () => {
        const ctx = vm.createContext({ performance: { now: () => 5 } });
        vm.runInContext(`var __hook = { onCommitFiberRoot: function () {} };`, ctx);
        evalRecorder(ctx);
        ctx.nativePerformanceNow = () => 777;
        vm.runInContext(INSTALL_HOOK, ctx);
        commit(ctx, rootOf(null));
        expect(commits(ctx)[0].t).toBe(777);
    });

    it("sets no trap when the bundle has started without a hook", () => {
        const ctx = makeContext();
        const original = vm.runInContext("Object.defineProperty", ctx);
        vm.runInContext("globalThis.__BUNDLE_START_TIME__ = 100;", ctx);
        evalRecorder(ctx);
        expect(vm.runInContext("Object.defineProperty", ctx)).toBe(original);
        expect(ctx.__eb_dp_orig).toBeUndefined();
    });

    it("does not swallow the original's throw and records nothing", () => {
        const ctx = makeContext();
        vm.runInContext(`__hook.onCommitFiberRoot = function () { throw new Error('boom'); };`, ctx);
        installHookNow(ctx);
        evalRecorder(ctx);
        expect(() => commit(ctx, rootOf(null))).toThrow("boom");
        expect(commits(ctx).length).toBe(0);
    });

    it("survives a malformed root", () => {
        const ctx = makeContext();
        installHookNow(ctx);
        evalRecorder(ctx);
        expect(commit(ctx, null)).toBe("orig-result");
        expect(ctx.__calls.length).toBe(1);
    });

    it("skips the walk when the duration is missing", () => {
        const ctx = makeContext();
        installHookNow(ctx);
        evalRecorder(ctx);
        const child: Fiber = { tag: 0, type: fn("A"), flags: 1, selfBaseDuration: 5 };
        commit(ctx, { current: { tag: 3, child, alternate: null } });
        expect(commits(ctx)[0].duration).toBeNull();
        expect(commits(ctx)[0].slowest).toBeNull();
    });

    it("picks the slowest component that performed work", () => {
        const ctx = makeContext();
        installHookNow(ctx);
        evalRecorder(ctx);
        const host: Fiber = { tag: 5, type: "View", flags: 1, selfBaseDuration: 99 };
        const c: Fiber = { tag: 0, type: fn("C"), flags: 0, selfBaseDuration: 50, sibling: host };
        const b: Fiber = { tag: 0, type: fn("B"), flags: 1, selfBaseDuration: 9, sibling: c };
        const a: Fiber = { tag: 0, type: fn("A"), flags: 1, selfBaseDuration: 3, sibling: b };
        commit(ctx, rootOf(a));
        expect(commits(ctx)[0].slowest).toBe("B");
        expect(commits(ctx)[0].slowestMs).toBe(9);
    });

    it("unwraps memo and forwardRef names", () => {
        const ctx = makeContext();
        installHookNow(ctx);
        evalRecorder(ctx);
        commit(ctx, rootOf({ tag: 14, type: { type: fn("Inner") }, flags: 1, selfBaseDuration: 4 }));
        commit(ctx, rootOf({ tag: 11, type: { render: fn("Fwd") }, flags: 1, selfBaseDuration: 4 }));
        expect(commits(ctx)[0].slowest).toBe("Inner");
        expect(commits(ctx)[1].slowest).toBe("Fwd");
    });

    it("skips subtrees whose child pointer is unchanged", () => {
        const ctx = makeContext();
        installHookNow(ctx);
        evalRecorder(ctx);
        const heavy: Fiber = { tag: 0, type: fn("Heavy"), flags: 1, selfBaseDuration: 40 };
        const parent: Fiber = { tag: 0, type: fn("Parent"), flags: 1, selfBaseDuration: 2, child: heavy };
        parent.alternate = { child: heavy };
        commit(ctx, rootOf(parent));
        expect(commits(ctx)[0].slowest).toBe("Parent");
    });

    it("stops after 2000 fibers", () => {
        const ctx = makeContext();
        installHookNow(ctx);
        evalRecorder(ctx);
        let head: Fiber | null = null;
        for (let i = 2999; i >= 0; i--) {
            head = { tag: 0, type: fn(`F${i}`), flags: i === 2500 ? 1 : 0, selfBaseDuration: 1, sibling: head };
        }
        commit(ctx, rootOf(head));
        expect(commits(ctx)[0].slowest).toBeNull();
    });

    it("caps the ring at 500 and counts drops", () => {
        const ctx = makeContext();
        installHookNow(ctx);
        evalRecorder(ctx);
        for (let i = 0; i < 510; i++) commit(ctx, rootOf(null));
        expect(commits(ctx).length).toBe(500);
        expect(ctx.__eb_commits_dropped).toBe(10);
    });
});
