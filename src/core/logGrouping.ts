import {
    fingerprintEvent,
    LEVEL_RANK,
    type DraftEvent,
    type EventKind,
    type EventLevel,
    type RawLogLine,
} from "./logEvents.js";

export interface GroupContext {
    deviceKey: string;
    deviceName: string;
    source: "native" | "js";
}

const CRASH_OPENERS = [/^\*{3}\s/, /^Cmdline:/, /^pid:\s+\d+.*>>>/];
const JAVA_CRASH_OPENER = /^FATAL EXCEPTION/;
const ANR_OPENER = /^ANR in /;
const JAVA_CONTINUATION = /^\s*(at\s|Caused by:|\.\.\.\s|[\w.$]+(Exception|Error)([:\s]|$))/;

/** `pid:tid:tag` — logcat interleaves processes, so adjacency cannot group. */
function streamKey(line: RawLogLine): string {
    return `${line.pid}:${line.tid ?? line.pid}:${line.tag}`;
}

function openerKind(line: RawLogLine): EventKind | null {
    if (CRASH_OPENERS.some((re) => re.test(line.message))) return "crash";
    if (JAVA_CRASH_OPENER.test(line.message)) return "crash";
    if (ANR_OPENER.test(line.message)) return "anr";
    return null;
}

function continues(kind: EventKind, open: RawLogLine, line: RawLogLine): boolean {
    if (streamKey(open) !== streamKey(line)) return false;
    if (kind === "crash" && line.tag === "DEBUG") return true;
    if (kind === "crash" && line.tag === "AndroidRuntime") {
        return JAVA_CONTINUATION.test(line.message) || /^Process:/.test(line.message);
    }
    if (kind === "anr") return line.message.trim().length > 0;
    return false;
}

/**
 * Frame #00 of every abort is libc.so (abort+…) — the mechanism, not the
 * cause — with the ART/libbase abort helpers stacked above it. Naming those
 * gives every SIGABRT on every device an identical, useless title, so skip
 * them and report the first frame belonging to real code. Falls back to the
 * first library seen if the whole backtrace is runtime machinery.
 */
const ABORT_MACHINERY = /^(libc|libc\+\+|libart|libbase|liblog|libutils|libcutils|libbacktrace|libunwindstack)\.so$/;

function culpritLibrary(lines: RawLogLine[]): string | undefined {
    let fallback: string | undefined;
    for (const line of lines) {
        const m = line.message.match(/\/([\w.\-+]+\.so)\s*\(/);
        if (!m) continue;
        if (!fallback) fallback = m[1];
        if (!ABORT_MACHINERY.test(m[1])) return m[1];
    }
    return fallback;
}

function titleFor(kind: EventKind, lines: RawLogLine[]): string {
    const text = lines.map((l) => l.message).join("\n");
    if (kind === "crash") {
        const signal = text.match(/signal\s+\d+\s+\(([A-Z]+)\)/);
        if (signal) {
            const frames = lines.filter((l) => /^\s*#\d+\s+pc\s/.test(l.message)).length;
            const so = culpritLibrary(lines);
            const where = so ? ` in ${so}` : "";
            return `${signal[1]}${where}${frames ? ` (${frames} frames)` : ""}`;
        }
        const java = text.match(/^([\w.$]+(?:Exception|Error))(?::\s*(.*))?$/m);
        if (java) {
            const frames = lines.filter((l) => /^\s*at\s/.test(l.message)).length;
            const detail = java[2] ? `: ${java[2]}` : "";
            return `${java[1]}${detail}${frames ? ` (${frames} frames)` : ""}`;
        }
    }
    if (kind === "anr") return lines[0].message;
    const first = lines[0].message;
    return first.length > 160 ? `${first.slice(0, 160)}…` : first;
}

function maxLevel(lines: RawLogLine[]): EventLevel {
    return lines.reduce<EventLevel>(
        (acc, l) => (LEVEL_RANK[l.level] > LEVEL_RANK[acc] ? l.level : acc),
        "debug"
    );
}

function toDraft(kind: EventKind, lines: RawLogLine[], ctx: GroupContext): DraftEvent {
    return {
        source: ctx.source,
        deviceKey: ctx.deviceKey,
        deviceName: ctx.deviceName,
        ts: lines[0].ts,
        level: maxLevel(lines),
        kind,
        title: titleFor(kind, lines),
        owner: lines.find((l) => l.subject)?.subject,
        lineCount: lines.length,
        byteSize: lines.reduce((n, l) => n + l.raw.length, 0),
        fingerprint: fingerprintEvent(lines, ctx.deviceKey),
        lines,
    };
}

/**
 * Correlate lines into events.
 *
 * Continuation is keyed on (pid, tid, tag) rather than adjacency because
 * logcat interleaves processes: a foreign line can land in the middle of a
 * backtrace without ending it. Unmatched lines become single-line `message`
 * events rather than being dropped, so an unrecognized crash format still
 * surfaces — worse formatting, never silence.
 */
export function groupIntoEvents(lines: RawLogLine[], ctx: GroupContext): DraftEvent[] {
    const events: DraftEvent[] = [];
    const open = new Map<string, { kind: EventKind; lines: RawLogLine[] }>();

    const flush = (key: string) => {
        const group = open.get(key);
        if (group) {
            events.push(toDraft(group.kind, group.lines, ctx));
            open.delete(key);
        }
    };

    for (const line of lines) {
        const key = streamKey(line);
        const existing = open.get(key);

        if (existing && continues(existing.kind, existing.lines[0], line)) {
            existing.lines.push(line);
            continue;
        }
        if (existing) flush(key);

        const kind = openerKind(line);
        if (kind) {
            open.set(key, { kind, lines: [line] });
        } else {
            events.push(toDraft("message", [line], ctx));
        }
    }

    for (const key of [...open.keys()]) flush(key);
    events.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    return events;
}
