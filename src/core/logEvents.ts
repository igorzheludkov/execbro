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

// Process-global so an id identifies exactly one event across every device,
// and get_log_details needs no device argument. Deliberately NOT the
// per-device numbering that resolveNetworkBuffer had to retrofit with a
// "@deviceName" suffix after ids collided.
let nextNativeId = 1;

export class NativeLogBuffer {
    private events: LogEvent[] = [];
    private seen = new Set<string>();
    private lastTs: Date | undefined;
    private maxSize: number;

    /**
     * How many fingerprints to retain relative to stored events.
     *
     * `seen` does NOT need to cover all history: the watermark already stops
     * `logcat -T` from returning anything older than the last fetch, so the
     * only thing `seen` must absorb is the inclusive-boundary overlap — a
     * handful of events. Retaining several times maxSize is far more than
     * that window needs while keeping memory bounded in a long-lived server.
     */
    private static readonly SEEN_RETENTION_MULTIPLE = 4;

    constructor(maxSize: number = 200) {
        this.maxSize = maxSize;
    }

    /** Append unseen drafts, assigning ids. Returns only what was new. */
    ingest(drafts: DraftEvent[]): LogEvent[] {
        const added: LogEvent[] = [];
        for (const d of drafts) {
            if (this.seen.has(d.fingerprint)) continue;
            this.seen.add(d.fingerprint);
            const event: LogEvent = { ...d, id: `n${nextNativeId++}` };
            this.events.push(event);
            added.push(event);
            if (!this.lastTs || d.ts > this.lastTs) this.lastTs = d.ts;
        }
        while (this.events.length > this.maxSize) this.events.shift();

        // Set iteration is insertion-ordered, so this drops the oldest
        // fingerprints first.
        const seenCap = this.maxSize * NativeLogBuffer.SEEN_RETENTION_MULTIPLE;
        while (this.seen.size > seenCap) {
            const oldest = this.seen.values().next().value;
            if (oldest === undefined) break;
            this.seen.delete(oldest);
        }

        return added;
    }

    list(): LogEvent[] {
        return [...this.events];
    }

    get(id: string): LogEvent | undefined {
        return this.events.find((e) => e.id === id);
    }

    /** Retained fingerprint count. Exposed for tests that assert bounded growth. */
    get seenSize(): number {
        return this.seen.size;
    }

    /**
     * Clears stored events but NOT the seen-set or watermark — otherwise the
     * next fetch re-ingests everything the caller just cleared.
     */
    clear(): number {
        const count = this.events.length;
        this.events = [];
        return count;
    }

    /** Newest ingested device timestamp. Drives `logcat -T` / `log show --start`. */
    get watermark(): Date | undefined {
        return this.lastTs;
    }

    get size(): number {
        return this.events.length;
    }
}

export const nativeLogBuffers = new Map<string, NativeLogBuffer>();

export function getNativeLogBuffer(deviceKey: string): NativeLogBuffer {
    let buffer = nativeLogBuffers.get(deviceKey);
    if (!buffer) {
        buffer = new NativeLogBuffer(200);
        nativeLogBuffers.set(deviceKey, buffer);
    }
    return buffer;
}

/** Resolve an event id across every device buffer. */
export function findNativeEvent(id: string): LogEvent | undefined {
    for (const buffer of nativeLogBuffers.values()) {
        const hit = buffer.get(id);
        if (hit) return hit;
    }
    return undefined;
}

/** Test-only. */
export function __resetNativeLogBuffers(): void {
    nativeLogBuffers.clear();
    nextNativeId = 1;
}
