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
import { registerNetworkTools } from "./tools/networkTools.js";
import { registerBundleTools } from "./tools/bundleTools.js";
import { registerDeviceTools } from "./tools/deviceTools.js";
import { registerConnectionTools } from "./tools/connectionTools.js";
import { registerScreenshotTools } from "./tools/screenshotTools.js";
import { registerInteractionTools } from "./tools/interactionTools.js";
import { registerComponentTools } from "./tools/componentTools.js";

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










// ============================================================================
// Bundle/Build Error Tools
// ============================================================================


// ============================================================================
// Android Tools

// ============================================================================

registerAccountTools(server);
registerMetaTools(server, {
    devMode: isDevMode(),
    httpMode: process.argv.includes("--http"),
});
registerReduxTools(server);
registerExecutionTools(server);
registerLogTools(server);
registerNetworkTools(server);
registerBundleTools(server);
registerDeviceTools(server);
registerConnectionTools(server);
registerScreenshotTools(server);
registerInteractionTools(server);
registerComponentTools(server);


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
