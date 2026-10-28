import { describe, expect, it } from "@jest/globals";
import vm from "node:vm";
import { buildCommitReadSource, injectCommitRecorder, parseCommitRead, readCommits, settle, type CommitEntry } from "../../core/commitRecorder.js";
import { COMMIT_RECORDER_JS } from "../../core/injected/commitRecorder.js";

const at = (...times: number[]): CommitEntry[] => times.map((t) => ({ at: t, duration: 1, slowest: null, slowestMs: null }));

describe("settle", () => {
    it("ends the burst at the first gap over 500 ms", () => {
        const r = settle(at(100, 200, 450, 1100), 0, { now: 5000 });
        expect(r.commits).toBe(3);
        expect(r.settledAt).toBe(450);
    });

    it("ignores commits before the anchor", () => {
        expect(settle(at(-50, 10, 20), 0, { now: 5000 }).commits).toBe(2);
    });

    it("reports still rendering when the last commit is recent", () => {
        const r = settle(at(100, 300), 0, { now: 600 });
        expect(r.settledAt).toBeNull();
        expect(r.commits).toBe(2);
    });

    it("caps at 10 s", () => {
        const times: number[] = [];
        for (let t = 0; t <= 12_000; t += 200) times.push(t);
        const r = settle(at(...times), 0, { now: 20_000 });
        expect(r.settledAt).toBe(10_000);
        expect(r.commits).toBe(51);
    });

    it("sums durations and picks the slowest", () => {
        const commits: CommitEntry[] = [
            { at: 10, duration: 54, slowest: "SettingsHeader", slowestMs: 6.8 },
            { at: 20, duration: 4, slowest: "GeneralTab", slowestMs: 3.9 },
            { at: 30, duration: null, slowest: null, slowestMs: null },
        ];
        const r = settle(commits, 0, { now: 5000 });
        expect(r.totalMs).toBe(58);
        expect(r.slowest).toEqual({ name: "SettingsHeader", ms: 6.8 });
    });

    it("returns null total and slowest when every duration is null", () => {
        const commits: CommitEntry[] = [{ at: 10, duration: null, slowest: null, slowestMs: null }];
        const r = settle(commits, 0, { now: 5000 });
        expect(r.totalMs).toBeNull();
        expect(r.slowest).toBeNull();
    });

    it("returns an empty result when nothing committed after the anchor", () => {
        expect(settle(at(-10), 0, { now: 5000 })).toEqual({ commits: 0, totalMs: null, slowest: null, settledAt: null });
    });

    it("respects a custom gapMs", () => {
        const r = settle(at(100, 200, 450, 1100), 0, { now: 5000, gapMs: 1000 });
        expect(r.commits).toBe(4);
        expect(r.settledAt).toBe(1100);
    });
});

const GPL_PATH = "node_modules/react-native/Libraries/Utilities/GlobalPerformanceLogger.js";

function readContext(globals: Record<string, unknown>): vm.Context {
    const ctx = vm.createContext({ nativePerformanceNow: () => 1_000, ...globals });
    vm.runInContext("Date.now = function () { return 10000; };", ctx);
    return ctx;
}

const runRead = (ctx: vm.Context) => parseCommitRead(JSON.parse(vm.runInContext(`JSON.stringify(${buildCommitReadSource()})`, ctx)));

function registry(points: Record<string, number>) {
    const r = (id: number) => (id === 7 ? { default: { getPoints: () => points } } : undefined);
    r.getModules = () => new Map([[7, { verboseName: GPL_PATH }]]);
    return r;
}

describe("read", () => {
    it("converts every timestamp with one offset", () => {
        const ctx = readContext({
            __BUNDLE_START_TIME__: 100,
            __REACT_DEVTOOLS_GLOBAL_HOOK__: { __eb_commitsWrapped: true },
            __eb_commits: [{ t: 400, duration: 5, slowest: "A", slowestMs: 2 }],
            __eb_commits_dropped: 0,
            __r: registry({ initializeCore_end: 185 }),
        });
        const r = runRead(ctx);
        expect(r.installed).toBe(true);
        expect(r.bundleStartAt).toBe(9100);
        expect(r.initializeCoreEndAt).toBe(9185);
        expect(r.commits[0]).toEqual({ at: 9400, duration: 5, slowest: "A", slowestMs: 2 });
    });

    it("reports not installed without a ring", () => {
        expect(runRead(readContext({})).installed).toBe(false);
    });

    it("restores a leftover trap after the bundle started", () => {
        const ctx = readContext({});
        const original = vm.runInContext("Object.defineProperty", ctx);
        vm.runInContext(COMMIT_RECORDER_JS, ctx);
        vm.runInContext("globalThis.__BUNDLE_START_TIME__ = 100;", ctx);
        runRead(ctx);
        expect(vm.runInContext("Object.defineProperty", ctx)).toBe(original);
        expect(ctx.__eb_dp_orig).toBeUndefined();
    });

    it("wraps a hook that arrived without defineProperty and removes the trap", () => {
        const ctx = readContext({});
        const original = vm.runInContext("Object.defineProperty", ctx);
        vm.runInContext(COMMIT_RECORDER_JS, ctx);
        vm.runInContext("globalThis.__BUNDLE_START_TIME__ = 100; var calls = 0; globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { onCommitFiberRoot: function () { calls++; } };", ctx);
        expect(runRead(ctx).installed).toBe(true);
        expect(vm.runInContext("Object.defineProperty", ctx)).toBe(original);
        ctx.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, { current: { actualDuration: 3, child: null } });
        expect(ctx.calls).toBe(1);
        expect(runRead(ctx).commits).toHaveLength(1);
    });

    it("wraps a hook whose onCommitFiberRoot appeared after the define", () => {
        const ctx = readContext({});
        vm.runInContext(COMMIT_RECORDER_JS, ctx);
        vm.runInContext("var hook = {}; Object.defineProperty(globalThis, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { get: function () { return hook; } }); hook.onCommitFiberRoot = function () {}; globalThis.__BUNDLE_START_TIME__ = 100;", ctx);
        expect(runRead(ctx).installed).toBe(true);
    });

    it("keeps the trap while the bundle has not started", () => {
        const ctx = readContext({});
        vm.runInContext("globalThis.__eb_dp_orig = function () {};", ctx);
        runRead(ctx);
        expect(typeof ctx.__eb_dp_orig).toBe("function");
    });

    it("nulls the anchors when unavailable", () => {
        const r = runRead(readContext({}));
        expect(r.bundleStartAt).toBeNull();
        expect(r.initializeCoreEndAt).toBeNull();
    });

    it("readCommits falls back on a failed execute", async () => {
        const r = await readCommits(undefined, async () => ({ success: false, error: "x" }));
        expect(r).toEqual({ installed: false, commits: [], bundleStartAt: null, initializeCoreEndAt: null, dropped: 0 });
    });

    it("parseCommitRead drops malformed entries", () => {
        const r = parseCommitRead({ installed: true, commits: [{ at: "x" }, { at: 5, duration: null, slowest: null, slowestMs: null }] });
        expect(r.commits).toEqual([{ at: 5, duration: null, slowest: null, slowestMs: null }]);
        expect(r.dropped).toBe(0);
    });
});

describe("injectCommitRecorder", () => {
    it("sends one silent evaluate of the recorder", () => {
        const sent: string[] = [];
        injectCommitRecorder({ send: (data: string) => sent.push(data) });
        expect(sent).toHaveLength(1);
        const msg = JSON.parse(sent[0]);
        expect(msg.method).toBe("Runtime.evaluate");
        expect(msg.params.expression).toBe(COMMIT_RECORDER_JS);
        expect(msg.params.silent).toBe(true);
    });
});
