import { LogEntry, LogLevel } from "./types.js";

// Circular buffer for storing logs
export class LogBuffer {
    private logs: LogEntry[] = [];
    private maxSize: number;

    constructor(maxSize: number = 1000) {
        this.maxSize = maxSize;
    }

    add(entry: LogEntry): void {
        this.logs.push(entry);
        if (this.logs.length > this.maxSize) {
            this.logs.shift();
        }
    }

    get(count?: number, level?: string, startFromText?: string): LogEntry[] {
        let filtered = this.logs;

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

        if (count && count > 0) {
            filtered = filtered.slice(0, count);
        }

        return filtered;
    }

    search(text: string, maxResults?: number): LogEntry[] {
        const results = this.logs.filter((log) =>
            log.message.toLowerCase().includes(text.toLowerCase())
        );
        if (maxResults && maxResults > 0) {
            return results.slice(0, maxResults);
        }
        return results;
    }

    clear(): number {
        const count = this.logs.length;
        this.logs = [];
        return count;
    }

    get size(): number {
        return this.logs.length;
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

            return `${time} ${levelTag} ${message}`;
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
export function getLogSummary(
    logBuffer: LogBuffer,
    options: {
        lastN?: number;
        maxMessageLength?: number;
    } = {}
): string {
    const { lastN = 5, maxMessageLength = 100 } = options;
    const allLogs = logBuffer.getAll();

    if (allLogs.length === 0) {
        return "No logs captured yet.";
    }

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
    lines.push(`Last ${lastN} messages:`);
    const recentLogs = allLogs.slice(-lastN);
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
