import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerToolWithTelemetry } from "../core/register.js";
import { resolveAndroidDeviceId, resolveIosUdid } from "./_deviceArg.js";
import {
    getBundleStatusWithErrors,
    getBundleErrors,
    checkMetroState,
    parseErrorScreenText,
    bundleErrorBuffer,
    pushLogBox,
    dismissLogBox,
    formatDismissedEntries,
    addLogBoxIgnorePatterns,
    getLastLogBoxError,
    detectLogBox,
    connectedApps,
    androidScreenshot,
    iosScreenshot,
    inferIOSDevicePixelRatio,
    recognizeText,
    formatParsedError,
} from "../core/index.js";

export function registerBundleTools(server: McpServer): void {
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
                    .describe("Optional device target for screenshot fallback. Accepts an adb serial / iOS UDID, an emulator/simulator name, or a substring of the connected RN device name. Uses first available device if not specified.")
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
                    const r = await resolveAndroidDeviceId(deviceId);
                    if (!r.ok) return r.response;
                    screenshotResult = await androidScreenshot(undefined, r.serial);
                } else {
                    const r = await resolveIosUdid(deviceId);
                    if (!r.ok) return r.response;
                    screenshotResult = await iosScreenshot(undefined, r.udid);
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
}
