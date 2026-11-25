import { LogEntry, LogLevel } from "./types.js";
import { getEpoch } from "./state.js";

/** A backfilled line within this of a buffered line with the same text and epoch is the same line. */
export const BACKFILL_DEDUPE_MS = 2000;

// Process-global so ids never collide across per-device buffers.
let nextSeq = 1;

/** Test-only: reset the sequence so assertions are not order-dependent. */
export function __resetLogSeq(): void {
    nextSeq = 1;
}

// Circular buffer for storing logs
export class LogBuffer {
    private logs: LogEntry[] = [];
    private maxSize: number;
    private deviceName?: string;
    private dropped = 0;
    private clears = 0;

    /**
     * @param deviceName When set, add() stamps this device's current epoch.
     *   Omit for merged read buffers so copied entries keep their own epoch.
     */
    constructor(maxSize: number = 1000, deviceName?: string) {
        this.maxSize = maxSize;
        this.deviceName = deviceName;
    }

    add(entry: Omit<LogEntry, "seq" | "epoch"> & { seq?: number; epoch?: number }): void {
        const stamped: LogEntry = {
            ...entry,
            seq: entry.seq ?? nextSeq++,
            epoch: entry.epoch ?? (this.deviceName ? getEpoch(this.deviceName) : 1),
        };
        this.logs.push(stamped);
        if (this.logs.length > this.maxSize) {
            this.logs.shift();
            this.dropped++;
        }
    }

    /**
     * Insert lines logged before CDP attached, ahead of the live lines of the
     * same run. A line the buffer already holds (same epoch, same text, within
     * BACKFILL_DEDUPE_MS) is skipped: around the attach a line can arrive both
     * ways. Returns how many were inserted.
     */
    insertBackfill(entries: Array<Omit<LogEntry, "seq" | "epoch">>, epoch: number): number {
        // ponytail: O(n·m) dedupe scan, n ≤ buffer cap; index by message if backfills get large
        const fresh = [...entries]
            .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
            .filter((e) => !this.logs.some((l) =>
                l.epoch === epoch &&
                l.message === e.message &&
                Math.abs(l.timestamp.getTime() - e.timestamp.getTime()) <= BACKFILL_DEDUPE_MS
            ))
            .map((e): LogEntry => ({ ...e, seq: nextSeq++, epoch }));
        if (fresh.length === 0) return 0;

        const lastTs = fresh[fresh.length - 1].timestamp.getTime();
        const at = this.logs.findIndex((l) => l.epoch === epoch && l.timestamp.getTime() > lastTs);
        this.logs.splice(at === -1 ? this.logs.length : at, 0, ...fresh);
        while (this.logs.length > this.maxSize) {
            this.logs.shift();
            this.dropped++;
        }
        return fresh.length;
    }

    get(count?: number, level?: string, startFromText?: string, epoch?: number): LogEntry[] {
        let filtered = this.logs;

        if (epoch != null) {
            filtered = filtered.filter((log) => log.epoch === epoch);
        }

        // If startFromText is provided, find the LAST matching line and start from there
        if (startFromText) {
            let startIndex = -1;
            for (let i = filtered.length - 1; i >= 0; i--) {
                if (filtered[i].message.includes(startFromText)) {
                    startIndex = i;
                    break;
                }
            }
            if (startIndex !== -1) {
                filtered = filtered.slice(startIndex);
            }
        }

        if (level && level !== "all") {
            filtered = filtered.filter((log) => log.level === level);
        }

        // Newest N. Was slice(0, count) — that returned the OLDEST entries and
        // made a restarted app look like it had produced nothing new.
        if (count && count > 0) {
            filtered = filtered.slice(-count);
        }

        return filtered;
    }

    search(text: string, maxResults?: number): LogEntry[] {
        const results = this.logs.filter((log) =>
            log.message.toLowerCase().includes(text.toLowerCase())
        );
        if (maxResults && maxResults > 0) {
            return results.slice(-maxResults);
        }
        return results;
    }

    clear(): number {
        const count = this.logs.length;
        this.logs = [];
        this.dropped = 0;
        this.clears++;
        return count;
    }

    removeByText(text: string): number {
        const before = this.logs.length;
        this.logs = this.logs.filter(log => !log.message.includes(text));
        return before - this.logs.length;
    }

    get size(): number {
        return this.logs.length;
    }

    /** How many times clear() ran; a background writer compares it to know it raced one. */
    get clearCount(): number {
        return this.clears;
    }

    /** Entries evicted by the capacity cap since the last clear(). */
    get droppedCount(): number {
        return this.dropped;
    }

    getAll(): LogEntry[] {
        return [...this.logs];
    }
}

// Map console type to log level
export function mapConsoleType(type: string): LogEntry["level"] {
    switch (type) {
        case "error":
            return "error";
        case "warning":
        case "warn":
            return "warn";
        case "info":
            return "info";
        case "debug":
            return "debug";
        default:
            return "log";
    }
}

// Options for formatting logs
export interface FormatLogsOptions {
    maxMessageLength?: number;  // Default: 500, set to 0 for unlimited
    verbose?: boolean;          // Disable all truncation
}

// Format logs for text output
export function formatLogs(
    logs: LogEntry[],
    options: FormatLogsOptions = {}
): string {
    if (logs.length === 0) {
        return "No logs captured yet. Make sure Metro is running and the app is connected.";
    }

    const { maxMessageLength = 500, verbose = false } = options;

    return logs
        .map((log) => {
            const time = log.timestamp.toLocaleTimeString();
            const levelTag = `[${log.level.toUpperCase()}]`;
            let message = log.message;

            // Apply truncation unless verbose or unlimited
            if (!verbose && maxMessageLength > 0 && message.length > maxMessageLength) {
                message = message.slice(0, maxMessageLength) + `... [truncated: ${log.message.length} chars]`;
            }

            const origin = log.origin === "systemLog" ? "(syslog) " : "";
            return `${time} ${levelTag} ${origin}${message}`;
        })
        .join("\n");
}

// Get logs with formatting
export function getLogs(
    logBuffer: LogBuffer,
    options: {
        maxLogs?: number;
        level?: LogLevel;
        startFromText?: string;
        maxMessageLength?: number;
        verbose?: boolean;
    } = {}
): { logs: LogEntry[]; count: number; formatted: string } {
    const { maxLogs = 50, level = "all", startFromText, maxMessageLength, verbose } = options;
    const logs = logBuffer.get(maxLogs, level, startFromText);
    return {
        logs,
        count: logs.length,
        formatted: formatLogs(logs, { maxMessageLength, verbose })
    };
}

// Search logs with formatting
export function searchLogs(
    logBuffer: LogBuffer,
    text: string,
    options: {
        maxResults?: number;
        maxMessageLength?: number;
        verbose?: boolean;
    } = {}
): { logs: LogEntry[]; count: number; formatted: string } {
    const { maxResults = 50, maxMessageLength, verbose } = options;
    const logs = logBuffer.search(text, maxResults);
    return {
        logs,
        count: logs.length,
        formatted: formatLogs(logs, { maxMessageLength, verbose })
    };
}

// Get log summary (counts by level + last N messages)
//
// `level` narrows the sample messages only. The By-Level breakdown stays over
// the whole buffer on purpose: it is the one number that tells the caller
// whether the level they asked for is even present, and filtering it would
// reduce it to a single self-evident row.
export function getLogSummary(
    logBuffer: LogBuffer,
    options: {
        lastN?: number;
        maxMessageLength?: number;
        level?: string;
    } = {}
): string {
    const { lastN = 5, maxMessageLength = 100, level: levelFilter } = options;
    const allLogs = logBuffer.getAll();

    if (allLogs.length === 0) {
        return "No logs captured yet.";
    }

    // Same comparison LogBuffer.get uses, so summary and full reads agree on
    // what "level" means.
    const filtering = !!levelFilter && levelFilter !== "all";
    const sampleSource = filtering ? allLogs.filter((log) => log.level === levelFilter) : allLogs;

    // Count by level
    const byLevel: Record<string, number> = {};
    for (const log of allLogs) {
        byLevel[log.level] = (byLevel[log.level] || 0) + 1;
    }

    const lines: string[] = [];
    lines.push(`Total: ${allLogs.length} logs`);
    lines.push("");
    lines.push("By Level:");
    for (const [level, count] of Object.entries(byLevel).sort((a, b) => b[1] - a[1])) {
        lines.push(`  ${level.toUpperCase()}: ${count}`);
    }

    // Last N messages
    lines.push("");
    const scope = filtering ? ` ${levelFilter!.toUpperCase()}` : "";
    lines.push(`Last ${lastN}${scope} messages:`);
    const recentLogs = sampleSource.slice(-lastN);
    if (recentLogs.length === 0) {
        lines.push(`  (none — no ${levelFilter} logs in the buffer)`);
    }
    for (const log of recentLogs) {
        const time = log.timestamp.toLocaleTimeString();
        let message = log.message;
        if (maxMessageLength > 0 && message.length > maxMessageLength) {
            message = message.slice(0, maxMessageLength) + "...";
        }
        lines.push(`  ${time} [${log.level.toUpperCase()}] ${message}`);
    }

    return lines.join("\n");
}
