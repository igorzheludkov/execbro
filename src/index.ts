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





// ============================================================================
// Bundle/Build Error Tools
// ============================================================================


// ============================================================================
// Android Tools

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


// ============================================================================
// Android Accessibility Tools (UI Hierarchy)
// ============================================================================
// ============================================================================
// iOS Simulator Tools
// ============================================================================



// Tool: iOS install app

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
registerNetworkTools(server);
registerBundleTools(server);
registerDeviceTools(server);
registerConnectionTools(server);
registerScreenshotTools(server);


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
