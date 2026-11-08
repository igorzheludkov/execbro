/**
 * Wait for the requests an action started to finish, capped. The same idea as Detox's
 * idle synchronization, limited and reported instead of open-ended: an app that polls
 * or holds a long request is never idle, so only requests that started after the
 * action count, and whatever is still running at the cap is reported, not waited on.
 *
 * Why it exists: on a Sign in tap the screen settles before /auth/login answers, so
 * reading at the visual settle reported the request as pending and missed the error
 * text and route change that followed.
 */

import type { NetworkRequest } from "./types.js";

export const IDLE_CAP_MS = 3000;
/** After the last request finishes, how long nothing may start before the app counts as idle. */
export const IDLE_QUIET_MS = 300;
/** Before the first poll when no visual settle ran: a touch reaches JS some ms after the driver returns. */
export const IDLE_GRACE_MS = 300;
export const IDLE_POLL_MS = 100;

export interface IdleDeps {
    now(): number;
    sleep(ms: number): Promise<void>;
    refresh(): Promise<void>;
    requests(): NetworkRequest[];
}

export async function waitForNetworkIdle(
    opts: { since: number; capAt: number; graceMs: number },
    deps: IdleDeps
): Promise<{ pending: number; capped: boolean }> {
    if (opts.graceMs > 0) await deps.sleep(opts.graceMs);
    let quietSince: number | null = null;
    for (;;) {
        await deps.refresh();
        const started = deps.requests().filter((r) => r.timestamp.getTime() >= opts.since);
        const inFlight = started.filter((r) => !r.completed).length;
        if (started.length === 0) return { pending: 0, capped: false };
        if (inFlight === 0) {
            quietSince ??= deps.now();
            if (deps.now() - quietSince >= IDLE_QUIET_MS) return { pending: 0, capped: false };
        } else {
            quietSince = null;
        }
        if (deps.now() >= opts.capAt) return { pending: inFlight, capped: true };
        await deps.sleep(IDLE_POLL_MS);
    }
}
