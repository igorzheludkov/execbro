import { execFileAsync, withCancelableTimeout } from "./exec.js";
import { IOS_VERDICT_SUBSYSTEMS } from "./logOwnership.js";
import type { EventLevel, RawLogLine } from "./logEvents.js";

const MAX_BUFFER = 32 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;

const MESSAGE_TYPE: Record<string, EventLevel> = {
    Fault: "fatal",
    Error: "error",
    Default: "log",
    Info: "info",
    Debug: "debug",
};

const IOS_SUBJECT_RE = /\b([a-z0-9]+(?:\.[A-Za-z0-9-]+){2,})\b/;

/**
 * `log show --start` parses a bare timestamp as DEVICE-LOCAL time, and rejects
 * an explicit UTC offset (verified against a live simulator). Emitting UTC
 * would therefore shift the window by the host's offset: over-fetching hours
 * of logs east of UTC, and silently MISSING events — crashes included — west
 * of it. The simulator shares the host clock, so local components are correct.
 */
function localStamp(d: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
        `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Build the `log show` invocation.
 *
 * The predicate does the filtering inside the OS: a 30-minute app-scoped read
 * is 42 KB, where an unscoped one is orders of magnitude larger.
 */
export function buildLogShowCommand(opts: {
    udid: string;
    processName?: string;
    sinceTs?: Date;
    /** "error" keeps error+fault; "fault" keeps fault only. */
    minMessageType?: "error" | "fault";
}): string[] {
    const predicates: string[] = [];
    if (opts.processName) {
        // The app's own output AND the verdicts about it. runningboardd, not
        // the app, reports jetsam kills and launch failures, so a bare
        // `process ==` scoped them out of existence: IOS_VERDICT_SUBSYSTEMS
        // could never match, and "surfaces crashes and OOM kills" was false on
        // iOS. Ownership discriminates per line, so admitting the reporters
        // here does not admit their verdicts about other apps.
        const verdicts = [...IOS_VERDICT_SUBSYSTEMS].map((s) => `subsystem == "${s}"`).join(" OR ");
        predicates.push(`(process == "${opts.processName}" OR ${verdicts})`);
    }
    // Enumerated explicitly — the predicate language has no ordering over
    // messageType, so a ">=" comparison silently matches nothing.
    if (opts.minMessageType === "fault") {
        predicates.push("messageType == fault");
    } else if (opts.minMessageType === "error") {
        predicates.push("(messageType == error OR messageType == fault)");
    }

    // argv form: no shell parses this, so the predicate and timestamp carry
    // their spaces and quotes as literal argument bytes.
    const parts = ["simctl", "spawn", opts.udid, "log", "show", "--style", "ndjson"];
    if (opts.sinceTs) {
        parts.push("--start", localStamp(opts.sinceTs));
    } else {
        parts.push("--last", "30m");
    }
    if (predicates.length > 0) {
        parts.push("--predicate", predicates.join(" AND "));
    }
    return parts;
}

export function parseLogShowNdjson(stdout: string): RawLogLine[] {
    const out: RawLogLine[] = [];
    for (const raw of stdout.split("\n")) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        let rec: Record<string, unknown>;
        try {
            rec = JSON.parse(trimmed);
        } catch {
            continue;   // banner or partial line
        }
        // The stream ends with a {count, finished} summary object.
        if (typeof rec.eventMessage !== "string") continue;

        const subsystem = typeof rec.subsystem === "string" ? rec.subsystem : "";
        const category = typeof rec.category === "string" ? rec.category : "";
        const message = rec.eventMessage;
        const messageType = typeof rec.messageType === "string" ? rec.messageType : "Default";
        // `log show` reports no bare process field — only the executable's
        // full path, whose basename is what the `process ==` predicate and
        // resolveIosProcessName both speak in.
        const imagePath = typeof rec.processImagePath === "string" ? rec.processImagePath : "";
        const process = imagePath.split("/").pop() || undefined;

        out.push({
            process,
            ts: new Date(String(rec.timestamp).replace(" ", "T").replace(/([+-]\d{2})(\d{2})$/, "$1:$2")),
            level: MESSAGE_TYPE[messageType] ?? "log",
            pid: Number(rec.processID ?? 0),
            tid: rec.threadID === undefined ? undefined : Number(rec.threadID),
            tag: subsystem || category ? `${subsystem}:${category}` : "default",
            message,
            subject: message.match(IOS_SUBJECT_RE)?.[1],
            raw: trimmed,
        });
    }
    return out;
}

export async function fetchIosLines(opts: {
    udid: string;
    processName?: string;
    sinceTs?: Date;
    minMessageType?: "error" | "fault";
    signal?: AbortSignal;
}): Promise<RawLogLine[]> {
    const args = buildLogShowCommand(opts);
    const { stdout } = await withCancelableTimeout(
        (signal) => execFileAsync("xcrun", args, { signal, maxBuffer: MAX_BUFFER }),
        FETCH_TIMEOUT_MS,
        `log show (${opts.udid})`
    );
    return parseLogShowNdjson(stdout);
}

/**
 * Map a bundle id to the `process ==` value the predicate needs.
 *
 * The predicate matches the executable name, not the bundle id — verified:
 * org.reactjs.native.example.RnDebuggerTestApp -> RnDebuggerTestApp.
 */
const processNameCache = new Map<string, string>();

export async function resolveIosProcessName(
    udid: string,
    bundleId: string,
    signal?: AbortSignal
): Promise<string | undefined> {
    const key = `${udid}:${bundleId}`;
    const cached = processNameCache.get(key);
    if (cached) return cached;
    try {
        const { stdout } = await execFileAsync(
            "xcrun",
            ["simctl", "get_app_container", udid, bundleId, "app"],
            { signal }
        );
        const name = stdout.trim().split("/").pop()?.replace(/\.app$/, "");
        if (name) processNameCache.set(key, name);
        return name || undefined;
    } catch {
        return undefined;
    }
}

/** Test-only. */
export function __resetIosProcessNameCache(): void {
    processNameCache.clear();
}
