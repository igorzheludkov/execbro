import { getEpoch } from "./state.js";

export type EpochParam = number | "current" | "all" | undefined;

/**
 * Render entries with a visible boundary wherever the app run changes, so the
 * agent can tell "this happened before the restart" from "this is the live run".
 */
export function withRestartDividers<T extends { epoch: number }>(
    entries: T[],
    render: (entry: T) => string
): string {
    const lines: string[] = [];
    let previousEpoch: number | null = null;
    for (const entry of entries) {
        if (previousEpoch !== null && entry.epoch !== previousEpoch) {
            lines.push(`── app restarted (epoch ${entry.epoch}) ──`);
        }
        lines.push(render(entry));
        previousEpoch = entry.epoch;
    }
    return lines.join("\n");
}

/**
 * Silence here is the failure mode: a capped, truncated view is otherwise
 * indistinguishable from a complete one.
 */
export function evictionNotice(droppedCount: number, envVar: string): string {
    if (droppedCount <= 0) return "";
    return `\n\n[${droppedCount.toLocaleString("en-US")} older entries evicted — raise ${envVar} to retain more]`;
}

/**
 * Defaults to undefined (no filter) so pre-restart data is visible by default —
 * hiding it would reintroduce the exact symptom this feature fixes.
 */
export function resolveEpochFilter(epoch: EpochParam, device?: string): number | undefined {
    if (epoch === undefined || epoch === "all") return undefined;
    if (epoch === "current") return getEpoch(device ?? "unknown");
    return epoch;
}
