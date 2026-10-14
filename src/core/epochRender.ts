import { resolveDeviceEpoch } from "./state.js";

export type EpochParam = number | "current" | "all" | undefined;

/**
 * Render entries with a visible boundary wherever the app run changes, so the
 * agent can tell "this happened before the restart" from "this is the live run".
 */
export function withRestartDividers<T extends { epoch: number; device?: string }>(
    entries: T[],
    render: (entry: T) => string
): string {
    // Epochs are per device. A merged read interleaves devices, and comparing
    // against the previous row printed a "restart" at every device switch.
    const lines: string[] = [];
    const previousEpoch = new Map<string, number>();
    for (const entry of entries) {
        const key = entry.device ?? "";
        const prev = previousEpoch.get(key);
        if (prev !== undefined && entry.epoch !== prev) {
            lines.push(`── ${entry.device ? `${entry.device}: ` : ""}app restarted (epoch ${entry.epoch}) ──`);
        }
        lines.push(render(entry));
        previousEpoch.set(key, entry.epoch);
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
    if (epoch === "current") return resolveDeviceEpoch(device);
    return epoch;
}
