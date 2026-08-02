/**
 * Route history — which screens the app has been on, in order, with how long
 * it stayed and where it came from.
 *
 * The current route is readable on demand, but "how did I get here" needs a
 * record kept as navigation happens. Capture prefers an in-app navigation
 * listener; when none can be attached the reader falls back to sampling what
 * it observes on each screen read, and says so — a thin trail that looks
 * complete is worse than one that admits what it missed.
 */

import { executeInApp } from "./jsExecute.js";
import { buildNavHandlesSource } from "./navigation.js";
import { getEpoch } from "./state.js";

const DEFAULT_ROUTE_HISTORY_SIZE = 50;

export interface RouteVisit {
    route: string;
    /** Previous route, or null when unknown (first visit, or after a restart). */
    from: string | null;
    enteredAt: number;
    /** null while this is the current route. */
    leftAt: number | null;
    epoch: number;
}

export type RouteHistoryMode = "listener" | "sampled";

export interface RouteHistoryResult {
    mode: RouteHistoryMode;
    visits: RouteVisit[];
}

/** Ring buffer capacity. Override: EXECBRO_ROUTE_HISTORY_SIZE. */
export function routeHistorySize(): number {
    const raw = process.env.EXECBRO_ROUTE_HISTORY_SIZE;
    if (!raw) return DEFAULT_ROUTE_HISTORY_SIZE;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ROUTE_HISTORY_SIZE;
    return parsed;
}

/** "42s" / "9m32s" / "1h04m" */
export function formatDwell(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    if (total < 60) return `${total}s`;
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
    return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function dwellOf(v: RouteVisit, now: number): number {
    return (v.leftAt ?? now) - v.enteredAt;
}

export function formatRouteTrail(result: RouteHistoryResult, now: number): string {
    if (result.visits.length === 0) {
        return "🕒 Route trail: no route changes recorded yet.";
    }

    // Most recent first. Epoch decreases down the list, so a run boundary is a
    // change in epoch between adjacent rendered rows.
    const ordered = [...result.visits].sort((a, b) => b.enteredAt - a.enteredAt);
    const width = Math.max(...ordered.map((v) => v.route.length));

    const lines: string[] = ["🕒 Route trail (most recent first):"];
    ordered.forEach((v, i) => {
        const prev = ordered[i - 1];
        if (prev && prev.epoch !== v.epoch) {
            lines.push(`   ── app restarted (epoch ${prev.epoch}) ──`);
        }
        const dwell = formatDwell(dwellOf(v, now));
        const origin = v.from ? `   ← from ${v.from}` : "";
        lines.push(`   ${v.route.padEnd(width)}  ${dwell.padStart(7)}${origin}`);
    });

    if (result.mode === "sampled") {
        lines.push("");
        lines.push("⚠ sampled — no navigation listener found; transitions between calls may be missing");
    }

    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// In-app capture
// ---------------------------------------------------------------------------

/**
 * Installer for the in-app navigation listener.
 *
 * Idempotent: re-injecting into the same runtime is a no-op, so this can run on
 * connect and again from the reader without double-subscribing. A reload
 * produces a fresh global, which is exactly the signal that a new install is
 * needed.
 *
 * Requires the __eb_nav preamble. ES5 only.
 */
export function buildRouteHistoryInstallSource(cap: number): string {
    return `(function () {
    try {
        var g = globalThis;
        if (g.__ebRouteHistory && g.__ebRouteHistory.installed) {
            return { ok: true, mode: g.__ebRouteHistory.mode, reused: true };
        }
        var store = { installed: true, mode: 'sampled', entries: [] };
        g.__ebRouteHistory = store;

        var ref = (typeof __eb_nav !== 'undefined' && __eb_nav) ? __eb_nav.stateReader : null;
        if (!ref || typeof ref.addListener !== 'function' || typeof ref.getCurrentRoute !== 'function') {
            return { ok: true, mode: 'sampled', reused: false, reason: 'no navigation ref with addListener' };
        }

        var record = function () {
            var name = null;
            try {
                var cur = ref.getCurrentRoute();
                name = cur && cur.name ? cur.name : null;
            } catch (e) { return; }
            if (!name) return;

            var last = store.entries[store.entries.length - 1];
            if (last && last.leftAt === null) {
                if (last.route === name) return;
                last.leftAt = Date.now();
                store.entries.push({ route: name, from: last.route, enteredAt: Date.now(), leftAt: null });
            } else {
                store.entries.push({ route: name, from: null, enteredAt: Date.now(), leftAt: null });
            }
            if (store.entries.length > ${cap}) {
                store.entries.splice(0, store.entries.length - ${cap});
            }
        };

        ref.addListener('state', record);
        store.mode = 'listener';
        record();
        return { ok: true, mode: 'listener', reused: false };
    } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
    }
})()`;
}

/** Reads the in-app buffer. Returns null when nothing is installed. */
export function buildRouteHistoryReadSource(): string {
    return `(function () {
    var s = globalThis.__ebRouteHistory;
    if (!s || !s.installed) return null;
    return { mode: s.mode, entries: s.entries };
})()`;
}

/**
 * Install the listener. Non-fatal by contract: any failure leaves the reader on
 * the sampled path, so callers can fire this without guarding.
 */
export async function installRouteHistory(device?: string): Promise<RouteHistoryMode> {
    try {
        const expr = `(function(){ ${buildNavHandlesSource()}
    return JSON.stringify(${buildRouteHistoryInstallSource(routeHistorySize())});
})()`;
        const res = await executeInApp(expr, false, { originatingToolName: "route_history" }, device);
        if (!res.success || typeof res.result !== "string") return "sampled";
        const parsed = JSON.parse(res.result) as { mode?: string };
        return parsed.mode === "listener" ? "listener" : "sampled";
    } catch {
        return "sampled";
    }
}

/**
 * Read the trail, preferring the in-app buffer and falling back to what we
 * sampled. Self-healing: a missing buffer (first call, or a reload) is
 * installed before reading.
 */
export async function readRouteHistory(device?: string): Promise<RouteHistoryResult> {
    const deviceKey = device ?? "default";
    const epoch = getEpoch(deviceKey);

    try {
        const read = await executeInApp(
            `JSON.stringify(${buildRouteHistoryReadSource()})`,
            false,
            { originatingToolName: "route_history" },
            device
        );

        let payload: { mode?: string; entries?: Array<Omit<RouteVisit, "epoch">> } | null = null;
        if (read.success && typeof read.result === "string" && read.result !== "null") {
            payload = JSON.parse(read.result);
        }

        // No buffer means a fresh runtime (first read, or a reload took it with
        // it). Install and read once more before giving up on the listener.
        if (!payload) {
            const mode = await installRouteHistory(device);
            if (mode === "listener") {
                const again = await executeInApp(
                    `JSON.stringify(${buildRouteHistoryReadSource()})`,
                    false,
                    { originatingToolName: "route_history" },
                    device
                );
                if (again.success && typeof again.result === "string" && again.result !== "null") {
                    payload = JSON.parse(again.result);
                }
            }
        }

        if (payload && payload.mode === "listener" && Array.isArray(payload.entries)) {
            return {
                mode: "listener",
                visits: payload.entries.map((e) => ({ ...e, epoch }))
            };
        }
    } catch {
        // Fall through to the sampled trail.
    }

    return { mode: "sampled", visits: sampledVisits(deviceKey) };
}

// ---------------------------------------------------------------------------
// Sampled fallback (node-side)
//
// Recorded on every screen-state read, not only when history is requested —
// otherwise the fallback would have nothing to show the first time it is asked.
// ---------------------------------------------------------------------------

const sampled = new Map<string, RouteVisit[]>();

export function resetSampledRoutes(): void {
    sampled.clear();
}

export function sampledVisits(deviceKey: string): RouteVisit[] {
    return sampled.get(deviceKey) ?? [];
}

export function recordSampledRoute(
    deviceKey: string,
    route: string,
    epoch: number,
    now: number
): void {
    if (!route) return;
    const visits = sampled.get(deviceKey) ?? [];
    const open = visits[visits.length - 1];

    if (open && open.leftAt === null) {
        // A new run is a new visit even when the route name is unchanged, so a
        // reload cannot read as one long uninterrupted dwell.
        if (open.route === route && open.epoch === epoch) return;
        open.leftAt = now;
        visits.push({
            route,
            from: open.epoch === epoch ? open.route : null,
            enteredAt: now,
            leftAt: null,
            epoch
        });
    } else {
        visits.push({ route, from: null, enteredAt: now, leftAt: null, epoch });
    }

    const cap = routeHistorySize();
    if (visits.length > cap) visits.splice(0, visits.length - cap);
    sampled.set(deviceKey, visits);
}
