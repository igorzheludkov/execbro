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
    formatLogsAsTonl,
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
import { UserInputError } from "../core/errors.js";
import {
    isSDKInstalled,
    querySDKConsole,
    clearSDKConsole,
    getSDKConsoleStats,
} from "../core/sdkBridge.js";

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
                format: z
                    .enum(["text", "tonl"])
                    .optional()
                    .default("tonl")
                    .describe("Output format: 'text' or 'tonl' (default, compact token-optimized format, ~30-50% smaller)"),
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
        async ({ maxLogs, level, startFromText, maxMessageLength, verbose, format, summary, device }) => {
            // Check if SDK is installed — prefer SDK data for richer logs
            const sdkAvailable = await isSDKInstalled();
    
            if (sdkAvailable) {
                if (summary) {
                    const sdkStats = await getSDKConsoleStats();
                    if (sdkStats.success) {
                        const s = sdkStats.data;
                        const lines: string[] = [];
                        lines.push(`Total logs: ${s.total}`);
                        if (s.byLevel && Object.keys(s.byLevel).length > 0) {
                            lines.push("\nBy Level:");
                            for (const [lvl, cnt] of Object.entries(s.byLevel)) lines.push(`  ${lvl}: ${cnt}`);
                        }
                        return { content: [{ type: "text" as const, text: `Log Summary (SDK):\n\n${lines.join("\n")}` }] };
                    }
                }
    
                const sdkResult = await querySDKConsole({ count: maxLogs, level, text: startFromText });
                if (sdkResult.success) {
                    const entries = sdkResult.data;
                    if (entries.length === 0) {
                        return { content: [{ type: "text" as const, text: "No console logs captured yet." }] };
                    }
                    if (format === "tonl") {
                        const tonlLines = entries.map((e) => {
                            const time = new Date(e.timestamp).toLocaleTimeString();
                            let msg = e.message;
                            if (!verbose && maxMessageLength > 0 && msg.length > maxMessageLength) {
                                msg = msg.slice(0, maxMessageLength) + "...";
                            }
                            return `${time} [${e.level}] ${msg}`;
                        });
                        return { content: [{ type: "text" as const, text: `Console Logs (${entries.length} entries, SDK):\n\n${tonlLines.join("\n")}` }] };
                    }
                    const lines = entries.map((e) => {
                        const time = new Date(e.timestamp).toLocaleTimeString();
                        let msg = e.message;
                        if (!verbose && maxMessageLength > 0 && msg.length > maxMessageLength) {
                            msg = msg.slice(0, maxMessageLength) + "...";
                        }
                        return `[${time}] [${e.level.toUpperCase()}] ${msg}`;
                    });
                    return { content: [{ type: "text" as const, text: `Console Logs (${entries.length} entries, SDK):\n\n${lines.join("\n")}` }] };
                }
            }
    
            // Return summary if requested
            if (summary) {
                const summaryText = getLogSummary(resolveLogBuffer(device), { lastN: 5, maxMessageLength: 100 });
                let connectionWarning = "";
                if (getTotalLogCount() === 0) {
                    const status = await checkAndEnsureConnection(device);
                    connectionWarning = status.message ? `\n\n${status.message}` : "";
    
                    if (status.connected) {
                        const targetApp = device ? getConnectedAppByDevice(device) : getFirstConnectedApp();
                        if (targetApp) {
                            const pipeline = await verifyLogPipeline(targetApp);
                            if (pipeline.message) {
                                connectionWarning += `\n\n${pipeline.message}`;
                            }
                        }
                    }
    
                    connectionWarning += await metroMissingHintIfAbsent("get_logs");
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: `Log Summary:\n\n${summaryText}${connectionWarning}`
                        }
                    ]
                };
            }
    
            const { logs, count, formatted } = getLogs(resolveLogBuffer(device), {
                maxLogs,
                level,
                startFromText,
                maxMessageLength,
                verbose
            });
    
            // Check connection health
            let connectionWarning = "";
            let emptyReason: string | undefined;
            if (count === 0) {
                const status = await checkAndEnsureConnection(device);
                connectionWarning = status.message ? `\n\n${status.message}` : "";
    
                // Track empty reason for telemetry
                emptyReason = "no_logs";
                if (!status.connected) {
                    emptyReason = "disconnected";
                } else if (status.wasReconnected) {
                    emptyReason = "post_reconnect";
                }
    
                // End-to-end log pipeline verification (with automatic recovery)
                if (status.connected) {
                    const targetApp = device ? getConnectedAppByDevice(device) : getFirstConnectedApp();
                    if (targetApp) {
                        const pipeline = await verifyLogPipeline(targetApp);
                        if (pipeline.message) {
                            connectionWarning += `\n\n${pipeline.message}`;
                        }
                        if (!pipeline.ok) {
                            emptyReason = "pipeline_failed";
                        } else if (pipeline.recovered) {
                            emptyReason = "pipeline_recovered";
                        }
                        // If pipeline recovered, re-read the buffer — new logs may have arrived
                        if (pipeline.recovered && pipeline.ok) {
                            const retryResult = getLogs(resolveLogBuffer(device), {
                                maxLogs, level, startFromText, maxMessageLength, verbose
                            });
                            if (retryResult.count > 0) {
                                // Return the recovered logs instead of empty
                                return {
                                    _emptyReason: "pipeline_recovered",
                                    content: [{
                                        type: "text",
                                        text: `React Native Console Logs (${retryResult.count} entries):\n\n${retryResult.formatted}${connectionWarning}`
                                    }]
                                };
                            }
                        }
                    }
                }
    
                // Add diagnostic metadata for empty results (captured by telemetry via responsePreview)
                if (count === 0) {
                    const diagParts = [
                        `empty_reason=${status?.wasReconnected ? "post_reconnect" : "no_logs"}`,
                        `connection=${getPassiveConnectionStatus().reason}`,
                        `device_count=${connectedApps.size}`,
                        `buffer_sizes=${JSON.stringify(Object.fromEntries([...logBuffers.entries()].map(([k, v]) => [k, v.size])))}`,
                    ];
                    connectionWarning += `\n\n[DIAG] ${diagParts.join(", ")}`;
                }
    
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
    
            // Use TONL format if requested
            if (format === "tonl") {
                const tonlOutput = formatLogsAsTonl(logs, { maxMessageLength: verbose ? 0 : maxMessageLength });
                return {
                    ...(emptyReason && { _emptyReason: emptyReason }),
                    content: [
                        {
                            type: "text",
                            text: `React Native Console Logs (${count} entries)${startNote}:\n\n${tonlOutput}${gapWarning}${connectionWarning}`
                        }
                    ]
                };
            }
    
            return {
                ...(emptyReason && { _emptyReason: emptyReason }),
                content: [
                    {
                        type: "text",
                        text: `React Native Console Logs (${count} entries)${startNote}:\n\n${formatted}${gapWarning}${connectionWarning}`
                    }
                ]
            };
        },
        // Empty result detector: buffer has no entries at all
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
                format: z
                    .enum(["text", "tonl"])
                    .optional()
                    .default("tonl")
                    .describe("Output format: 'text' or 'tonl' (default, compact token-optimized format)"),
                device: z.string().optional().describe("Target device name (substring match). Omit for all devices. Run get_apps to see connected devices.")
            }
        },
        async ({ text, maxResults, maxMessageLength, verbose, format, device }) => {
            // Check if SDK is installed — prefer SDK data
            const sdkAvailable = await isSDKInstalled();
    
            if (sdkAvailable) {
                const sdkResult = await querySDKConsole({ count: maxResults, text });
                if (sdkResult.success) {
                    const entries = sdkResult.data;
                    if (entries.length === 0) {
                        return { content: [{ type: "text" as const, text: `No logs matching "${text}" found.` }] };
                    }
                    if (format === "tonl") {
                        const tonlLines = entries.map((e) => {
                            const time = new Date(e.timestamp).toLocaleTimeString();
                            let msg = e.message;
                            if (!verbose && maxMessageLength > 0 && msg.length > maxMessageLength) {
                                msg = msg.slice(0, maxMessageLength) + "...";
                            }
                            return `${time} [${e.level}] ${msg}`;
                        });
                        return { content: [{ type: "text" as const, text: `Search results for "${text}" (${entries.length} matches, SDK):\n\n${tonlLines.join("\n")}` }] };
                    }
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
    
            const { logs, count, formatted } = searchLogs(resolveLogBuffer(device), text, { maxResults, maxMessageLength, verbose });
    
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
    
            // Use TONL format if requested
            if (format === "tonl") {
                const tonlOutput = formatLogsAsTonl(logs, { maxMessageLength: verbose ? 0 : maxMessageLength });
                return {
                    content: [
                        {
                            type: "text",
                            text: `Search results for "${text}" (${count} matches):\n\n${tonlOutput}${connectionWarning}`
                        }
                    ]
                };
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
                const count = getLogBuffer(deviceName).clear();
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

}
