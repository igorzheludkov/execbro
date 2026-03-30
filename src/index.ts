#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer } from "node:http";
import { z } from "zod";

import { getGuideOverview, getGuideByTopic, getAvailableTopics } from "./core/guides.js";
import { getLicenseStatus, getDashboardUrl } from "./core/license.js";
import { isSDKInstalled, querySDKNetwork, getSDKNetworkEntry, getSDKNetworkStats, clearSDKNetwork, querySDKConsole, getSDKConsoleStats, clearSDKConsole } from "./core/sdkBridge.js";
import { tap, type TapResult } from "./pro/tap.js";
import {
    getActivateLicenseConfig,
    handleActivateLicense,
    getDeleteAccountConfig,
    handleDeleteAccount,
} from "./tools/accountTools.js";

import type { DeviceInfo } from "./core/index.js";
import {
    logBuffers,
    networkBuffers,
    getLogBuffer,
    getNetworkBuffer,
    getAllLogs,
    getTotalLogCount,
    getConnectedAppByDevice,
    LogBuffer,
    NetworkBuffer,
    bundleErrorBuffer,
    connectedApps,
    getActiveSimulatorUdid,
    scanMetroPorts,
    fetchDevices,
    selectMainDevice,
    filterBridgelessDevices,
    connectToDevice,
    getConnectedApps,
    executeInApp,
    listDebugGlobals,
    inspectGlobal,
    reloadApp,
    // React Component Inspection
    getComponentTree,
    getScreenLayout,
    inspectComponent,
    findComponents,
    inspectAtPoint,
    toggleElementInspector,
    isInspectorActive,
    getInspectorSelection,
    getFirstConnectedApp,
    getLogs,
    searchLogs,
    getLogSummary,
    getNetworkRequests,
    searchNetworkRequests,
    getNetworkStats,
    formatRequestDetails,
    // Connection state
    getAllConnectionStates,
    getAllConnectionMetadata,
    getRecentGaps,
    formatDuration,
    ConnectionGap,
    cancelAllReconnectionTimers,
    cancelReconnectionTimer,
    clearAllConnectionState,
    suppressReconnection,
    suppressReconnectionForKey,
    clearReconnectionSuppression,
    // Context health tracking
    getContextHealth,
    // Connection resilience
    ensureConnection,
    checkAndEnsureConnection,
    getPassiveConnectionStatus,
    // Bundle (Metro build errors)
    connectMetroBuildEvents,
    disconnectMetroBuildEvents,
    getBundleErrors,
    getBundleStatusWithErrors,
    checkMetroState,
    // Error screen parsing (OCR fallback)
    parseErrorScreenText,
    formatParsedError,
    // OCR
    recognizeText,
    inferIOSDevicePixelRatio,
    // Android
    listAndroidDevices,
    androidScreenshot,
    androidInstallApp,
    androidLaunchApp,
    androidListPackages,
    // Android UI Input (Phase 2)
    ANDROID_KEY_EVENTS,
    androidTap,
    androidLongPress,
    androidSwipe,
    androidInputText,
    androidKeyEvent,
    androidGetScreenSize,
    androidGetDensity,
    androidGetStatusBarHeight,
    // Android Accessibility (UI Hierarchy)
    androidDescribeAll,
    androidDescribePoint,
    // Android Element Finding (no screenshots)
    androidFindElement,
    androidWaitForElement,
    // iOS
    listIOSSimulators,
    iosScreenshot,
    iosInstallApp,
    iosLaunchApp,
    iosOpenUrl,
    iosTerminateApp,
    iosBootSimulator,
    // iOS IDB-based UI tools
    iosTap,
    iosSwipe,
    iosInputText,
    iosButton,
    iosKeyEvent,
    iosKeySequence,
    iosDescribeAll,
    iosDescribePoint,
    IOS_BUTTON_TYPES,
    // iOS Element Finding (no screenshots)
    iosFindElement,
    iosWaitForElement,
    // Debug HTTP Server
    startDebugHttpServer,
    getDebugServerPort,
    // Telemetry
    initTelemetry,
    trackToolInvocation,
    getTargetPlatform,
    // Format utilities (TONL)
    formatLogsAsTonl,
    formatNetworkAsTonl
} from "./core/index.js";

// Helper: resolve log buffer for a device (or create a merged buffer from all devices)
function resolveLogBuffer(device?: string): LogBuffer {
    if (device) {
        const app = getConnectedAppByDevice(device);
        if (!app) throw new Error(`No connected device matches "${device}"`);
        const deviceName = app.deviceInfo.deviceName || app.deviceInfo.title || "unknown";
        return getLogBuffer(deviceName);
    }
    // Merge all logs into a temporary buffer for read operations
    const merged = new LogBuffer(5000);
    for (const buffer of logBuffers.values()) {
        for (const entry of buffer.getAll()) {
            merged.add(entry);
        }
    }
    return merged;
}

// Helper: resolve network buffer for a device (or create a merged buffer from all devices)
function resolveNetworkBuffer(device?: string): NetworkBuffer {
    if (device) {
        const app = getConnectedAppByDevice(device);
        if (!app) throw new Error(`No connected device matches "${device}"`);
        const deviceName = app.deviceInfo.deviceName || app.deviceInfo.title || "unknown";
        return getNetworkBuffer(deviceName);
    }
    // Merge all network requests into a temporary buffer for read operations
    const merged = new NetworkBuffer(5000);
    for (const buffer of networkBuffers.values()) {
        for (const req of buffer.getAll({})) {
            merged.set(`${Math.random()}`, req);
        }
    }
    return merged;
}

// Create MCP server
const server = new McpServer(
    {
        name: "react-native-ai-devtools",
        version: "1.0.0"
    },
    {
        instructions:
            "React Native debugging MCP server. Call get_usage_guide to learn recommended workflows for all tools. Quick start: scan_metro → get_logs / search_logs (console debugging) → ios_screenshot → tap(text=\"Submit\") or tap(x, y) (interact with UI)."
    }
);

// ============================================================================
// Telemetry Wrapper
// ============================================================================

/**
 * Parse JPEG dimensions from a raw buffer by scanning for the SOF marker.
 * Only needs the first ~2KB of the image to find dimensions.
 */
function getJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

    let offset = 2;
    while (offset < buffer.length - 9) {
        if (buffer[offset] !== 0xff) return null;
        const marker = buffer[offset + 1];

        // SOF markers: C0-CF except C4 (DHT) and CC (DAC)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xcc) {
            const height = buffer.readUInt16BE(offset + 5);
            const width = buffer.readUInt16BE(offset + 7);
            return { width, height };
        }

        // Skip segment (read its length)
        const segLength = buffer.readUInt16BE(offset + 2);
        offset += 2 + segLength;
    }
    return null;
}

/**
 * Estimate how many tokens an image will consume in Claude's vision encoder.
 * Per Anthropic docs, Claude auto-resizes images to fit within:
 *   1) 1568px on any side, AND
 *   2) ~1.15 megapixels total (whichever is hit first)
 * Then tokens ≈ (width * height) / 750 (capped at ~1,600 per image).
 * We only decode the first ~2KB of the base64 string to read JPEG dimensions.
 */
function estimateImageTokens(base64Data: string): number {
    try {
        // Decode only the first ~2KB (2732 base64 chars ≈ 2048 bytes) to find JPEG header
        const headerBase64 = base64Data.slice(0, 2732);
        const buffer = Buffer.from(headerBase64, "base64");
        const dims = getJpegDimensions(buffer);
        if (!dims) return Math.ceil(base64Data.length / 4); // fallback for non-JPEG

        let { width, height } = dims;

        // Step 1: Claude resizes to fit within 1568px on any side
        const MAX_CLAUDE_DIM = 1568;
        if (width > MAX_CLAUDE_DIM || height > MAX_CLAUDE_DIM) {
            const scale = MAX_CLAUDE_DIM / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
        }

        // Step 2: Claude further resizes to fit within ~1.15 megapixels
        const MAX_PIXELS = 1_150_000;
        if (width * height > MAX_PIXELS) {
            const scale = Math.sqrt(MAX_PIXELS / (width * height));
            width = Math.round(width * scale);
            height = Math.round(height * scale);
        }

        return Math.ceil((width * height) / 750);
    } catch {
        return Math.ceil(base64Data.length / 4); // fallback
    }
}

// Registry for dev meta-tool — stores handlers and configs for dynamic dispatch
/* eslint-disable @typescript-eslint/no-explicit-any */
const toolRegistry = new Map<string, { config: any; handler: (args: any) => Promise<any> }>();

function registerToolWithTelemetry(toolName: string, config: any, handler: (args: any) => Promise<any>, emptyResultDetector?: (result: any) => boolean): void {
    toolRegistry.set(toolName, { config, handler });
    server.registerTool(toolName, config, async (args: any) => {
        const startTime = Date.now();
        let success = true;
        let errorMessage: string | undefined;
        let errorContext: string | undefined;
        let inputTokens: number | undefined;
        let outputTokens: number | undefined;
        let emptyResult: boolean | undefined;

        try {
            inputTokens = Math.ceil(JSON.stringify(args).length / 4);
        } catch {
            /* circular refs — leave undefined */
        }

        try {
            const result = await handler(args);
            // Check if result indicates an error
            if (result?.isError) {
                success = false;
                // Prefer concise _errorMessage over full response text (which may be large JSON)
                errorMessage = result._errorMessage || result.content?.[0]?.text || "Unknown error";
                // Extract error context if provided (e.g., the expression that caused a syntax error)
                errorContext = result._errorContext;
            }
            // Check for empty result (only on success, only if detector provided)
            if (success && emptyResultDetector) {
                try {
                    emptyResult = emptyResultDetector(result);
                } catch {
                    // Detector failure should never affect tool execution
                }
            }
            if (Array.isArray(result?.content)) {
                let totalTokens = 0;
                for (const item of result.content) {
                    if (item.type === "text" && typeof item.text === "string") {
                        totalTokens += Math.ceil(item.text.length / 4);
                    } else if (item.type === "image" && typeof item.data === "string") {
                        totalTokens += estimateImageTokens(item.data);
                    }
                }
                if (totalTokens > 0) outputTokens = totalTokens;
            }
            return result;
        } catch (error) {
            success = false;
            errorMessage = error instanceof Error ? error.message : String(error);
            throw error;
        } finally {
            const duration = Date.now() - startTime;
            trackToolInvocation(toolName, success, duration, errorMessage, errorContext, inputTokens, outputTokens, getTargetPlatform(), emptyResult);
        }
    });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// Tool: Usage guide for agents
registerToolWithTelemetry(
    "get_usage_guide",
    {
        description:
            "Get recommended workflows and best practices for using the debugging tools. Call without parameters to see all available topics with short descriptions. Call with a topic parameter to get the full guide for that topic.",
        inputSchema: {
            topic: z
                .string()
                .optional()
                .describe(
                    "Topic to get the full guide for. Available topics: setup, inspect, layout, interact, logs, network, state, bundle. Omit to see the overview of all topics."
                )
        }
    },
    async ({ topic }) => {
        if (!topic) {
            return {
                content: [{ type: "text", text: getGuideOverview() }]
            };
        }

        const guide = getGuideByTopic(topic);
        if (!guide) {
            const available = getAvailableTopics().join(", ");
            return {
                content: [
                    {
                        type: "text",
                        text: `Unknown topic: "${topic}". Available topics: ${available}`
                    }
                ],
                isError: true
            };
        }

        return {
            content: [{ type: "text", text: guide }]
        };
    }
);

// Tool: Scan for Metro servers
registerToolWithTelemetry(
    "scan_metro",
    {
        description:
            "Scan for running Metro bundler servers and automatically connect to any found React Native apps. This is typically the FIRST tool to call when starting a debugging session - it establishes the connection needed for other tools like get_logs, list_debug_globals, execute_in_app, and reload_app.",
        inputSchema: {
            startPort: z.coerce.number().optional().default(8081).describe("Start port for scanning (default: 8081)"),
            endPort: z.coerce.number().optional().default(19002).describe("End port for scanning (default: 19002)")
        }
    },
    async ({ startPort, endPort }) => {
        // Clear reconnection suppression (in case user previously called disconnect_metro)
        clearReconnectionSuppression();
        const openPorts = await scanMetroPorts(startPort, endPort);

        if (openPorts.length === 0) {
            return {
                content: [
                    {
                        type: "text",
                        text: "No Metro servers found. Make sure Metro bundler is running (npm start or expo start)."
                    }
                ]
            };
        }

        // Phase 1: Fetch devices from all ports first
        const portDevices = new Map<number, DeviceInfo[]>();
        for (const port of openPorts) {
            const devices = await fetchDevices(port);
            const bridgeless = filterBridgelessDevices(devices);
            if (bridgeless.length > 0) {
                portDevices.set(port, bridgeless);
            }
        }

        // Phase 2: Assign each device to the best port
        // If a device appears on multiple ports, prefer the port where it has
        // the fewest OTHER unique devices (i.e. its dedicated Metro server)
        const devicePortAssignment = new Map<string, number>(); // deviceName -> best port
        const allDeviceNames = new Map<string, { device: DeviceInfo; ports: number[] }>();

        for (const [port, devices] of portDevices) {
            for (const device of devices) {
                const name = device.deviceName || device.title;
                const entry = allDeviceNames.get(name);
                if (entry) {
                    entry.ports.push(port);
                } else {
                    allDeviceNames.set(name, { device, ports: [port] });
                }
            }
        }

        for (const [name, { ports }] of allDeviceNames) {
            if (ports.length === 1) {
                devicePortAssignment.set(name, ports[0]);
            } else {
                // Prefer the port with fewer OTHER unique devices (the dedicated Metro)
                let bestPort = ports[0];
                let fewestOthers = Infinity;
                for (const port of ports) {
                    const othersOnPort = (portDevices.get(port) || [])
                        .filter(d => (d.deviceName || d.title) !== name).length;
                    if (othersOnPort < fewestOthers) {
                        fewestOthers = othersOnPort;
                        bestPort = port;
                    }
                }
                devicePortAssignment.set(name, bestPort);
            }
        }

        // Phase 3: Connect devices to their assigned ports
        const results: string[] = [];
        for (const port of openPorts) {
            const devices = portDevices.get(port);
            if (!devices) {
                results.push(`Port ${port}: No debuggable devices found`);
                continue;
            }

            results.push(`Port ${port}: Found ${devices.length} device(s)`);

            for (const device of devices) {
                const name = device.deviceName || device.title;
                const assignedPort = devicePortAssignment.get(name);
                if (assignedPort !== port) {
                    results.push(`  - ${name}: Skipped (assigned to port ${assignedPort})`);
                    continue;
                }
                try {
                    const connectionResult = await connectToDevice(device, port);
                    results.push(`  - ${connectionResult}`);
                } catch (error) {
                    results.push(`  - ${name}: Failed - ${error}`);
                }
            }

            // Connect to Metro build events for this port
            try {
                await connectMetroBuildEvents(port);
                results.push(`  - Connected to Metro build events`);
            } catch {
                // Build events connection is optional
            }
        }

        return {
            content: [
                {
                    type: "text",
                    text: `Metro scan results:\n${results.join("\n")}`
                }
            ]
        };
    }
);

// Tool: Get connected apps
registerToolWithTelemetry(
    "get_apps",
    {
        description:
            "List currently connected React Native apps and their connection status. If no apps are connected, run scan_metro first to establish a connection.",
        inputSchema: {}
    },
    async () => {
        const apps = getConnectedApps();

        if (apps.length === 0) {
            return {
                content: [
                    {
                        type: "text",
                        text: "No connected devices. Run scan_metro to discover and connect to Metro servers."
                    }
                ]
            };
        }

        const deviceLines = apps
            .filter(({ isConnected }) => isConnected)
            .map(({ app }, i) => {
                const name = app.deviceInfo.deviceName || app.deviceInfo.title;
                const appId = app.deviceInfo.appId || app.deviceInfo.title.split(" (")[0] || "unknown";
                return `  ${i + 1}. ${name} — ${appId} (${app.platform}, port ${app.port})`;
            });

        const text = [
            `Connected devices:`,
            ...deviceLines,
            ``,
            `Use device="${apps[0].app.deviceInfo.deviceName}" to target a specific device.`,
            ``,
            `Total logs in buffer: ${getTotalLogCount()}`
        ].join("\n");

        return {
            content: [{ type: "text", text }]
        };
    }
);

// Tool: Get connection status (detailed health and gap tracking)
registerToolWithTelemetry(
    "get_connection_status",
    {
        description:
            "Get detailed connection health status including uptime, recent disconnects/reconnects, and connection gaps that may indicate missing data.",
        inputSchema: {}
    },
    async () => {
        const connections = getConnectedApps();
        const states = getAllConnectionStates();
        const metadata = getAllConnectionMetadata();

        const lines: string[] = [];
        lines.push("=== Connection Status ===\n");

        if (connections.length === 0 && states.size === 0) {
            lines.push("No connections established. Run scan_metro to connect.");
            return {
                content: [{ type: "text", text: lines.join("\n") }]
            };
        }

        // Show active connections
        for (const { key, app, isConnected } of connections) {
            const state = states.get(key);
            const contextHealth = getContextHealth(key);

            lines.push(`--- ${app.deviceInfo.title} (Port ${app.port}) ---`);
            lines.push(`  Status: ${isConnected ? "CONNECTED" : "DISCONNECTED"}`);

            if (state) {
                if (state.lastConnectedTime) {
                    const uptime = Date.now() - state.lastConnectedTime.getTime();
                    lines.push(`  Connected since: ${state.lastConnectedTime.toLocaleTimeString()}`);
                    lines.push(`  Uptime: ${formatDuration(uptime)}`);
                }

                if (state.status === "reconnecting") {
                    lines.push(`  Reconnecting: Attempt ${state.reconnectionAttempts}`);
                }

                // Show recent gaps (last 5 minutes)
                if (state.connectionGaps.length > 0) {
                    const recentGaps = state.connectionGaps.filter(
                        (g: ConnectionGap) => Date.now() - g.disconnectedAt.getTime() < 300000
                    );
                    if (recentGaps.length > 0) {
                        lines.push(`  Recent gaps: ${recentGaps.length}`);
                        for (const gap of recentGaps.slice(-3)) {
                            const duration = gap.durationMs ? formatDuration(gap.durationMs) : "ongoing";
                            lines.push(`    - ${gap.disconnectedAt.toLocaleTimeString()} (${duration}): ${gap.reason}`);
                        }
                    }
                }
            }

            // Show context health
            if (contextHealth) {
                lines.push(`  Context Health:`);
                lines.push(`    Context ID: ${contextHealth.contextId ?? "unknown"}`);
                lines.push(`    Status: ${contextHealth.isStale ? "STALE" : "HEALTHY"}`);
                if (contextHealth.lastHealthCheck) {
                    const healthResult = contextHealth.lastHealthCheckSuccess ? "PASS" : "FAIL";
                    lines.push(
                        `    Last Check: ${contextHealth.lastHealthCheck.toLocaleTimeString()} (${healthResult})`
                    );
                }
                if (contextHealth.lastContextCreated) {
                    lines.push(`    Context Created: ${contextHealth.lastContextCreated.toLocaleTimeString()}`);
                }
                if (contextHealth.lastContextDestroyed) {
                    lines.push(`    Context Destroyed: ${contextHealth.lastContextDestroyed.toLocaleTimeString()}`);
                }
            }
            lines.push("");
        }

        // Show disconnected/reconnecting states without active connections
        for (const [key, state] of states.entries()) {
            if (!connections.find((c) => c.key === key)) {
                const meta = metadata.get(key);
                lines.push(`--- ${meta?.deviceInfo.title || key} (Disconnected) ---`);
                lines.push(`  Status: ${state.status.toUpperCase()}`);
                if (state.lastDisconnectTime) {
                    lines.push(`  Disconnected at: ${state.lastDisconnectTime.toLocaleTimeString()}`);
                }
                if (state.reconnectionAttempts > 0) {
                    lines.push(`  Reconnection attempts: ${state.reconnectionAttempts}`);
                }
                lines.push("");
            }
        }

        return {
            content: [{ type: "text", text: lines.join("\n") }]
        };
    }
);

// Tool: License status
registerToolWithTelemetry(
    "get_license_status",
    {
        description:
            "Get your installation ID and license status. Shows your unique Installation ID (needed to activate Pro in the dashboard), current license tier, and cache validity.",
        inputSchema: {},
    },
    async () => {
        const status = getLicenseStatus();
        const lines: string[] = [];

        lines.push(`Installation ID: ${status.installationId}`);
        lines.push(`License: ${status.tier.charAt(0).toUpperCase() + status.tier.slice(1)}`);

        if (status.plan) {
            lines.push(`Plan expires: ${status.plan.expiresAt}`);
        }

        lines.push(`Cache valid until: ${status.cacheExpiresAt}`);

        if (status.tier === "free") {
            const dashboardUrl = getDashboardUrl();
            lines.push("");
            if (dashboardUrl) {
                lines.push(`Link your account: ${dashboardUrl}/link?id=${status.installationId}`);
            }
        }

        return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
        };
    }
);

// Tool: Ensure connection health
registerToolWithTelemetry(
    "ensure_connection",
    {
        description:
            "Verify or establish a healthy connection to a React Native app. Use before running commands if connection may be stale, or after navigation/reload. This tool runs a health check and will auto-reconnect if needed.",
        inputSchema: {
            port: z.coerce.number().optional().describe("Metro port (default: auto-detect)"),
            healthCheck: z
                .boolean()
                .optional()
                .default(true)
                .describe("Run health check to verify page context is responsive (default: true)"),
            forceRefresh: z
                .boolean()
                .optional()
                .default(false)
                .describe("Force close existing connection and reconnect (default: false)")
        }
    },
    async ({ port, healthCheck, forceRefresh }) => {
        const result = await ensureConnection({ port, healthCheck, forceRefresh });

        if (!result.connected) {
            return {
                content: [
                    {
                        type: "text",
                        text: result.error || "Connection failed: No error details available. Try running scan_metro to check if Metro is running, then ensure_connection with forceRefresh=true."
                    }
                ],
                isError: true
            };
        }

        const lines: string[] = [];
        lines.push("=== Connection Ensured ===\n");

        if (result.connectionInfo) {
            lines.push(`Device: ${result.connectionInfo.deviceTitle}`);
            lines.push(`Port: ${result.connectionInfo.port}`);
            lines.push(`Uptime: ${result.connectionInfo.uptime}`);
            if (result.connectionInfo.contextId !== null) {
                lines.push(`Context ID: ${result.connectionInfo.contextId}`);
            }
        }

        lines.push("");
        lines.push(`Reconnected: ${result.wasReconnected ? "Yes" : "No"}`);
        lines.push(`Health Check: ${result.healthCheckPassed ? "PASSED" : "FAILED"}`);

        if (!result.healthCheckPassed) {
            lines.push("");
            lines.push("Warning: Health check failed. The page context may be stale.");
            lines.push("Consider using forceRefresh=true or reload_app to get a fresh context.");
        }

        return {
            content: [{ type: "text", text: lines.join("\n") }]
        };
    }
);

// Tool: Get console logs
registerToolWithTelemetry(
    "get_logs",
    {
        description:
            "Retrieve console logs from connected React Native app. Tip: Use summary=true first for a quick overview (counts by level + last 5 messages), then fetch specific logs as needed.",
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
                const status = await checkAndEnsureConnection();
                connectionWarning = status.message ? `\n\n${status.message}` : "";
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
        if (count === 0) {
            const status = await checkAndEnsureConnection();
            connectionWarning = status.message ? `\n\n${status.message}` : "";
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
                content: [
                    {
                        type: "text",
                        text: `React Native Console Logs (${count} entries)${startNote}:\n\n${tonlOutput}${gapWarning}${connectionWarning}`
                    }
                ]
            };
        }

        return {
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
    "search_logs",
    {
        description: "Search console logs for text (case-insensitive)",
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
            const status = await checkAndEnsureConnection();
            connectionWarning = status.message ? `\n\n${status.message}` : "";
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
    "clear_logs",
    {
        description: "Clear the log buffer",
        inputSchema: {
            device: z.string().optional().describe("Target device name (substring match). Omit to clear all devices. Run get_apps to see connected devices.")
        }
    },
    async ({ device }) => {
        if (device) {
            const app = getConnectedAppByDevice(device);
            if (!app) throw new Error(`No connected device matches "${device}"`);
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

// Tool: Connect to specific Metro port
registerToolWithTelemetry(
    "connect_metro",
    {
        description:
            "Connect to a Metro server on a specific port. Use this when you know the exact port, otherwise use scan_metro which auto-detects. Establishes the WebSocket connection needed for debugging tools.",
        inputSchema: {
            port: z.coerce.number().default(8081).describe("Metro server port (default: 8081)")
        }
    },
    async ({ port }) => {
        try {
            const devices = await fetchDevices(port);
            if (devices.length === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `No devices found on port ${port}. Make sure the app is running.`
                        }
                    ]
                };
            }

            const results: string[] = [`Found ${devices.length} device(s) on port ${port}:`];

            for (const device of devices) {
                try {
                    const result = await connectToDevice(device, port);
                    results.push(`  - ${result}`);
                } catch (error) {
                    results.push(`  - ${device.title}: Failed - ${error}`);
                }
            }

            // Also connect to Metro build events
            try {
                await connectMetroBuildEvents(port);
                results.push(`  - Connected to Metro build events`);
            } catch {
                // Build events connection is optional
            }

            return {
                content: [
                    {
                        type: "text",
                        text: results.join("\n")
                    }
                ]
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Failed to connect: ${error}`
                    }
                ]
            };
        }
    }
);

// Tool: Disconnect from Metro
registerToolWithTelemetry(
    "disconnect_metro",
    {
        description:
            "Disconnect from Metro servers and stop auto-reconnection. Without device param: disconnects ALL devices. With device param: disconnects only the matching device. Use this to remove stale connections or free the CDP slot for the built-in debugger. Log and network buffers are preserved. Reconnect later with scan_metro.",
        inputSchema: {
            device: z.string().optional().describe("Target device name (substring match) to disconnect. Omit to disconnect all devices. Run get_apps to see connected devices.")
        }
    },
    async ({ device }) => {
        const connections = getConnectedApps();

        if (connections.length === 0) {
            return {
                content: [
                    {
                        type: "text",
                        text: "No active Metro connections to disconnect."
                    }
                ]
            };
        }

        // Targeted disconnect: only disconnect a specific device
        if (device) {
            const app = getConnectedAppByDevice(device);
            if (!app) {
                return {
                    content: [{ type: "text", text: `No connected device matches "${device}". Run get_apps to see connected devices.` }],
                    isError: true
                };
            }

            // Find and close the matching connection
            for (const [key, connectedApp] of connectedApps.entries()) {
                if (connectedApp.ws === app.ws) {
                    // Suppress reconnection for this specific device
                    suppressReconnectionForKey(key);
                    cancelReconnectionTimer(key);
                    try {
                        connectedApp.ws.close();
                    } catch {
                        // Ignore close errors
                    }
                    connectedApps.delete(key);

                    const name = connectedApp.deviceInfo.deviceName || connectedApp.deviceInfo.title;
                    return {
                        content: [{ type: "text", text: `Disconnected from ${name} (port ${connectedApp.port}). Buffers preserved. Use scan_metro to reconnect.` }]
                    };
                }
            }
        }

        // Disconnect all
        const disconnected: string[] = [];

        // Suppress reconnection BEFORE closing sockets
        // (close handlers fire async and would re-schedule reconnection)
        suppressReconnection();
        cancelAllReconnectionTimers();

        // Close all CDP WebSocket connections
        for (const [key, app] of connectedApps.entries()) {
            try {
                app.ws.close();
            } catch {
                // Ignore close errors
            }
            disconnected.push(`${app.deviceInfo.title} (port ${app.port})`);
            connectedApps.delete(key);
        }

        // Disconnect Metro build events WebSocket
        disconnectMetroBuildEvents();

        // Clear connection state (but NOT log/network buffers)
        clearAllConnectionState();

        const lines = [
            `Disconnected from ${disconnected.length} app(s):`,
            ...disconnected.map((d) => `  - ${d}`),
            "",
            "Metro CDP connection is now free for the built-in React Native debugger.",
            "Log and network buffers are preserved.",
            'Use "scan_metro" to reconnect when ready.'
        ];

        return {
            content: [{ type: "text", text: lines.join("\n") }]
        };
    }
);

// Tool: Execute JavaScript in app
registerToolWithTelemetry(
    "execute_in_app",
    {
        description:
            "Execute JavaScript code in the connected React Native app and return the result. Use this for inspecting app state, calling methods on exposed global objects, or running diagnostic code. Hermes compatible: 'global' is automatically polyfilled to 'globalThis', so both global.__REDUX_STORE__ and globalThis.__REDUX_STORE__ work.\n\n" +
            "RECOMMENDED WORKFLOW: 1) list_debug_globals to discover available objects, 2) inspect_global to see properties/methods, 3) execute_in_app to call specific methods or read values.\n\n" +
            "LIMITATIONS (Hermes engine):\n" +
            "- NO require() or import — only pre-existing globals are available\n" +
            "- NO async/await syntax — use simple expressions or promise chains (.then())\n" +
            "- NO emoji or non-ASCII characters in string literals — causes parse errors\n" +
            "- Keep expressions simple and synchronous when possible\n\n" +
            "GOOD examples: `__DEV__`, `__APOLLO_CLIENT__.cache.extract()`, `__EXPO_ROUTER__.navigate('/settings')`\n" +
            "BAD examples: `async () => { await fetch(...) }`, `require('react-native')`, `console.log('\\u{1F600}')`",
        inputSchema: {
            expression: z
                .string()
                .describe(
                    "JavaScript expression to execute. Must be valid Hermes syntax — no require(), no async/await, no emoji/non-ASCII in strings. Use globals discovered via list_debug_globals."
                ),
            awaitPromise: z.coerce
                .boolean()
                .optional()
                .default(true)
                .describe("Whether to await promises (default: true)"),
            maxResultLength: z.coerce
                .number()
                .optional()
                .default(2000)
                .describe(
                    "Max characters in result (default: 2000, set to 0 for unlimited). Tip: For large objects like Redux stores, use inspect_global instead or set higher limit."
                ),
            verbose: z
                .boolean()
                .optional()
                .default(false)
                .describe("Disable result truncation. Tip: Be cautious - Redux stores or large state can return 10KB+."),
            device: z.string().optional().describe("Target device name (substring match). Omit for default device. Run get_apps to see connected devices.")
        }
    },
    async ({ expression, awaitPromise, maxResultLength, verbose, device }) => {
        const result = await executeInApp(expression, awaitPromise, {}, device);

        if (!result.success) {
            let errorText = `Error: ${result.error}`;

            // If the error is a ReferenceError (accessing a global that doesn't exist),
            // guide the agent to expose the variable as a global first
            if (result.error?.includes("ReferenceError")) {
                errorText +=
                    "\n\nNOTE: This variable is not exposed as a global. To access it, first assign it to a global variable in your app code (e.g., `globalThis.__MY_VAR__ = myVar;`), then use execute_in_app to read `__MY_VAR__`. You can also use list_debug_globals to see what globals ARE currently available.";
            }

            return {
                content: [
                    {
                        type: "text",
                        text: errorText
                    }
                ],
                isError: true,
                // Include expression as context for telemetry (helps debug syntax errors)
                _errorContext: expression
            };
        }

        let resultText = result.result ?? "undefined";

        // Apply truncation unless verbose or unlimited
        if (!verbose && maxResultLength > 0 && resultText.length > maxResultLength) {
            resultText =
                resultText.slice(0, maxResultLength) + `... [truncated: ${result.result?.length ?? 0} chars total]`;
        }

        return {
            content: [
                {
                    type: "text",
                    text: resultText
                }
            ]
        };
    },
    // Empty result detector: successful execution but no meaningful output
    (result) => {
        if (result?.isError) return false;
        const text = result?.content?.[0]?.text;
        return text === undefined || text === "" || text === "undefined" || text === "null";
    }
);

// Tool: List debug globals available in the app
registerToolWithTelemetry(
    "list_debug_globals",
    {
        description:
            "List globally available debugging objects in the connected React Native app (Apollo Client, Redux store, React DevTools, etc.). Use this to discover what state management and debugging tools are available.",
        inputSchema: {
            device: z.string().optional().describe("Target device name (substring match). Omit for default device. Run get_apps to see connected devices.")
        }
    },
    async ({ device }) => {
        const result = await listDebugGlobals(device);

        if (!result.success) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error: ${result.error}`
                    }
                ],
                isError: true
            };
        }

        return {
            content: [
                {
                    type: "text",
                    text: `Available debug globals in the app:\n\n${result.result}`
                }
            ]
        };
    }
);

// Tool: Inspect a global object to see its properties and types
registerToolWithTelemetry(
    "inspect_global",
    {
        description:
            "Inspect a global object to see its properties, types, and whether they are callable functions. Use this BEFORE calling methods on unfamiliar objects to avoid errors.",
        inputSchema: {
            objectName: z
                .string()
                .describe("Name of the global object to inspect (e.g., '__EXPO_ROUTER__', '__APOLLO_CLIENT__')"),
            device: z.string().optional().describe("Target device name (substring match). Omit for default device. Run get_apps to see connected devices.")
        }
    },
    async ({ objectName, device }) => {
        const result = await inspectGlobal(objectName, device);

        if (!result.success) {
            let errorText = `Error: ${result.error}`;

            // If the error is a ReferenceError (accessing a global that doesn't exist),
            // guide the agent to expose the variable as a global first
            if (result.error?.includes("ReferenceError")) {
                errorText += `\n\nNOTE: '${objectName}' is not exposed as a global variable. To inspect it, first assign it to a global in your app code (e.g., \`globalThis.${objectName} = ${objectName.replace(/^__/, "").replace(/__$/, "")};\`), then call inspect_global again. Use list_debug_globals to see what globals ARE currently available.`;
            }

            return {
                content: [
                    {
                        type: "text",
                        text: errorText
                    }
                ],
                isError: true
            };
        }

        return {
            content: [
                {
                    type: "text",
                    text: `Properties of ${objectName}:\n\n${result.result}`
                }
            ]
        };
    }
);

// ============================================================================
// React Component Inspection Tools
// ============================================================================

// Tool: Get the React component tree
registerToolWithTelemetry(
    "get_component_tree",
    {
        description:
            "Get the React component tree from the running app. **RECOMMENDED**: Use focusedOnly=true with structureOnly=true for a token-efficient overview of just the active screen (~1-2KB). This skips navigation wrappers and global overlays, showing only what's actually visible.",
        inputSchema: {
            focusedOnly: z
                .boolean()
                .optional()
                .default(false)
                .describe(
                    "Return only the focused/active screen subtree, skipping navigation wrappers and overlays. Dramatically reduces output size. (Recommended: true)"
                ),
            structureOnly: z
                .boolean()
                .optional()
                .default(false)
                .describe(
                    "Return ultra-compact structure with just component names (no props, styles, or paths). Use this first for overview, then drill down with inspect_component."
                ),
            maxDepth: z
                .number()
                .optional()
                .describe(
                    "Maximum tree depth (default: 25 for focusedOnly+structureOnly, 40 for structureOnly, 100 for full mode)"
                ),
            includeProps: z
                .boolean()
                .optional()
                .default(false)
                .describe("Include component props (excluding children and style). Ignored if structureOnly=true."),
            includeStyles: z
                .boolean()
                .optional()
                .default(false)
                .describe("Include layout styles (padding, margin, flex, etc.). Ignored if structureOnly=true."),
            hideInternals: z
                .boolean()
                .optional()
                .default(true)
                .describe(
                    "Hide internal RN components (RCTView, RNS*, Animated, etc.) for cleaner output (default: true)"
                ),
            format: z
                .enum(["json", "tonl"])
                .optional()
                .default("tonl")
                .describe(
                    "Output format: 'json' or 'tonl' (default, compact indented tree). Ignored if structureOnly=true."
                ),
            device: z.string().optional().describe("Target device name (substring match). Omit for default device. Run get_apps to see connected devices.")
        }
    },
    async ({ focusedOnly, structureOnly, maxDepth, includeProps, includeStyles, hideInternals, format, device }) => {
        const result = await getComponentTree({
            focusedOnly,
            structureOnly,
            maxDepth,
            includeProps,
            includeStyles,
            hideInternals,
            format,
            device
        });

        if (!result.success) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error: ${result.error}`
                    }
                ],
                isError: true
            };
        }

        return {
            content: [
                {
                    type: "text",
                    text: `React Component Tree:\n\n${result.result}`
                }
            ]
        };
    }
);

// Tool: Get full screen layout (all components with layout styles)
registerToolWithTelemetry(
    "get_screen_layout",
    {
        description:
            "Get layout information for all components on screen. **USE AFTER get_component_tree**: First use get_component_tree(structureOnly=true) to understand structure, then use this tool OR find_components with includeLayout=true to get layout details for specific areas. This tool returns full layout data which can be large for complex screens.",
        inputSchema: {
            maxDepth: z
                .number()
                .optional()
                .default(65)
                .describe("Maximum tree depth to traverse (default: 65, balanced for most screens)"),
            componentsOnly: z
                .boolean()
                .optional()
                .default(false)
                .describe("Only show custom components, hide host components (View, Text, etc.)"),
            shortPath: z
                .boolean()
                .optional()
                .default(true)
                .describe("Show only last 3 path segments instead of full path (default: true)"),
            summary: z
                .boolean()
                .optional()
                .default(false)
                .describe("Return only component counts by name instead of full element list (default: false)"),
            format: z
                .enum(["json", "tonl"])
                .optional()
                .default("tonl")
                .describe("Output format: 'json' or 'tonl' (default, pipe-delimited rows, ~40% smaller)"),
            device: z.string().optional().describe("Target device name (substring match). Omit for default device. Run get_apps to see connected devices.")
        }
    },
    async ({ maxDepth, componentsOnly, shortPath, summary, format, device }) => {
        const result = await getScreenLayout({ maxDepth, componentsOnly, shortPath, summary, format, device });

        if (!result.success) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error: ${result.error}`
                    }
                ],
                isError: true
            };
        }

        return {
            content: [
                {
                    type: "text",
                    text: `Screen Layout:\n\n${result.result}`
                }
            ]
        };
    }
);

// Tool: Inspect a specific component by name
registerToolWithTelemetry(
    "inspect_component",
    {
        description:
            "Inspect a specific React component by name. **DRILL-DOWN TOOL**: Use after get_component_tree(structureOnly=true) to inspect specific components. Returns props, style, state (hooks), and optionally children tree. Use childrenDepth to control how deep nested children go.",
        inputSchema: {
            componentName: z
                .string()
                .describe("Name of the component to inspect (e.g., 'Button', 'HomeScreen', 'FlatList')"),
            index: z
                .number()
                .optional()
                .default(0)
                .describe("If multiple instances exist, which one to inspect (0-based index, default: 0)"),
            includeState: z
                .boolean()
                .optional()
                .default(true)
                .describe("Include component state/hooks (default: true)"),
            includeChildren: z.boolean().optional().default(false).describe("Include children component tree"),
            childrenDepth: z
                .number()
                .optional()
                .default(1)
                .describe(
                    "How many levels deep to show children (default: 1 = direct children only, 2+ = nested tree)"
                ),
            shortPath: z.boolean().optional().default(true).describe("Show only last 3 path segments (default: true)"),
            simplifyHooks: z
                .boolean()
                .optional()
                .default(true)
                .describe("Simplify hooks output by hiding effects and reducing depth (default: true)"),
            device: z.string().optional().describe("Target device name (substring match). Omit for default device. Run get_apps to see connected devices.")
        }
    },
    async ({ componentName, index, includeState, includeChildren, childrenDepth, shortPath, simplifyHooks, device }) => {
        const result = await inspectComponent(componentName, {
            index,
            includeState,
            includeChildren,
            childrenDepth,
            shortPath,
            simplifyHooks,
            device
        });

        if (!result.success) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error: ${result.error}`
                    }
                ],
                isError: true
            };
        }

        return {
            content: [
                {
                    type: "text",
                    text: `Component Inspection: ${componentName}\n\n${result.result}`
                }
            ]
        };
    }
);

// Tool: Find components matching a pattern
registerToolWithTelemetry(
    "find_components",
    {
        description:
            "Find components matching a name pattern. **TARGETED SEARCH**: Use after get_component_tree(structureOnly=true) to find specific components by pattern and get their layout info. More efficient than get_screen_layout for targeted queries. Use includeLayout=true to get padding/margin/flex styles.",
        inputSchema: {
            pattern: z
                .string()
                .describe(
                    "Regex pattern to match component names (case-insensitive). Examples: 'Button', 'Screen$', 'List.*Item'"
                ),
            maxResults: z.number().optional().default(20).describe("Maximum number of results to return (default: 20)"),
            includeLayout: z
                .boolean()
                .optional()
                .default(false)
                .describe("Include layout styles (padding, margin, flex) for each matched component"),
            shortPath: z.boolean().optional().default(true).describe("Show only last 3 path segments (default: true)"),
            summary: z
                .boolean()
                .optional()
                .default(false)
                .describe("Return only component counts by name instead of full list (default: false)"),
            format: z
                .enum(["json", "tonl"])
                .optional()
                .default("tonl")
                .describe("Output format: 'json' or 'tonl' (default, pipe-delimited rows, ~40% smaller)"),
            device: z.string().optional().describe("Target device name (substring match). Omit for default device. Run get_apps to see connected devices.")
        }
    },
    async ({ pattern, maxResults, includeLayout, shortPath, summary, format, device }) => {
        const result = await findComponents(pattern, { maxResults, includeLayout, shortPath, summary, format, device });

        if (!result.success) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error: ${result.error}`
                    }
                ],
                isError: true
            };
        }

        return {
            content: [
                {
                    type: "text",
                    text: `Find Components (pattern: "${pattern}"):\n\n${result.result}`
                }
            ]
        };
    }
);

// Tool: Unified tap — tries fiber, accessibility, OCR, coordinate strategies
registerToolWithTelemetry(
    "tap",
    {
        description:
            "Tap a UI element. Automatically tries multiple strategies: fiber tree (React), accessibility tree (native), and OCR (visual). " +
            "Auto-detects platform (iOS/Android). For coordinates, pass raw pixel values from screenshot — tap handles all coordinate conversion internally (iOS pixel-to-point, scale factor adjustments).\n\n" +
            "IMPORTANT: When both iOS and Android devices are connected, specify platform explicitly to avoid tapping on the wrong device.\n\n" +
            "Examples:\n" +
            "- tap(text=\"Submit\") — finds and taps element with matching text\n" +
            "- tap(testID=\"login-btn\") — finds by testID\n" +
            "- tap(component=\"HamburgerIcon\") — finds by React component name\n" +
            "- tap(x=300, y=600) — taps at pixel coordinates from screenshot (conversion handled internally)\n" +
            "- tap(text=\"Menu\", strategy=\"ocr\") — forces OCR strategy only\n" +
            "- tap(x=300, y=600, native=true, platform=\"android\") — taps directly via ADB/simctl without React Native connection",
        inputSchema: {
            text: z
                .string()
                .optional()
                .describe(
                    "Visible text to match (case-insensitive substring). ASCII only for fiber strategy; OCR handles non-ASCII."
                ),
            testID: z
                .string()
                .optional()
                .describe("Exact match on the element's testID prop."),
            component: z
                .string()
                .optional()
                .describe(
                    "Component name match (case-insensitive substring, e.g. 'Button', 'MenuItem')."
                ),
            index: z.coerce
                .number()
                .optional()
                .describe(
                    "Zero-based index when multiple elements match (default: 0)."
                ),
            x: z.coerce
                .number()
                .optional()
                .describe(
                    "X coordinate in pixels (from screenshot). Must provide both x and y."
                ),
            y: z.coerce
                .number()
                .optional()
                .describe(
                    "Y coordinate in pixels (from screenshot). Must provide both x and y."
                ),
            strategy: z
                .enum(["auto", "fiber", "accessibility", "ocr", "coordinate"])
                .optional()
                .default("auto")
                .describe(
                    '"auto" (default) tries fiber -> accessibility -> OCR. Set explicitly to skip strategies you know will fail.'
                ),
            maxTraversalDepth: z.coerce
                .number()
                .optional()
                .describe(
                    "Max parent levels to traverse when searching by component name (default: 15). " +
                    "Increase if your component is deeply wrapped (e.g. inside multiple HOCs/animation wrappers)."
                ),
            native: z
                .boolean()
                .optional()
                .default(false)
                .describe(
                    "When true, tap coordinates directly via ADB/simctl without requiring a React Native connection. " +
                    "Useful for interacting with native UI, system dialogs, or non-RN apps. Requires x/y coordinates."
                ),
            platform: z
                .enum(["ios", "android"])
                .optional()
                .describe(
                    "Target platform. Required when both iOS and Android devices are connected. Auto-detected if only one platform is available."
                ),
        },
    },
    async (args: any) => {
        const result: TapResult = await tap({
            text: args.text,
            testID: args.testID,
            component: args.component,
            index: args.index,
            x: args.x,
            y: args.y,
            strategy: args.strategy,
            maxTraversalDepth: args.maxTraversalDepth,
            native: args.native,
            platform: args.platform,
        });

        const text = JSON.stringify(result, null, 2);
        // Pack strategy mode + attempted strategies into errorContext for telemetry
        // e.g. "s=ocr|fiber:no_pressable|ocr:no_match" or "s=auto|fiber:no_pressable|accessibility:not_found|ocr:no_match"
        const stratPrefix = args.strategy && args.strategy !== "auto" ? `s=${args.strategy}|` : "";
        const errorContext = result.attempted?.length
            ? stratPrefix + result.attempted.map(a => `${a.strategy}:${a.reason.slice(0, 40)}`).join("|")
            : undefined;
        return {
            content: [{ type: "text", text }],
            isError: !result.success,
            _errorMessage: result.error,
            _errorContext: errorContext,
        };
    }
);

// Tool: Toggle Element Inspector programmatically
registerToolWithTelemetry(
    "toggle_element_inspector",
    {
        description:
            "Toggle React Native's Element Inspector overlay on/off. Rarely needed directly — get_inspector_selection auto-enables the inspector when called with coordinates. Use this only when you need manual control over the overlay visibility.",
        inputSchema: {
            device: z.string().optional().describe("Target device name (substring match). Omit for default device. Run get_apps to see connected devices.")
        }
    },
    async ({ device }) => {
        const result = await toggleElementInspector(device);

        if (!result.success) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error: ${result.error}`
                    }
                ],
                isError: true
            };
        }

        try {
            const parsed = JSON.parse(result.result || "{}");
            if (parsed.error) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Failed to toggle Element Inspector: ${parsed.error}`
                        }
                    ],
                    isError: true
                };
            }
            return {
                content: [
                    {
                        type: "text",
                        text: parsed.message || "Element Inspector toggled successfully"
                    }
                ]
            };
        } catch {
            return {
                content: [
                    {
                        type: "text",
                        text: result.result || "Element Inspector toggled"
                    }
                ]
            };
        }
    }
);

// Tool: Get currently selected element from Element Inspector
registerToolWithTelemetry(
    "get_inspector_selection",
    {
        description:
            "Identify the React component at a screen location by reading RN's Element Inspector. Returns a clean component hierarchy with file paths — ideal for finding the real component name (e.g. HomeScreen > SneakerCard > PulseActionButton). If x/y provided: auto-enables inspector, taps at coordinates, returns hierarchy. If no coordinates: returns current selection. WORKFLOW: Use ios_screenshot or ocr_screenshot to visually identify the target element, then call this tool with coordinates to get the component tree.",
        inputSchema: {
            x: z
                .number()
                .optional()
                .describe("X coordinate (in points). If provided with y, auto-taps at this location."),
            y: z
                .number()
                .optional()
                .describe("Y coordinate (in points). If provided with x, auto-taps at this location."),
            device: z.string().optional().describe("Target device name (substring match). Omit for default device. Run get_apps to see connected devices.")
        }
    },
    async ({ x, y, device }) => {
        // If coordinates provided, do the full flow: enable inspector -> tap -> read
        if (x !== undefined && y !== undefined) {
            // Check if inspector is active
            const inspectorActive = await isInspectorActive(device);

            // Enable inspector if not active
            if (!inspectorActive) {
                await toggleElementInspector(device);
                // Wait for inspector to initialize
                await new Promise((resolve) => setTimeout(resolve, 300));
            }

            // Detect platform from connected app
            const app = device ? getConnectedAppByDevice(device) : getFirstConnectedApp();
            if (!app) {
                return {
                    content: [{ type: "text", text: "No app connected. Run scan_metro first." }],
                    isError: true
                };
            }

            const isIOS =
                app.deviceInfo.title?.toLowerCase().includes("iphone") ||
                app.deviceInfo.title?.toLowerCase().includes("ipad") ||
                app.deviceInfo.deviceName?.toLowerCase().includes("simulator") ||
                app.deviceInfo.description?.toLowerCase().includes("ios");

            // Tap at coordinates
            try {
                if (isIOS) {
                    await iosTap(x, y, {});
                } else {
                    await androidTap(x, y);
                }
            } catch (tapError) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Failed to tap at (${x}, ${y}): ${tapError instanceof Error ? tapError.message : String(tapError)}`
                        }
                    ],
                    isError: true
                };
            }

            // Wait for selection to update
            await new Promise((resolve) => setTimeout(resolve, 200));
        }

        // Read the current selection
        const result = await getInspectorSelection(device);

        if (!result.success) {
            return {
                content: [{ type: "text", text: `Error: ${result.error}` }],
                isError: true
            };
        }

        try {
            const parsed = JSON.parse(result.result || "{}");
            if (parsed.error) {
                const hint = parsed.hint ? `\n\n${parsed.hint}` : "";
                return {
                    content: [{ type: "text", text: `${parsed.error}${hint}` }],
                    isError: true
                };
            }

            // Format the output nicely
            let output = `Element: ${parsed.element}\n`;
            output += `Path: ${parsed.path}\n`;
            if (parsed.frame) {
                output += `Frame: (${parsed.frame.left?.toFixed(1)}, ${parsed.frame.top?.toFixed(1)}) ${parsed.frame.width}x${parsed.frame.height}\n`;
            }
            if (parsed.style) {
                output += `Style: ${JSON.stringify(parsed.style, null, 2)}\n`;
            }

            return {
                content: [{ type: "text", text: output }]
            };
        } catch {
            return {
                content: [{ type: "text", text: result.result || "No selection data" }]
            };
        }
    }
);

// Tool: Inspect component at coordinates (like Element Inspector)
registerToolWithTelemetry(
    "inspect_at_point",
    {
        description:
            "Inspect the React component at specific (x, y) coordinates for layout debugging. Returns component props, measured frame (position/size in dp), and component path. Works on both Paper and Fabric. Coordinates are in dp (density-independent pixels). To convert from screenshot pixels: divide by the device pixel ratio (e.g. 540px / 2.625 = 205dp). Best for: checking layout bounds, reading component props/styles, pixel-perfect debugging. For identifying component names: prefer get_inspector_selection which returns a cleaner hierarchy with file paths.",
        inputSchema: {
            x: z
                .number()
                .describe(
                    "X coordinate in dp (logical pixels). Convert from screenshot pixels by dividing by the device pixel ratio."
                ),
            y: z
                .number()
                .describe(
                    "Y coordinate in dp (logical pixels). Convert from screenshot pixels by dividing by the device pixel ratio."
                ),
            includeProps: z
                .boolean()
                .optional()
                .default(true)
                .describe("Include component props in the output (default: true)"),
            includeFrame: z
                .boolean()
                .optional()
                .default(true)
                .describe("Include position/dimensions (frame) in the output (default: true)"),
            device: z.string().optional().describe("Target device name (substring match). Omit for default device. Run get_apps to see connected devices.")
        }
    },
    async ({ x, y, includeProps, includeFrame, device }) => {
        const result = await inspectAtPoint(x, y, { includeProps, includeFrame, device });

        if (!result.success) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error: ${result.error}`
                    }
                ],
                isError: true
            };
        }

        // Parse the result to check for errors in the response
        try {
            const parsed = JSON.parse(result.result || "{}");
            if (parsed.error) {
                const hint = parsed.hint ? `\n\n${parsed.hint}` : "";
                const alternatives = parsed.alternatives
                    ? `\n\nAlternatives:\n${parsed.alternatives.map((a: string) => `  - ${a}`).join("\n")}`
                    : "";
                return {
                    content: [
                        {
                            type: "text",
                            text: `Inspect at (${x}, ${y}): ${parsed.error}${hint}${alternatives}`
                        }
                    ],
                    isError: true
                };
            }
        } catch {
            // If parsing fails, just return the raw result
        }

        return {
            content: [
                {
                    type: "text",
                    text: `Element at (${x}, ${y}):\n\n${result.result}`
                }
            ]
        };
    }
);

// Tool: Get network requests
registerToolWithTelemetry(
    "get_network_requests",
    {
        description:
            "Retrieve captured network requests from connected React Native app. Shows URL, method, status, and timing. Note: On Bridgeless targets (Expo SDK 52+) without the SDK, capture may miss early startup requests. Install react-native-ai-devtools-sdk for full capture with headers and response bodies. Tip: Use summary=true first for stats overview.",
        inputSchema: {
            maxRequests: z
                .number()
                .optional()
                .default(50)
                .describe("Maximum number of requests to return (default: 50)"),
            method: z.string().optional().describe("Filter by HTTP method (GET, POST, PUT, DELETE, etc.)"),
            urlPattern: z.string().optional().describe("Filter by URL pattern (case-insensitive substring match)"),
            status: z.number().optional().describe("Filter by HTTP status code (e.g., 200, 401, 500)"),
            format: z
                .enum(["text", "tonl"])
                .optional()
                .default("tonl")
                .describe("Output format: 'text' or 'tonl' (default, compact token-optimized format, ~30-50% smaller)"),
            summary: z
                .boolean()
                .optional()
                .default(false)
                .describe("Return statistics only (count, methods, domains, status codes). Use for quick overview."),
            device: z.string().optional().describe("Target device name (substring match). Omit for all devices. Run get_apps to see connected devices.")
        }
    },
    async ({ maxRequests, method, urlPattern, status, format, summary, device }) => {
        // Check if SDK is installed — prefer SDK data over CDP/interceptor buffer
        const sdkAvailable = await isSDKInstalled();

        if (sdkAvailable) {
            if (summary) {
                const sdkStats = await getSDKNetworkStats();
                if (sdkStats.success) {
                    const s = sdkStats.data;
                    const lines: string[] = [];
                    lines.push(`Total requests: ${s.total}`);
                    lines.push(`Completed: ${s.completed}`);
                    lines.push(`Errors: ${s.errors}`);
                    if (s.avgDuration != null) lines.push(`Avg duration: ${s.avgDuration}ms`);
                    if (s.byMethod && Object.keys(s.byMethod).length > 0) {
                        lines.push("\nBy Method:");
                        for (const [m, c] of Object.entries(s.byMethod)) lines.push(`  ${m}: ${c}`);
                    }
                    if (s.byStatus && Object.keys(s.byStatus).length > 0) {
                        lines.push("\nBy Status:");
                        for (const [st, c] of Object.entries(s.byStatus)) lines.push(`  ${st}: ${c}`);
                    }
                    if (s.byDomain && Object.keys(s.byDomain).length > 0) {
                        lines.push("\nBy Domain:");
                        for (const [d, c] of Object.entries(s.byDomain).sort((a: any, b: any) => b[1] - a[1]).slice(0, 10)) lines.push(`  ${d}: ${c}`);
                    }
                    return { content: [{ type: "text" as const, text: `Network Summary (SDK):\n\n${lines.join("\n")}` }] };
                }
            }

            const sdkResult = await querySDKNetwork({ count: maxRequests, method, urlPattern, status });
            if (sdkResult.success) {
                const entries = sdkResult.data;
                if (entries.length === 0) {
                    return { content: [{ type: "text" as const, text: "No network requests captured yet." }] };
                }
                const lines = entries.map((r) => {
                    const time = new Date(r.timestamp).toLocaleTimeString();
                    const st = r.status ?? "pending";
                    const dur = r.duration != null ? `${r.duration}ms` : "-";
                    return `[${r.id}] ${time} ${r.method} ${st} ${dur} ${r.url}`;
                });
                return { content: [{ type: "text" as const, text: `Network Requests (${entries.length} entries, SDK):\n\n${lines.join("\n")}` }] };
            }
        }

        // Fallback: read from in-process buffer (CDP/interceptor)
        // Return summary if requested
        if (summary) {
            const stats = getNetworkStats(resolveNetworkBuffer(device));
            let connectionWarning = "";
            if (resolveNetworkBuffer(device).size === 0) {
                const connStatus = await checkAndEnsureConnection();
                connectionWarning = connStatus.message ? `\n\n${connStatus.message}` : "";
                if (!sdkAvailable) {
                    connectionWarning += "\n\n[TIP] For full network capture including startup requests and response bodies, install the SDK: npm install react-native-ai-devtools-sdk";
                }
            }
            return {
                content: [
                    {
                        type: "text",
                        text: `Network Summary:\n\n${stats}${connectionWarning}`
                    }
                ]
            };
        }

        const { requests, count, formatted } = getNetworkRequests(resolveNetworkBuffer(device), {
            maxRequests,
            method,
            urlPattern,
            status
        });

        // Check connection health
        let connectionWarning = "";
        if (count === 0) {
            const connStatus = await checkAndEnsureConnection();
            connectionWarning = connStatus.message ? `\n\n${connStatus.message}` : "";
            if (!sdkAvailable) {
                connectionWarning += "\n\n[TIP] For full network capture including startup requests and response bodies, install the SDK: npm install react-native-ai-devtools-sdk";
            }
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
                gapWarning = `\n\n[WARNING] Connection was restored ${secAgo}s ago. Some requests may have been missed during the ${formatDuration(gapDuration)} gap.`;
            } else {
                gapWarning = `\n\n[WARNING] Connection is currently disconnected. Network data may be incomplete.`;
            }
        }

        // Use TONL format if requested
        if (format === "tonl") {
            const tonlOutput = formatNetworkAsTonl(requests);
            return {
                content: [
                    {
                        type: "text",
                        text: `Network Requests (${count} entries):\n\n${tonlOutput}${gapWarning}${connectionWarning}`
                    }
                ]
            };
        }

        return {
            content: [
                {
                    type: "text",
                    text: `Network Requests (${count} entries):\n\n${formatted}${gapWarning}${connectionWarning}`
                }
            ]
        };
    },
    // Empty result detector: buffer has no entries at all
    () => { let total = 0; for (const b of networkBuffers.values()) total += b.size; return total === 0; }
);

// Tool: Search network requests
registerToolWithTelemetry(
    "search_network",
    {
        description: "Search network requests by URL pattern (case-insensitive)",
        inputSchema: {
            urlPattern: z.string().describe("URL pattern to search for"),
            maxResults: z.number().optional().default(50).describe("Maximum number of results to return (default: 50)"),
            format: z
                .enum(["text", "tonl"])
                .optional()
                .default("tonl")
                .describe("Output format: 'text' or 'tonl' (default, compact token-optimized format)"),
            device: z.string().optional().describe("Target device name (substring match). Omit for all devices. Run get_apps to see connected devices.")
        }
    },
    async ({ urlPattern, maxResults, format, device }) => {
        // Check if SDK is installed — prefer SDK data
        const sdkAvailable = await isSDKInstalled();

        if (sdkAvailable) {
            const sdkResult = await querySDKNetwork({ count: maxResults, urlPattern });
            if (sdkResult.success) {
                const entries = sdkResult.data;
                if (entries.length === 0) {
                    return { content: [{ type: "text" as const, text: `No network requests matching "${urlPattern}" found.` }] };
                }
                const lines = entries.map((r) => {
                    const time = new Date(r.timestamp).toLocaleTimeString();
                    const st = r.status ?? "pending";
                    const dur = r.duration != null ? `${r.duration}ms` : "-";
                    return `[${r.id}] ${time} ${r.method} ${st} ${dur} ${r.url}`;
                });
                if (format === "tonl") {
                    return { content: [{ type: "text" as const, text: `Network search results for "${urlPattern}" (${entries.length} matches, SDK):\n\n${lines.join("\n")}` }] };
                }
                return { content: [{ type: "text" as const, text: `Network search results for "${urlPattern}" (${entries.length} matches, SDK):\n\n${lines.join("\n")}` }] };
            }
        }

        const { requests, count, formatted } = searchNetworkRequests(resolveNetworkBuffer(device), urlPattern, maxResults);

        // Check connection health
        let connectionWarning = "";
        if (count === 0) {
            const status = await checkAndEnsureConnection();
            connectionWarning = status.message ? `\n\n${status.message}` : "";
        } else {
            const passive = getPassiveConnectionStatus();
            connectionWarning = !passive.connected
                ? "\n\n[CONNECTION] Disconnected. Showing cached data. New data is not being captured."
                : "";
        }

        // Use TONL format if requested
        if (format === "tonl") {
            const tonlOutput = formatNetworkAsTonl(requests);
            return {
                content: [
                    {
                        type: "text",
                        text: `Network search results for "${urlPattern}" (${count} matches):\n\n${tonlOutput}${connectionWarning}`
                    }
                ]
            };
        }

        return {
            content: [
                {
                    type: "text",
                    text: `Network search results for "${urlPattern}" (${count} matches):\n\n${formatted}${connectionWarning}`
                }
            ]
        };
    }
);

// Tool: Get request details
registerToolWithTelemetry(
    "get_request_details",
    {
        description:
            "Get full details of a specific network request including headers, body, and timing. With the SDK installed, includes full request/response bodies. Without SDK, bodies are not available on most targets. Use get_network_requests first to find the request ID.",
        inputSchema: {
            requestId: z.string().describe("The request ID to get details for"),
            maxBodyLength: z.coerce
                .number()
                .optional()
                .default(500)
                .describe(
                    "Max characters for request body (default: 500, set to 0 for unlimited). Tip: Large POST bodies (file uploads, base64) can be 10KB+."
                ),
            verbose: z
                .boolean()
                .optional()
                .default(false)
                .describe("Disable body truncation. Tip: Use when you need to inspect full JSON payloads."),
            device: z.string().optional().describe("Target device name (substring match). Omit for all devices. Run get_apps to see connected devices.")
        }
    },
    async ({ requestId, maxBodyLength, verbose, device }) => {
        // Check SDK first — it has full headers and body
        const sdkAvailable = await isSDKInstalled();
        if (sdkAvailable) {
            const sdkResult = await getSDKNetworkEntry(requestId);
            if (sdkResult.success && sdkResult.data) {
                const r = sdkResult.data;
                const lines: string[] = [];
                lines.push(`=== ${r.method} ${r.url} ===`);
                lines.push(`Request ID: ${r.id}`);
                lines.push(`Time: ${new Date(r.timestamp).toISOString()}`);
                lines.push(`Status: ${r.status ?? "pending"} ${r.statusText ?? ""}`);
                if (r.duration != null) lines.push(`Duration: ${r.duration}ms`);
                if (r.mimeType) lines.push(`Content-Type: ${r.mimeType}`);
                if (r.error) lines.push(`Error: ${r.error}`);
                if (r.requestHeaders && Object.keys(r.requestHeaders).length > 0) {
                    lines.push("\n--- Request Headers ---");
                    for (const [k, v] of Object.entries(r.requestHeaders)) lines.push(`${k}: ${v}`);
                }
                if (r.requestBody) {
                    lines.push("\n--- Request Body ---");
                    let body = r.requestBody;
                    if (!verbose && maxBodyLength > 0 && body.length > maxBodyLength) {
                        body = body.slice(0, maxBodyLength) + `... [truncated: ${r.requestBody.length} chars]`;
                    }
                    lines.push(body);
                }
                if (r.responseHeaders && Object.keys(r.responseHeaders).length > 0) {
                    lines.push("\n--- Response Headers ---");
                    for (const [k, v] of Object.entries(r.responseHeaders)) lines.push(`${k}: ${v}`);
                }
                if (r.responseBody) {
                    lines.push("\n--- Response Body ---");
                    let body = r.responseBody;
                    if (!verbose && maxBodyLength > 0 && body.length > maxBodyLength) {
                        body = body.slice(0, maxBodyLength) + `... [truncated: ${r.responseBody.length} chars]`;
                    }
                    lines.push(body);
                }
                return { content: [{ type: "text" as const, text: lines.join("\n") }] };
            }
        }

        // Fallback: read from in-process buffer
        const request = resolveNetworkBuffer(device).get(requestId);

        if (!request) {
            const status = await checkAndEnsureConnection();
            const connectionNote = status.message ? `\n\n${status.message}` : "";
            return {
                content: [
                    {
                        type: "text",
                        text: `Request not found: ${requestId}${connectionNote}`
                    }
                ],
                isError: true
            };
        }

        return {
            content: [
                {
                    type: "text",
                    text: formatRequestDetails(request, { maxBodyLength, verbose })
                }
            ]
        };
    }
);

// Tool: Get network stats
registerToolWithTelemetry(
    "get_network_stats",
    {
        description: "Get statistics about captured network requests: counts by method, status code, and domain.",
        inputSchema: {
            device: z.string().optional().describe("Target device name (substring match). Omit for all devices. Run get_apps to see connected devices.")
        }
    },
    async ({ device }) => {
        // Check if SDK is installed — prefer SDK data
        const sdkAvailable = await isSDKInstalled();

        if (sdkAvailable) {
            const sdkStats = await getSDKNetworkStats();
            if (sdkStats.success) {
                const s = sdkStats.data;
                const lines: string[] = [];
                lines.push(`Total requests: ${s.total}`);
                lines.push(`Completed: ${s.completed}`);
                lines.push(`Errors: ${s.errors}`);
                if (s.avgDuration != null) lines.push(`Avg duration: ${s.avgDuration}ms`);
                if (s.byMethod && Object.keys(s.byMethod).length > 0) {
                    lines.push("\nBy Method:");
                    for (const [m, c] of Object.entries(s.byMethod)) lines.push(`  ${m}: ${c}`);
                }
                if (s.byStatus && Object.keys(s.byStatus).length > 0) {
                    lines.push("\nBy Status:");
                    for (const [st, c] of Object.entries(s.byStatus)) lines.push(`  ${st}: ${c}`);
                }
                if (s.byDomain && Object.keys(s.byDomain).length > 0) {
                    lines.push("\nBy Domain:");
                    for (const [d, c] of Object.entries(s.byDomain).sort((a: any, b: any) => b[1] - a[1]).slice(0, 10)) lines.push(`  ${d}: ${c}`);
                }
                return { content: [{ type: "text" as const, text: `Network Statistics (SDK):\n\n${lines.join("\n")}` }] };
            }
        }

        const stats = getNetworkStats(resolveNetworkBuffer(device));

        // Check connection health
        let connectionWarning = "";
        if (resolveNetworkBuffer(device).size === 0) {
            const status = await checkAndEnsureConnection();
            connectionWarning = status.message ? `\n\n${status.message}` : "";
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
                    text: `Network Statistics:\n\n${stats}${connectionWarning}`
                }
            ]
        };
    },
    // Empty result detector: buffer has no entries at all
    () => { let total = 0; for (const b of networkBuffers.values()) total += b.size; return total === 0; }
);

// Tool: Clear network requests
registerToolWithTelemetry(
    "clear_network",
    {
        description: "Clear the network request buffer",
        inputSchema: {
            device: z.string().optional().describe("Target device name (substring match). Omit to clear all devices. Run get_apps to see connected devices.")
        }
    },
    async ({ device }) => {
        let totalCleared = 0;
        if (device) {
            const app = getConnectedAppByDevice(device);
            if (!app) throw new Error(`No connected device matches "${device}"`);
            const deviceName = app.deviceInfo.deviceName || app.deviceInfo.title || "unknown";
            totalCleared = getNetworkBuffer(deviceName).clear();
        } else {
            for (const buffer of networkBuffers.values()) {
                totalCleared += buffer.clear();
            }
        }

        // Also clear SDK buffer if available
        const sdkAvailable = await isSDKInstalled();
        if (sdkAvailable) {
            const sdkResult = await clearSDKNetwork();
            if (sdkResult.success && sdkResult.count) {
                totalCleared += sdkResult.count;
            }
        }

        return {
            content: [
                {
                    type: "text",
                    text: `Cleared ${totalCleared} network requests from buffer.`
                }
            ]
        };
    }
);

// Tool: Reload the app
registerToolWithTelemetry(
    "reload_app",
    {
        description:
            "Reload the React Native app (triggers JavaScript bundle reload like pressing 'r' in Metro). Will auto-connect to Metro if no connection exists. Note: After reload, the app may take a few seconds to fully restart and become responsive — wait before running other tools. IMPORTANT: React Native has Fast Refresh enabled by default - code changes are automatically applied without needing reload. Only use when: (1) logs/behavior don't reflect code changes after a few seconds, (2) app is in broken/error state, or (3) need to reset app state completely (navigation stack, context, etc.).",
        inputSchema: {
            device: z.string().optional().describe("Target device name (substring match). Omit for default device. Run get_apps to see connected devices.")
        }
    },
    async ({ device }) => {
        const result = await reloadApp(device);

        if (!result.success) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error: ${result.error}`
                    }
                ],
                isError: true
            };
        }

        return {
            content: [
                {
                    type: "text",
                    text: result.result ?? "App reload triggered"
                }
            ]
        };
    }
);

// ============================================================================
// Bundle/Build Error Tools
// ============================================================================

// Tool: Get bundle status
registerToolWithTelemetry(
    "get_bundle_status",
    {
        description:
            "Get the current Metro bundler status including build state and any recent bundling errors. Use this to check if there are compilation/bundling errors that prevent the app from loading.",
        inputSchema: {}
    },
    async () => {
        // Get port from first connected app if available
        const apps = Array.from(connectedApps.values());
        const metroPort = apps.length > 0 ? apps[0].port : undefined;

        const { formatted } = await getBundleStatusWithErrors(bundleErrorBuffer, metroPort);

        return {
            content: [
                {
                    type: "text",
                    text: formatted
                }
            ]
        };
    }
);

// Tool: Get bundle errors
registerToolWithTelemetry(
    "get_bundle_errors",
    {
        description:
            "Retrieve captured Metro bundling/compilation errors. These are errors that occur during the bundle build process (import resolution, syntax errors, transform errors) that prevent the app from loading. If no errors are captured but Metro is running without connected apps, automatically falls back to screenshot+OCR to capture the error from the device screen.",
        inputSchema: {
            maxErrors: z.number().optional().default(10).describe("Maximum number of errors to return (default: 10)"),
            platform: z
                .enum(["ios", "android"])
                .optional()
                .describe(
                    "Platform for screenshot fallback when no errors are captured via CDP. Required to enable fallback."
                ),
            deviceId: z
                .string()
                .optional()
                .describe("Optional device ID for screenshot fallback. Uses first available device if not specified.")
        }
    },
    async ({ maxErrors, platform, deviceId }) => {
        // First, try to get errors from the buffer (captured via CDP/Metro WebSocket)
        const { errors, formatted } = getBundleErrors(bundleErrorBuffer, { maxErrors });

        if (errors.length > 0) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Bundle Errors (${errors.length} captured):\n\n${formatted}`
                    }
                ]
            };
        }

        // No errors in buffer - check if we should try fallback
        if (!platform) {
            // No platform specified, return empty result with hint
            return {
                content: [
                    {
                        type: "text",
                        text: `Bundle Errors (0 captured):\n\nNo bundle errors captured.\n\nTip: If the app failed to load and you see a red error screen on the device, use the 'platform' parameter (ios/android) to enable screenshot+OCR fallback for error capture.`
                    }
                ]
            };
        }

        // Check Metro state to see if fallback is warranted
        const metroState = await checkMetroState(connectedApps.size);

        if (!metroState.needsFallback) {
            // Metro not running or apps are connected - fallback not needed
            const statusMsg = metroState.metroRunning
                ? "Metro is running and apps are connected."
                : "Metro is not running.";

            return {
                content: [
                    {
                        type: "text",
                        text: `Bundle Errors (0 captured):\n\nNo bundle errors captured. ${statusMsg}`
                    }
                ]
            };
        }

        // Metro is running but no apps connected - try screenshot fallback
        try {
            let screenshotResult: {
                success: boolean;
                error?: string;
                data?: Buffer;
                scaleFactor?: number;
                originalWidth?: number;
                originalHeight?: number;
            };

            if (platform === "android") {
                screenshotResult = await androidScreenshot(undefined, deviceId);
            } else {
                screenshotResult = await iosScreenshot(undefined, deviceId);
            }

            if (!screenshotResult.success || !screenshotResult.data) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Bundle Errors (0 captured):\n\nNo bundle errors captured via CDP.\n\nMetro is running on port(s) ${metroState.metroPorts.join(", ")} but no apps are connected (possible bundle error).\n\nScreenshot fallback failed: ${screenshotResult.error || "No image data"}`
                        }
                    ]
                };
            }

            // Calculate device pixel ratio for iOS
            const devicePixelRatio =
                platform === "ios" && screenshotResult.originalWidth && screenshotResult.originalHeight
                    ? inferIOSDevicePixelRatio(screenshotResult.originalWidth, screenshotResult.originalHeight)
                    : 1;

            // Run OCR on the screenshot
            const ocrResult = await recognizeText(screenshotResult.data, {
                scaleFactor: screenshotResult.scaleFactor || 1,
                platform,
                devicePixelRatio
            });

            if (!ocrResult.success || !ocrResult.fullText) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Bundle Errors (0 captured):\n\nNo bundle errors captured via CDP.\n\nMetro is running on port(s) ${metroState.metroPorts.join(", ")} but no apps are connected.\n\nScreenshot captured but OCR found no text. The screen may not show an error message.`
                        }
                    ]
                };
            }

            // Parse the OCR text for error information
            const parsedError = parseErrorScreenText(ocrResult.fullText);

            if (!parsedError.found || !parsedError.error) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Bundle Errors (0 captured):\n\nNo bundle errors captured via CDP.\n\nMetro is running on port(s) ${metroState.metroPorts.join(", ")} but no apps are connected.\n\nScreenshot OCR text:\n${ocrResult.fullText.substring(0, 1000)}${ocrResult.fullText.length > 1000 ? "..." : ""}\n\n(No error pattern detected in text)`
                        }
                    ]
                };
            }

            // Add the parsed error to the buffer for future reference
            bundleErrorBuffer.add(parsedError.error);

            return {
                content: [
                    {
                        type: "text",
                        text: `Bundle Errors (1 captured via screenshot fallback):\n\n${formatParsedError(parsedError)}`
                    }
                ]
            };
        } catch (fallbackError) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Bundle Errors (0 captured):\n\nNo bundle errors captured via CDP.\n\nMetro is running on port(s) ${metroState.metroPorts.join(", ")} but no apps are connected.\n\nScreenshot fallback error: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`
                    }
                ]
            };
        }
    }
);

// Tool: Clear bundle errors
registerToolWithTelemetry(
    "clear_bundle_errors",
    {
        description: "Clear the bundle error buffer",
        inputSchema: {}
    },
    async () => {
        const count = bundleErrorBuffer.clear();

        return {
            content: [
                {
                    type: "text",
                    text: `Cleared ${count} bundle errors from buffer.`
                }
            ]
        };
    }
);

// ============================================================================
// Android Tools
// ============================================================================

// Tool: List Android devices
registerToolWithTelemetry(
    "list_android_devices",
    {
        description: "List connected Android devices and emulators via ADB",
        inputSchema: {}
    },
    async () => {
        const result = await listAndroidDevices();

        return {
            content: [
                {
                    type: "text",
                    text: result.success ? result.result! : `Error: ${result.error}`
                }
            ],
            isError: !result.success
        };
    }
);

// Tool: Android screenshot
registerToolWithTelemetry(
    "android_screenshot",
    {
        description: "Take a screenshot from an Android device/emulator. Returns the image data that can be displayed.",
        inputSchema: {
            outputPath: z
                .string()
                .optional()
                .describe("Optional path to save the screenshot. If not provided, saves to temp directory."),
            deviceId: z
                .string()
                .optional()
                .describe(
                    "Optional device ID (from list_android_devices). Uses first available device if not specified."
                )
        }
    },
    async ({ outputPath, deviceId }) => {
        const result = await androidScreenshot(outputPath, deviceId);

        if (!result.success) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Error: ${result.error}`
                    }
                ],
                isError: true
            };
        }

        // Include image data if available
        if (result.data) {
            // Build info text with coordinate conversion guidance
            const pixelWidth = result.originalWidth || 0;
            const pixelHeight = result.originalHeight || 0;

            // Store screenshot metadata for coordinate conversion
            const firstApp = connectedApps.values().next().value;
            if (firstApp) {
                firstApp.lastScreenshot = {
                    originalWidth: pixelWidth,
                    originalHeight: pixelHeight,
                    scaleFactor: result.scaleFactor || 1,
                };
            }

            let infoText = `Screenshot captured (${pixelWidth}x${pixelHeight} pixels)`;

            // Get status bar height for coordinate guidance
            let statusBarPixels = 63; // Default fallback
            let statusBarDp = 24;
            let densityDpi = 440; // Common default
            try {
                const statusBarResult = await androidGetStatusBarHeight(deviceId);
                if (statusBarResult.success && statusBarResult.heightPixels) {
                    statusBarPixels = statusBarResult.heightPixels;
                    statusBarDp = statusBarResult.heightDp || 24;
                }
                const densityResult = await androidGetDensity(deviceId);
                if (densityResult.success && densityResult.density) {
                    densityDpi = densityResult.density;
                }
            } catch {
                // Use defaults
            }

            infoText += `\n📱 Android uses PIXELS for all coordinates`;

            if (result.scaleFactor && result.scaleFactor > 1) {
                infoText += `\n🖼️ Image was scaled down to fit API limits (scale: ${result.scaleFactor.toFixed(3)})`;
                infoText += `\n📐 tap() handles coordinate conversion automatically — pass pixel coords from this image directly`;
            } else {
                infoText += `\n📐 Screenshot coords = tap coords (no conversion needed)`;
            }

            infoText += `\n⚠️ Status bar: ${statusBarPixels}px (${statusBarDp}dp) from top - app content starts below this`;
            infoText += `\n📊 Display density: ${densityDpi}dpi`;
            infoText += `\n\n💡 Next steps:`;
            infoText += `\n  • tap(text="Button Label") — tap element by visible text`;
            infoText += `\n  • tap(x=<px>, y=<px>) — tap at coordinates from this screenshot`;
            infoText += `\n  • android_describe_all — get full UI tree with exact tap coordinates`;
            infoText += `\n  • android_find_element(text="...") — find element coordinates without tapping`;

            return {
                content: [
                    {
                        type: "text" as const,
                        text: infoText
                    },
                    {
                        type: "image" as const,
                        data: result.data.toString("base64"),
                        mimeType: "image/jpeg"
                    }
                ]
            };
        }

        return {
            content: [
                {
                    type: "text" as const,
                    text: `Screenshot saved to: ${result.result}`
                }
            ]
        };
    }
);

// Tool: Android install app
registerToolWithTelemetry(
    "android_install_app",
    {
        description: "Install an APK on an Android device/emulator",
        inputSchema: {
            apkPath: z.string().describe("Path to the APK file to install"),
            deviceId: z
                .string()
                .optional()
                .describe("Optional device ID. Uses first available device if not specified."),
            replace: z
                .boolean()
                .optional()
                .default(true)
                .describe("Replace existing app if already installed (default: true)"),
            grantPermissions: z
                .boolean()
                .optional()
                .default(false)
                .describe("Grant all runtime permissions on install (default: false)")
        }
    },
    async ({ apkPath, deviceId, replace, grantPermissions }) => {
        const result = await androidInstallApp(apkPath, deviceId, { replace, grantPermissions });

        return {
            content: [
                {
                    type: "text",
                    text: result.success ? result.result! : `Error: ${result.error}`
                }
            ],
            isError: !result.success
        };
    }
);

// Tool: Android launch app
registerToolWithTelemetry(
    "android_launch_app",
    {
        description: "Launch an app on an Android device/emulator by package name",
        inputSchema: {
            packageName: z.string().describe("Package name of the app (e.g., com.example.myapp)"),
            activityName: z
                .string()
                .optional()
                .describe(
                    "Optional activity name to launch (e.g., .MainActivity). If not provided, launches the main activity."
                ),
            deviceId: z
                .string()
                .optional()
                .describe("Optional device ID. Uses first available device if not specified.")
        }
    },
    async ({ packageName, activityName, deviceId }) => {
        const result = await androidLaunchApp(packageName, activityName, deviceId);

        return {
            content: [
                {
                    type: "text",
                    text: result.success ? result.result! : `Error: ${result.error}`
                }
            ],
            isError: !result.success
        };
    }
);

// Tool: Android list packages
registerToolWithTelemetry(
    "android_list_packages",
    {
        description: "List installed packages on an Android device/emulator",
        inputSchema: {
            deviceId: z
                .string()
                .optional()
                .describe("Optional device ID. Uses first available device if not specified."),
            filter: z.string().optional().describe("Optional filter to search packages by name (case-insensitive)")
        }
    },
    async ({ deviceId, filter }) => {
        const result = await androidListPackages(deviceId, filter);

        return {
            content: [
                {
                    type: "text",
                    text: result.success ? result.result! : `Error: ${result.error}`
                }
            ],
            isError: !result.success
        };
    }
);

// ============================================================================
// Android UI Input Tools (Phase 2)
// ============================================================================

// Tool: Android long press
registerToolWithTelemetry(
    "android_long_press",
    {
        description: "Long press at specific coordinates on an Android device/emulator screen",
        inputSchema: {
            x: z.coerce.number().describe("X coordinate in pixels"),
            y: z.coerce.number().describe("Y coordinate in pixels"),
            durationMs: z.number().optional().default(1000).describe("Press duration in milliseconds (default: 1000)"),
            deviceId: z
                .string()
                .optional()
                .describe("Optional device ID. Uses first available device if not specified.")
        }
    },
    async ({ x, y, durationMs, deviceId }) => {
        const result = await androidLongPress(x, y, durationMs, deviceId);

        return {
            content: [
                {
                    type: "text",
                    text: result.success ? result.result! : `Error: ${result.error}`
                }
            ],
            isError: !result.success
        };
    }
);

// Tool: Android swipe
registerToolWithTelemetry(
    "android_swipe",
    {
        description: "Swipe from one point to another on an Android device/emulator screen",
        inputSchema: {
            startX: z.coerce.number().describe("Starting X coordinate in pixels"),
            startY: z.coerce.number().describe("Starting Y coordinate in pixels"),
            endX: z.coerce.number().describe("Ending X coordinate in pixels"),
            endY: z.coerce.number().describe("Ending Y coordinate in pixels"),
            durationMs: z.number().optional().default(300).describe("Swipe duration in milliseconds (default: 300)"),
            deviceId: z
                .string()
                .optional()
                .describe("Optional device ID. Uses first available device if not specified.")
        }
    },
    async ({ startX, startY, endX, endY, durationMs, deviceId }) => {
        const result = await androidSwipe(startX, startY, endX, endY, durationMs, deviceId);

        return {
            content: [
                {
                    type: "text",
                    text: result.success ? result.result! : `Error: ${result.error}`
                }
            ],
            isError: !result.success
        };
    }
);

// Tool: Android input text
registerToolWithTelemetry(
    "android_input_text",
    {
        description:
            "Type text on an Android device/emulator. The text will be input at the current focus point (tap an input field first).",
        inputSchema: {
            text: z.string().describe("Text to type"),
            deviceId: z
                .string()
                .optional()
                .describe("Optional device ID. Uses first available device if not specified.")
        }
    },
    async ({ text, deviceId }) => {
        const result = await androidInputText(text, deviceId);

        return {
            content: [
                {
                    type: "text",
                    text: result.success ? result.result! : `Error: ${result.error}`
                }
            ],
            isError: !result.success
        };
    }
);

// Tool: Android key event
registerToolWithTelemetry(
    "android_key_event",
    {
        description: `Send a key event to an Android device/emulator. Common keys: ${Object.keys(ANDROID_KEY_EVENTS).join(", ")}`,
        inputSchema: {
            key: z.string().describe(`Key name (${Object.keys(ANDROID_KEY_EVENTS).join(", ")}) or numeric keycode`),
            deviceId: z
                .string()
                .optional()
                .describe("Optional device ID. Uses first available device if not specified.")
        }
    },
    async ({ key, deviceId }) => {
        // Try to parse as number first, otherwise treat as key name
        const keyCode = /^\d+$/.test(key) ? parseInt(key, 10) : (key.toUpperCase() as keyof typeof ANDROID_KEY_EVENTS);

        const result = await androidKeyEvent(keyCode, deviceId);

        return {
            content: [
                {
                    type: "text",
                    text: result.success ? result.result! : `Error: ${result.error}`
                }
            ],
            isError: !result.success
        };
    }
);

// Tool: Android get screen size
registerToolWithTelemetry(
    "android_get_screen_size",
    {
        description: "Get the screen size (resolution) of an Android device/emulator",
        inputSchema: {
            deviceId: z
                .string()
                .optional()
                .describe("Optional device ID. Uses first available device if not specified.")
        }
    },
    async ({ deviceId }) => {
        const result = await androidGetScreenSize(deviceId);

        if (!result.success) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error: ${result.error}`
                    }
                ],
                isError: true
            };
        }

        return {
            content: [
                {
                    type: "text",
                    text: `Screen size: ${result.width}x${result.height} pixels`
                }
            ]
        };
    }
);

// ============================================================================
// Android Accessibility Tools (UI Hierarchy)
// ============================================================================

// Tool: Android describe all (UI hierarchy)
server.registerTool(
    "android_describe_all",
    {
        description:
            "Get the full UI accessibility tree from the Android device using uiautomator. Returns a hierarchical view of all UI elements with their text, content-description, resource-id, bounds, and tap coordinates.",
        inputSchema: {
            deviceId: z
                .string()
                .optional()
                .describe("Optional device ID. Uses first available device if not specified.")
        }
    },
    async ({ deviceId }) => {
        const result = await androidDescribeAll(deviceId);

        return {
            content: [
                {
                    type: "text",
                    text: result.success ? result.formatted! : `Error: ${result.error}`
                }
            ],
            isError: !result.success
        };
    }
);

// Tool: Android describe point
server.registerTool(
    "android_describe_point",
    {
        description:
            "Get UI element info at specific coordinates on an Android device. Returns the element's text, content-description, resource-id, bounds, and state flags.",
        inputSchema: {
            x: z.coerce.number().describe("X coordinate in pixels"),
            y: z.coerce.number().describe("Y coordinate in pixels"),
            deviceId: z
                .string()
                .optional()
                .describe("Optional device ID. Uses first available device if not specified.")
        }
    },
    async ({ x, y, deviceId }) => {
        const result = await androidDescribePoint(x, y, deviceId);

        return {
            content: [
                {
                    type: "text",
                    text: result.success ? result.formatted! : `Error: ${result.error}`
                }
            ],
            isError: !result.success
        };
    }
);

// Tool: Android find element (no screenshot needed)
server.registerTool(
    "android_find_element",
    {
        description:
            "Find a UI element on Android screen by text, content description, or resource ID. Returns element details including tap coordinates. Use this to check if an element exists without tapping it. Workflow: 1) wait_for_element, 2) find_element, 3) tap with returned coordinates. Prefer this over screenshots for button taps.",
        inputSchema: {
            text: z.string().optional().describe("Exact text match for the element"),
            textContains: z.string().optional().describe("Partial text match (case-insensitive)"),
            contentDesc: z.string().optional().describe("Exact content-description match"),
            contentDescContains: z.string().optional().describe("Partial content-description match (case-insensitive)"),
            resourceId: z
                .string()
                .optional()
                .describe("Resource ID match (e.g., 'com.app:id/button' or just 'button')"),
            index: z
                .number()
                .optional()
                .describe("If multiple elements match, select the nth one (0-indexed, default: 0)"),
            deviceId: z
                .string()
                .optional()
                .describe("Optional device ID. Uses first available device if not specified.")
        }
    },
    async ({ text, textContains, contentDesc, contentDescContains, resourceId, index, deviceId }) => {
        const result = await androidFindElement(
            { text, textContains, contentDesc, contentDescContains, resourceId, index },
            deviceId
        );

        if (!result.success) {
            return {
                content: [{ type: "text", text: `Error: ${result.error}` }],
                isError: true
            };
        }

        if (!result.found) {
            return {
                content: [
                    {
                        type: "text",
                        text: result.error || "Element not found"
                    }
                ]
            };
        }

        const el = result.element!;
        const info = [
            `Found element (${result.matchCount} match${result.matchCount! > 1 ? "es" : ""})`,
            `  Text: "${el.text}"`,
            `  Content-desc: "${el.contentDesc}"`,
            `  Resource ID: "${el.resourceId}"`,
            `  Class: ${el.className}`,
            `  Bounds: [${el.bounds.left},${el.bounds.top}][${el.bounds.right},${el.bounds.bottom}]`,
            `  Center (tap coords): (${el.center.x}, ${el.center.y})`,
            `  Clickable: ${el.clickable}, Enabled: ${el.enabled}`
        ].join("\n");

        return {
            content: [{ type: "text", text: info }]
        };
    }
);

// Tool: Android wait for element
server.registerTool(
    "android_wait_for_element",
    {
        description:
            "Wait for a UI element to appear on Android screen. Polls the accessibility tree until the element is found or timeout is reached. Use this FIRST after navigation to ensure screen is ready, then use find_element + tap.",
        inputSchema: {
            text: z.string().optional().describe("Exact text match for the element"),
            textContains: z.string().optional().describe("Partial text match (case-insensitive)"),
            contentDesc: z.string().optional().describe("Exact content-description match"),
            contentDescContains: z.string().optional().describe("Partial content-description match (case-insensitive)"),
            resourceId: z
                .string()
                .optional()
                .describe("Resource ID match (e.g., 'com.app:id/button' or just 'button')"),
            index: z
                .number()
                .optional()
                .describe("If multiple elements match, select the nth one (0-indexed, default: 0)"),
            timeoutMs: z
                .number()
                .optional()
                .default(10000)
                .describe("Maximum time to wait in milliseconds (default: 10000)"),
            pollIntervalMs: z
                .number()
                .optional()
                .default(500)
                .describe("Time between polls in milliseconds (default: 500)"),
            deviceId: z
                .string()
                .optional()
                .describe("Optional device ID. Uses first available device if not specified.")
        }
    },
    async ({
        text,
        textContains,
        contentDesc,
        contentDescContains,
        resourceId,
        index,
        timeoutMs,
        pollIntervalMs,
        deviceId
    }) => {
        const result = await androidWaitForElement(
            {
                text,
                textContains,
                contentDesc,
                contentDescContains,
                resourceId,
                index,
                timeoutMs,
                pollIntervalMs
            },
            deviceId
        );

        if (!result.success) {
            return {
                content: [{ type: "text", text: `Error: ${result.error}` }],
                isError: true
            };
        }

        if (!result.found) {
            return {
                content: [
                    {
                        type: "text",
                        text: result.timedOut
                            ? `Timed out after ${result.elapsedMs}ms - element not found`
                            : result.error || "Element not found"
                    }
                ]
            };
        }

        const el = result.element!;
        const info = [
            `Element found after ${result.elapsedMs}ms`,
            `  Text: "${el.text}"`,
            `  Content-desc: "${el.contentDesc}"`,
            `  Resource ID: "${el.resourceId}"`,
            `  Center (tap coords): (${el.center.x}, ${el.center.y})`,
            `  Clickable: ${el.clickable}, Enabled: ${el.enabled}`
        ].join("\n");

        return {
            content: [{ type: "text", text: info }]
        };
    }
);

// ============================================================================
// iOS Simulator Tools
// ============================================================================

// Tool: List iOS simulators
registerToolWithTelemetry(
    "list_ios_simulators",
    {
        description: "List available iOS simulators",
        inputSchema: {
            onlyBooted: z
                .boolean()
                .optional()
                .default(false)
                .describe("Only show currently running simulators (default: false)")
        }
    },
    async ({ onlyBooted }) => {
        const result = await listIOSSimulators(onlyBooted);

        return {
            content: [
                {
                    type: "text",
                    text: result.success ? result.result! : `Error: ${result.error}`
                }
            ],
            isError: !result.success
        };
    }
);

// Tool: iOS screenshot
registerToolWithTelemetry(
    "ios_screenshot",
    {
        description: "Take a screenshot from an iOS simulator. Returns the image data that can be displayed.",
        inputSchema: {
            outputPath: z
                .string()
                .optional()
                .describe("Optional path to save the screenshot. If not provided, saves to temp directory."),
            udid: z
                .string()
                .optional()
                .describe("Optional simulator UDID (from list_ios_simulators). Uses booted simulator if not specified.")
        }
    },
    async ({ outputPath, udid }) => {
        const result = await iosScreenshot(outputPath, udid);

        if (!result.success) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Error: ${result.error}`
                    }
                ],
                isError: true
            };
        }

        // Include image data if available
        if (result.data) {
            // Build info text with coordinate guidance for iOS
            const pixelWidth = result.originalWidth || 0;
            const pixelHeight = result.originalHeight || 0;

            // Store screenshot metadata for coordinate conversion
            const firstApp = connectedApps.values().next().value;
            if (firstApp) {
                firstApp.lastScreenshot = {
                    originalWidth: pixelWidth,
                    originalHeight: pixelHeight,
                    scaleFactor: result.scaleFactor || 1,
                };
            }

            // Try to get actual screen dimensions and safe area from accessibility tree
            let pointWidth = 0;
            let pointHeight = 0;
            let scaleFactor = 3; // Default to 3x for modern iPhones
            let safeAreaTop = 59; // Default safe area offset
            try {
                const describeResult = await iosDescribeAll(udid);
                if (describeResult.success && describeResult.elements && describeResult.elements.length > 0) {
                    // First element is typically the Application with full screen frame
                    const rootElement = describeResult.elements[0];
                    // Try parsed frame first, then parse AXFrame string
                    if (rootElement.frame) {
                        pointWidth = Math.round(rootElement.frame.width);
                        pointHeight = Math.round(rootElement.frame.height);
                        // The frame.y of the root element indicates where content starts (after status bar)
                        if (rootElement.frame.y > 0) {
                            safeAreaTop = Math.round(rootElement.frame.y);
                        }
                    } else if (rootElement.AXFrame) {
                        // Parse format: "{{x, y}, {width, height}}"
                        const match = rootElement.AXFrame.match(
                            /\{\{([\d.]+),\s*([\d.]+)\},\s*\{([\d.]+),\s*([\d.]+)\}\}/
                        );
                        if (match) {
                            const frameY = parseFloat(match[2]);
                            pointWidth = Math.round(parseFloat(match[3]));
                            pointHeight = Math.round(parseFloat(match[4]));
                            if (frameY > 0) {
                                safeAreaTop = Math.round(frameY);
                            }
                        }
                    }
                    // Calculate actual scale factor
                    if (pointWidth > 0) {
                        scaleFactor = Math.round(pixelWidth / pointWidth);
                    }
                }
            } catch {
                // Fallback: use 3x scale for modern devices
            }

            // Fallback if we couldn't get dimensions
            if (pointWidth === 0) {
                pointWidth = Math.round(pixelWidth / scaleFactor);
                pointHeight = Math.round(pixelHeight / scaleFactor);
            }

            const safeAreaOffsetPixels = safeAreaTop * scaleFactor;

            let infoText = `Screenshot captured (${pixelWidth}x${pixelHeight} pixels)`;
            infoText += `\n📱 iOS screen: ${pointWidth}x${pointHeight} points (${scaleFactor}x scale)`;
            infoText += `\n📐 tap() handles pixel-to-point conversion automatically — pass pixel coords from this image directly`;
            infoText += `\n⚠️ Status bar + safe area: ${safeAreaTop} points (${safeAreaOffsetPixels} pixels) from top`;
            if (result.scaleFactor && result.scaleFactor > 1) {
                infoText += `\n🖼️ Image was scaled down to fit API limits (scale: ${result.scaleFactor.toFixed(3)})`;
            }
            infoText += `\n\n💡 Next steps:`;
            infoText += `\n  • tap(text="Button Label") — tap element by visible text`;
            infoText += `\n  • tap(x=<px>, y=<px>) — tap at coordinates from this screenshot`;
            infoText += `\n  • ios_describe_all — get full UI tree with exact tap coordinates`;
            infoText += `\n  • ios_find_element(label="...") — find element coordinates without tapping`;

            return {
                content: [
                    {
                        type: "text" as const,
                        text: infoText
                    },
                    {
                        type: "image" as const,
                        data: result.data.toString("base64"),
                        mimeType: "image/jpeg"
                    }
                ]
            };
        }

        return {
            content: [
                {
                    type: "text" as const,
                    text: `Screenshot saved to: ${result.result}`
                }
            ]
        };
    }
);

// Tool: OCR Screenshot - Extract text with coordinates from screenshot
registerToolWithTelemetry(
    "ocr_screenshot",
    {
        description:
            "RECOMMENDED: Use this tool FIRST when you need to find and tap UI elements. Takes a screenshot and extracts all visible text with tap-ready coordinates using OCR. " +
            "ADVANTAGES over accessibility trees: (1) Works on ANY visible text regardless of accessibility labels, (2) Returns ready-to-use tapX/tapY coordinates - no conversion needed, (3) Faster than parsing accessibility hierarchies, (4) Works consistently across iOS and Android. " +
            "USE THIS FOR: Finding buttons, labels, menu items, tab bars, or any text you need to tap. Simply find the text in the results and use its tapX/tapY with the tap command.",
        inputSchema: {
            platform: z.enum(["ios", "android"]).describe("Platform to capture screenshot from"),
            deviceId: z
                .string()
                .optional()
                .describe("Optional device ID (Android) or UDID (iOS). Uses first available device if not specified.")
        }
    },
    async ({ platform, deviceId }) => {
        // Call the HTTP endpoint for OCR (allows hot-reload without session restart)
        // Prefer child process port, fall back to in-process port
        const port = getDebugServerPort();
        if (!port) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: "Debug HTTP server not running"
                    }
                ],
                isError: true
            };
        }

        try {
            const params = new URLSearchParams({ platform, engine: "auto" });
            if (deviceId) params.set("deviceId", deviceId);

            const response = await fetch(`http://localhost:${port}/api/ocr?${params}`);
            const ocrResult = await response.json();

            if (!ocrResult.success) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `OCR failed: ${ocrResult.error || "Unknown error"}`
                        }
                    ],
                    isError: true
                };
            }

            // Format results for MCP tool output
            const elements = ocrResult.words
                .filter((w: { confidence: number; text: string }) => w.confidence > 50 && w.text.trim().length > 0)
                .map((w: { text: string; confidence: number; tapCenter: { x: number; y: number } }) => ({
                    text: w.text,
                    confidence: Math.round(w.confidence),
                    tapX: w.tapCenter.x,
                    tapY: w.tapCenter.y
                }));

            const result = {
                platform,
                engine: ocrResult.engine || "unknown",
                processingTimeMs: ocrResult.processingTimeMs,
                fullText: ocrResult.fullText?.trim() || "",
                confidence: Math.round(ocrResult.confidence || 0),
                elementCount: elements.length,
                elements,
                note: "tapX/tapY are ready to use with tap commands (already converted for platform)"
            };

            return {
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify(result, null, 2)
                    }
                ]
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `OCR request failed: ${error instanceof Error ? error.message : String(error)}`
                    }
                ],
                isError: true
            };
        }
    }
);

// Tool: iOS install app
registerToolWithTelemetry(
    "ios_install_app",
    {
        description: "Install an app bundle (.app) on an iOS simulator",
        inputSchema: {
            appPath: z.string().describe("Path to the .app bundle to install"),
            udid: z.string().optional().describe("Optional simulator UDID. Uses booted simulator if not specified.")
        }
    },
    async ({ appPath, udid }) => {
        const result = await iosInstallApp(appPath, udid);

        return {
            content: [
                {
                    type: "text",
                    text: result.success ? result.result! : `Error: ${result.error}`
                }
            ],
            isError: !result.success
        };
    }
);

// Tool: iOS launch app
registerToolWithTelemetry(
    "ios_launch_app",
    {
        description: "Launch an app on an iOS simulator by bundle ID",
        inputSchema: {
            bundleId: z.string().describe("Bundle ID of the app (e.g., com.example.myapp)"),
            udid: z.string().optional().describe("Optional simulator UDID. Uses booted simulator if not specified.")
        }
    },
    async ({ bundleId, udid }) => {
        const result = await iosLaunchApp(bundleId, udid);

        return {
            content: [
                {
                    type: "text",
                    text: result.success ? result.result! : `Error: ${result.error}`
                }
            ],
            isError: !result.success
        };
    }
);

// Tool: iOS open URL
registerToolWithTelemetry(
    "ios_open_url",
    {
        description: "Open a URL in the iOS simulator (opens in default handler or Safari)",
        inputSchema: {
            url: z.string().describe("URL to open (e.g., https://example.com or myapp://path)"),
            udid: z.string().optional().describe("Optional simulator UDID. Uses booted simulator if not specified.")
        }
    },
    async ({ url, udid }) => {
        const result = await iosOpenUrl(url, udid);

        return {
            content: [
                {
                    type: "text",
                    text: result.success ? result.result! : `Error: ${result.error}`
                }
            ],
            isError: !result.success
        };
    }
);

// Tool: iOS terminate app
registerToolWithTelemetry(
    "ios_terminate_app",
    {
        description: "Terminate a running app on an iOS simulator",
        inputSchema: {
            bundleId: z.string().describe("Bundle ID of the app to terminate"),
            udid: z.string().optional().describe("Optional simulator UDID. Uses booted simulator if not specified.")
        }
    },
    async ({ bundleId, udid }) => {
        const result = await iosTerminateApp(bundleId, udid);

        return {
            content: [
                {
                    type: "text",
                    text: result.success ? result.result! : `Error: ${result.error}`
                }
            ],
            isError: !result.success
        };
    }
);

// Tool: iOS boot simulator
registerToolWithTelemetry(
    "ios_boot_simulator",
    {
        description: "Boot an iOS simulator by UDID. Use list_ios_simulators to find available simulators.",
        inputSchema: {
            udid: z.string().describe("UDID of the simulator to boot (from list_ios_simulators)")
        }
    },
    async ({ udid }) => {
        const result = await iosBootSimulator(udid);

        return {
            content: [
                {
                    type: "text",
                    text: result.success ? result.result! : `Error: ${result.error}`
                }
            ],
            isError: !result.success
        };
    }
);

// ============================================================================
// iOS IDB-Based UI Tools (require Facebook IDB)
// Install with: brew install idb-companion
// ============================================================================

// Tool: iOS swipe
server.registerTool(
    "ios_swipe",
    {
        description:
            "Swipe gesture on an iOS simulator screen. Requires IDB to be installed (brew install idb-companion).",
        inputSchema: {
            startX: z.coerce.number().describe("Starting X coordinate in pixels"),
            startY: z.coerce.number().describe("Starting Y coordinate in pixels"),
            endX: z.coerce.number().describe("Ending X coordinate in pixels"),
            endY: z.coerce.number().describe("Ending Y coordinate in pixels"),
            duration: z.coerce.number().optional().describe("Optional swipe duration in seconds"),
            delta: z.coerce.number().optional().describe("Optional delta between touch events (step size)"),
            udid: z.string().optional().describe("Optional simulator UDID. Uses booted simulator if not specified.")
        }
    },
    async ({ startX, startY, endX, endY, duration, delta, udid }) => {
        const result = await iosSwipe(startX, startY, endX, endY, { duration, delta, udid });

        return {
            content: [
                {
                    type: "text",
                    text: result.success ? result.result! : `Error: ${result.error}`
                }
            ],
            isError: !result.success
        };
    }
);

// Tool: iOS input text
server.registerTool(
    "ios_input_text",
    {
        description:
            "Type text into the active input field on an iOS simulator. Requires IDB to be installed (brew install idb-companion).",
        inputSchema: {
            text: z.string().describe("Text to type into the active input field"),
            udid: z.string().optional().describe("Optional simulator UDID. Uses booted simulator if not specified.")
        }
    },
    async ({ text, udid }) => {
        const result = await iosInputText(text, udid);

        return {
            content: [
                {
                    type: "text",
                    text: result.success ? result.result! : `Error: ${result.error}`
                }
            ],
            isError: !result.success
        };
    }
);

// Tool: iOS button
server.registerTool(
    "ios_button",
    {
        description:
            "Press a hardware button on an iOS simulator. Requires IDB to be installed (brew install idb-companion).",
        inputSchema: {
            button: z
                .enum(IOS_BUTTON_TYPES)
                .describe("Hardware button to press: HOME, LOCK, SIDE_BUTTON, SIRI, or APPLE_PAY"),
            duration: z.coerce.number().optional().describe("Optional button press duration in seconds"),
            udid: z.string().optional().describe("Optional simulator UDID. Uses booted simulator if not specified.")
        }
    },
    async ({ button, duration, udid }) => {
        const result = await iosButton(button, { duration, udid });

        return {
            content: [
                {
                    type: "text",
                    text: result.success ? result.result! : `Error: ${result.error}`
                }
            ],
            isError: !result.success
        };
    }
);

// Tool: iOS key event
server.registerTool(
    "ios_key_event",
    {
        description:
            "Send a key event to an iOS simulator by keycode. Requires IDB to be installed (brew install idb-companion).",
        inputSchema: {
            keycode: z.coerce.number().describe("iOS keycode to send"),
            duration: z.coerce.number().optional().describe("Optional key press duration in seconds"),
            udid: z.string().optional().describe("Optional simulator UDID. Uses booted simulator if not specified.")
        }
    },
    async ({ keycode, duration, udid }) => {
        const result = await iosKeyEvent(keycode, { duration, udid });

        return {
            content: [
                {
                    type: "text",
                    text: result.success ? result.result! : `Error: ${result.error}`
                }
            ],
            isError: !result.success
        };
    }
);

// Tool: iOS key sequence
server.registerTool(
    "ios_key_sequence",
    {
        description:
            "Send a sequence of key events to an iOS simulator. Requires IDB to be installed (brew install idb-companion).",
        inputSchema: {
            keycodes: z.array(z.coerce.number()).describe("Array of iOS keycodes to send in sequence"),
            udid: z.string().optional().describe("Optional simulator UDID. Uses booted simulator if not specified.")
        }
    },
    async ({ keycodes, udid }) => {
        const result = await iosKeySequence(keycodes, udid);

        return {
            content: [
                {
                    type: "text",
                    text: result.success ? result.result! : `Error: ${result.error}`
                }
            ],
            isError: !result.success
        };
    }
);

// Tool: iOS describe all (accessibility tree)
server.registerTool(
    "ios_describe_all",
    {
        description:
            "Get accessibility information for the entire iOS simulator screen. Returns a nested tree of UI elements with labels, values, and frames. Requires IDB to be installed (brew install idb-companion).",
        inputSchema: {
            udid: z.string().optional().describe("Optional simulator UDID. Uses booted simulator if not specified.")
        }
    },
    async ({ udid }) => {
        const result = await iosDescribeAll(udid);

        return {
            content: [
                {
                    type: "text",
                    text: result.success ? result.result! : `Error: ${result.error}`
                }
            ],
            isError: !result.success
        };
    }
);

// Tool: iOS describe point
server.registerTool(
    "ios_describe_point",
    {
        description:
            "Get accessibility information for the UI element at a specific point on the iOS simulator screen. Requires IDB to be installed (brew install idb-companion).",
        inputSchema: {
            x: z.coerce.number().describe("X coordinate in pixels"),
            y: z.coerce.number().describe("Y coordinate in pixels"),
            udid: z.string().optional().describe("Optional simulator UDID. Uses booted simulator if not specified.")
        }
    },
    async ({ x, y, udid }) => {
        const result = await iosDescribePoint(x, y, udid);

        return {
            content: [
                {
                    type: "text",
                    text: result.success ? result.result! : `Error: ${result.error}`
                }
            ],
            isError: !result.success
        };
    }
);

// Tool: iOS find element (no screenshot needed)
server.registerTool(
    "ios_find_element",
    {
        description:
            "Find a UI element on iOS simulator by accessibility label or value. Returns element details including tap coordinates. Requires IDB (brew install idb-companion). Workflow: 1) wait_for_element, 2) find_element, 3) tap with returned coordinates. Prefer this over screenshots for button taps.",
        inputSchema: {
            label: z.string().optional().describe("Exact accessibility label match"),
            labelContains: z.string().optional().describe("Partial label match (case-insensitive)"),
            value: z.string().optional().describe("Exact accessibility value match"),
            valueContains: z.string().optional().describe("Partial value match (case-insensitive)"),
            type: z.string().optional().describe("Element type to match (e.g., 'Button', 'TextField')"),
            index: z
                .number()
                .optional()
                .describe("If multiple elements match, select the nth one (0-indexed, default: 0)"),
            udid: z.string().optional().describe("Optional simulator UDID. Uses booted simulator if not specified.")
        }
    },
    async ({ label, labelContains, value, valueContains, type, index, udid }) => {
        const result = await iosFindElement({ label, labelContains, value, valueContains, type, index }, udid);

        if (!result.success) {
            return {
                content: [{ type: "text", text: `Error: ${result.error}` }],
                isError: true
            };
        }

        if (!result.found) {
            return {
                content: [
                    {
                        type: "text",
                        text: result.error || "Element not found"
                    }
                ]
            };
        }

        const el = result.element!;
        const info = [
            `Found element (${result.matchCount} match${result.matchCount! > 1 ? "es" : ""})`,
            `  Label: "${el.label}"`,
            `  Value: "${el.value}"`,
            `  Type: ${el.type}`,
            `  Frame: {x: ${el.frame.x}, y: ${el.frame.y}, w: ${el.frame.width}, h: ${el.frame.height}}`,
            `  Center (tap coords): (${el.center.x}, ${el.center.y})`,
            `  Enabled: ${el.enabled}`
        ].join("\n");

        return {
            content: [{ type: "text", text: info }]
        };
    }
);

// Tool: iOS wait for element
server.registerTool(
    "ios_wait_for_element",
    {
        description:
            "Wait for a UI element to appear on iOS simulator. Polls until found or timeout. Requires IDB (brew install idb-companion). Use this FIRST after navigation to ensure screen is ready, then use find_element + tap.",
        inputSchema: {
            label: z.string().optional().describe("Exact accessibility label match"),
            labelContains: z.string().optional().describe("Partial label match (case-insensitive)"),
            value: z.string().optional().describe("Exact accessibility value match"),
            valueContains: z.string().optional().describe("Partial value match (case-insensitive)"),
            type: z.string().optional().describe("Element type to match (e.g., 'Button', 'TextField')"),
            index: z
                .number()
                .optional()
                .describe("If multiple elements match, select the nth one (0-indexed, default: 0)"),
            timeoutMs: z
                .number()
                .optional()
                .default(10000)
                .describe("Maximum time to wait in milliseconds (default: 10000)"),
            pollIntervalMs: z
                .number()
                .optional()
                .default(500)
                .describe("Time between polls in milliseconds (default: 500)"),
            udid: z.string().optional().describe("Optional simulator UDID. Uses booted simulator if not specified.")
        }
    },
    async ({ label, labelContains, value, valueContains, type, index, timeoutMs, pollIntervalMs, udid }) => {
        const result = await iosWaitForElement(
            {
                label,
                labelContains,
                value,
                valueContains,
                type,
                index,
                timeoutMs,
                pollIntervalMs
            },
            udid
        );

        if (!result.success) {
            return {
                content: [{ type: "text", text: `Error: ${result.error}` }],
                isError: true
            };
        }

        if (!result.found) {
            return {
                content: [
                    {
                        type: "text",
                        text: result.timedOut
                            ? `Timed out after ${result.elapsedMs}ms - element not found`
                            : result.error || "Element not found"
                    }
                ]
            };
        }

        const el = result.element!;
        const info = [
            `Element found after ${result.elapsedMs}ms`,
            `  Label: "${el.label}"`,
            `  Value: "${el.value}"`,
            `  Type: ${el.type}`,
            `  Center (tap coords): (${el.center.x}, ${el.center.y})`,
            `  Enabled: ${el.enabled}`
        ].join("\n");

        return {
            content: [{ type: "text", text: info }]
        };
    }
);

// Tool: Get debug server info
registerToolWithTelemetry(
    "get_debug_server",
    {
        description:
            "Get the debug HTTP server URL. Use this to find where you can access logs, network requests, and other debug data via HTTP.",
        inputSchema: {}
    },
    async () => {
        const port = getDebugServerPort();

        if (!port) {
            return {
                content: [
                    {
                        type: "text",
                        text: "Debug HTTP server is not running."
                    }
                ],
                isError: true
            };
        }

        const info = {
            url: `http://localhost:${port}`,
            endpoints: {
                status: `http://localhost:${port}/api/status`,
                logs: `http://localhost:${port}/api/logs`,
                network: `http://localhost:${port}/api/network`,
                bundleErrors: `http://localhost:${port}/api/bundle-errors`,
                apps: `http://localhost:${port}/api/apps`
            }
        };

        return {
            content: [
                {
                    type: "text",
                    text: `Debug HTTP server running at:\n\n${JSON.stringify(info, null, 2)}`
                }
            ]
        };
    }
);

// Tool: Restart HTTP server (hot-reload)
registerToolWithTelemetry(
    "restart_http_server",
    {
        description:
            "Note: HTTP server now runs in-process to share state. To apply code changes, restart the MCP session.",
        inputSchema: {}
    },
    async () => {
        const port = getDebugServerPort();
        return {
            content: [
                {
                    type: "text",
                    text: `HTTP server is running in-process on port ${port}. To apply code changes, rebuild with 'npm run build' and restart the MCP session. The in-process mode is required for the dashboard to show logs, network requests, and connected apps.`
                }
            ]
        };
    }
);

// Tool: Activate Pro license
registerToolWithTelemetry(
    "activate_license",
    getActivateLicenseConfig(),
    handleActivateLicense,
);

// Tool: Delete account
registerToolWithTelemetry(
    "delete_account",
    getDeleteAccountConfig(),
    handleDeleteAccount,
);

/**
 * Auto-connect to Metro bundler on startup
 * Scans common ports and connects to any running Metro servers
 */
async function autoConnectToMetro(): Promise<void> {
    console.error("[rn-ai-debugger] Auto-scanning for Metro servers...");

    try {
        const openPorts = await scanMetroPorts();

        if (openPorts.length === 0) {
            console.error("[rn-ai-debugger] No Metro servers found on startup. Use scan_metro to connect later.");
            return;
        }

        for (const port of openPorts) {
            try {
                const devices = await fetchDevices(port);
                const mainDevice = selectMainDevice(devices);

                if (mainDevice) {
                    await connectToDevice(mainDevice, port);
                    console.error(`[rn-ai-debugger] Auto-connected to ${mainDevice.title} on port ${port}`);

                    // Also connect to Metro build events
                    try {
                        await connectMetroBuildEvents(port);
                    } catch {
                        // Build events connection is optional
                    }
                }
            } catch (error) {
                console.error(`[rn-ai-debugger] Failed to auto-connect on port ${port}: ${error}`);
            }
        }
    } catch (error) {
        console.error(`[rn-ai-debugger] Auto-connect error: ${error}`);
    }
}

// Main function
async function main() {
    // Initialize telemetry (checks opt-out env var, loads/creates installation ID)
    // License validation is lazy — runs on first tool use via ensureLicense()
    initTelemetry();

    // Start debug HTTP server in-process (shares state with MCP server)
    // Note: Child process mode doesn't work because state (logs, network, apps) isn't shared
    await startDebugHttpServer();
    console.error("[rn-ai-debugger] HTTP server started in-process");

    const useHttp = process.argv.includes("--http");
    const httpPort = parseInt(process.env.MCP_HTTP_PORT || "8600", 10);

    if (useHttp) {
        // Register dev meta-tool — proxies calls to any tool using the latest handlers
        server.registerTool(
            "dev",
            {
                description:
                    'Development meta-tool for hot-reload testing. Use action="list" to get all available tools with descriptions. ' +
                    'Use action="call" with tool and args to invoke any tool using the latest code after hot-reload. ' +
                    "This tool always reflects the latest server code without needing a session restart.",
                inputSchema: {
                    action: z.enum(["list", "call"]).describe('"list" to see all tools, "call" to invoke a tool'),
                    tool: z.string().optional().describe("Tool name to call (required when action is call)"),
                    args: z.record(z.any()).optional().describe("Arguments to pass to the tool (optional, default {})"),
                },
            },
            async ({ action, tool, args }: { action: "list" | "call"; tool?: string; args?: Record<string, any> }) => {
                if (action === "list") {
                    const tools = Array.from(toolRegistry.entries()).map(([name, { config }]) => ({
                        name,
                        description: config.description || "",
                    }));
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify(tools, null, 2) }],
                    };
                }

                if (action === "call") {
                    if (!tool) {
                        return {
                            content: [{ type: "text" as const, text: 'Error: "tool" parameter is required when action is "call"' }],
                            isError: true,
                        };
                    }
                    const entry = toolRegistry.get(tool);
                    if (!entry) {
                        return {
                            content: [{ type: "text" as const, text: `Error: Tool "${tool}" not found. Use action="list" to see available tools.` }],
                            isError: true,
                        };
                    }
                    return await entry.handler(args || {});
                }

                return {
                    content: [{ type: "text" as const, text: 'Error: action must be "list" or "call"' }],
                    isError: true,
                };
            }
        );

        // HTTP transport mode — stateless for dev hot-reload
        // Stateless = no session IDs, so server restarts don't break Claude Code's connection
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
        });

        await server.connect(transport);

        const httpServer = createHttpServer(async (req, res) => {
            const url = new URL(req.url || "", `http://localhost:${httpPort}`);

            if (url.pathname === "/mcp") {
                await transport.handleRequest(req, res);
                return;
            }

            res.writeHead(404);
            res.end("Not found");
        });

        httpServer.listen(httpPort, () => {
            console.error(`[rn-ai-debugger] MCP HTTP server listening on http://localhost:${httpPort}/mcp`);
        });
    } else {
        // Stdio transport mode — default for production
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error("[rn-ai-debugger] Server started on stdio");
    }

    // Auto-connect to Metro in background (non-blocking)
    // Use setImmediate to ensure MCP server is fully ready first
    setImmediate(() => {
        autoConnectToMetro().catch((err) => {
            console.error("[rn-ai-debugger] Auto-connect failed:", err);
        });
    });
}

main().catch((error) => {
    console.error("[rn-ai-debugger] Fatal error:", error);
    process.exit(1);
});
