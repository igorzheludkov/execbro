import type { LogEvent } from "./logEvents.js";
import { toStackFrames } from "./logStack.js";
import {
    firstUserFrame,
    symbolicateFrames,
    type StackFrame,
    type SymbolicatedFrame,
} from "./symbolicate.js";

/**
 * Read-time symbolication for log events.
 *
 * Everything here degrades to nothing. Metro unreachable, a production bundle,
 * or a `null` from symbolicateFrames must render the raw entry with no suffix
 * and no error — a log read that fails because the symbolicator is down would
 * be a strict regression on the tool's core job.
 */

/**
 * Distinct frames symbolicated per get_logs call, post-dedupe. A buffer full
 * of errors would otherwise fan out to hundreds of frames in one read.
 */
export const READ_FRAME_BUDGET = 20;

/** Levels whose stacks get resolved in a list read. */
const LIST_LEVELS = new Set(["error", "fatal"]);

export interface ResolvedStacks {
    /** event id -> the frame to render as a suffix. */
    byEventId: Map<string, SymbolicatedFrame>;
    /** Events that had a stack but were cut off by the budget. */
    overBudget: number;
}

const EMPTY: ResolvedStacks = { byEventId: new Map(), overBudget: 0 };

function frameKey(f: StackFrame): string {
    return `${f.file}|${f.lineNumber}|${f.column}`;
}

/** `src/screens/Profile.tsx:84:12 in ProfileHeader` */
export function formatFrame(frame: SymbolicatedFrame): string {
    const where = `${frame.file}:${frame.lineNumber}:${frame.column}`;
    return frame.methodName ? `${where} in ${frame.methodName}` : where;
}

/**
 * Resolves the first user frame for every error/fatal event that carries a
 * stack, in ONE request across the whole response.
 */
export async function resolveListStacks(
    events: readonly LogEvent[],
    budget = READ_FRAME_BUDGET
): Promise<ResolvedStacks> {
    const candidates = events.filter(
        (e) => e.source === "js" && LIST_LEVELS.has(e.level) && e.stackTrace?.length
    );
    if (candidates.length === 0) return EMPTY;

    // Flatten to a deduped request while remembering which unique frame each
    // event's frames map to, so per-event slices survive the dedupe.
    const uniqueFrames: StackFrame[] = [];
    const indexByKey = new Map<string, number>();
    const perEvent: Array<{ id: string; indexes: number[] }> = [];
    let overBudget = 0;

    for (const event of candidates) {
        const frames = toStackFrames(event.stackTrace ?? []);
        if (frames.length === 0) continue;

        const indexes: number[] = [];
        let truncated = false;
        for (const frame of frames) {
            const key = frameKey(frame);
            let idx = indexByKey.get(key);
            if (idx === undefined) {
                if (uniqueFrames.length >= budget) {
                    truncated = true;
                    break;
                }
                idx = uniqueFrames.length;
                indexByKey.set(key, idx);
                uniqueFrames.push(frame);
            }
            indexes.push(idx);
        }
        // Only counts as over budget if nothing usable was resolved for it;
        // a stack whose top frames fit can still yield its first user frame.
        if (truncated && indexes.length === 0) overBudget++;
        if (indexes.length > 0) perEvent.push({ id: event.id, indexes });
    }

    if (uniqueFrames.length === 0) return { byEventId: new Map(), overBudget };

    let resolved: (SymbolicatedFrame | null)[] | null;
    try {
        resolved = await symbolicateFrames(uniqueFrames);
    } catch {
        return { byEventId: new Map(), overBudget };
    }
    if (resolved === null) return { byEventId: new Map(), overBudget };

    const byEventId = new Map<string, SymbolicatedFrame>();
    for (const { id, indexes } of perEvent) {
        const slice = indexes.map((i) => resolved[i] ?? null);
        const first = firstUserFrame(slice);
        if (first) byEventId.set(id, first);
    }

    return { byEventId, overBudget };
}

/**
 * Resolves an event's full stack for get_log_details. Returns rendered lines,
 * or an empty array when there is nothing to show or Metro is unreachable.
 */
export async function resolveFullStack(event: LogEvent): Promise<string[]> {
    const frames = toStackFrames(event.stackTrace ?? []);
    if (frames.length === 0) return [];

    let resolved: (SymbolicatedFrame | null)[] | null;
    try {
        resolved = await symbolicateFrames(frames);
    } catch {
        return [];
    }
    if (resolved === null) return [];

    const lines: string[] = [];
    resolved.forEach((frame, i) => {
        if (frame) {
            // Frames Metro marks `collapse` are RN/React internals. They stay
            // visible — a full stack that hid them would be lying — but the
            // marker tells the agent which lines are not its code.
            lines.push(`  ${frame.collapse ? "·" : "→"} ${formatFrame(frame)}`);
        } else {
            const raw = frames[i];
            lines.push(`  ? ${raw.methodName ?? "<anonymous>"} (unresolved)`);
        }
    });
    return lines;
}
