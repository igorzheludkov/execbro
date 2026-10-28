/**
 * Commit recorder — every React commit since the JS runtime started, read on
 * the device's Date clock, plus the rule that groups commits into a burst.
 *
 * The recorder itself is injected (see injected/commitRecorder.ts); this
 * module reads it and owns the burst rule. Where a burst starts is the
 * caller's choice: route render cost anchors on the action that caused the
 * navigation, because the route listener fires a few ms after the commit that
 * mounted the screen, and that commit is usually the expensive one.
 */

import { executeInApp } from "./jsExecute.js";
import type { ExecuteFn } from "./fastRefreshTools.js";
import { buildRequireSource } from "./moduleRegistry.js";
import { getNextMessageId } from "./state.js";
import { COMMIT_RECORDER_JS } from "./injected/commitRecorder.js";

export interface CommitEntry {
    /** Device Date.now() ms. */
    at: number;
    duration: number | null;
    slowest: string | null;
    slowestMs: number | null;
}

export interface SettleResult {
    commits: number;
    totalMs: number | null;
    slowest: { name: string; ms: number } | null;
    /** null while still rendering. */
    settledAt: number | null;
}

const DEFAULT_GAP_MS = 500;
const DEFAULT_CAP_MS = 10_000;

export function settle(
    commits: CommitEntry[],
    anchorAt: number,
    opts: { now: number; gapMs?: number; capMs?: number }
): SettleResult {
    const gapMs = opts.gapMs ?? DEFAULT_GAP_MS;
    const capAt = anchorAt + (opts.capMs ?? DEFAULT_CAP_MS);
    const after = commits.filter((c) => c.at >= anchorAt && c.at <= capAt).sort((a, b) => a.at - b.at);
    if (after.length === 0) return { commits: 0, totalMs: null, slowest: null, settledAt: null };

    let end = 0;
    while (end + 1 < after.length && after[end + 1].at - after[end].at <= gapMs) end++;
    const burst = after.slice(0, end + 1);
    const lastAt = burst[burst.length - 1].at;
    const ranToEnd = end === after.length - 1;
    const stillRendering = ranToEnd && opts.now - lastAt < gapMs && opts.now < capAt;

    let totalMs: number | null = null;
    let slowest: SettleResult["slowest"] = null;
    for (const c of burst) {
        if (c.duration !== null) totalMs = (totalMs ?? 0) + c.duration;
        if (c.slowest !== null && c.slowestMs !== null && (!slowest || c.slowestMs > slowest.ms)) {
            slowest = { name: c.slowest, ms: c.slowestMs };
        }
    }
    return { commits: burst.length, totalMs, slowest, settledAt: stillRendering ? null : lastAt };
}

export interface CommitRead {
    installed: boolean;
    commits: CommitEntry[];
    bundleStartAt: number | null;
    initializeCoreEndAt: number | null;
    /** Commits evicted from the ring. */
    dropped: number;
}

const EMPTY_READ: CommitRead = { installed: false, commits: [], bundleStartAt: null, initializeCoreEndAt: null, dropped: 0 };

/**
 * One evaluate: the ring, the startup anchors, and the offset that moves them
 * from the in-app performance clock to Date.now(). Also finishes the install
 * the trap may have missed, and takes the trap down, so it cannot outlive the
 * bundle's start. ES5 only.
 */
export function buildCommitReadSource(): string {
    return `(function () {
    var g = globalThis;
    var clock = typeof g.nativePerformanceNow === 'function'
        ? g.nativePerformanceNow
        : function () { return g.performance.now(); };
    var offset = Date.now() - clock();
    var started = typeof g.__BUNDLE_START_TIME__ === 'number';
    // Once the bundle has started the trap has done its job. With a hook,
    // re-run the recorder (idempotent) to wrap it if the trap missed it; without
    // one (release build, no React) just take the trap down.
    if (started && g.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
        ${COMMIT_RECORDER_JS};
    } else if (started && g.__eb_dp_orig) {
        if (Object.defineProperty === g.__eb_dp_trap) Object.defineProperty = g.__eb_dp_orig;
        delete g.__eb_dp_orig;
        delete g.__eb_dp_trap;
    }
    var hook = g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    // GlobalPerformanceLogger is per runtime, so its point is cached on the
    // runtime instead of re-indexing the module registry on every read.
    if (started && typeof g.__eb_icEnd !== 'number') {
        try {
            ${buildRequireSource()}
            var m = __eb_require('Libraries/Utilities/GlobalPerformanceLogger.js');
            var logger = m && !m.__eb_error ? (m.default || m) : null;
            var end = logger && typeof logger.getPoints === 'function' ? logger.getPoints().initializeCore_end : null;
            if (typeof end === 'number') g.__eb_icEnd = end;
        } catch (e) {}
    }
    var ring = Array.isArray(g.__eb_commits) ? g.__eb_commits : null;
    var commits = [];
    if (ring) {
        for (var i = 0; i < ring.length; i++) {
            var c = ring[i];
            commits.push({ at: c.t + offset, duration: c.duration, slowest: c.slowest, slowestMs: c.slowestMs });
        }
    }
    return {
        installed: !!(ring && hook && hook.__eb_commitsWrapped),
        commits: commits,
        bundleStartAt: started ? g.__BUNDLE_START_TIME__ + offset : null,
        initializeCoreEndAt: typeof g.__eb_icEnd === 'number' ? g.__eb_icEnd + offset : null,
        dropped: typeof g.__eb_commits_dropped === 'number' ? g.__eb_commits_dropped : 0
    };
})()`;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function parseCommitRead(raw: unknown): CommitRead {
    if (!raw || typeof raw !== "object") return { ...EMPTY_READ, commits: [] };
    const r = raw as Record<string, unknown>;
    const commits: CommitEntry[] = [];
    for (const c of Array.isArray(r.commits) ? r.commits : []) {
        const at = num((c as Record<string, unknown>)?.at);
        if (at === null) continue;
        const e = c as Record<string, unknown>;
        commits.push({ at, duration: num(e.duration), slowest: str(e.slowest), slowestMs: num(e.slowestMs) });
    }
    return {
        installed: r.installed === true,
        commits,
        bundleStartAt: num(r.bundleStartAt),
        initializeCoreEndAt: num(r.initializeCoreEndAt),
        dropped: num(r.dropped) ?? 0,
    };
}

export async function readCommits(device?: string, execute: ExecuteFn = executeInApp): Promise<CommitRead> {
    try {
        const read = await execute(`JSON.stringify(${buildCommitReadSource()})`, false, { originatingToolName: "commit_recorder" }, device);
        if (!read.success || typeof read.result !== "string") return { ...EMPTY_READ, commits: [] };
        return parseCommitRead(JSON.parse(read.result));
    } catch {
        return { ...EMPTY_READ, commits: [] };
    }
}

/**
 * Sent on every new JS context (it lands before the bundle) and on connect (for
 * an app that was already running). Fire-and-forget like the network
 * interceptor: the read reports whether it took.
 */
export function injectCommitRecorder(ws: { send(data: string): void }): void {
    ws.send(JSON.stringify({ id: getNextMessageId(), method: "Runtime.evaluate", params: { expression: COMMIT_RECORDER_JS, silent: true } }));
}
