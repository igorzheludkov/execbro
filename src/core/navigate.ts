import type { FailureKind } from "./errors.js";
import { executeInApp } from "./jsExecute.js";
import {
    buildNavHandlesSource,
    buildRouteTableSource,
    buildNearestRoutesSource,
    buildNavigateSource,
    type NavAction
} from "./navigation.js";

/**
 * Poll schedule for confirming a navigation.
 *
 * Same-evaluation reads are unreliable in a way that varies BY APP: astro-app
 * read stale (reporting no change for a navigation that succeeded), gifted read
 * fresh. Both React Navigation, both measured 2026-07-31. Since the behaviour
 * cannot be predicted, verification is always a separate, delayed read — an app
 * that happens to read fresh simply settles on the first poll and costs one
 * round trip rather than four.
 */
export const POLL_DELAYS_MS = [150, 350, 600, 900];

export interface NavigationOutcome {
    changed: boolean;
    indeterminate: boolean;
}

/**
 * `changed: false` and `indeterminate` mean different things and must not be
 * collapsed: the first says a guard bounced us or the destination was already
 * current; the second says we never obtained a settled reading at all.
 */
export function classifyNavigationOutcome(
    before: string | null,
    after: string | null,
    settled: boolean
): NavigationOutcome {
    if (!settled) return { changed: false, indeterminate: true };
    return { changed: before !== after, indeterminate: false };
}

export interface PerformNavigationOptions {
    action: NavAction;
    to?: string;
    params?: Record<string, unknown>;
    device?: string;
    includeRouteTable?: boolean;
}

export interface NavigationResult {
    success: boolean;
    kind: string | null;
    action: string;
    to: string | null;
    route: { before: string | null; after: string | null };
    changed: boolean;
    indeterminate: boolean;
    stack?: string[];
    routeTable?: string[];
    /** Structured cause, forwarded to telemetry by the tool layer. */
    failureKind?: FailureKind;
    error?: string;
}

function preamble(): string {
    return `${buildNavHandlesSource()}\n${buildRouteTableSource()}\n${buildNearestRoutesSource()}`;
}

/**
 * Read the settled position: current route, the active stack path, and the
 * route table (so a caller asking for it does not pay a second round trip).
 */
function readStateExpression(): string {
    return `(function(){ ${preamble()}
    var t = __eb_routeTable();
    var reader = __eb_nav && __eb_nav.stateReader;
    var stack = [];
    if (reader && typeof reader.getRootState === 'function') {
        try {
            var s = reader.getRootState();
            var guard = 0;
            while (s && s.routes && guard < 8) {
                var i = (typeof s.index === 'number') ? s.index : s.routes.length - 1;
                var r = s.routes[i];
                if (!r) break;
                stack.push(r.name);
                s = r.state;
                guard++;
            }
        } catch (e) { /* leave the stack partial rather than failing the read */ }
    }
    return JSON.stringify({ current: t.current, currentId: t.currentId, stack: stack, all: t.all });
})()`;
}

export async function performNavigation(opts: PerformNavigationOptions): Promise<NavigationResult> {
    const { action, to = null, params, device, includeRouteTable } = opts;

    // Asking for the route table with nowhere to go is a LISTING, not a failed
    // navigation. This is the tool's only route-discovery affordance, and
    // requiring a destination to reach it made it unreachable until you already
    // knew the answer.
    if (action !== "back" && action !== "reset" && !to && includeRouteTable === true) {
        const read = await executeInApp(readStateExpression(), false, { originatingToolName: "navigate" }, device);
        if (read.success) {
            try {
                const parsed = JSON.parse(String(read.result)) as { current: string | null; stack: string[]; all: string[] };
                return {
                    success: true, kind: null, action, to,
                    route: { before: parsed.current, after: parsed.current },
                    changed: false, indeterminate: false,
                    stack: parsed.stack,
                    routeTable: parsed.all
                };
            } catch {
                // Fall through to the normal path, which reports the real error.
            }
        }
    }

    const perform = `(function(){ ${preamble()}
    return JSON.stringify(${buildNavigateSource(action, to, params ?? null)});
})()`;

    const performed = await executeInApp(perform, false, { originatingToolName: "navigate" }, device);
    if (!performed.success) {
        return {
            success: false, kind: null, action, to,
            route: { before: null, after: null }, changed: false, indeterminate: false,
            error: performed.error
        };
    }

    let head: { ok: boolean; badArgs?: boolean; kind: string | null; error?: string; before?: string | null; beforeId?: string | null; routes?: string[] };
    try {
        head = JSON.parse(String(performed.result));
    } catch {
        return {
            success: false, kind: null, action, to,
            route: { before: null, after: null }, changed: false, indeterminate: false,
            error: `Unparseable navigation result: ${String(performed.result).slice(0, 200)}`
        };
    }

    const before = head.before ?? null;
    if (!head.ok) {
        // Hand back the registered routes whenever the app knew them. Expo
        // Router destinations are paths and never appear in routeNames, so the
        // list is legitimately empty there and nothing is appended.
        const routes = head.routes ?? [];
        const shown = routes.slice(0, 12);
        const hint = shown.length > 0
            ? ` Registered routes: ${shown.join(", ")}${routes.length > shown.length ? ` (+${routes.length - shown.length} more)` : ""}.`
            : "";
        return {
            success: false, kind: head.kind, action, to,
            route: { before, after: before }, changed: false, indeterminate: false,
            ...(routes.length > 0 && { routeTable: routes }),
            // Flagged at the refusal site rather than matched on the message
            // here, for the same reason `failureKind` exists at all: the text
            // is free to be reworded and the classification must not move
            // with it.
            ...(head.badArgs === true && { failureKind: "bad_arguments" as const }),
            error: `${head.error ?? "Navigation failed"}${hint}`
        };
    }

    // Settle-poll. Exit as soon as the route moves, so an app whose state reads
    // fresh pays one round trip instead of four.
    // Compared by route key + params when the router reports them, so a move to
    // the same route name with new params is not reported as "did not change".
    const beforeId = head.beforeId ?? before;
    let after: string | null = before;
    let afterId: string | null = beforeId;
    let stack: string[] = [];
    let all: string[] = [];
    let settled = false;
    for (const delay of POLL_DELAYS_MS) {
        await new Promise((r) => setTimeout(r, delay));
        const read = await executeInApp(readStateExpression(), false, { originatingToolName: "navigate" }, device);
        if (!read.success) continue;
        try {
            const parsed = JSON.parse(String(read.result)) as { current: string | null; currentId?: string | null; stack: string[]; all: string[] };
            after = parsed.current;
            afterId = parsed.currentId ?? parsed.current;
            stack = parsed.stack;
            all = parsed.all;
            settled = true;
            if (afterId !== beforeId) break;
        } catch {
            // Try the next poll rather than failing the whole navigation.
        }
    }

    const outcome = classifyNavigationOutcome(beforeId, afterId, settled);
    return {
        success: true, kind: head.kind, action, to,
        route: { before, after },
        changed: outcome.changed,
        indeterminate: outcome.indeterminate,
        stack,
        routeTable: includeRouteTable ? all : undefined
    };
}
