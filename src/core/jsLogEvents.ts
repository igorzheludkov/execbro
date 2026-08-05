import { createHash } from "node:crypto";
import type { LogEntry } from "./types.js";
import type { EventKind, EventLevel, LogEvent, RawLogLine } from "./logEvents.js";
import { logBuffers } from "./state.js";
import { registerJsEventResolver } from "./logEvents.js";

const JS_FRAME = /^\s+at\s/;
const TITLE_MAX = 160;

function classify(entry: LogEntry): { kind: EventKind; frames: number } {
    const lines = entry.message.split("\n");
    const frames = lines.filter((l) => JS_FRAME.test(l)).length;
    const isError = entry.level === "error" || entry.level === "fatal";
    return { kind: isError && frames > 0 ? "exception" : "message", frames };
}

function titleFor(entry: LogEntry, frames: number): string {
    const head = entry.message.split("\n")[0];
    const clipped = head.length > TITLE_MAX ? `${head.slice(0, TITLE_MAX)}…` : head;
    return frames > 0 ? `${clipped}  (${frames} frames)` : clipped;
}

/**
 * Derive events from console entries at READ time.
 *
 * The CDP ingest path is deliberately untouched — rewriting the hot path every
 * user depends on, just to gain grouping, would be far riskier than deriving
 * on read. `seq` (assigned in LogBuffer.add) is what keeps ids stable.
 */
export function jsEventsFromEntries(entries: LogEntry[], deviceName: string): LogEvent[] {
    return entries.map((entry) => {
        const { kind, frames } = classify(entry);
        const line: RawLogLine = {
            ts: entry.timestamp,
            level: entry.level as EventLevel,
            pid: 0,
            tag: "console",
            message: entry.message,
            raw: entry.message,
        };
        return {
            id: `j${entry.seq}`,
            source: "js",
            deviceKey: deviceName,
            deviceName,
            ts: entry.timestamp,
            level: entry.level as EventLevel,
            kind,
            title: titleFor(entry, frames),
            lineCount: 1,
            byteSize: entry.message.length,
            fingerprint: createHash("sha1").update(`js|${entry.seq}`).digest("hex"),
            lines: [line],
            stackTrace: entry.stackTrace,
        };
    });
}

/** Scan every device buffer for the entry whose seq matches the id. */
export function findJsEvent(id: string): LogEvent | undefined {
    const digits = id.slice(1);
    if (!/^\d+$/.test(digits)) return undefined;
    const seq = Number(digits);
    for (const [deviceName, buffer] of logBuffers.entries()) {
        const hit = buffer.getAll().find((e) => e.seq === seq);
        if (hit) return jsEventsFromEntries([hit], deviceName)[0];
    }
    return undefined;
}

registerJsEventResolver(findJsEvent);
