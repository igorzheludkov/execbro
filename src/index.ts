#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer } from "node:http";
import { existsSync, unlinkSync } from "fs";
import { z } from "zod";

import { getGuideOverview, getGuideByTopic, getAvailableTopics, DECISION_TREE } from "./core/guides.js";
import { getLicenseStatus, getDashboardUrl, getUsageInfo, getPricingInfo, formatPlanPrice } from "./core/license.js";
import { API_BASE_URL } from "./core/config.js";
import { getPostHogClient, identifyIfDevMode, shutdownPostHog } from "./core/posthog.js";
import { UserInputError } from "./core/errors.js";
import { clearFocusedInput, dismissKeyboard, inputTextWithReplace } from "./core/focusedInputTools.js";
import { getInstallationId, getServerVersion, getPackageName, isDevMode, TELEMETRY_JSONL_PATH, categorizeError } from "./core/telemetry.js";
import { isSDKInstalled, querySDKNetwork, getSDKNetworkEntry, getSDKNetworkStats, clearSDKNetwork, querySDKConsole, getSDKConsoleStats, clearSDKConsole } from "./core/sdkBridge.js";
import { reduxDispatch, reduxGetState } from "./core/redux.js";
import { tap, convertScreenshotToTapCoords, type TapResult } from "./pro/tap.js";
import { registerAccountTools } from "./tools/accountTools.js";
import { registerMetaTools } from "./tools/metaTools.js";
import { registerReduxTools } from "./tools/reduxTools.js";
import { registerExecutionTools } from "./tools/executionTools.js";
import { registerLogTools } from "./tools/logTools.js";

import type { DeviceInfo } from "./core/index.js";
import {
    logBuffers,
    networkBuffers,
    getLogBuffer,
    getNetworkBuffer,
    getAllLogs,
    getTotalLogCount,
    getConnectedAppByDevice,
    getConnectedAppBySimulatorUdid,
    getConnectedAppByAndroidDeviceId,
    LogBuffer,
    NetworkBuffer,
    bundleErrorBuffer,
    imageBuffer,
    connectedApps,
    getActiveSimulatorUdid,
    getActiveOrBootedSimulatorUdid,
    scanMetroPorts,
    fetchDevices,
    selectMainDevice,
    filterDebuggableDevices,
    connectToDevice,
    getConnectedApps,
    executeInApp,
    listDebugGlobals,
    inspectGlobal,
    reloadApp,
    // React Component Inspection
    getComponentTree,
    getScreenLayout,
    getPressableElements,
    inspectComponent,
    findComponents,
    inspectAtPoint,
    toggleElementInspector,
    getInspectorSelection,
    getInspectorSelectionAtPoint,
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
    clearAllCDPMessageTimes,
    suppressReconnection,
    suppressReconnectionForKey,
    clearReconnectionSuppression,
    purgeStaleConnectionsForPorts,
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
    androidLongPress,
    androidSwipe,
    androidInputText,
    androidKeyEvent,
    androidGetScreenSize,
    androidGetDensity,
    androidGetStatusBarHeight,
    // iOS
    listIOSSimulators,
    iosScreenshot,
    iosInstallApp,
    iosLaunchApp,
    iosOpenUrl,
    iosTerminateApp,
    iosBootSimulator,
    // iOS UI driver tools
    isUiDriverAvailable,
    getUiDriverInstallHint,
    iosButton,
    iosInputText,
    iosDescribeAll,
    detectIOSSystemOverlay,
    formatIOSSystemOverlayWarning,
    IOS_BUTTON_TYPES,
    getDevicePixelRatio,
    getIOSSafeAreaTop,
    // Telemetry
    initTelemetry,
    trackToolInvocation,
    getTargetPlatform,
    // Format utilities (TONL)
    formatLogsAsTonl,
    formatNetworkAsTonl,
    // LogBox detection & control
    detectLogBox,
    formatLogBoxWarning,
    dismissLogBox,
    formatDismissedEntries,
    pushLogBox,
    addLogBoxIgnorePatterns,
    getLastLogBoxError,
    verifyLogPipeline,
    formatIssueBody,
    buildGitHubUrl,
    shouldShowFeedbackHint,
    markFeedbackHintShown,
    // Native-only hints — shown when Metro-required tools are called without a connection
    hasMetro,
    metroMissingHintIfAbsent,
} from "./core/index.js";
import { resolveLogBuffer, resolveNetworkBuffer } from "./core/toolHelpers.js";
import { installToolRegistryInterceptor, registerToolWithTelemetry, toolRegistry } from "./core/register.js";
export { toolRegistry };

// Create MCP server
const server = new McpServer(
    {
        name: "ExecBro (Mobile DevTools)",
        version: "1.0.0"
    },
    {
        instructions: [
            "React Native debugging MCP server.",
            "",
            DECISION_TREE,
            "",
            "Call get_usage_guide with no arguments for the same decision tree plus a summary of every guide."
        ].join("\n")
    }
);
installToolRegistryInterceptor(server);

// ============================================================================
// Telemetry Wrapper
// ============================================================================

// Banner helpers for platform-specific tool descriptions. Appended after the
// verbatim first sentence of every ios_*/android_* tool to steer agents toward
// cross-platform primaries (tap, get_screen_layout, etc) unless native-only
// behavior is required. See src/core/nativeOnlyHints.ts for the complementary
// runtime hint shown when Metro is absent.
const platformFallbackBanner = (prefer: string) =>
    `\n[PLATFORM FALLBACK — prefer ${prefer} unless you specifically need native-only behavior]`;

const platformUniqueBanner = (useCase: string) =>
    `\n[PLATFORM-SPECIFIC — no cross-platform equivalent; use when ${useCase}]`;

const primaryInteractionBanner = () =>
    `\n[PRIMARY INTERACTION TOOL — works on iOS and Android; prefer over ios_*/android_* siblings]`;



// Tool: Scan for Metro servers
registerToolWithTelemetry(
    server,
    "scan_metro",
    {
        description:
            "Scan for running Metro bundler servers and automatically connect to any found React Native apps. This is typically the FIRST tool to call when starting a debugging session - it establishes the connection needed for other tools like get_logs, list_debug_globals, execute_in_app, and reload_app.\n" +
            "PURPOSE: Discover Metro on common ports (8081, 8082, 19000-19002) and auto-connect all React Native debugger targets it advertises.\n" +
            "WHEN TO USE: At the start of any session, or after the user restarts Metro / boots a new simulator.\n" +
            "WORKFLOW: scan_metro -> get_apps -> get_logs / ios_screenshot / tap.\n" +
            "GOOD: scan_metro()\n" +
            "BAD: scan_metro() called repeatedly in a loop — use ensure_connection to re-verify an existing connection.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"setup\") for the full session-setup playbook.",
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
            const debuggable = filterDebuggableDevices(devices);
            if (debuggable.length > 0) {
                portDevices.set(port, debuggable);
            }
        }

        // Phase 1.5: Purge stale connections for scanned ports
        // When Metro restarts with a different app, device IDs change.
        // Old connections remain in connectedApps — remove them before connecting new devices.
        const purged = purgeStaleConnectionsForPorts(portDevices);

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
        if (purged.length > 0) {
            results.push(`Purged ${purged.length} stale connection(s): ${purged.join(", ")}`);
        }
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
                    const isStale = connectionResult.includes("stale CDP target");
                    const prefix = isStale ? "  - STALE" : "  -";
                    results.push(`${prefix} ${connectionResult}`);
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

        // Advisory if any CDP targets failed the liveness probe
        const staleCount = results.filter((r) => r.startsWith("  - STALE")).length;
        if (staleCount > 0) {
            results.push("");
            results.push(`Note: ${staleCount} stale CDP target(s) advertised by Metro were rejected.`);
            results.push("If you expected one of these to be live, restart Metro: the target is a leftover from a previous device/app session.");
        }

        // Proactive check: warn if iOS UI driver is missing
        const hasIosDevice = Array.from(allDeviceNames.values()).some(
            ({ device }) => {
                const title = (device.title || "").toLowerCase();
                return title.includes("iphone") || title.includes("ipad") || title.includes("ios");
            }
        );
        if (hasIosDevice) {
            const uiDriverOk = await isUiDriverAvailable();
            if (!uiDriverOk) {
                results.push("");
                results.push("⚠️  WARNING: iOS UI driver is NOT installed. The `tap` tool and other UI-interaction tools will fail.");
                results.push("   Install the default driver: brew install cameroncooke/axe/axe");
                results.push("   Alternative: brew install idb-companion (set IOS_DRIVER=idb to use it)");
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

// Tool: Ensure connection health
registerToolWithTelemetry(
    server,
    "ensure_connection",
    {
        description:
            "Verify or establish a healthy connection to a React Native app. Use before running commands if connection may be stale, or after navigation/reload. This tool runs a health check and will auto-reconnect if needed.\n" +
            "PURPOSE: Health-check the existing CDP connection and transparently reconnect if it has gone stale, without rescanning all Metro ports.\n" +
            "WHEN TO USE: After a suspected disconnect (silent gaps, reload_app, app crash) or before long-running flows where a mid-flow drop would be costly. Cheaper than scan_metro when you already connected once this session.\n" +
            "WORKFLOW: scan_metro (once) -> ensure_connection(healthCheck=true) -> resume tool calls. Use forceRefresh=true if the first probe still looks dead.\n" +
            "GOOD: ensure_connection({ healthCheck: true })\n" +
            "BAD: ensure_connection() before scan_metro has ever run — call scan_metro first.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"setup\") for the full session-setup playbook.",
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

        const infos = result.connectionInfos;
        if (infos.length === 0) {
            lines.push("(no connected devices)");
        } else {
            infos.forEach((info, idx) => {
                if (idx > 0) lines.push("");
                lines.push(`Device: ${info.deviceName} [${info.platform}]`);
                lines.push(`  Bundle: ${info.deviceTitle}`);
                lines.push(`  Port: ${info.port}`);
                lines.push(`  Uptime: ${info.uptime}`);
                if (info.contextId !== null) {
                    lines.push(`  Context ID: ${info.contextId}`);
                }
                lines.push(`  Health Check: ${info.healthCheckPassed ? "PASSED" : "FAILED"}`);
            });
        }

        lines.push("");
        lines.push(`Reconnected: ${result.wasReconnected ? "Yes" : "No"}`);

        if (infos.length > 1) {
            const healthyCount = infos.filter(i => i.healthCheckPassed).length;
            lines.push(`Overall: ${healthyCount}/${infos.length} devices healthy`);
            lines.push(`Use device="<deviceName>" to target a specific device (substring match against the Device line above).`);
        }

        if (!result.healthCheckPassed) {
            const failed = infos.filter(i => !i.healthCheckPassed).map(i => i.deviceName);
            lines.push("");
            if (failed.length > 0) {
                lines.push(`Warning: Health check failed for: ${failed.join(", ")}. The page context may be stale.`);
            } else {
                lines.push("Warning: Health check failed. The page context may be stale.");
            }
            lines.push("Consider using forceRefresh=true or reload_app to get a fresh context.");
        }

        return {
            content: [{ type: "text", text: lines.join("\n") }]
        };
    }
);

// Tool: Get connected apps
registerToolWithTelemetry(
    server,
    "get_apps",
    {
        description:
            "List currently connected React Native apps and their connection status. If no apps are connected, run scan_metro first to establish a connection.\n" +
            "PURPOSE: Enumerate active debug targets with device names, platforms, ports, and detected RN/Expo versions so you can target the right one.\n" +
            "WHEN TO USE: After scan_metro to confirm what connected, or before passing a device=\"...\" filter to another tool.\n" +
            "WORKFLOW: scan_metro -> get_apps -> get_logs / ios_screenshot / tap (with device=\"...\" if multiple).\n" +
            "LIMITATIONS: Only lists devices the MCP has successfully connected to — stale targets don't appear here, use get_connection_status for health details.\n" +
            "GOOD: get_apps()\n" +
            "BAD: Calling get_apps in a tight loop — the list doesn't change without a scan_metro or disconnect_metro.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"setup\") for the full session-setup playbook.",
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
                const lines = [`  ${i + 1}. ${name} — ${appId} (${app.platform}, port ${app.port})`];
                if (app.appDetection) {
                    const d = app.appDetection;
                    const version = d.reactNativeVersion !== "unknown" ? `RN ${d.reactNativeVersion}` : "RN unknown";
                    const expo = d.expoSdkVersion ? `, Expo SDK ${d.expoSdkVersion}` : "";
                    lines.push(`     Environment: ${version}, ${d.architecture} arch, ${d.jsEngine}, ${app.platform} ${d.osVersion}${expo}`);
                }
                return lines.join("\n");
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

// Tool: Unified tap — tries fiber, accessibility, OCR, coordinate strategies
registerToolWithTelemetry(
    server,
    "tap",
    {
        description:
            "Tap a UI element. Automatically tries multiple strategies: fiber tree (React), accessibility tree (native), and OCR (visual)." +
            primaryInteractionBanner() + "\n" +
            "PURPOSE: Single unified tap entry point — resolves text/testID/component/coordinates into a real touch event on the correct device.\n" +
            "WHEN TO USE: Any time you need to press a button, focus an input, open a menu, or verify a handler fires. Prefer testID, then text, then component, then (x,y) from a screenshot's pressables list.\n" +
            "WORKFLOW: ios_screenshot or android_screenshot -> tap(testID=\"...\") | tap(text=\"...\") | tap(x, y) -> screenshot again to verify. Use burst=true when meaningful=false but visual feedback looks transient.\n" +
            "LIMITATIONS: iOS needs AXe (brew install cameroncooke/axe/axe) or IDB for accessibility/coordinate taps. Non-ASCII text skips fiber (Hermes); prefer testID. When iOS AND Android are connected, pass platform explicitly.\n" +
            "GOOD: tap({ testID: \"login-btn\" }); tap({ text: \"Submit\" }); tap({ x: 300, y: 600 }); tap({ x: 300, y: 600, native: true, platform: \"android\" })\n" +
            "BAD: tap({ text: \"\" }) or tap({ x: 0, y: 0 }) — missing a target. tap({ text: \"Submit\" }) without first screenshotting an ambiguous screen.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"interact\") for the full device-interaction playbook.",
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
            device: z
                .string()
                .optional()
                .describe(
                    "Target device name (substring match against the connected RN app's device name). " +
                    "Use to pin the tap to a specific device when multiple are connected (e.g. \"iPhone SE\"). " +
                    "Run get_apps to see connected device names. For iOS, the matched device's simulatorUdid is used to scope the tap."
                ),
            udid: z
                .string()
                .optional()
                .describe(
                    "iOS simulator UDID (from list_ios_simulators). Takes precedence over device/platform when set. " +
                    "iOS-only — pairing with platform=\"android\" returns an error."
                ),
            screenshot: z
                .boolean()
                .optional()
                .default(true)
                .describe(
                    "Return post-tap image bytes in the response. Default true. Set to false to drop the PNG bytes — verification still runs (set verify=false to skip that too). Combine with verify=true to get the meaningful/changeRate signal without paying the ~1MB-per-tap bandwidth cost."
                ),
            verify: z
                .boolean()
                .optional()
                .describe(
                    "Run before/after screenshot diff to detect if the tap had a meaningful visual effect. " +
                    "Default: true for coordinate/accessibility/ocr strategies, false for fiber. " +
                    "Independent of `screenshot` — verify can run with screenshot=false (the diff is computed internally; image bytes are dropped). " +
                    "When skipped, the response contains `verification: { skipped: true, skippedReason }` so callers can tell apart \"ran clean\" from \"never ran\"."
                ),
            burst: z
                .boolean()
                .optional()
                .default(false)
                .describe(
                    "Enable burst screenshot capture for enhanced verification. " +
                    "Captures 4 rapid screenshots (~150ms intervals) after the tap to detect transient visual feedback " +
                    "(press animations, highlights, ripples) that may settle before a standard after-screenshot. " +
                    "Results are stored in the image buffer (use get_images to inspect individual frames). " +
                    "Default: false."
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
            device: args.device,
            udid: args.udid,
            screenshot: args.screenshot,
            verify: args.verify,
            burst: args.burst,
        });

        const { screenshot: screenshotData, ...resultWithoutScreenshot } = result;
        const text = JSON.stringify(resultWithoutScreenshot, null, 2);
        // Pack predicate + strategy mode + attempted strategies into errorContext for telemetry.
        // Always include the predicate so unmeaningful outcomes (no isError, no _errorMessage) still
        // carry triage context — otherwise blob8 ends up blank and the dashboard shows empty rows.
        // e.g. "p={\"text\":\"Save\"}|s=ocr|fiber:no_pressable|ocr:no_match"
        const stratPrefix = args.strategy && args.strategy !== "auto" ? `s=${args.strategy}|` : "";
        let predicatePrefix = "";
        try {
            if (result.query !== undefined) {
                predicatePrefix = `p=${JSON.stringify(result.query)}|`;
            }
        } catch {
            // query may contain non-serializable values — drop the prefix rather than fail.
        }
        const attemptedPart = result.attempted?.length
            ? result.attempted.map(a => `${a.strategy}:${a.reason.slice(0, 40)}`).join("|")
            : "";
        const ctxParts = `${predicatePrefix}${stratPrefix}${attemptedPart}`;
        const errorContext = ctxParts ? ctxParts.replace(/\|$/, "") : undefined;

        const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
            { type: "text" as const, text },
        ];

        if (screenshotData) {
            content.push({
                type: "image" as const,
                data: screenshotData.image,
                mimeType: "image/jpeg",
            });
        }

        return {
            content,
            isError: !result.success && !result.ambiguous,
            _errorMessage: !result.success && !result.ambiguous
                ? `${JSON.stringify(result.query)}|${result.error || ""}`
                : undefined,
            _errorContext: errorContext,
            _meaningful: result.verification?.meaningful,
            _changeRate: result.verification?.changeRate,
            _tapStrategy: result.method,
            _iosDriver: result.platform === "ios" ? (process.env.IOS_DRIVER?.toLowerCase() || "axe") : undefined,
            _artifactKey: result.artifactKey,
            _ocrClosestMatch: result.ocrClosestMatch,
            _fiberPressableCount: result.fiberPressableCount,
            _accessibilityMatchCount: result.accessibilityMatchCount,
            _appRoute: result.appRoute,
        };
    }
);

// Tool: Get full screen layout (all components with layout styles)
registerToolWithTelemetry(
    server,
    "get_screen_layout",
    {
        description:
            "Get a screen map showing visible components as an indented tree with actual screen positions. Uses measureInWindow for real coordinates and filters out off-screen components. Returns meaningful component names with text content and frame data (x,y width x height). Coordinates are in **points** (iOS) or **dp** (Android) — NOT screenshot pixels. Use tap(text=...) or tap(testID=...) to interact with discovered components. Use extended=true to include layout styles (padding, margin, flex, backgroundColor, etc.)." +
            primaryInteractionBanner() + "\n" +
            "PURPOSE: Quickest textual map of what is actually on screen right now — component names, positions, and text — so you can plan taps and inspections without guessing.\n" +
            "WHEN TO USE: First step whenever the user asks \"what's on screen\", \"why is X covering Y\", or before tapping a visually ambiguous element.\n" +
            "WORKFLOW: get_screen_layout -> find_components(pattern=\"...\") or inspect_component(componentName=\"...\") -> tap(testID=...) -> get_screen_layout again to confirm.\n" +
            "LIMITATIONS: Coordinates are points/dp, not screenshot pixels — pass them to tap() which handles conversion, do not multiply by devicePixelRatio yourself.\n" +
            "GOOD: get_screen_layout({ extended: true })\n" +
            "BAD: get_screen_layout({ summary: true }) when you actually need to pick a specific element — summary hides the tree.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"layout\") for the full layout-check playbook.",
        inputSchema: {
            extended: z
                .boolean()
                .optional()
                .default(false)
                .describe("Include layout styles (padding, margin, flex, backgroundColor, borderRadius, etc.) for each component. Default: false for compact output."),
            summary: z
                .boolean()
                .optional()
                .default(false)
                .describe("Return only component counts by name instead of full tree (default: false)"),
            device: z.string().optional().describe("Target device name (substring match). Omit for default device. Run get_apps to see connected devices.")
        }
    },
    async ({ extended, summary, device }) => {
        if (!hasMetro()) {
            const hint = await metroMissingHintIfAbsent("get_screen_layout");
            return {
                content: [{ type: "text", text: `Screen Layout unavailable.${hint}` }],
                isError: true
            };
        }

        const result = await getScreenLayout({ extended, summary, device });

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


// Tool: iOS screenshot
registerToolWithTelemetry(
    server,
    "ios_screenshot",
    {
        description: "Take a screenshot from an iOS simulator. Returns the image plus two lists: (1) pressable elements — the tappable components on screen with ready-to-use pixel tap coordinates, testIDs, and labels; (2) screen layout — all visible React components for context. Prefer tap(text=\"...\") when text is exact and unique; otherwise use tap(x, y) with coordinates from the pressables list — this is the most reliable way to tap icons or visually-identified elements. Use component names from the layout for inspect_component/find_components.\n" +
            "PURPOSE: Snapshot what the user sees on iOS AND get tap-ready pressables + a structured component map in one call.\n" +
            "WHEN TO USE: Any visual verification, before/after comparison, or as the starting point for tapping UI by coordinates.\n" +
            "WORKFLOW: ios_screenshot -> pick element from pressables -> tap(x, y) or tap(testID=...) -> ios_screenshot to verify.\n" +
            "LIMITATIONS: Requires a booted iOS simulator (simctl). For physical devices or system dialogs without RN, combine with tap(..., native=true).\n" +
            "GOOD: ios_screenshot()\n" +
            "BAD: ios_screenshot({ udid: \"guess\" }) with a made-up UDID — run list_ios_simulators first.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"interact\") for the full device-interaction playbook.",
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

            // Resolve the RN app running on THIS simulator so enrichment pulls
            // fiber/layout data from the right app (not the first-connected one,
            // which may belong to a different simulator).
            const resolvedUdid = udid || (await getActiveOrBootedSimulatorUdid());
            const targetApp = resolvedUdid ? getConnectedAppBySimulatorUdid(resolvedUdid) : null;
            const targetDeviceName = targetApp?.deviceInfo.deviceName;

            // Store screenshot metadata on the matching app (not an arbitrary one)
            if (targetApp) {
                targetApp.lastScreenshot = {
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

            // The Screen Layout tree was previously appended here but produced huge noisy
            // output (nested Svg/G/Path duplicates). Agents should use get_screen_layout
            // explicitly when they need the tree. The Pressable elements block below is
            // the signal most consumers actually want.
            let pressablesText: string | null = null;

            // Enrich with pressable elements. With targetApp present we use the
            // fiber path (most accurate). Without targetApp, getPressableElements
            // falls back to iOS accessibility tree (E1) when we pass platform.
            try {
                const pressables = await getPressableElements({
                    device: targetDeviceName,
                    platform: "ios",
                    udid: resolvedUdid ?? undefined
                });
                if (pressables.success && pressables.parsedElements && pressables.parsedElements.length > 0) {
                    const screenshotScale = result.scaleFactor || 1;
                    pressablesText = pressables.parsedElements.map((el) => {
                        // See enrichScreenshotWithLayout: shift y when fiber reports the element
                        // inside the safe-area band (a react-native-screens modal artifact).
                        let centerYPoints = el.center.y;
                        if (safeAreaTop > 0 && centerYPoints < safeAreaTop) {
                            centerYPoints += safeAreaTop;
                        }
                        const px = Math.round((el.center.x * scaleFactor) / screenshotScale);
                        const py = Math.round((centerYPoints * scaleFactor) / screenshotScale);
                        const label = el.accessibilityLabel || el.text || el.testID || (el.intent ? `${el.intent} icon` : el.component);
                        const idPart = el.testID ? ` testID="${el.testID}"` : "";
                        const kindPart = el.isInput ? " [input]" : "";
                        const wrapPart = el.isWrapper ? " [wrapper — skip]" : "";
                        const nearPart = !el.text && !el.accessibilityLabel && el.nearbyText ? ` near "${el.nearbyText}"` : "";
                        return `  (${px}, ${py}) ${el.component}: "${label}"${nearPart}${idPart}${kindPart}${wrapPart}`;
                    }).join("\n");
                }
            } catch {
                // Non-fatal: screenshot works without pressables enrichment
            }

            let infoText = `Screenshot captured (${pixelWidth}x${pixelHeight} pixels)`;
            infoText += `\n📱 iOS screen: ${pointWidth}x${pointHeight} points (${scaleFactor}x scale)`;
            infoText += `\n📐 tap() handles pixel-to-point conversion automatically — pass pixel coords from this image directly`;
            infoText += `\n⚠️ Status bar + safe area: ${safeAreaTop} points (${safeAreaOffsetPixels} pixels) from top`;
            if (result.scaleFactor && result.scaleFactor > 1) {
                infoText += `\n🖼️ Image was scaled down to fit API limits (scale: ${result.scaleFactor.toFixed(3)})`;
            }
            if (pressablesText) {
                infoText += `\n\n🎯 Pressable elements (ready-to-tap, coordinates in screenshot pixels):`;
                infoText += `\n${pressablesText}`;
                infoText += `\n\n💡 Next steps:`;
                infoText += `\n  • tap(text="Button Label") — when text is exact and unique`;
                infoText += `\n  • tap(testID="id") or tap(component="Name") — when you know the identifier`;
                infoText += `\n  • tap(x=<px>, y=<px>) — use coordinates from the pressable elements list above (reliable for icons and ambiguous elements)`;
                infoText += `\n  • get_screen_layout — full component tree when you need more than pressables`;
            } else {
                if (!targetApp && connectedApps.size > 0) {
                    infoText += `\n\nℹ️ Pressable enrichment skipped: no RN app is connected to simulator ${resolvedUdid}.`;
                    infoText += ` ${connectedApps.size} other app(s) are connected on different device(s) — their fiber data was intentionally not used to avoid mismatched output.`;
                }
                infoText += `\n\n💡 Next steps:`;
                infoText += `\n  • tap(text="Button Label") — tap element by visible text`;
                infoText += `\n  • tap(x=<px>, y=<px>) — tap at coordinates from this screenshot`;
                infoText += `\n  • get_screen_layout — get full UI tree with real on-screen positions`;
            }

            // Check for LogBox overlay — only on the matching RN app; skip otherwise
            // to avoid surfacing warnings from a different simulator's app.
            if (targetApp) {
                try {
                    const logBoxState = await detectLogBox(targetDeviceName);
                    if (logBoxState && logBoxState.total > 0) {
                        infoText += formatLogBoxWarning(logBoxState);
                    }
                } catch {
                    // Non-fatal: LogBox detection failure should not break screenshot
                }
            }

            // I1 (2026-05-16): detect native iOS system overlays (auth sheets, alerts,
            // permission dialogs) that sit on top of the RN app. The pressables list
            // reflects the RN screen underneath; without this warning the agent will
            // happily tap inert RN buttons and loop. Runs whether or not there's a
            // matching RN app — the overlay belongs to the simulator, not the app.
            try {
                const overlay = await detectIOSSystemOverlay(resolvedUdid ?? undefined);
                if (overlay) {
                    infoText += formatIOSSystemOverlayWarning(overlay);
                }
            } catch {
                // Non-fatal: overlay detection failure should not break screenshot
            }

            imageBuffer.add({
                id: `ios-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                image: result.data,
                timestamp: Date.now(),
                source: "ios_screenshot",
                metadata: {
                    width: result.originalWidth || 0,
                    height: result.originalHeight || 0,
                    scaleFactor: result.scaleFactor || 1,
                    platform: "ios",
                },
            });

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

// Tool: Android screenshot
registerToolWithTelemetry(
    server,
    "android_screenshot",
    {
        description: "Take a screenshot from an Android device/emulator. Returns the image plus two lists: (1) pressable elements — the tappable components on screen with ready-to-use pixel tap coordinates, testIDs, and labels; (2) screen layout — all visible React components for context. Prefer tap(text=\"...\") when text is exact and unique; otherwise use tap(x, y) with coordinates from the pressables list — this is the most reliable way to tap icons or visually-identified elements. Use component names from the layout for inspect_component/find_components.\n" +
            "PURPOSE: Snapshot what the user sees on Android AND get tap-ready pressables + a structured component map in one call.\n" +
            "WHEN TO USE: Any visual verification, before/after comparison, or as the starting point for tapping UI by coordinates on Android.\n" +
            "WORKFLOW: android_screenshot -> pick element from pressables -> tap(x, y) or tap(testID=...) -> android_screenshot to verify.\n" +
            "LIMITATIONS: Requires adb in PATH and a running device/emulator. For non-RN surfaces (system dialogs, permission prompts), combine with tap(..., native=true).\n" +
            "GOOD: android_screenshot()\n" +
            "BAD: android_screenshot({ deviceId: \"guess\" }) with a made-up serial — run list_android_devices first.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"interact\") for the full device-interaction playbook.",
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

            // Resolve the RN app running on THIS Android device so enrichment
            // pulls data from the right app (not whichever app is "first").
            const targetApp = getConnectedAppByAndroidDeviceId(deviceId);
            const targetDeviceName = targetApp?.deviceInfo.deviceName;

            // Store screenshot metadata on the matching app (not an arbitrary one)
            if (targetApp) {
                targetApp.lastScreenshot = {
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

            // Enrich with screen layout data (component names + tap coordinates).
            // On Bridgeless/Fabric Android (the only target architecture we support;
            // legacy arch is <5% of users and not a priority), both code paths that
            // feed this enrichment return DEVICE PIXELS:
            //   - fiber path: React's measureInWindow on Fabric returns native pixels.
            //   - a11y fallback: uiautomator's bounds are already device pixels.
            // The earlier formula multiplied by densityDpi/160 on the (incorrect)
            // assumption that fiber returned DP — inflating every coordinate by
            // ~2.6× on a 420dpi emulator and producing numbers like (1170, 4054)
            // for a button visually sitting near (445, 1370) in the JPEG. Drop the
            // density factor; only the scaleFactor downscale is needed.
            let pressablesText: string | null = null;
            // Screen Layout tree previously appended here was dropped — it was noisy
            // (nested Svg/G/Path duplicates). Use get_screen_layout when the tree is needed.

            // Enrich with pressable elements. With targetApp present we use the
            // fiber path (most accurate). Without targetApp, getPressableElements
            // falls back to the Android accessibility (uiautomator) tree (E1).
            try {
                const pressables = await getPressableElements({ device: targetDeviceName, platform: "android" });
                if (pressables.success && pressables.parsedElements && pressables.parsedElements.length > 0) {
                    const screenshotScale = result.scaleFactor || 1;
                    pressablesText = pressables.parsedElements.map((el) => {
                        const px = Math.round(el.center.x / screenshotScale);
                        const py = Math.round(el.center.y / screenshotScale);
                        const label = el.accessibilityLabel || el.text || el.testID || (el.intent ? `${el.intent} icon` : el.component);
                        const idPart = el.testID ? ` testID="${el.testID}"` : "";
                        const kindPart = el.isInput ? " [input]" : "";
                        const wrapPart = el.isWrapper ? " [wrapper — skip]" : "";
                        const nearPart = !el.text && !el.accessibilityLabel && el.nearbyText ? ` near "${el.nearbyText}"` : "";
                        return `  (${px}, ${py}) ${el.component}: "${label}"${nearPart}${idPart}${kindPart}${wrapPart}`;
                    }).join("\n");
                }
            } catch {
                // Non-fatal: screenshot works without pressables enrichment
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
            if (pressablesText) {
                infoText += `\n\n🎯 Pressable elements (ready-to-tap, coordinates in screenshot pixels):`;
                infoText += `\n${pressablesText}`;
                infoText += `\n\n💡 Next steps:`;
                infoText += `\n  • tap(text="Button Label") — when text is exact and unique`;
                infoText += `\n  • tap(testID="id") or tap(component="Name") — when you know the identifier`;
                infoText += `\n  • tap(x=<px>, y=<px>) — use coordinates from the pressable elements list above (reliable for icons and ambiguous elements)`;
                infoText += `\n  • get_screen_layout — full component tree when you need more than pressables`;
            } else {
                if (!targetApp && connectedApps.size > 0) {
                    infoText += `\n\nℹ️ Pressable enrichment skipped: no RN app is connected to device ${deviceId ?? "(default)"}.`;
                    infoText += ` ${connectedApps.size} other app(s) are connected on different device(s) — their fiber data was intentionally not used to avoid mismatched output.`;
                }
                infoText += `\n\n💡 Next steps:`;
                infoText += `\n  • tap(text="Button Label") — tap element by visible text`;
                infoText += `\n  • tap(x=<px>, y=<px>) — tap at coordinates from this screenshot`;
                infoText += `\n  • get_screen_layout — get full UI tree with real on-screen positions`;
            }

            // Check for LogBox overlay — only on the matching RN app; skip otherwise
            // to avoid surfacing warnings from a different device's app.
            if (targetApp) {
                try {
                    const logBoxState = await detectLogBox(targetDeviceName);
                    if (logBoxState && logBoxState.total > 0) {
                        infoText += formatLogBoxWarning(logBoxState);
                    }
                } catch {
                    // Non-fatal: LogBox detection failure should not break screenshot
                }
            }

            imageBuffer.add({
                id: `android-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                image: result.data,
                timestamp: Date.now(),
                source: "android_screenshot",
                metadata: {
                    width: result.originalWidth || 0,
                    height: result.originalHeight || 0,
                    scaleFactor: result.scaleFactor || 1,
                    platform: "android",
                },
            });

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

// Tool: Get connection status (detailed health and gap tracking)
registerToolWithTelemetry(
    server,
    "get_connection_status",
    {
        description:
            "Get detailed connection health status including uptime, recent disconnects/reconnects, and connection gaps that may indicate missing data.\n" +
            "PURPOSE: Diagnose flaky CDP sessions — quantify uptime, count reconnects, and expose gaps where logs/network data could be missing.\n" +
            "WHEN TO USE: When logs look suspiciously empty, tools complain about disconnect/reconnect, or the app was suspended and resumed.\n" +
            "WORKFLOW: get_connection_status -> if unhealthy: disconnect_metro -> scan_metro to rebuild a clean session.\n" +
            "LIMITATIONS: Reports only MCP-side view; doesn't know why Metro dropped the socket (simulator sleep, app backgrounded, etc).\n" +
            "GOOD: get_connection_status() after noticing stale data.\n" +
            "BAD: Polling get_connection_status as a heartbeat — use ensure_connection(healthCheck=true) for a live probe.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"setup\") for the full session-setup playbook.",
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




// Tool: Connect to specific Metro port
registerToolWithTelemetry(
    server,
    "connect_metro",
    {
        description:
            "Connect to a Metro server on a specific port.\n" +
            "[DEPRECATED IN PRACTICE — prefer `scan_metro` which auto-discovers all common ports and connects every Bridgeless target at once. Use `connect_metro` only when you need to target a specific non-default port]\n" +
            "PURPOSE: Establish a CDP WebSocket connection to a single Metro server on a known, non-default port.\n" +
            "WHEN TO USE: Only when the Metro bundler is running on a port outside the common 8081/8082/19000-19002 range that `scan_metro` already covers — otherwise always prefer `scan_metro`.\n" +
            "SEE ALSO: call scan_metro for auto-discovery; call get_apps afterwards to confirm the device attached.",
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
    server,
    "disconnect_metro",
    {
        description:
            "Disconnect from Metro servers and stop auto-reconnection. Without device param: disconnects ALL devices. With device param: disconnects only the matching device. Use this to remove stale connections or free the CDP slot for the built-in debugger. Log and network buffers are preserved. Reconnect later with scan_metro.\n" +
            "PURPOSE: Cleanly release CDP slots so another debugger (Flipper, React DevTools, Chrome) can attach, or nuke a stale connection the MCP keeps reviving.\n" +
            "WHEN TO USE: Before launching a native debugger, when connections keep flapping, or after a simulator/device restart left zombie targets.\n" +
            "WORKFLOW: disconnect_metro -> attach other debugger / restart app -> scan_metro to reconnect.\n" +
            "LIMITATIONS: Suppresses auto-reconnect until scan_metro or connect_metro is called again; buffers persist but won't receive new events.\n" +
            "GOOD: disconnect_metro(); disconnect_metro({ device: \"iPhone\" })\n" +
            "BAD: Using disconnect_metro to clear logs — use clear_logs instead; disconnect breaks capture.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"setup\") for the full session-setup playbook.",
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
        clearAllCDPMessageTimes();

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



// ============================================================================
// React Component Inspection Tools
// ============================================================================

// Tool: Get the React component tree
registerToolWithTelemetry(
    server,
    "get_component_tree",
    {
        description:
            "Get the full React component tree from the running app. Shows the complete fiber hierarchy including providers, navigation wrappers, and internal components. For a screen overview with positions and text, use get_screen_layout instead. Use structureOnly=true for compact names-only output.\n" +
            "PURPOSE: Expose the entire fiber tree — including providers, navigators, and off-screen subtrees — when get_screen_layout's visible-only view isn't enough.\n" +
            "WHEN TO USE: Debugging context propagation, navigation wrappers, hidden modals, or when you need to understand the full React architecture.\n" +
            "WORKFLOW: get_component_tree(structureOnly=true) for overview -> find_components for targeted lookup -> inspect_component for props/state.\n" +
            "LIMITATIONS: Full trees can be large; always start with structureOnly=true. Ignores non-React native views. Minified builds return display names that may be opaque.\n" +
            "GOOD: get_component_tree({ structureOnly: true })\n" +
            "BAD: get_component_tree({ includeProps: true, includeStyles: true }) on a large app — likely hits response-size limits. Prefer inspect_component for specific nodes.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"inspect\") for the full component-inspect playbook.",
        inputSchema: {
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
                    "Maximum tree depth (default: 5000)"
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
    async ({ structureOnly, maxDepth, includeProps, includeStyles, hideInternals, format, device }) => {
        const result = await getComponentTree({
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

// Tool: Get all pressable elements on screen
registerToolWithTelemetry(
    server,
    "get_pressable_elements",
    {
        description:
            "Find all pressable (onPress) and input (TextInput) elements currently visible on screen. Returns component names, ready-to-tap center coordinates in SCREENSHOT PIXELS (same space as ios_screenshot/android_screenshot — pass directly to tap(x, y)), text labels, testID, accessibilityLabel, and a spatial nearbyText hint for icon-only buttons. Each element includes hasLabel (true if it contains text) and isInput (true for TextInput fields).\n" +
            "HELPER — call before `tap` when you need to enumerate candidate elements before committing to a target; not a replacement for tap itself.\n" +
            "PURPOSE: Produce a ready-to-tap inventory of every interactive element on screen with screenshot-pixel coordinates that tap(x, y) accepts directly.\n" +
            "WHEN TO USE: Before tapping icon-only buttons, when text-based tap keeps failing, or to enumerate what the user can actually interact with.\n" +
            "WORKFLOW: ios_screenshot / android_screenshot -> get_pressable_elements -> tap(testID=\"...\") or tap(x, y) using the center coordinates.\n" +
            "LIMITATIONS: Visible-only (off-screen pressables are excluded). Requires a live React connection. Coordinates are in screenshot pixels — the tap tool converts to points internally.\n" +
            "GOOD: get_pressable_elements()\n" +
            "BAD: Calling when tap(testID=\"...\") already works — testID matching is faster and more stable.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"interact\") for the full interaction playbook.",
        inputSchema: {
            device: z.string().optional().describe("Target device name (substring match). Omit for default device. Run get_apps to see connected devices.")
        }
    },
    async ({ device }) => {
        const result = await getPressableElements({ device });

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

        const elements = result.parsedElements;
        if (!elements || elements.length === 0) {
            return {
                content: [{ type: "text", text: result.result || "No pressable elements found." }]
            };
        }

        // Resolve target app so we can pick the right simulator / android device
        const targetApp = device ? getConnectedAppByDevice(device) : getFirstConnectedApp();
        if (!targetApp) {
            // No connected app — return raw (points) output; better than nothing
            return {
                content: [{ type: "text", text: result.result || "No pressable elements found." }]
            };
        }

        // Capture a lightweight screenshot to learn scaleFactor (downscale) and dimensions.
        // Conversion: screenshot_px = native_coord * devicePixelRatio / screenshotScale
        let lines: string[] = [];
        try {
            if (targetApp.platform === "ios") {
                const udid = targetApp.simulatorUdid;
                const shot = await iosScreenshot(undefined, udid);
                const screenshotScale = shot.scaleFactor || 1;
                const devicePixelRatio =
                    (shot.originalWidth && shot.originalHeight
                        ? inferIOSDevicePixelRatio(shot.originalWidth, shot.originalHeight)
                        : null) ?? (await getDevicePixelRatio(udid)) ?? 3;
                // Fallback to 59pt (iPhone typical) when the UI driver preflight can't
                // resolve the true inset — matches ios_screenshot's default. Without this
                // shift, react-native-screens modal-presented screens report y relative
                // to content origin and taps land in the status bar instead of the button.
                const safeAreaTop = (await getIOSSafeAreaTop(udid).catch(() => 0)) || 59;
                // Keep the app's lastScreenshot metadata in sync so tap(x, y) uses the
                // same scaleFactor when converting our pixel coords back to points.
                if (shot.originalWidth && shot.originalHeight) {
                    targetApp.lastScreenshot = {
                        originalWidth: shot.originalWidth,
                        originalHeight: shot.originalHeight,
                        scaleFactor: screenshotScale
                    };
                }
                lines = formatPressablesInPixels(elements, {
                    platform: "ios",
                    devicePixelRatio,
                    screenshotScale,
                    safeAreaTop
                });
            } else {
                // Metro's `deviceName` is the device model (e.g. "sdk_gphone16k_arm64"),
                // not the adb serial (e.g. "emulator-5554"), so passing it as -s makes
                // adb miss the device and androidScreenshot/androidGetDensity silently
                // return defaults (scale=1, density=160). That leaves coords in raw
                // device pixels — off by ~1.2× from the screenshot/JPEG space the tool
                // description promises. Pass undefined to let adb auto-pick (matches
                // how android_screenshot works when called without deviceId). Multi-
                // Android-device support tracks separately under the multi-device
                // refactor; this path is a single-Android-device fix.
                const shot = await androidScreenshot(undefined, undefined);
                const screenshotScale = shot.scaleFactor || 1;
                const density = await androidGetDensity(undefined).catch(() => ({ density: 160 }));
                const devicePixelRatio = (density.density || 160) / 160;
                if (shot.originalWidth && shot.originalHeight) {
                    targetApp.lastScreenshot = {
                        originalWidth: shot.originalWidth,
                        originalHeight: shot.originalHeight,
                        scaleFactor: screenshotScale
                    };
                }
                lines = formatPressablesInPixels(elements, {
                    platform: "android",
                    devicePixelRatio,
                    screenshotScale,
                    safeAreaTop: 0
                });
            }
        } catch {
            // Fallback to points if screenshot/metadata unavailable
            return {
                content: [{ type: "text", text: result.result || "No pressable elements found." }]
            };
        }

        const iconCount = elements.filter((e) => !e.hasLabel).length;
        const labeledCount = elements.length - iconCount;
        const summary = `Found ${elements.length} pressable elements (${iconCount} icon-only, ${labeledCount} with text labels)`;
        const text = [summary, "", ...lines].join("\n");

        return {
            content: [{ type: "text", text }]
        };
    }
);

function formatPressablesInPixels(
    elements: NonNullable<Awaited<ReturnType<typeof getPressableElements>>["parsedElements"]>,
    opts: {
        platform: "ios" | "android";
        devicePixelRatio: number;
        screenshotScale: number;
        safeAreaTop: number;
    }
): string[] {
    const { platform, devicePixelRatio, screenshotScale, safeAreaTop } = opts;
    const out: string[] = [];
    for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        // react-native-screens modal presentations report y relative to content origin;
        // shift into the window frame when the measurement falls inside the safe-area band.
        let cy = el.center.y;
        let fy = el.frame.y;
        if (platform === "ios" && safeAreaTop > 0) {
            if (cy < safeAreaTop) cy += safeAreaTop;
            if (fy < safeAreaTop) fy += safeAreaTop;
        }
        // iOS: fiber returns points → convert points × DPR / screenshotScale = JPEG px.
        // Android: getPressableElements reconciles fiber DP against uiautomator device-pixel
        // bounds (executor.ts, 2026-05-17). After reconciliation, coords are already in
        // device pixels — only the JPEG downscale needs to be applied. Multiplying by DPR
        // here would re-inflate them by ~density/160 (~2.6× on a 420dpi device), reproducing
        // the original out-of-bounds bug.
        const toPx = (v: number) =>
            platform === "android"
                ? Math.round(v / screenshotScale)
                : Math.round((v * devicePixelRatio) / screenshotScale);
        const cx = toPx(el.center.x);
        const cyPx = toPx(cy);
        const fx = toPx(el.frame.x);
        const fyPx = toPx(fy);
        const fw = toPx(el.frame.width);
        const fh = toPx(el.frame.height);

        const num = i + 1;
        const label = el.hasLabel
            ? `"${el.text}"`
            : el.intent
              ? `(${el.intent} icon)`
              : "(icon/image)";
        const ids: string[] = [];
        if (el.testID) ids.push(`testID="${el.testID}"`);
        if (el.accessibilityLabel) ids.push(`a11y="${el.accessibilityLabel}"`);
        const idStr = ids.length > 0 ? ` [${ids.join(", ")}]` : "";
        const inputStr = el.isInput ? " (input)" : "";
        const wrapperStr = el.isWrapper ? " [wrapper — skip unless dismissing keyboard]" : "";
        const nearPart = el.nearbyText ? ` near "${el.nearbyText}"` : "";
        out.push(
            `${num}. ${el.component} ${label}${nearPart} — center:(${cx},${cyPx}) frame:(${fx},${fyPx} ${fw}x${fh})${idStr}${inputStr}${wrapperStr}`
        );
        if (el.path) out.push(`   path: ${el.path}`);
    }
    return out;
}

// Tool: Inspect a specific component by name
registerToolWithTelemetry(
    server,
    "inspect_component",
    {
        description:
            "Inspect a specific React component by name. **DRILL-DOWN TOOL**: Use after get_screen_layout or find_components to identify which component to inspect. Returns props, style, state (hooks), and optionally children tree. Use childrenDepth to control how deep nested children go." +
            primaryInteractionBanner() + "\n" +
            "PURPOSE: Reveal a mounted component's live props, hook state, and (optionally) child subtree so you can reason about why it renders the way it does.\n" +
            "WHEN TO USE: User asks \"why is this button disabled\", \"what props does X receive\", or you need to confirm state changed after a tap.\n" +
            "WORKFLOW: get_screen_layout or find_components -> inspect_component(componentName=\"Foo\") -> tap or execute_in_app to change state -> inspect_component again.\n" +
            "LIMITATIONS: Requires the component to be currently mounted in the fiber tree. Name matching is exact; use find_components for fuzzy/regex lookup.\n" +
            "GOOD: inspect_component({ componentName: \"SneakerCard\", index: 0 })\n" +
            "BAD: inspect_component({ componentName: \"Card\" }) when many Card instances exist — pass index or narrow via find_components.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"inspect\") for the full component-inspect playbook.",
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
    server,
    "find_components",
    {
        description:
            "Find components matching a name pattern. **TARGETED SEARCH**: Use after get_screen_layout or get_component_tree(structureOnly=true) to find specific components by pattern. Use includeLayout=true to get padding/margin/flex styles." +
            primaryInteractionBanner() + "\n" +
            "PURPOSE: Fast regex search over the entire fiber tree — including off-screen and wrapper components — to locate every instance of a component by name.\n" +
            "WHEN TO USE: You know roughly what the component is called (e.g., \"Button\", \"Screen$\") but not where it lives, or you need counts/paths before drilling in with inspect_component.\n" +
            "WORKFLOW: get_screen_layout (orient) -> find_components(pattern=\"...\") -> inspect_component(componentName=\"...\", index=N).\n" +
            "LIMITATIONS: Matches the React display name only; minified builds may return opaque names. Large result sets — use maxResults or a tighter pattern.\n" +
            "GOOD: find_components({ pattern: \"Button\" }); find_components({ pattern: \"Screen$\" })\n" +
            "BAD: find_components({ pattern: \".*\" }) — floods the response; narrow the regex.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"inspect\") for the full component-inspect playbook.",
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

// Tool: Toggle Element Inspector programmatically
registerToolWithTelemetry(
    server,
    "toggle_element_inspector",
    {
        description:
            "Toggle React Native's Element Inspector overlay on/off. Rarely needed directly — get_inspector_selection auto-toggles the overlay on for capture and back off afterward. Use only for edge cases (e.g., leaving the overlay visible on screen for a user-facing screenshot).\n" +
            "PURPOSE: Manual control over the on-device inspector overlay.\n" +
            "WHEN TO USE: Only for special cases like capturing a screenshot WITH the inspector visible. Normal inspection workflows should call get_inspector_selection directly.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"inspect\") for the full component-inspect playbook.",
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
    server,
    "get_inspector_selection",
    {
        description:
            "Identify the React component at a screen location AND read its full styling. Returns RN's curated owner-tree hierarchy with PER-COMPONENT STYLE (padding, margin, border, layout, colors, fontSize, etc.) — the same rich data the on-device Element Inspector shows. Works on Bridgeless / new arch by invoking RN's inspector programmatically. If x/y provided: toggles the overlay on, captures the selection, and toggles it back off (no screenshot pollution). If no coordinates: reads the current selection from a manually-driven overlay.\n" +
            "PURPOSE: Identity + styling. Answers \"what is this and how is it styled?\" — the primary tool for visual/style debugging at a coordinate.\n" +
            "WHEN TO USE: You see a visual issue at a pixel and want the component name AND its style values (e.g. \"why is borderRadius 14 instead of 16?\"). Best for style/CSS-style debugging.\n" +
            "WORKFLOW: ios_screenshot / android_screenshot -> note the suspect pixel -> get_inspector_selection(x, y) -> edit the returned style values.\n" +
            "LIMITATIONS: Requires RN dev mode (__DEV__). x/y are in points/dp. Brief overlay flicker (~600ms total). Source file paths are pre-wired but null on React 19 (where _debugSource was dropped); component name + style is always returned.\n" +
            "DIFFERENCE vs inspect_at_point: get_inspector_selection returns RICH STYLE per ancestor (the inspector's curated view) but only ONE frame (the inspected element). inspect_at_point returns FRAME PER ANCESTOR plus PROPS (handlers, refs, non-style props) but no rich style merging. Use this tool for style/identity; use inspect_at_point for layout measurements and props.\n" +
            "GOOD: get_inspector_selection({ x: 180, y: 420 }) // \"what is this gradient card and what's its borderRadius?\"\n" +
            "BAD: Calling it in a tight loop — prefer inspect_at_point (no overlay toggle, faster, no visual side effect).\n" +
            "SEE ALSO: call get_usage_guide(topic=\"inspect\") for the full component-inspect playbook.",
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
        if (!hasMetro()) {
            const hint = await metroMissingHintIfAbsent("get_inspector_selection");
            return {
                content: [{ type: "text", text: `Inspector selection unavailable.${hint}` }],
                isError: true
            };
        }

        // Coordinate path: use fiber-based hit testing (works on Bridgeless / new arch
        // where RN's built-in inspector cannot populate hierarchy via UIManager.findSubviewIn).
        // Avoids toggling the on-device overlay so screenshots stay clean.
        const result =
            x !== undefined && y !== undefined
                ? await getInspectorSelectionAtPoint(x, y, device)
                : await getInspectorSelection(device);

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

            let output = `Element: ${parsed.element}\n`;
            output += `Path: ${parsed.path}\n`;
            if (parsed.frame) {
                const f = parsed.frame;
                output += `Frame: (${f.left?.toFixed(1)}, ${f.top?.toFixed(1)}) ${f.width?.toFixed?.(1) ?? f.width}x${f.height?.toFixed?.(1) ?? f.height}\n`;
            }
            if (parsed.style) {
                output += `Style: ${JSON.stringify(parsed.style, null, 2)}\n`;
            }
            if (Array.isArray(parsed.hierarchy) && parsed.hierarchy.length > 0) {
                output += `\nHierarchy:\n`;
                for (const h of parsed.hierarchy as Array<{ name: string; source?: string; style?: Record<string, unknown> }>) {
                    output += `  - ${h.name}`;
                    if (h.source) output += `  (${h.source})`;
                    output += `\n`;
                    if (h.style && Object.keys(h.style).length > 0) {
                        const styleStr = JSON.stringify(h.style);
                        output += `      style: ${styleStr.length > 300 ? styleStr.slice(0, 300) + "…" : styleStr}\n`;
                    }
                }
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
    server,
    "inspect_at_point",
    {
        description:
            "Inspect layout AND props at (x, y). Returns FRAME PER ANCESTOR (position/size in dp for every ancestor that hit-tested the point), plus the innermost component's PROPS (handlers as `[Function]`, refs, custom props like onPress/data/testID). Pure JS hit-test via fiber tree + measureInWindow — no on-device overlay toggled, zero visual side effect. Works on Paper and Fabric.\n" +
            "PURPOSE: Layout/props diagnosis. Answers \"where is each ancestor positioned, and what props does the touched component expose?\"\n" +
            "WHEN TO USE: A button is clipped, an element's hit area is wrong, an animated frame is unexpected — or you need handler/ref/non-style props that the inspector doesn't surface. Also preferred for tight loops or before/after comparisons (no overlay flicker).\n" +
            "WORKFLOW: ios_screenshot -> find suspect pixel -> convert to dp (pixel / pixelRatio) -> inspect_at_point(x, y).\n" +
            "LIMITATIONS: Coordinates MUST be in dp, not screenshot pixels — wrong unit = wrong component. Style is shown as a reference (no rich merging) — for style debugging use get_inspector_selection.\n" +
            "DIFFERENCE vs get_inspector_selection: inspect_at_point returns FRAME PER ANCESTOR + PROPS, no overlay flicker, no rich style. get_inspector_selection returns RICH STYLE per ancestor (padding/margin/border) but only ONE frame and toggles the overlay briefly. Use get_inspector_selection for style/identity; use this tool for layout measurements and props.\n" +
            "GOOD: inspect_at_point({ x: 205, y: 360 }) // \"why is this button's hit area too small?\"\n" +
            "BAD: inspect_at_point({ x: 540, y: 960 }) // raw screenshot pixels — picks the wrong node.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"inspect\") for the full component-inspect playbook.",
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
    server,
    "get_network_requests",
    {
        description:
            "Retrieve captured network requests from connected React Native app. Shows URL, method, status, and timing. Note: On Bridgeless targets (Expo SDK 52+) without the SDK, capture may miss early startup requests. Install react-native-ai-devtools-sdk for full capture with headers and response bodies. Tip: Use summary=true first for stats overview.\n" +
            "PURPOSE: Inspect HTTP traffic the app made since connection — URLs, methods, status codes, and timings — to debug API, auth, and caching issues.\n" +
            "WHEN TO USE: User reports a failed login/load, slow screen, or wrong data. Confirm a request fired, check its status, and pivot to get_request_details for headers/body.\n" +
            "WORKFLOW: scan_metro -> reproduce action -> get_network_requests({ summary: true }) -> get_network_requests({ status: 500 }) or search_network -> get_request_details(id).\n" +
            "LIMITATIONS: Bridgeless targets without the SDK may miss pre-connect requests and response bodies — install react-native-ai-devtools-sdk for full fidelity.\n" +
            "GOOD: get_network_requests({ summary: true }) then get_network_requests({ urlPattern: \"/login\", status: 401 })\n" +
            "BAD: get_network_requests({ maxRequests: 500 }) as the first call — start with summary=true.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"network\") for the full network-inspect playbook.",
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
                const connStatus = await checkAndEnsureConnection(device);
                connectionWarning = connStatus.message ? `\n\n${connStatus.message}` : "";
                if (!sdkAvailable) {
                    connectionWarning += "\n\n[TIP] For full network capture including startup requests and response bodies, install the SDK: npm install react-native-ai-devtools-sdk";
                }
                connectionWarning += await metroMissingHintIfAbsent("get_network_requests");
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
            const connStatus = await checkAndEnsureConnection(device);
            connectionWarning = connStatus.message ? `\n\n${connStatus.message}` : "";
            if (!sdkAvailable) {
                connectionWarning += "\n\n[TIP] For full network capture including startup requests and response bodies, install the SDK: npm install react-native-ai-devtools-sdk";
            }
            connectionWarning += await metroMissingHintIfAbsent("get_network_requests");
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
    server,
    "search_network",
    {
        description: "Search network requests by URL pattern (case-insensitive).\n" +
            "PURPOSE: Filter the network buffer to requests whose URL matches a substring — fast way to find a specific endpoint in a noisy app.\n" +
            "WHEN TO USE: You know part of the URL (e.g., \"/graphql\", \"users\", a domain) and want matching requests across all devices.\n" +
            "WORKFLOW: search_network(urlPattern=\"/api/\") -> get_request_details(requestId=\"...\") for full headers/body.\n" +
            "LIMITATIONS: Matches URL only; for method/status/body filtering use get_network_requests. Bodies are only present when the SDK is installed.\n" +
            "GOOD: search_network({ urlPattern: \"/graphql\" })\n" +
            "BAD: search_network({ urlPattern: \"\" }) — empty pattern matches everything; use get_network_requests instead.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"network\") for the full network-inspect playbook.",
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
            const status = await checkAndEnsureConnection(device);
            connectionWarning = status.message ? `\n\n${status.message}` : "";
            connectionWarning += await metroMissingHintIfAbsent("search_network");
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
    server,
    "get_request_details",
    {
        description:
            "Get full details of a specific network request including headers, body, and timing. With the SDK installed, includes full request/response bodies. Without SDK, bodies are not available on most targets. Use get_network_requests first to find the request ID.\n" +
            "PURPOSE: Drill into a single network entry — full request/response headers, body, status, and timing breakdown.\n" +
            "WHEN TO USE: After get_network_requests or search_network returns a suspect ID and you need the payload to diagnose.\n" +
            "WORKFLOW: get_network_requests / search_network -> copy id -> get_request_details(requestId).\n" +
            "LIMITATIONS: Bodies require the react-native-ai-devtools-sdk in the app; on CDP-only targets response bodies are missing. Large bodies are truncated — raise maxBodyLength.\n" +
            "GOOD: get_request_details({ requestId: \"42\", maxBodyLength: 4000 })\n" +
            "BAD: Guessing requestIds — always get them from get_network_requests / search_network first.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"network\") for the full network-inspect playbook.",
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
        // Resolve once per call so a mid-call SDK socket flap can't flip
        // routing partway through. Try SDK first (richer data), but ALWAYS
        // fall back to the CDP buffer on a miss — CDP records carry numeric
        // ids the SDK store doesn't know about, and vice versa.
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
            const status = await checkAndEnsureConnection(device);
            let connectionNote = status.message ? `\n\n${status.message}` : "";
            connectionNote += await metroMissingHintIfAbsent("get_request_details");

            // Enrich with up to 5 recent ids so the agent can pick a real one
            // instead of retrying with the same stale / made-up id (telemetry
            // shows ids like "latest", "js-x6e0-1208", "261" passed in).
            const recent = resolveNetworkBuffer(device).getAll({ count: 5 });
            let recentNote = "";
            if (recent.length > 0) {
                const lines = recent
                    .slice()
                    .reverse()
                    .map((r) => `  - ${r.requestId} — ${r.method} ${r.url}`)
                    .join("\n");
                recentNote = `\n\nRecent request ids in buffer (most recent first):\n${lines}\n\nIds are opaque strings — use one of the above, or call get_network_requests / search_network to discover more.`;
            } else {
                recentNote =
                    "\n\nNo network requests in the buffer for this device. " +
                    "Reproduce the action and call get_network_requests first to discover request ids.";
            }

            return {
                content: [
                    {
                        type: "text",
                        text: `Request not found: ${requestId}${connectionNote}${recentNote}`
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
    server,
    "get_network_stats",
    {
        description: "Get statistics about captured network requests: counts by method, status code, and domain.\n" +
            "PURPOSE: High-level view of traffic shape — totals, error counts, average duration, and top domains — without scanning every request.\n" +
            "WHEN TO USE: To quickly answer \"is there a spike in 5xx?\", \"which domain is chattiest?\", or to sanity-check capture is working.\n" +
            "WORKFLOW: get_network_stats -> if errors > 0: get_network_requests(status=\"500\") -> get_request_details.\n" +
            "LIMITATIONS: Reflects only the buffered window (last 200 entries per device). Resets when clear_network is called.\n" +
            "GOOD: get_network_stats()\n" +
            "BAD: Using it to find a specific request — use search_network or get_network_requests.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"network\") for the full network-inspect playbook.",
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
            const status = await checkAndEnsureConnection(device);
            connectionWarning = status.message ? `\n\n${status.message}` : "";
            connectionWarning += await metroMissingHintIfAbsent("get_network_stats");
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
    server,
    "clear_network",
    {
        description: "Clear the network request buffer.\n" +
            "PURPOSE: Reset the captured request list to isolate new traffic from a specific user action.\n" +
            "WHEN TO USE: Right before reproducing a bug so the buffer contains only the relevant requests.\n" +
            "WORKFLOW: clear_network -> trigger action (tap, execute_in_app) -> get_network_requests / search_network.\n" +
            "LIMITATIONS: Irreversible — cleared requests cannot be recovered. Also clears the SDK's in-app buffer when SDK is present.\n" +
            "GOOD: clear_network() before a reproduction.\n" +
            "BAD: Using clear_network as a workaround for stale connections — use scan_metro / ensure_connection instead.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"network\") for the full network-inspect playbook.",
        inputSchema: {
            device: z.string().optional().describe("Target device name (substring match). Omit to clear all devices. Run get_apps to see connected devices.")
        }
    },
    async ({ device }) => {
        let totalCleared = 0;
        if (device) {
            const app = getConnectedAppByDevice(device);
            if (!app) throw new UserInputError(`No connected device matches "${device}"`);
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

// Tool: Get images from shared image buffer
registerToolWithTelemetry(
    server,
    "get_images",
    {
        description:
            "Access the shared image buffer containing screenshots from all tools (ios_screenshot, android_screenshot, ocr_screenshot, tap verification). Returns metadata only by default — use id or groupId+frameIndex to retrieve actual image data. Tap burst verification stores frame groups here when burst=true is used.\n" +
            "PURPOSE: Retrieve prior screenshots — especially tap burst frames — without re-taking them, for visual diffing or reviewing transient UI states.\n" +
            "WHEN TO USE: After tap(burst=true) reports transientChangeDetected, or to compare before/after frames without another screenshot round-trip.\n" +
            "WORKFLOW: tap(burst=true) -> note verification.burstGroupId -> get_images(groupId, frameIndex=N) to inspect individual frames.\n" +
            "LIMITATIONS: Circular buffer (50 entries) — old images are evicted. Metadata is cheap; fetching image data is not — request specific ids, not bulk.\n" +
            "GOOD: get_images({ list: true }); get_images({ groupId: \"burst-abc\", frameIndex: 2 })\n" +
            "BAD: get_images() with no filter when buffer is full — floods context. Use list:true or last:N first.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"interact\") for the full interaction playbook.",
        inputSchema: {
            list: z.boolean().optional().describe("List all entries and groups (metadata only, no image data)"),
            id: z.string().optional().describe("Retrieve a specific image by ID (returns image data)"),
            groupId: z.string().optional().describe("List frames in a group (metadata only), or combine with frameIndex to retrieve a specific frame"),
            frameIndex: z.coerce.number().optional().describe("Retrieve a specific frame from a group (requires groupId)"),
            last: z.coerce.number().optional().describe("Return the N most recent entries (metadata only)"),
            source: z.string().optional().describe("Filter entries by source"),
            clear: z.boolean().optional().describe("Clear the buffer")
        }
    },
    async ({ id, groupId, frameIndex, last, source, clear }) => {
        if (clear) {
            const count = imageBuffer.clear();
            return {
                content: [{ type: "text" as const, text: `Cleared ${count} images from buffer.` }]
            };
        }

        if (id) {
            const entry = imageBuffer.getById(id);
            if (!entry) {
                return {
                    content: [{ type: "text" as const, text: `No image found with id "${id}".` }],
                    isError: true
                };
            }
            const { image, ...meta } = entry;
            return {
                content: [
                    { type: "text" as const, text: JSON.stringify(meta, null, 2) },
                    { type: "image" as const, data: image.toString("base64"), mimeType: "image/png" }
                ]
            };
        }

        if (groupId !== undefined && frameIndex !== undefined) {
            const entry = imageBuffer.getByGroupFrame(groupId, frameIndex);
            if (!entry) {
                return {
                    content: [{ type: "text" as const, text: `No frame ${frameIndex} found in group "${groupId}".` }],
                    isError: true
                };
            }
            const { image, ...meta } = entry;
            return {
                content: [
                    { type: "text" as const, text: JSON.stringify(meta, null, 2) },
                    { type: "image" as const, data: image.toString("base64"), mimeType: "image/png" }
                ]
            };
        }

        const entries = imageBuffer.listEntries({ source, groupId, last });
        const groups = imageBuffer.listGroups();
        return {
            content: [
                {
                    type: "text" as const,
                    text: JSON.stringify({ entries, groups, total: imageBuffer.size }, null, 2)
                }
            ]
        };
    }
);

// Tool: Reload the app
registerToolWithTelemetry(
    server,
    "reload_app",
    {
        description:
            "Reload the React Native app (triggers JavaScript bundle reload like pressing 'r' in Metro).\n" +
            "DO NOT call this reflexively after JS/TS/TSX/style edits — Fast Refresh applies those automatically in 1-2s. Reloading discards in-memory state: navigation stack, context, hooks state, BLE/WebSocket connections, paired devices, auth sessions. That can force re-pairing or re-login and break your verification loop, so the cost of an unnecessary reload is high.\n" +
            "ONLY reload when: (1) native code, app.json, Info.plist, Podfile, or a native module changed; (2) Fast Refresh visibly failed (red-screen, stale render confirmed via screenshot after a few seconds); (3) the app is in a broken/error state; (4) you need to reset app state completely; or (5) the user explicitly asks. If unsure, take a screenshot first and verify Fast Refresh didn't already apply the change — don't reload defensively.\n" +
            "Will auto-connect to Metro if no connection exists. After reload, the app may take a few seconds to fully restart and become responsive — wait before running other tools.",
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

// Tool: LogBox control (replaces dismiss_logbox)
registerToolWithTelemetry(
    server,
    "logbox",
    {
        description:
            "Interact with React Native's LogBox overlay (dev mode only). " +
            'Actions: "dismiss" clears all entries and returns their content. ' +
            '"push" displays a message in the LogBox error banner (visible to the developer watching the device). ' +
            '"ignore" adds patterns to suppress future LogBox entries for this session. ' +
            '"detect" reads current LogBox state without modifying it. ' +
            "Only works in __DEV__ mode — LogBox does not exist in production builds.\n" +
            "PURPOSE: Control RN's on-device red/yellow overlay — clear it when it blocks UI, suppress noisy repeats, or push a message back to the developer.\n" +
            "WHEN TO USE: Screenshot/tap reports LogBox is obstructing the screen, an error banner prevents interaction, or you want to surface info to the dev watching the simulator.\n" +
            "WORKFLOW: logbox(action=\"detect\") -> if present: logbox(action=\"dismiss\") to read + clear -> continue UI work. Use action=\"ignore\" with patterns to stop repeat noise.\n" +
            "LIMITATIONS: Dev-only — no effect in production builds. \"push\" at level=\"warning\" won't show a banner unless LogBox is already open.\n" +
            "GOOD: logbox({ action: \"dismiss\" }); logbox({ action: \"ignore\", patterns: [\"[APOLLO]\"] })\n" +
            "BAD: Spamming logbox(action=\"push\") for every tool step — annoys the developer.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"logs\") for the full logs playbook.",
        inputSchema: {
            action: z.enum(["dismiss", "push", "ignore", "detect"]).describe('Action to perform: "dismiss", "push", "ignore", or "detect"'),
            message: z.string().optional().describe('Message to push into LogBox (required when action="push")'),
            level: z.enum(["error", "warning"]).optional().describe('LogBox level for push (default: "error"). Only "error" shows a visible bottom banner; "warning" is stored but not visually shown unless LogBox is already open'),
            expanded: z.boolean().optional().describe('When true, opens the full-screen LogBox detail view instead of the minimized bottom banner. Useful for important messages with clickable URLs (default: false)'),
            subtitle: z.string().optional().describe('Additional info shown in the call stack area when expanded=true (default: "MCP Server"). Use for context like "License Check", "Usage Limit", etc.'),
            target: z.enum(["logbox", "metro"]).optional().describe('Where to push the message (default: "logbox"). "logbox" shows on device screen, "metro" outputs to Metro terminal via console.log'),
            patterns: z.array(z.string()).optional().describe('Patterns to ignore (required when action="ignore"), e.g. ["[APOLLO]", "deprecated"]'),
            device: z.string().optional().describe("Target device name (substring match). Omit for default device. Run get_apps to see connected devices.")
        }
    },
    async ({ action, message, level, expanded, subtitle, target, patterns, device }) => {
        const explainLogBoxError = (base: string): string => {
            const reason = getLastLogBoxError();
            const reasonHints: Record<string, string> = {
                dev_false: "__DEV__ is false — either a production build OR a stale/zombie CDP target whose JS context is in a degraded state. Try scan_metro to drop stale connections, then retry.",
                no_get_modules: "__r.getModules is missing — usually a stale CDP target (not a real runtime). Try scan_metro to refresh.",
                modules_not_iterable: "Module registry returned an unexpected shape.",
                logbox_module_not_found: "LogBoxData module not found in the Metro registry — possible if LogBox is tree-shaken or the app overrode it.",
                execute_failed: "executeInApp failed — no connected app or evaluate timed out.",
                exception: "Exception thrown during detection.",
            };
            const detail = reason ? (reasonHints[reason] ?? reason) : "unknown cause";
            return `${base}\nReason: ${reason ?? "unknown"} — ${detail}`;
        };
        if (action === "dismiss") {
            const result = await dismissLogBox(device);

            if (result === null) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: explainLogBoxError("LogBox not available.")
                        }
                    ]
                };
            }

            if (result.totalDismissed === 0) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "No LogBox entries to dismiss."
                        }
                    ]
                };
            }

            return {
                content: [
                    {
                        type: "text" as const,
                        text: formatDismissedEntries(result)
                    }
                ]
            };
        }

        if (action === "push") {
            if (!message) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: 'Error: "message" parameter is required when action is "push".'
                        }
                    ],
                    isError: true
                };
            }

            const success = await pushLogBox(message, level || "error", expanded || false, target || "logbox", subtitle, device);

            if (!success) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: explainLogBoxError("Failed to push message to LogBox.")
                        }
                    ]
                };
            }

            return {
                content: [
                    {
                        type: "text" as const,
                        text: target === "metro"
                            ? `Message pushed to Metro terminal: "${message}"`
                            : `Message pushed to LogBox as ${level || "error"}: "${message}"`
                    }
                ]
            };
        }

        if (action === "ignore") {
            if (!patterns || patterns.length === 0) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: 'Error: "patterns" parameter is required when action is "ignore" (non-empty array of strings).'
                        }
                    ],
                    isError: true
                };
            }

            const activePatterns = await addLogBoxIgnorePatterns(patterns, device);

            if (activePatterns === null) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: explainLogBoxError("Failed to add ignore patterns.")
                        }
                    ]
                };
            }

            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Added ignore patterns: ${patterns.map((p: string) => `"${p}"`).join(", ")}\n\nAll active ignore patterns: ${activePatterns.map((p: string) => `"${p}"`).join(", ")}`
                    }
                ]
            };
        }

        if (action === "detect") {
            const state = await detectLogBox(device);

            if (state === null) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: explainLogBoxError("LogBox not available.")
                        }
                    ]
                };
            }

            if (state.total === 0) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "No LogBox entries detected."
                        }
                    ]
                };
            }

            const MAX_MSG_LENGTH = 150;
            let output = `LogBox state: ${state.total} entr${state.total === 1 ? "y" : "ies"} (${state.errors} error${state.errors !== 1 ? "s" : ""}, ${state.warnings} warning${state.warnings !== 1 ? "s" : ""}, ${state.fatals} fatal${state.fatals !== 1 ? "s" : ""})\n`;

            for (const entry of state.entries) {
                const truncated =
                    entry.message.length > MAX_MSG_LENGTH ? entry.message.substring(0, MAX_MSG_LENGTH) + "..." : entry.message;
                const countStr = entry.count > 1 ? ` (x${entry.count})` : "";
                output += `\n[${entry.level}] ${truncated}${countStr}`;
            }

            return {
                content: [
                    {
                        type: "text" as const,
                        text: output
                    }
                ]
            };
        }

        return {
            content: [
                {
                    type: "text" as const,
                    text: `Unknown action: "${action}". Use "dismiss", "push", "ignore", or "detect".`
                }
            ],
            isError: true
        };
    }
);

// ============================================================================
// Bundle/Build Error Tools
// ============================================================================

// Tool: Get bundle status
registerToolWithTelemetry(
    server,
    "get_bundle_status",
    {
        description:
            "Get the current Metro bundler status including build state and any recent bundling errors. Use this to check if there are compilation/bundling errors that prevent the app from loading.\n" +
            "PURPOSE: Snapshot Metro's current build state (idle / transforming / error) together with any captured errors — a fast \"is the bundler healthy?\" check.\n" +
            "WHEN TO USE: Before diving into runtime debugging — rules out compile-time failures that would make get_logs and tap pointless.\n" +
            "WORKFLOW: get_bundle_status -> if errors present: get_bundle_errors for detail -> fix -> clear_bundle_errors.\n" +
            "LIMITATIONS: Relies on Metro's WebSocket event stream; if Metro isn't running or the connection dropped, status may be stale.\n" +
            "GOOD: get_bundle_status() at the start of a debug session.\n" +
            "BAD: Polling every second — Metro events are push-based; just call once and act on the result.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"bundle\") for the full bundle-check playbook.",
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
    server,
    "get_bundle_errors",
    {
        description:
            "Retrieve captured Metro bundling/compilation errors. These are errors that occur during the bundle build process (import resolution, syntax errors, transform errors) that prevent the app from loading. If no errors are captured but Metro is running without connected apps, automatically falls back to screenshot+OCR to capture the error from the device screen.\n" +
            "PURPOSE: Surface Metro's build-time failures (not runtime JS errors) that keep the app from booting or hot-reloading.\n" +
            "WHEN TO USE: App shows the red error screen, refuses to connect, or Fast Refresh stops working after an edit. Also use when get_logs is silent but the app is clearly broken.\n" +
            "WORKFLOW: get_bundle_status -> get_bundle_errors -> fix source -> clear_bundle_errors -> reload_app.\n" +
            "LIMITATIONS: Captures errors Metro emits via its WebSocket; the screenshot+OCR fallback requires a booted simulator and the platform param.\n" +
            "GOOD: get_bundle_errors({ platform: \"ios\" })\n" +
            "BAD: Using get_bundle_errors to look for runtime TypeErrors — those live in get_logs, not the bundler.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"bundle\") for the full bundle-check playbook.",
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
    server,
    "clear_bundle_errors",
    {
        description: "Clear the bundle error buffer.\n" +
            "PURPOSE: Reset captured Metro build errors after a fix so get_bundle_status/get_bundle_errors reflect the current state.\n" +
            "WHEN TO USE: After fixing a bundling error and before re-triggering Metro to confirm the error is gone.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"bundle\") for the full bundle-check playbook.",
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
    server,
    "list_android_devices",
    {
        description: "List connected Android devices and emulators via ADB.\n" +
            "PURPOSE: Discover which physical devices and emulators are visible to adb so you can pick a target UDID/serial.\n" +
            "WHEN TO USE: Before android_install_app / android_launch_app, or when a tool reports \"no device\" and you need to confirm visibility.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"setup\") for the full session-setup playbook.",
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

// Tool: Android install app
registerToolWithTelemetry(
    server,
    "android_install_app",
    {
        description: "Install an APK on an Android device/emulator" +
            platformUniqueBanner("installing an Android APK") +
            "\nPURPOSE: Push a built APK to a connected Android device or emulator via adb." +
            "\nWHEN TO USE: After producing a fresh build, when switching app variants, or when preparing a clean test run." +
            "\nSEE ALSO: call get_usage_guide(topic=\"setup\") for the full session-setup playbook.",
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
    server,
    "android_launch_app",
    {
        description: "Launch an app on an Android device/emulator by package name" +
            platformUniqueBanner("launching an Android app by package name") +
            "\nPURPOSE: Start an installed Android app by its package (and optional activity) so the next tool calls hit a running process." +
            "\nWHEN TO USE: After android_install_app, after a force-stop, or when the app isn't foregrounded before interaction." +
            "\nSEE ALSO: call get_usage_guide(topic=\"setup\") for the full session-setup playbook.",
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
    server,
    "android_list_packages",
    {
        description: "List installed packages on an Android device/emulator" +
            platformUniqueBanner("listing installed Android packages") +
            "\nPURPOSE: Enumerate package names visible to adb so you can confirm installation or pick the right target for android_launch_app." +
            "\nWHEN TO USE: Before android_launch_app when you don't know the exact package name, or to verify an install succeeded." +
            "\nSEE ALSO: call get_usage_guide(topic=\"setup\") for the full session-setup playbook.",
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
    server,
    "android_long_press",
    {
        description: "Long press at specific coordinates on an Android device/emulator screen" +
            platformFallbackBanner("`tap` for short taps; keep android_long_press for long-press gestures specifically") +
            "\nPURPOSE: Emit a sustained touch at raw pixel coordinates to trigger long-press handlers (context menus, drag starts, multi-select)." +
            "\nWHEN TO USE: Only when a long-press gesture is required — regular taps should go through `tap`." +
            "\nSEE ALSO: call get_usage_guide(topic=\"interact\") for the full UI-interaction playbook.",
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
    server,
    "android_swipe",
    {
        description: "Swipe from one point to another on an Android device/emulator screen" +
            platformFallbackBanner("`tap` for targeted interactions; keep android_swipe for raw-coordinate gestures") +
            "\nPURPOSE: Perform a raw-coordinate swipe gesture for scrolling, paging, dismissing sheets, or drawer opens on Android." +
            "\nWHEN TO USE: When you need a gesture rather than a tap — scroll lists, swipe carousels, or pull-to-refresh." +
            "\nSEE ALSO: call get_usage_guide(topic=\"interact\") for the full UI-interaction playbook.",
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
    server,
    "android_input_text",
    {
        description:
            "Type text on an Android device/emulator." +
            platformFallbackBanner("`tap(text=...)` — it auto-focuses TextInput via the fiber tree") +
            " The text will be input at the current focus point (tap an input field first)." +
            "\nPURPOSE: Send keystrokes to whichever input currently has focus on Android — the tool does NOT focus a field itself." +
            "\nWHEN TO USE: Only after an input is already focused, or when `tap(text=...)` on the input didn't take focus for some reason." +
            "\nREPLACE MODE: pass replace:true to clear the focused field first (via React onChangeText so controlled state stays consistent), then type the new value. Use for pre-filled fields where appending would corrupt the value." +
            "\nSEE ALSO: call get_usage_guide(topic=\"interact\") for the full UI-interaction playbook.",
        inputSchema: {
            text: z.string().describe("Text to type"),
            replace: z
                .boolean()
                .optional()
                .describe(
                    "If true, clear the focused TextInput via React onChangeText before typing. Use to set a pre-filled field to an exact value without concatenation. Requires Bridgeless/Fabric."
                ),
            device: z
                .string()
                .optional()
                .describe(
                    "Optional RN device name (substring match) — needed by replace:true when multiple RN apps are connected, to disambiguate which device's focused input to clear. Single-device sessions can omit."
                ),
            deviceId: z
                .string()
                .optional()
                .describe("Optional device ID. Uses first available device if not specified.")
        }
    },
    async ({ text, replace, device, deviceId }) => {
        const result = await inputTextWithReplace(
            text,
            replace === true,
            (t) => androidInputText(t, deviceId),
            () => clearFocusedInput(device)
        );

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
    server,
    "android_key_event",
    {
        description: "Send a key event to an Android device/emulator." +
            platformUniqueBanner("sending Android key events (BACK, HOME, MENU, etc.)") +
            ` Common keys: ${Object.keys(ANDROID_KEY_EVENTS).join(", ")}` +
            "\nPURPOSE: Dispatch Android system keys (BACK, HOME, MENU, ENTER, DEL, etc.) that aren't reachable via on-screen tap." +
            "\nWHEN TO USE: Navigate back from a screen, submit a form with ENTER, dismiss the keyboard, or press hardware-style keys during a flow." +
            "\nSEE ALSO: call get_usage_guide(topic=\"interact\") for the full UI-interaction playbook.",
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
    server,
    "android_get_screen_size",
    {
        description: "Get the screen size (resolution) of an Android device/emulator" +
            platformUniqueBanner("reading Android device pixel resolution") +
            "\nPURPOSE: Return the device's pixel width and height so you can compute safe tap/swipe coordinates." +
            "\nWHEN TO USE: Before scripting raw-coordinate gestures on an unfamiliar device, or when normalizing coordinates across devices." +
            "\nSEE ALSO: call get_usage_guide(topic=\"interact\") for the full UI-interaction playbook.",
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
// ============================================================================
// iOS Simulator Tools
// ============================================================================

// Tool: List iOS simulators
registerToolWithTelemetry(
    server,
    "list_ios_simulators",
    {
        description: "List available iOS simulators.\n" +
            "PURPOSE: Enumerate installed iOS simulators with their UDIDs and boot state so you can boot or install into the right one.\n" +
            "WHEN TO USE: Before ios_boot_simulator / ios_install_app, or when you need a UDID for a specific device name.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"setup\") for the full session-setup playbook.",
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

// Tool: OCR Screenshot - Extract text with coordinates from screenshot
registerToolWithTelemetry(
    server,
    "ocr_screenshot",
    {
        description:
            "RECOMMENDED: Use this tool FIRST when you need to find and tap UI elements. Takes a screenshot and extracts all visible text with tap-ready coordinates using OCR. " +
            "ADVANTAGES over accessibility trees: (1) Works on ANY visible text regardless of accessibility labels, (2) Returns ready-to-use tapX/tapY coordinates - no conversion needed, (3) Faster than parsing accessibility hierarchies, (4) Works consistently across iOS and Android. " +
            "USE THIS FOR: Finding buttons, labels, menu items, tab bars, or any text you need to tap. Simply find the text in the results and use its tapX/tapY with the tap command.\n" +
            "PURPOSE: Visually locate text on screen and return coordinates safe to pass straight into tap.\n" +
            "WHEN TO USE: Non-RN surfaces, third-party WebViews, accessibility-poor screens, or when fiber/testID strategies have failed.\n" +
            "WORKFLOW: ocr_screenshot(platform=\"ios\") -> scan results for the label -> tap(x=tapX, y=tapY) -> ios_screenshot to verify.\n" +
            "LIMITATIONS: OCR accuracy degrades on very small or stylized text; icons with no label won't appear — use tap(component=...) instead.\n" +
            "GOOD: ocr_screenshot({ platform: \"ios\" })\n" +
            "BAD: ocr_screenshot used just to view the screen — plain ios_screenshot / android_screenshot is cheaper when you don't need OCR text.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"interact\") for the full device-interaction playbook.",
        inputSchema: {
            platform: z.enum(["ios", "android"]).describe("Platform to capture screenshot from"),
            deviceId: z
                .string()
                .optional()
                .describe("Optional device ID (Android) or UDID (iOS). Uses first available device if not specified.")
        }
    },
    async ({ platform, deviceId }) => {
        try {
            // Take screenshot
            const screenshotResult = platform === "android"
                ? await androidScreenshot(undefined, deviceId)
                : await iosScreenshot(undefined, deviceId);

            if (!screenshotResult.success || !screenshotResult.data) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Screenshot failed: ${screenshotResult.error || "No image data"}`
                        }
                    ],
                    isError: true
                };
            }

            // Calculate device pixel ratio for iOS
            const devicePixelRatio =
                platform === "ios" && screenshotResult.originalWidth && screenshotResult.originalHeight
                    ? inferIOSDevicePixelRatio(screenshotResult.originalWidth, screenshotResult.originalHeight)
                    : 1;

            // Run OCR on the screenshot
            const scaleFactor = screenshotResult.scaleFactor || 1;
            const ocrResult = await recognizeText(screenshotResult.data, {
                scaleFactor,
                platform,
                devicePixelRatio
            });

            if (!ocrResult.success) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `OCR failed: no text recognized`
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

            const result: Record<string, unknown> = {
                platform,
                engine: ocrResult.engine || "unknown",
                processingTimeMs: ocrResult.processingTimeMs,
                fullText: ocrResult.fullText?.trim() || "",
                confidence: Math.round(ocrResult.confidence || 0),
                elementCount: elements.length,
                elements,
                note: "tapX/tapY are in device pixels — pass directly to tap(x, y) for automatic platform conversion"
            };

            // Check for LogBox overlay (uses default CDP device — native deviceId cannot be mapped to CDP device name)
            try {
                const logBoxState = await detectLogBox();
                if (logBoxState && logBoxState.total > 0) {
                    result.logBoxWarning = formatLogBoxWarning(logBoxState).trim();
                }
            } catch {
                // Non-fatal: LogBox detection failure should not break OCR
            }

            // Store screenshot in image buffer
            try {
                imageBuffer.add({
                    id: `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    image: screenshotResult.data,
                    timestamp: Date.now(),
                    source: "ocr_screenshot",
                    metadata: {
                        width: screenshotResult.originalWidth || 0,
                        height: screenshotResult.originalHeight || 0,
                        scaleFactor,
                        platform,
                    },
                });
            } catch {
                // Non-fatal: image buffer write failure should not break OCR response
            }

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
                        text: `OCR failed: ${error instanceof Error ? error.message : String(error)}`
                    }
                ],
                isError: true
            };
        }
    }
);

// Tool: iOS install app
registerToolWithTelemetry(
    server,
    "ios_install_app",
    {
        description: "Install an app bundle (.app) on an iOS simulator" +
            platformUniqueBanner("installing an iOS .app/.ipa bundle") +
            "\nPURPOSE: Deploy a built .app bundle onto a booted iOS simulator via simctl." +
            "\nWHEN TO USE: After producing a fresh simulator build, when switching app variants, or when preparing a clean test run." +
            "\nSEE ALSO: call get_usage_guide(topic=\"setup\") for the full session-setup playbook.",
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
    server,
    "ios_launch_app",
    {
        description: "Launch an app on an iOS simulator by bundle ID" +
            platformUniqueBanner("launching an iOS app by bundle ID") +
            "\nPURPOSE: Start an installed iOS app by its bundle ID so the next tool calls hit a running process." +
            "\nWHEN TO USE: After ios_install_app, after ios_terminate_app, or when the app isn't foregrounded before interaction." +
            "\nSEE ALSO: call get_usage_guide(topic=\"setup\") for the full session-setup playbook.",
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
    server,
    "ios_open_url",
    {
        description: "Open a URL in the iOS simulator (opens in default handler or Safari).\n" +
            "PURPOSE: Drive an iOS simulator into a deep link or universal link entry point so you can exercise routing from an external entry.\n" +
            "WHEN TO USE: Testing deep-link handlers, universal link routing, OAuth/SSO callback URLs, or any flow that enters the app via a URL.\n" +
            "WORKFLOW: ios_boot_simulator -> ios_launch_app (or have the app running) -> ios_open_url -> ios_screenshot / get_screen_layout to verify the target screen rendered.\n" +
            "GOOD: ios_open_url(url=\"myapp://product/42\") to land directly on a product screen.\n" +
            "BAD: ios_open_url(url=\"...\") used as a substitute for in-app navigation when the user would normally tap — prefer `tap` for normal interaction flows.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"interact\") for the full UI-interaction playbook." +
            platformUniqueBanner("testing iOS deep links or universal links"),
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
    server,
    "ios_terminate_app",
    {
        description: "Terminate a running app on an iOS simulator" +
            platformUniqueBanner("force-terminating an iOS app") +
            "\nPURPOSE: Force-kill an iOS app process so the next launch starts from a cold state." +
            "\nWHEN TO USE: To reset app state fully (beyond what reload_app does), or before reinstalling a new build." +
            "\nSEE ALSO: call get_usage_guide(topic=\"setup\") for the full session-setup playbook.",
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
    server,
    "ios_boot_simulator",
    {
        description: "Boot an iOS simulator by UDID.\n" +
            "PURPOSE: Bring a specific simulator online so you can install/launch an app in it.\n" +
            "WHEN TO USE: At session start when no simulator is running, or after switching between device models.\n" +
            "SEE ALSO: call get_usage_guide(topic=\"setup\") for the full session-setup playbook." +
            platformUniqueBanner("booting an iOS simulator") +
            " Use list_ios_simulators to find available simulators.",
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
// iOS UI Interaction Tools (require an iOS UI driver)
// Default: AXe — brew install cameroncooke/axe/axe
// Alternative: IDB — brew install idb-companion (set IOS_DRIVER=idb)
// ============================================================================
// Tool: iOS button
server.registerTool(
    "ios_button",
    {
        description:
            "Press a hardware button on an iOS simulator." +
            platformUniqueBanner("pressing iOS hardware buttons (HOME, LOCK, SIRI, APPLE_PAY)") +
            " Requires an iOS UI driver: AXe (recommended: brew install cameroncooke/axe/axe) or IDB (brew install idb-companion)." +
            "\nPURPOSE: Trigger iOS hardware buttons (HOME, LOCK, SIDE_BUTTON, SIRI, APPLE_PAY) that aren't reachable via on-screen tap." +
            "\nWHEN TO USE: Send the app to background (HOME), lock the simulator (LOCK), or exercise Siri/Apple Pay flows." +
            "\nSEE ALSO: call get_usage_guide(topic=\"interact\") for the full UI-interaction playbook.",
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

// Tool: Clear focused text input
registerToolWithTelemetry(
    server,
    "clear_focused_input",
    {
        description:
            "Clear the contents of the currently focused TextInput, updating React state correctly so controlled components (Formik, react-hook-form, useState) stay consistent." +
            "\nPURPOSE: Reset whatever TextInput has focus to empty, with the React state owner notified via onChangeText. Use BEFORE typing a replacement value into a pre-filled field." +
            "\nWHEN TO USE: After tap(testID=...) focuses an input that already has text. Pair with ios_input_text/android_input_text (or use their replace:true flag for one-shot)." +
            "\nLIMITATIONS: Requires Bridgeless/Fabric (RN new architecture). Returns 'no focused TextInput' if nothing is focused — does not silently no-op." +
            "\nSEE ALSO: dismiss_keyboard, ios_input_text({replace:true}), android_input_text({replace:true}). call get_usage_guide(topic=\"interact\") for the full UI-interaction playbook.",
        inputSchema: {
            device: z
                .string()
                .optional()
                .describe("Optional device name (substring match). Uses default device if not specified.")
        }
    },
    async ({ device }) => {
        const result = await clearFocusedInput(device);
        return {
            content: [
                {
                    type: "text",
                    text: result.success ? `Cleared focused input (via ${result.via}).` : `Error: ${result.error}`
                }
            ],
            isError: !result.success
        };
    }
);

// Tool: Dismiss keyboard
registerToolWithTelemetry(
    server,
    "dismiss_keyboard",
    {
        description:
            "Blur the currently focused TextInput, dismissing the on-screen keyboard." +
            "\nPURPOSE: Close the keyboard when it's blocking content beneath the input, or move focus off an input before a tap that would otherwise be intercepted." +
            "\nWHEN TO USE: After typing into a field and before tapping a button that is hidden by the keyboard. Or to verify a 'tap outside dismisses' UX is wired up." +
            "\nLIMITATIONS: Requires Bridgeless/Fabric (RN new architecture). Returns 'no focused TextInput' if nothing is focused.",
        inputSchema: {
            device: z
                .string()
                .optional()
                .describe("Optional device name (substring match). Uses default device if not specified.")
        }
    },
    async ({ device }) => {
        const result = await dismissKeyboard(device);
        return {
            content: [
                {
                    type: "text",
                    text: result.success
                        ? `Dismissed keyboard (nativeTag ${result.nativeTag}).`
                        : `Error: ${result.error}`
                }
            ],
            isError: !result.success
        };
    }
);

// Tool: iOS input text
registerToolWithTelemetry(
    server,
    "ios_input_text",
    {
        description:
            "Type text on an iOS simulator." +
            platformFallbackBanner("`tap(text=...)` — it auto-focuses TextInput via the fiber tree") +
            " The text is typed into whichever field currently has focus (tap an input first). Mirrors `android_input_text` so cross-platform agents can use `<platform>_input_text` without branching on the iOS driver shell-out." +
            "\nPURPOSE: Send keystrokes to the focused field on an iOS simulator via the active UI driver (AXe — preferred — or IDB)." +
            "\nWHEN TO USE: Only after an input is already focused, or when `tap(testID=...)` on the input didn't take focus for some reason. Use the testID-first flow whenever possible — it's faster and survives UI repositioning." +
            "\nREPLACE MODE: pass replace:true to clear the focused field first (via React onChangeText so controlled state stays consistent), then type the new value. Use for pre-filled fields where appending would corrupt the value." +
            "\nLIMITATIONS: AXe types via the US-keyboard HID — non-ASCII characters (Cyrillic, CJK, Arabic) may not transmit correctly. If the active driver is AXe and the text contains non-ASCII chars, prefer pasting via the simulator pasteboard or setting IOS_DRIVER=idb." +
            "\nSEE ALSO: call get_usage_guide(topic=\"interact\") for the full UI-interaction playbook.",
        inputSchema: {
            text: z.string().describe("Text to type into the currently focused field."),
            replace: z
                .boolean()
                .optional()
                .describe(
                    "If true, clear the focused TextInput via React onChangeText before typing. Use to set a pre-filled field to an exact value without concatenation. Requires Bridgeless/Fabric."
                ),
            device: z
                .string()
                .optional()
                .describe(
                    "Optional RN device name (substring match) — needed by replace:true when multiple RN apps are connected, to disambiguate which device's focused input to clear. Single-device sessions can omit."
                ),
            udid: z.string().optional().describe("Optional simulator UDID (from list_ios_simulators). Uses booted simulator if not specified.")
        }
    },
    async ({ text, replace, device, udid }) => {
        const result = await inputTextWithReplace(
            text,
            replace === true,
            (t) => iosInputText(t, udid),
            () => clearFocusedInput(device)
        );

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

registerAccountTools(server);
registerMetaTools(server, {
    devMode: isDevMode(),
    httpMode: process.argv.includes("--http"),
});
registerReduxTools(server);
registerExecutionTools(server);
registerLogTools(server);


// Main function
async function main() {
    // Initialize telemetry (checks opt-out env var, loads/creates installation ID)
    // License validation is lazy — runs on first tool use via ensureLicense()
    initTelemetry();
    identifyIfDevMode(getInstallationId());

    // --- Eager usage check (pre-loads usage cache for tool-level gate) ---
    const { ensureLicense } = await import("./core/license.js");
    await ensureLicense();

    const useHttp = process.argv.includes("--http");
    const httpPort = parseInt(process.env.MCP_HTTP_PORT || "8600", 10);

    if (useHttp) {
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
            console.error(`[execbro] MCP HTTP server listening on http://localhost:${httpPort}/mcp`);
        });
    } else {
        // Stdio transport mode — default for production
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error("[execbro] Server started on stdio");
    }

}

// Skip boot when loaded by unit tests — tests import this module purely to
// enumerate `toolRegistry`. Jest sets JEST_WORKER_ID; EXECBRO_TEST_MODE
// (or legacy RN_AI_DEVTOOLS_TEST_MODE) is a manual escape hatch.
// Production + dev:mcp leave all unset and boot.
if (!process.env.EXECBRO_TEST_MODE && !process.env.RN_AI_DEVTOOLS_TEST_MODE && !process.env.JEST_WORKER_ID) {
    main().catch((error) => {
        console.error("[execbro] Fatal error:", error);
        process.exit(1);
    });
}

// Graceful shutdown: close CDP connections so the slot is freed for other sessions
function gracefulShutdown() {
    suppressReconnection();
    cancelAllReconnectionTimers();
    for (const [key, app] of connectedApps.entries()) {
        try {
            app.ws.close();
        } catch {
            // Ignore close errors during shutdown
        }
        connectedApps.delete(key);
    }
    disconnectMetroBuildEvents();
    clearAllConnectionState();
    clearAllCDPMessageTimes();
    shutdownPostHog().catch(() => {});
}

process.on("beforeExit", () => {
    shutdownPostHog().catch(() => {});
});

process.on("SIGINT", () => {
    gracefulShutdown();
    process.exit(0);
});

process.on("SIGTERM", () => {
    gracefulShutdown();
    process.exit(0);
});
