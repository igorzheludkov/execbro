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
