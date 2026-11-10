import { delay } from "./jsExecute.js";

// --- measureInWindow completion polling ---

/**
 * Both fiber passes below dispatch measureInWindow for every candidate host and
 * then read the results back in a second eval. The wait between the two used to
 * be a flat `delay(300)`; measured on device (2026-07-31) the two evals cost
 * ~50ms and ~15ms, so the sleep was 5x the real work and dominated every fiber
 * tap (3 depth attempts -> ~1.1s).
 *
 * We now poll the in-app measurement arrays instead. A poll eval is ~15ms, so a
 * screen whose callbacks land in the first frame proceeds in ~40ms instead of
 * 300ms. The deadline keeps the worst case (a host whose callback never fires,
 * leaving a permanent null) no slower than the old fixed wait.
 */
export const MEASURE_POLL_SCHEDULE_MS = [20, 40, 60, 100, 140];
export const MEASURE_POLL_DEADLINE_MS = 300;

/**
 * Poll until every slot in the named in-app measurement arrays is filled.
 * `evaluatePending` returns the number of not-yet-measured slots (or null when
 * the evaluation failed — treated as "stop waiting", same as the old code which
 * simply proceeded after its sleep). Injected for testing.
 */
export async function waitForMeasurements(args: {
    evaluatePending: () => Promise<number | null>;
    /** Give up after this long; the last schedule step repeats until then. */
    deadlineMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}): Promise<{ pending: number | null; polls: number; waitedMs: number }> {
    const now = args.now ?? (() => Date.now());
    const sleep = args.sleep ?? delay;
    const deadline = args.deadlineMs ?? MEASURE_POLL_DEADLINE_MS;
    const start = now();
    let pending: number | null = null;
    let polls = 0;

    for (;;) {
        await sleep(MEASURE_POLL_SCHEDULE_MS[Math.min(polls, MEASURE_POLL_SCHEDULE_MS.length - 1)]);
        pending = await args.evaluatePending();
        polls++;
        // null => the probe itself failed; 0 => everything measured.
        if (pending === null || pending === 0) break;
        if (now() - start >= deadline) break;
    }

    return { pending, polls, waitedMs: now() - start };
}

/**
 * Build the probe expression counting unfilled slots across the given globals.
 */
export function buildPendingMeasurementExpression(globalNames: string[]): string {
    const list = globalNames.map((n) => `globalThis.${n}`).join(", ");
    return `(function() {
        var arrays = [${list}];
        var pending = 0;
        for (var a = 0; a < arrays.length; a++) {
            var m = arrays[a];
            if (!m) continue;
            for (var i = 0; i < m.length; i++) { if (!m[i]) pending++; }
        }
        return pending;
    })()`;
}
