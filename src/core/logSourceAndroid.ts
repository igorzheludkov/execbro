import { execAsync, withCancelableTimeout } from "./exec.js";
import type { EventLevel, RawLogLine } from "./logEvents.js";

/** A full dump is 13.8 MB; node's exec default is 1 MiB. */
const MAX_BUFFER = 32 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 5000;

const PRIORITY: Record<string, EventLevel> = {
    V: "debug",
    D: "debug",
    I: "info",
    W: "warn",
    E: "error",
    F: "fatal",
};

// "  1785352265.203  1210 13886 I NearbyMediums: Wifi changed"
const LINE_RE = /^\s*(\d+\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+([^:]*?)\s*:\s?(.*)$/;

const SUBJECT_PATTERNS = [
    /^Cmdline:\s*(\S+)/,
    />>>\s*(\S+)\s*<<</,
    /^Process:\s*([\w.]+)/,
];

function declaredSubject(message: string): string | undefined {
    for (const re of SUBJECT_PATTERNS) {
        const m = message.match(re);
        if (m) return m[1];
    }
    return undefined;
}

/**
 * Build the logcat invocation.
 *
 * Filtering is pushed into adb rather than done in node: a full dump is
 * 13.8 MB, and node's exec buffer is 1 MiB by default.
 */
export function buildLogcatArgs(opts: {
    serial?: string;
    sinceTs?: Date;
    pid?: number;
    minPriority?: string;
    /** Read ONLY the crash buffer — used when app identity is unknown. */
    crashOnly?: boolean;
}): string {
    const parts = ["adb"];
    if (opts.serial) parts.push("-s", opts.serial);
    // crash first: it is small, and it is where tombstones land.
    parts.push("logcat", "-d", "-b", opts.crashOnly ? "crash" : "crash,main", "-v", "epoch");
    if (opts.sinceTs) {
        parts.push("-T", `'${(opts.sinceTs.getTime() / 1000).toFixed(3)}'`);
    }
    if (opts.pid !== undefined) parts.push(`--pid=${opts.pid}`);
    if (opts.minPriority) parts.push(`'*:${opts.minPriority}'`);
    return parts.join(" ");
}

export function parseLogcatEpoch(stdout: string): RawLogLine[] {
    const out: RawLogLine[] = [];
    for (const raw of stdout.split("\n")) {
        if (!raw.trim() || raw.startsWith("---------")) continue;
        const m = raw.match(LINE_RE);
        if (!m) continue;
        const [, epoch, pid, tid, priority, tag, message] = m;
        out.push({
            ts: new Date(Math.round(parseFloat(epoch) * 1000)),
            level: PRIORITY[priority] ?? "log",
            pid: Number(pid),
            tid: Number(tid),
            tag: tag.trim(),
            message,
            subject: declaredSubject(message),
            raw,
        });
    }
    return out;
}

export async function fetchAndroidLines(opts: {
    serial?: string;
    sinceTs?: Date;
    pid?: number;
    minPriority?: string;
    crashOnly?: boolean;
    signal?: AbortSignal;
}): Promise<RawLogLine[]> {
    const cmd = buildLogcatArgs(opts);
    const { stdout } = await withCancelableTimeout(
        (signal) => execAsync(cmd, { signal, maxBuffer: MAX_BUFFER }),
        FETCH_TIMEOUT_MS,
        `logcat (${opts.serial ?? "default device"})`
    );
    return parseLogcatEpoch(stdout);
}

/** Resolve the app's live pid, or undefined when it is not running. */
export async function resolveAndroidPid(
    packageName: string,
    serial?: string,
    signal?: AbortSignal
): Promise<number | undefined> {
    const target = serial ? `-s ${serial}` : "";
    try {
        const { stdout } = await execAsync(`adb ${target} shell pidof -s ${packageName}`, { signal });
        const pid = Number(stdout.trim());
        return Number.isFinite(pid) && pid > 0 ? pid : undefined;
    } catch {
        // Not running — expected after a crash, which is the main case.
        return undefined;
    }
}
