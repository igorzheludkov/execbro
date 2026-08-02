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
