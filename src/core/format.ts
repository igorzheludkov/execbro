import { encodeTONL } from "tonl";
import { LogEntry } from "./types.js";
import { NetworkRequest } from "./types.js";

// Output format type
export type OutputFormat = "text" | "tonl";

// TONL format hint to include in responses
const TONL_HINT = "[Format: TONL - compact token-optimized format. Fields in header, values in rows.]\n";

// Truncate message helper
function truncateMessage(message: string, maxLength: number): string {
    if (maxLength <= 0 || message.length <= maxLength) {
        return message;
    }
    return message.slice(0, maxLength) + `...[${message.length}ch]`;
}

// Format logs as TONL
export function formatLogsAsTonl(
    logs: LogEntry[],
    options: { maxMessageLength?: number } = {}
): string {
    const { maxMessageLength = 500 } = options;

    const data = logs.map((log) => ({
        time: log.timestamp.toLocaleTimeString(),
        level: log.level.toUpperCase(),
        msg: truncateMessage(log.message, maxMessageLength)
    }));

    return TONL_HINT + encodeTONL({ logs: data });
}

// Format network requests as TONL (compact list view)
export function formatNetworkAsTonl(requests: NetworkRequest[]): string {
    const data = requests.map((req) => ({
        id: req.requestId,
        time: req.timestamp.toLocaleTimeString(),
        method: req.method,
        status: req.status ?? "pending",
        duration: req.timing?.duration ? `${req.timing.duration}ms` : "-",
        url: req.url,
        error: req.error || undefined
    }));

    return TONL_HINT + encodeTONL({ requests: data });
}
