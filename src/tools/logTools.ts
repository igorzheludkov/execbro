import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerToolWithTelemetry } from "../core/register.js";
import {
    getLogs,
    searchLogs,
    getLogSummary,
    getTotalLogCount,
    getConnectedAppByDevice,
    getFirstConnectedApp,
    checkAndEnsureConnection,
    metroMissingHintIfAbsent,
    logBuffers,
    verifyLogPipeline,
    getPassiveConnectionStatus,
    connectedApps,
    getRecentGaps,
    formatDuration,
    getLogBuffer,
} from "../core/index.js";
import { resolveLogBuffer } from "../core/toolHelpers.js";
import { diagnoseEmptyLogs, type LogDiagnosis } from "../core/logDiagnosis.js";
import { UserInputError } from "../core/errors.js";
import {
    isSDKInstalled,
    querySDKConsole,
    clearSDKConsole,
    getSDKConsoleStats,
} from "../core/sdkBridge.js";
import { findLogEvent, getNativeLogBuffer, nativeLogBuffers } from "../core/logEvents.js";
import "../core/jsLogEvents.js";
import { formatEventList, formatEventDetails } from "../core/logEventFormat.js";
import { collectNativeEvents } from "../core/nativeLogs.js";

// Binds the live connection/pipeline probes for `diagnoseEmptyLogs`. Kept here
// so the diagnosis logic itself stays free of module-level state and testable.
function logDiagnosisDeps(device?: string) {
    return {
        checkConnection: () => checkAndEnsureConnection(device),
        resolveApp: () => (device ? getConnectedAppByDevice(device) : getFirstConnectedApp()),
        verifyPipeline: verifyLogPipeline,
    };
}

export function registerLogTools(server: McpServer): void {
    // Tool: Get console logs
    registerToolWithTelemetry(
        server,
        "get_logs",
        {
            description:
                "Retrieve console logs from connected React Native app. Tip: Use summary=true first for a quick overview (counts by level + last 5 messages), then fetch specific logs as needed.\n" +
                "PURPOSE: Pull captured console output (log/warn/error/info/debug) from the in-memory buffer for the connected app.\n" +
                "WHEN TO USE: Start of any log-driven investigation, verifying a code change picked up via Fast Refresh, or confirming a reported error actually fires.\n" +
                "WORKFLOW: scan_metro -> get_logs(summary=true) -> narrow with search_logs(text=\"...\") or get_logs(level=\"error\") -> clear_logs between reproductions.\n" +
                "LIMITATIONS: Circular buffer (~500 entries). Only captures logs emitted after the app connected; pre-connect logs are lost.\n" +
                "GOOD: get_logs({ summary: true }) then get_logs({ level: \"error\", maxLogs: 20 })\n" +
                "BAD: get_logs({ maxLogs: 500, verbose: true }) as a first call — floods context; start with summary=true.\n" +
                "SEE ALSO: call get_usage_guide(topic=\"logs\") for the full console-debugging playbook.",
            inputSchema: {
                maxLogs: z.coerce
                    .number()
                    .optional()
                    .default(50)
                    .describe("Maximum number of logs to return (default: 50)"),
                level: z
                    .enum(["all", "log", "warn", "error", "info", "debug"])
                    .optional()
                    .default("all")
                    .describe("Filter by log level (default: all)"),
                startFromText: z.string().optional().describe("Start from the first log line containing this text"),
                maxMessageLength: z.coerce
                    .number()
                    .optional()
                    .default(500)
                    .describe(
                        "Max characters per message (default: 500, set to 0 for unlimited). Tip: Use lower values for overview, higher when debugging specific data structures."
                    ),
                verbose: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe(
                        "Disable all truncation and return full messages. Tip: Use with lower maxLogs (e.g., 10) to avoid token overload when inspecting large objects."
                    ),
                summary: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe(
                        "Return summary statistics instead of full logs (count by level + last 5 messages). Use for quick overview."
                    ),
                device: z.string().optional().describe("Target device name (substring match). Omit for all devices. Run get_apps to see connected devices.")
            }
        },
        async ({ maxLogs, level, startFromText, maxMessageLength, verbose, summary, device }) => {
            // Check if SDK is installed — prefer SDK data for richer logs.
            // `device` must be threaded through: without it the SDK bridge reads
            // whichever app happens to be first, so a multi-device session
            // silently answers with the wrong device's buffer.
            const sdkAvailable = await isSDKInstalled(device);
    
            if (sdkAvailable) {
                if (summary) {
                    const sdkStats = await getSDKConsoleStats(device);
                    // An empty SDK buffer is not an answer — fall through to the
                    // CDP buffer below rather than reporting zero logs.
                    if (sdkStats.success && sdkStats.data.total > 0) {
                        const s = sdkStats.data;
                        const lines: string[] = [];
                        lines.push(`Total logs: ${s.total}`);
                        if (s.byLevel && Object.keys(s.byLevel).length > 0) {
                            lines.push("\nBy Level:");
                            for (const [lvl, cnt] of Object.entries(s.byLevel)) lines.push(`  ${lvl}: ${cnt}`);
                        }
                        // Served real SDK data — not empty, regardless of what the
                        // (separate) CDP buffer happens to hold.
                        return { _emptyResult: false, content: [{ type: "text" as const, text: `Log Summary (SDK):\n\n${lines.join("\n")}` }] };
                    }
                }
    
                const sdkResult = await querySDKConsole({ count: maxLogs, level, text: startFromText }, device);
                if (sdkResult.success && sdkResult.data.length > 0) {
                    const entries = sdkResult.data;
                    const lines = entries.map((e) => {
                        const time = new Date(e.timestamp).toLocaleTimeString();
                        let msg = e.message;
                        if (!verbose && maxMessageLength > 0 && msg.length > maxMessageLength) {
                            msg = msg.slice(0, maxMessageLength) + "...";
                        }
                        return `[${time}] [${e.level.toUpperCase()}] ${msg}`;
                    });
                    return { _emptyResult: false, content: [{ type: "text" as const, text: `Console Logs (${entries.length} entries, SDK):\n\n${lines.join("\n")}` }] };
                }
            }
    
            // Return summary if requested
            if (summary) {
                const buffer = resolveLogBuffer(device);
                const summaryText = getLogSummary(buffer, { lastN: 5, maxMessageLength: 100 });
                // Judge emptiness by the buffer this summary was actually built
                // from, not the global count across every device.
                const summaryEmpty = buffer.size === 0;
                let connectionWarning = "";
                let emptyReason: string | undefined;
                if (summaryEmpty) {
                    const diagnosis = await diagnoseEmptyLogs(logDiagnosisDeps(device));
                    connectionWarning = diagnosis.warning;
                    emptyReason = diagnosis.reason;
                    connectionWarning += await metroMissingHintIfAbsent("get_logs");
                }
                return {
                    _emptyResult: summaryEmpty,
                    ...(emptyReason && { _emptyReason: emptyReason }),
                    content: [
                        {
                            type: "text",
                            text: `Log Summary:\n\n${summaryText}${connectionWarning}`
                        }
                    ]
                };
            }
    
            // Resolved once: for the all-devices case this copies every buffered
            // entry into a merged buffer, so it is not free to call repeatedly.
            const logBuffer = resolveLogBuffer(device);
            const { logs, count, formatted } = getLogs(logBuffer, {
                maxLogs,
                level,
                startFromText,
                maxMessageLength,
                verbose
            });

            // `_emptyResult` measures CAPTURE reliability, not whether this
            // particular call returned rows — see the 2026-03-19 empty-result
            // spec. A filter that matches nothing is a natural outcome, so it is
            // reported via `_emptyReason` (`filtered_out`) without setting the
            // empty flag. Keeps the empty rate comparable across time.
            const bufferEmpty = logBuffer.size === 0;

            // Check connection health
            let connectionWarning = "";
            let emptyReason: string | undefined;
            if (count === 0 && !bufferEmpty) {
                // Capture is demonstrably working — the level/startFromText filter
                // simply matched nothing. Report that instead of probing the
                // connection and blaming it for a filter miss.
                emptyReason = "filtered_out";
                connectionWarning = "";
            } else if (bufferEmpty) {
                const diagnosis: LogDiagnosis = await diagnoseEmptyLogs(logDiagnosisDeps(device));
                connectionWarning = diagnosis.warning;
                emptyReason = diagnosis.reason;

                // If the pipeline recovered, re-read the buffer — new logs may have arrived
                if (diagnosis.recovered) {
                    const retryResult = getLogs(resolveLogBuffer(device), {
                        maxLogs, level, startFromText, maxMessageLength, verbose
                    });
                    if (retryResult.count > 0) {
                        // Return the recovered logs instead of empty
                        return {
                            _emptyResult: false,
                            _emptyReason: "pipeline_recovered",
                            content: [{
                                type: "text",
                                text: `React Native Console Logs (${retryResult.count} entries):\n\n${retryResult.formatted}${connectionWarning}`
                            }]
                        };
                    }
                }

                // Diagnostic metadata for empty results (local dev dashboard only —
                // responsePreview is never sent to the remote telemetry backend).
                const diagParts = [
                    `empty_reason=${emptyReason}`,
                    `connection=${getPassiveConnectionStatus().reason}`,
                    `device_count=${connectedApps.size}`,
                    `buffer_sizes=${JSON.stringify(Object.fromEntries([...logBuffers.entries()].map(([k, v]) => [k, v.size])))}`,
                ];
                connectionWarning += `\n\n[DIAG] ${diagParts.join(", ")}`;

                connectionWarning += await metroMissingHintIfAbsent("get_logs");
            } else {
                const passive = getPassiveConnectionStatus();
                connectionWarning = !passive.connected
                    ? "\n\n[CONNECTION] Disconnected. Showing cached data. New data is not being captured."
                    : "";
            }
    
            // Check for recent connection gaps
            const warningThresholdMs = 30000; // 30 seconds
            const recentGaps = getRecentGaps(warningThresholdMs);
            let gapWarning = "";
    
            if (recentGaps.length > 0) {
                const latestGap = recentGaps[recentGaps.length - 1];
                const gapDuration = latestGap.durationMs || Date.now() - latestGap.disconnectedAt.getTime();
    
                if (latestGap.reconnectedAt) {
                    const secAgo = Math.round((Date.now() - latestGap.reconnectedAt.getTime()) / 1000);
                    gapWarning = `\n\n[WARNING] Connection was restored ${secAgo}s ago. Some logs may have been missed during the ${formatDuration(gapDuration)} gap.`;
                } else {
                    gapWarning = `\n\n[WARNING] Connection is currently disconnected. Logs may be incomplete.`;
                }
            }
    
            const startNote = startFromText ? ` (starting from "${startFromText}")` : "";
    
            return {
                _emptyResult: bufferEmpty,
                ...(emptyReason && { _emptyReason: emptyReason }),
                content: [
                    {
                        type: "text",
                        text: `React Native Console Logs (${count} entries)${startNote}:\n\n${formatted}${gapWarning}${connectionWarning}`
                    }
                ]
            };
        },
        // Fallback only — every return path above sets `_emptyResult` explicitly,
        // which takes precedence. Retained so a future path that forgets to set it
        // still reports something rather than nothing.
        () => getTotalLogCount() === 0
    );
    
    // Tool: Search logs
    registerToolWithTelemetry(
        server,
        "search_logs",
        {
            description: "Search console logs for text (case-insensitive).\n" +
                "PURPOSE: Find log lines matching a substring across the connected app's console buffer.\n" +
                "WHEN TO USE: User reports a known error/warning, or wants to trace a specific event (e.g., \"redux\", \"auth failed\"). For unfocused exploration, prefer get_logs.\n" +
                "WORKFLOW: scan_metro -> search_logs(text=\"...\") -> if empty, get_logs to verify buffer populated.\n" +
                "LIMITATIONS: Only matches text captured AFTER the app connected; won't find pre-connect logs.\n" +
                "GOOD: search_logs({ text: \"TypeError\" })\n" +
                "BAD: search_logs({ text: \"\" })  (use get_logs for a raw dump)\n" +
                "SEE ALSO: call get_usage_guide(topic=\"logs\") for the full console-debugging playbook.",
            inputSchema: {
                text: z.string().describe("Text to search for in log messages"),
                maxResults: z.coerce
                    .number()
                    .optional()
                    .default(50)
                    .describe("Maximum number of results to return (default: 50)"),
                maxMessageLength: z.coerce
                    .number()
                    .optional()
                    .default(500)
                    .describe("Max characters per message (default: 500, set to 0 for unlimited)"),
                verbose: z.boolean().optional().default(false).describe("Disable all truncation and return full messages"),
                device: z.string().optional().describe("Target device name (substring match). Omit for all devices. Run get_apps to see connected devices.")
            }
        },
        async ({ text, maxResults, maxMessageLength, verbose, device }) => {
            // Check if SDK is installed — prefer SDK data. See get_logs: the
            // device must be threaded through, and an empty SDK result falls
            // through to the CDP buffer instead of short-circuiting.
            const sdkAvailable = await isSDKInstalled(device);
    
            if (sdkAvailable) {
                const sdkResult = await querySDKConsole({ count: maxResults, text }, device);
                if (sdkResult.success && sdkResult.data.length > 0) {
                    const entries = sdkResult.data;
                    const lines = entries.map((e) => {
                        const time = new Date(e.timestamp).toLocaleTimeString();
                        let msg = e.message;
                        if (!verbose && maxMessageLength > 0 && msg.length > maxMessageLength) {
                            msg = msg.slice(0, maxMessageLength) + "...";
                        }
                        return `[${time}] [${e.level.toUpperCase()}] ${msg}`;
                    });
                    return { content: [{ type: "text" as const, text: `Search results for "${text}" (${entries.length} matches, SDK):\n\n${lines.join("\n")}` }] };
                }
            }
    
            const { count, formatted } = searchLogs(resolveLogBuffer(device), text, { maxResults, maxMessageLength, verbose });
    
            // Check connection health
            let connectionWarning = "";
            if (count === 0) {
                const status = await checkAndEnsureConnection(device);
                connectionWarning = status.message ? `\n\n${status.message}` : "";
                connectionWarning += await metroMissingHintIfAbsent("search_logs");
            } else {
                const passive = getPassiveConnectionStatus();
                connectionWarning = !passive.connected
                    ? "\n\n[CONNECTION] Disconnected. Showing cached data. New data is not being captured."
                    : "";
            }
    
            return {
                content: [
                    {
                        type: "text",
                        text: `Search results for "${text}" (${count} matches):\n\n${formatted}${connectionWarning}`
                    }
                ]
            };
        }
    );
    
    // Tool: Clear logs
    registerToolWithTelemetry(
        server,
        "clear_logs",
        {
            description: "Clear the log buffer.\n" +
                "PURPOSE: Empty the in-memory console buffer (and the SDK buffer if installed) so the next get_logs / search_logs only sees fresh entries.\n" +
                "WHEN TO USE: Before reproducing a bug so the resulting logs are isolated; between test iterations to avoid noise from earlier runs.\n" +
                "WORKFLOW: clear_logs -> reproduce the issue (tap / navigate / reload_app) -> get_logs or search_logs.\n" +
                "GOOD: clear_logs() right before tap(text=\"Submit\")\n" +
                "BAD: clear_logs() AFTER the repro — you just deleted the evidence.\n" +
                "SEE ALSO: call get_usage_guide(topic=\"logs\") for the full console-debugging playbook.",
            inputSchema: {
                device: z.string().optional().describe("Target device name (substring match). Omit to clear all devices. Run get_apps to see connected devices.")
            }
        },
        async ({ device }) => {
            if (device) {
                const app = getConnectedAppByDevice(device);
                if (!app) throw new UserInputError(`No connected device matches "${device}"`);
                const deviceName = app.deviceInfo.deviceName || app.deviceInfo.title || "unknown";
                let count = getLogBuffer(deviceName).clear();
                // Clear that device's in-app SDK buffer too, otherwise a targeted
                // clear leaves the SDK entries behind and the next get_logs still
                // returns them.
                if (await isSDKInstalled(device)) {
                    const sdkResult = await clearSDKConsole(device);
                    if (sdkResult.success && sdkResult.count) count += sdkResult.count;
                }
                return { content: [{ type: "text", text: `Cleared ${count} log entries from ${deviceName}.` }] };
            }
            // Clear all
            let total = 0;
            for (const buffer of logBuffers.values()) {
                total += buffer.clear();
            }
    
            // Also clear SDK buffer if available
            const sdkAvailable = await isSDKInstalled();
            if (sdkAvailable) {
                const sdkResult = await clearSDKConsole();
                if (sdkResult.success && sdkResult.count) {
                    total += sdkResult.count;
                }
            }
    
            return { content: [{ type: "text", text: `Cleared ${total} log entries from all devices.` }] };
        }
    );

    // Tool: Get full payload for one log event
    registerToolWithTelemetry(
        server,
        "get_log_details",
        {
            description: "Get the full payload of a single log event — complete stack trace, backtrace, or oversized message.\n" +
                "PURPOSE: Expand one row from get_logs into its full text. A crash row collapses a 60-line backtrace; this returns all of it.\n" +
                "WHEN TO USE: After get_logs shows an event you need to read in full (a crash, an exception, a large payload).\n" +
                "WORKFLOW: get_logs -> copy the id (e.g. \"n7\") -> get_log_details(id=\"n7\").\n" +
                "LIMITATIONS: Ids are valid for the current server session. Reads the buffer — it does not re-query the device.\n" +
                "GOOD: get_log_details({ id: \"n7\" })\n" +
                "BAD: Guessing ids — always take them from get_logs.\n" +
                "SEE ALSO: call get_usage_guide(topic=\"logs\") for the full console-debugging playbook.",
            inputSchema: {
                id: z.string().describe("Event id from get_logs (e.g. \"n7\")"),
                maxLength: z.coerce
                    .number()
                    .optional()
                    .default(4000)
                    .describe("Max characters of payload (default: 4000, 0 for unlimited)"),
                verbose: z.boolean().optional().default(false).describe("Disable truncation entirely")
            }
        },
        async ({ id, maxLength, verbose }) => {
            const event = findLogEvent(id);
            if (!event) {
                throw new UserInputError(
                    `No log event with id "${id}". Ids come from get_logs — "n7" for native events, "j12" for console entries — ` +
                    `and are valid for this server session. Call get_logs again to refresh them.`
                );
            }
            return {
                content: [{ type: "text" as const, text: formatEventDetails(event, { maxLength, verbose }) }]
            };
        }
    );

}
