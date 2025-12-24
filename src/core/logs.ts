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

// Format logs for text output
export function formatLogs(logs: LogEntry[]): string {
    if (logs.length === 0) {
        return "No logs captured yet. Make sure Metro is running and the app is connected.";
    }

    return logs
        .map((log) => {
            const time = log.timestamp.toLocaleTimeString();
            const levelTag = `[${log.level.toUpperCase()}]`;
            return `${time} ${levelTag} ${log.message}`;
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
    } = {}
): { logs: LogEntry[]; formatted: string } {
    const { maxLogs = 50, level = "all", startFromText } = options;
    const logs = logBuffer.get(maxLogs, level, startFromText);
    return {
        logs,
        formatted: formatLogs(logs)
    };
}

// Search logs with formatting
export function searchLogs(
    logBuffer: LogBuffer,
    text: string,
    maxResults: number = 50
): { logs: LogEntry[]; formatted: string } {
    const logs = logBuffer.search(text, maxResults);
    return {
        logs,
        formatted: formatLogs(logs)
    };
}
