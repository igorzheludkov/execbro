import { createHash } from "node:crypto";
import type { LogLevel } from "./types.js";

/**
 * Real severity levels, ordered. Excludes the "all" sentinel that LogLevel
 * carries for the get_logs `level` filter — ranking a sentinel is meaningless,
 * and Record<LogLevel, number> would demand an entry for it.
 */
export type EventLevel = Exclude<LogLevel, "all">;

/**
 * A single log line after platform normalization. Everything downstream of
 * acquisition — ownership, grouping, relevance — operates on this shape, so
 * the Android and iOS paths share one implementation each.
 */
export interface RawLogLine {
    ts: Date;
    level: EventLevel;
    pid: number;
    tid?: number;
    /** Android tag, or iOS "subsystem:category". */
    tag: string;
    message: string;
    /**
     * The owner this line DECLARES as its subject — parsed from `Cmdline:`,
     * `>>> pkg <<<`, or `Process: pkg`. A tombstone is written by tombstoned's
     * pid, not the dead app's, so this is the only way to attribute a crash.
     */
    subject?: string;
    raw: string;
}

export type EventKind = "crash" | "anr" | "exception" | "lifecycle" | "message";

export interface LogEvent {
    /** "n7" (native) | "j12" (js). Globally unique, stable for the session. */
    id: string;
    source: "native" | "js";
    deviceKey: string;
    deviceName: string;
    ts: Date;
    level: EventLevel;
    kind: EventKind;
    title: string;
    owner?: string;
    lineCount: number;
    byteSize: number;
    fingerprint: string;
    lines: RawLogLine[];
}

/** An event before the buffer assigns it an id. */
export type DraftEvent = Omit<LogEvent, "id">;

export interface AppIdentity {
    /** simulatorUdid ?? adbSerial — the buffer key. Never deviceName. */
    deviceKey: string;
    platform: "ios" | "android";
    /** THIS device's identifier. iOS bundle id and Android package differ. */
    appId: string;
    /** Live pid, when the app is running. Absent after a crash. */
    pid?: number;
}

export const LEVEL_RANK: Record<EventLevel, number> = {
    debug: 0,
    log: 1,
    info: 2,
    warn: 3,
    error: 4,
    fatal: 5,
};

/**
 * Identity of an event, derived from its FIRST line only.
 *
 * `logcat -T <ts>` is inclusive of the boundary, so the last event seen always
 * comes back on the next fetch — and it may come back truncated if the window
 * cut mid-backtrace. Hashing only the header line keeps the two reads equal.
 * The device timestamp is used, never the host clock: emulators measured 4s
 * of skew, which would make host-derived hashes unstable.
 */
export function fingerprintEvent(lines: RawLogLine[], deviceKey: string): string {
    const head = lines[0];
    if (!head) return createHash("sha1").update(`${deviceKey}|empty`).digest("hex");
    const parts = [
        deviceKey,
        head.ts.toISOString(),
        String(head.pid),
        head.tag,
        head.message,
    ];
    // JSON.stringify, not join("|"): log messages and tags are free-form and
    // routinely contain the separator, which would let two different field
    // splits hash identically and silently collapse two distinct events into
    // one during dedupe.
    return createHash("sha1").update(JSON.stringify(parts)).digest("hex");
}
