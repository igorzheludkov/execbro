#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
    logBuffer,
    networkBuffer,
    bundleErrorBuffer,
    scanMetroPorts,
    fetchDevices,
    selectMainDevice,
    connectToDevice,
    getConnectedApps,
    executeInApp,
    listDebugGlobals,
    inspectGlobal,
    reloadApp,
    getLogs,
    searchLogs,
    getNetworkRequests,
    searchNetworkRequests,
    getNetworkStats,
    formatRequestDetails,
    // Bundle (Metro build errors)
    connectMetroBuildEvents,
    getBundleErrors,
    getBundleStatusWithErrors,
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
    // Android Accessibility (UI Hierarchy)
    androidDescribeAll,
    androidDescribePoint,
    androidTapElement,
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
    iosTapElement,
    iosSwipe,
    iosInputText,
    iosButton,
    iosKeyEvent,
    iosKeySequence,
    iosDescribeAll,
    iosDescribePoint,
    IOS_BUTTON_TYPES,
    // Debug HTTP Server
    startDebugHttpServer,
    getDebugServerPort
} from "./core/index.js";

// Create MCP server
const server = new McpServer({
    name: "react-native-ai-debugger",
    version: "1.0.0"
});

// Tool: Scan for Metro servers
server.registerTool(
    "scan_metro",
    {
        description: "Scan for running Metro bundler servers on common ports",
        inputSchema: {
            startPort: z.number().optional().default(8081).describe("Start port for scanning (default: 8081)"),
            endPort: z.number().optional().default(19002).describe("End port for scanning (default: 19002)")
        }
    },
    async ({ startPort, endPort }) => {
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

        // Fetch devices from each port and connect
        const results: string[] = [];
        for (const port of openPorts) {
            const devices = await fetchDevices(port);
            if (devices.length === 0) {
                results.push(`Port ${port}: No devices found`);
                continue;
            }

            results.push(`Port ${port}: Found ${devices.length} device(s)`);

            const mainDevice = selectMainDevice(devices);
            if (mainDevice) {
                try {
                    const connectionResult = await connectToDevice(mainDevice, port);
                    results.push(`  - ${connectionResult}`);

                    // Also connect to Metro build events for this port
                    try {
                        await connectMetroBuildEvents(port);
                        results.push(`  - Connected to Metro build events`);
                    } catch {
                        // Build events connection is optional, don't fail the scan
                    }
                } catch (error) {
                    results.push(`  - Failed: ${error}`);
                }
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
server.registerTool(
    "get_apps",
    {
        description: "List connected React Native apps and Metro server status",
        inputSchema: {}
    },
    async () => {
        const connections = getConnectedApps();

        if (connections.length === 0) {
            return {
                content: [
                    {
                        type: "text",
                        text: 'No apps connected. Run "scan_metro" first to discover and connect to running apps.'
                    }
                ]
            };
        }

        const status = connections.map(({ app, isConnected }) => {
            const state = isConnected ? "Connected" : "Disconnected";
            return `${app.deviceInfo.title} (${app.deviceInfo.deviceName}): ${state}`;
        });

        return {
            content: [
                {
                    type: "text",
                    text: `Connected apps:\n${status.join("\n")}\n\nTotal logs in buffer: ${logBuffer.size}`
                }
            ]
        };
    }
);

// Tool: Get console logs
server.registerTool(
    "get_logs",
    {
        description: "Retrieve console logs from connected React Native app",
        inputSchema: {
            maxLogs: z.number().optional().default(50).describe("Maximum number of logs to return (default: 50)"),
            level: z
                .enum(["all", "log", "warn", "error", "info", "debug"])
                .optional()
                .default("all")
                .describe("Filter by log level (default: all)"),
            startFromText: z.string().optional().describe("Start from the first log line containing this text")
        }
    },
    async ({ maxLogs, level, startFromText }) => {
        const { logs, formatted } = getLogs(logBuffer, { maxLogs, level, startFromText });

        const startNote = startFromText ? ` (starting from "${startFromText}")` : "";
        return {
            content: [
                {
                    type: "text",
                    text: `React Native Console Logs (${logs.length} entries)${startNote}:\n\n${formatted}`
                }
            ]
        };
    }
);

// Tool: Search logs
server.registerTool(
    "search_logs",
    {
        description: "Search console logs for text (case-insensitive)",
        inputSchema: {
            text: z.string().describe("Text to search for in log messages"),
            maxResults: z.number().optional().default(50).describe("Maximum number of results to return (default: 50)")
        }
    },
    async ({ text, maxResults }) => {
        const { logs, formatted } = searchLogs(logBuffer, text, maxResults);

        return {
            content: [
                {
                    type: "text",
                    text: `Search results for "${text}" (${logs.length} matches):\n\n${formatted}`
                }
            ]
        };
    }
);

// Tool: Clear logs
server.registerTool(
    "clear_logs",
    {
        description: "Clear the log buffer",
        inputSchema: {}
    },
    async () => {
        const count = logBuffer.clear();

        return {
            content: [
                {
                    type: "text",
                    text: `Cleared ${count} log entries from buffer.`
                }
            ]
        };
    }
);

// Tool: Connect to specific Metro port
server.registerTool(
    "connect_metro",
    {
        description: "Connect to a specific Metro server port",
        inputSchema: {
            port: z.number().default(8081).describe("Metro server port (default: 8081)")
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

// Tool: Execute JavaScript in app
server.registerTool(
    "execute_in_app",
    {
        description:
            "Execute JavaScript code in the connected React Native app and return the result. Use this for REPL-style interactions, inspecting app state, or running diagnostic code.",
        inputSchema: {
            expression: z.string().describe("JavaScript expression to execute in the app"),
            awaitPromise: z.boolean().optional().default(true).describe("Whether to await promises (default: true)")
        }
    },
    async ({ expression, awaitPromise }) => {
        const result = await executeInApp(expression, awaitPromise);

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
                    text: result.result ?? "undefined"
                }
            ]
        };
    }
);

// Tool: List debug globals available in the app
server.registerTool(
    "list_debug_globals",
    {
        description:
            "List globally available debugging objects in the connected React Native app (Apollo Client, Redux store, React DevTools, etc.). Use this to discover what state management and debugging tools are available.",
        inputSchema: {}
    },
    async () => {
        const result = await listDebugGlobals();

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
server.registerTool(
    "inspect_global",
    {
        description:
            "Inspect a global object to see its properties, types, and whether they are callable functions. Use this BEFORE calling methods on unfamiliar objects to avoid errors.",
        inputSchema: {
            objectName: z
                .string()
                .describe("Name of the global object to inspect (e.g., '__EXPO_ROUTER__', '__APOLLO_CLIENT__')")
        }
    },
    async ({ objectName }) => {
        const result = await inspectGlobal(objectName);

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
                    text: `Properties of ${objectName}:\n\n${result.result}`
                }
            ]
        };
    }
);

// Tool: Get network requests
server.registerTool(
    "get_network_requests",
    {
        description:
            "Retrieve captured network requests from connected React Native app. Shows URL, method, status, and timing.",
        inputSchema: {
            maxRequests: z
                .number()
                .optional()
                .default(50)
                .describe("Maximum number of requests to return (default: 50)"),
            method: z
                .string()
                .optional()
                .describe("Filter by HTTP method (GET, POST, PUT, DELETE, etc.)"),
            urlPattern: z
                .string()
                .optional()
                .describe("Filter by URL pattern (case-insensitive substring match)"),
            status: z
                .number()
                .optional()
                .describe("Filter by HTTP status code (e.g., 200, 401, 500)")
        }
    },
    async ({ maxRequests, method, urlPattern, status }) => {
        const { requests, formatted } = getNetworkRequests(networkBuffer, {
            maxRequests,
            method,
            urlPattern,
            status
        });

        return {
            content: [
                {
                    type: "text",
                    text: `Network Requests (${requests.length} entries):\n\n${formatted}`
                }
            ]
        };
    }
);

// Tool: Search network requests
server.registerTool(
    "search_network",
    {
        description: "Search network requests by URL pattern (case-insensitive)",
        inputSchema: {
            urlPattern: z.string().describe("URL pattern to search for"),
            maxResults: z
                .number()
                .optional()
                .default(50)
                .describe("Maximum number of results to return (default: 50)")
        }
    },
    async ({ urlPattern, maxResults }) => {
        const { requests, formatted } = searchNetworkRequests(networkBuffer, urlPattern, maxResults);

        return {
            content: [
                {
                    type: "text",
                    text: `Network search results for "${urlPattern}" (${requests.length} matches):\n\n${formatted}`
                }
            ]
        };
    }
);

// Tool: Get request details
server.registerTool(
    "get_request_details",
    {
        description:
            "Get full details of a specific network request including headers, body, and timing. Use get_network_requests first to find the request ID.",
        inputSchema: {
            requestId: z.string().describe("The request ID to get details for")
        }
    },
    async ({ requestId }) => {
        const request = networkBuffer.get(requestId);

        if (!request) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Request not found: ${requestId}`
                    }
                ],
                isError: true
            };
        }

        return {
            content: [
                {
                    type: "text",
                    text: formatRequestDetails(request)
                }
            ]
        };
    }
);

// Tool: Get network stats
server.registerTool(
    "get_network_stats",
    {
        description:
            "Get statistics about captured network requests: counts by method, status code, and domain.",
        inputSchema: {}
    },
    async () => {
        const stats = getNetworkStats(networkBuffer);

        return {
            content: [
                {
                    type: "text",
                    text: `Network Statistics:\n\n${stats}`
                }
            ]
        };
    }
);

// Tool: Clear network requests
server.registerTool(
    "clear_network",
    {
        description: "Clear the network request buffer",
        inputSchema: {}
    },
    async () => {
        const count = networkBuffer.clear();

        return {
            content: [
                {
                    type: "text",
                    text: `Cleared ${count} network requests from buffer.`
                }
            ]
        };
    }
);

// Tool: Reload the app
server.registerTool(
    "reload_app",
    {
        description:
            "Reload the connected React Native app. Triggers a JavaScript bundle reload (like pressing 'r' in Metro or shaking the device).",
        inputSchema: {}
    },
    async () => {
        const result = await reloadApp();

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
server.registerTool(
    "get_bundle_status",
    {
        description:
            "Get the current Metro bundler status including build state and any recent bundling errors. Use this to check if there are compilation/bundling errors that prevent the app from loading.",
        inputSchema: {}
    },
    async () => {
        const { formatted } = await getBundleStatusWithErrors(bundleErrorBuffer);

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
server.registerTool(
    "get_bundle_errors",
    {
        description:
            "Retrieve captured Metro bundling/compilation errors. These are errors that occur during the bundle build process (import resolution, syntax errors, transform errors) that prevent the app from loading.",
        inputSchema: {
            maxErrors: z
                .number()
                .optional()
                .default(10)
                .describe("Maximum number of errors to return (default: 10)")
        }
    },
    async ({ maxErrors }) => {
        const { errors, formatted } = getBundleErrors(bundleErrorBuffer, { maxErrors });

        return {
            content: [
                {
                    type: "text",
                    text: `Bundle Errors (${errors.length} captured):\n\n${formatted}`
                }
            ]
        };
    }
);

// Tool: Clear bundle errors
server.registerTool(
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
server.registerTool(
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
server.registerTool(
    "android_screenshot",
    {
        description:
            "Take a screenshot from an Android device/emulator. Returns the image data that can be displayed.",
        inputSchema: {
            outputPath: z
                .string()
                .optional()
                .describe("Optional path to save the screenshot. If not provided, saves to temp directory."),
            deviceId: z
                .string()
                .optional()
                .describe("Optional device ID (from list_android_devices). Uses first available device if not specified.")
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
            // Build info text with scale factor for coordinate conversion
            let infoText = `Screenshot captured (${result.originalWidth}x${result.originalHeight})`;
            if (result.scaleFactor && result.scaleFactor > 1) {
                infoText += `\n⚠️ Image was scaled down to fit API limits. Scale factor: ${result.scaleFactor.toFixed(3)}`;
                infoText += `\nTo tap/swipe: multiply image coordinates by ${result.scaleFactor.toFixed(3)} to get device coordinates.`;
            }

            return {
                content: [
                    {
                        type: "text" as const,
                        text: infoText
                    },
                    {
                        type: "image" as const,
                        data: result.data.toString("base64"),
                        mimeType: "image/png"
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
server.registerTool(
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
server.registerTool(
    "android_launch_app",
    {
        description: "Launch an app on an Android device/emulator by package name",
        inputSchema: {
            packageName: z.string().describe("Package name of the app (e.g., com.example.myapp)"),
            activityName: z
                .string()
                .optional()
                .describe("Optional activity name to launch (e.g., .MainActivity). If not provided, launches the main activity."),
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
server.registerTool(
    "android_list_packages",
    {
        description: "List installed packages on an Android device/emulator",
        inputSchema: {
            deviceId: z
                .string()
                .optional()
                .describe("Optional device ID. Uses first available device if not specified."),
            filter: z
                .string()
                .optional()
                .describe("Optional filter to search packages by name (case-insensitive)")
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

// Tool: Android tap
server.registerTool(
    "android_tap",
    {
        description: "Tap at specific coordinates on an Android device/emulator screen. NOTE: Prefer using android_tap_element instead, which finds elements by text/content-desc and is more reliable.",
        inputSchema: {
            x: z.number().describe("X coordinate in pixels"),
            y: z.number().describe("Y coordinate in pixels"),
            deviceId: z
                .string()
                .optional()
                .describe("Optional device ID. Uses first available device if not specified.")
        }
    },
    async ({ x, y, deviceId }) => {
        const result = await androidTap(x, y, deviceId);

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

// Tool: Android long press
server.registerTool(
    "android_long_press",
    {
        description: "Long press at specific coordinates on an Android device/emulator screen",
        inputSchema: {
            x: z.number().describe("X coordinate in pixels"),
            y: z.number().describe("Y coordinate in pixels"),
            durationMs: z
                .number()
                .optional()
                .default(1000)
                .describe("Press duration in milliseconds (default: 1000)"),
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
server.registerTool(
    "android_swipe",
    {
        description: "Swipe from one point to another on an Android device/emulator screen",
        inputSchema: {
            startX: z.number().describe("Starting X coordinate in pixels"),
            startY: z.number().describe("Starting Y coordinate in pixels"),
            endX: z.number().describe("Ending X coordinate in pixels"),
            endY: z.number().describe("Ending Y coordinate in pixels"),
            durationMs: z
                .number()
                .optional()
                .default(300)
                .describe("Swipe duration in milliseconds (default: 300)"),
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
server.registerTool(
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
server.registerTool(
    "android_key_event",
    {
        description: `Send a key event to an Android device/emulator. Common keys: ${Object.keys(ANDROID_KEY_EVENTS).join(", ")}`,
        inputSchema: {
            key: z
                .string()
                .describe(
                    `Key name (${Object.keys(ANDROID_KEY_EVENTS).join(", ")}) or numeric keycode`
                ),
            deviceId: z
                .string()
                .optional()
                .describe("Optional device ID. Uses first available device if not specified.")
        }
    },
    async ({ key, deviceId }) => {
        // Try to parse as number first, otherwise treat as key name
        const keyCode = /^\d+$/.test(key)
            ? parseInt(key, 10)
            : (key.toUpperCase() as keyof typeof ANDROID_KEY_EVENTS);

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
server.registerTool(
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
            x: z.number().describe("X coordinate in pixels"),
            y: z.number().describe("Y coordinate in pixels"),
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

// Tool: Android tap element
server.registerTool(
    "android_tap_element",
    {
        description:
            "PREFERRED: Tap an element by its text, content-description, or resource-id. More reliable than coordinate-based tapping. Automatically finds the element using uiautomator and taps its center.",
        inputSchema: {
            text: z
                .string()
                .optional()
                .describe("Exact text match for the element"),
            textContains: z
                .string()
                .optional()
                .describe("Partial text match (case-insensitive)"),
            contentDesc: z
                .string()
                .optional()
                .describe("Exact content-description match"),
            contentDescContains: z
                .string()
                .optional()
                .describe("Partial content-description match (case-insensitive)"),
            resourceId: z
                .string()
                .optional()
                .describe("Resource ID match (e.g., 'com.app:id/button' or just 'button')"),
            index: z
                .number()
                .optional()
                .describe("If multiple elements match, tap the nth one (0-indexed, default: 0)"),
            deviceId: z
                .string()
                .optional()
                .describe("Optional device ID. Uses first available device if not specified.")
        }
    },
    async ({ text, textContains, contentDesc, contentDescContains, resourceId, index, deviceId }) => {
        const result = await androidTapElement({
            text,
            textContains,
            contentDesc,
            contentDescContains,
            resourceId,
            index,
            deviceId
        });

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
// iOS Simulator Tools
// ============================================================================

// Tool: List iOS simulators
server.registerTool(
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
server.registerTool(
    "ios_screenshot",
    {
        description:
            "Take a screenshot from an iOS simulator. Returns the image data that can be displayed.",
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
            // iOS simulators use points, not pixels. Retina displays are typically 2x or 3x.
            const pixelWidth = result.originalWidth || 0;
            const pixelHeight = result.originalHeight || 0;
            // Assume 2x Retina scale for most iOS simulators
            const pointWidth = Math.round(pixelWidth / 2);
            const pointHeight = Math.round(pixelHeight / 2);

            let infoText = `Screenshot captured (${pixelWidth}x${pixelHeight} pixels)`;
            infoText += `\n📱 iOS IDB coordinates use POINTS: ${pointWidth}x${pointHeight}`;
            infoText += `\nTo convert image coords to IDB points: divide pixel coordinates by 2`;
            if (result.scaleFactor && result.scaleFactor > 1) {
                infoText += `\n⚠️ Image was scaled down to fit API limits (scale: ${result.scaleFactor.toFixed(3)})`;
            }
            infoText += `\n💡 Use ios_describe_all to get exact element coordinates`;

            return {
                content: [
                    {
                        type: "text" as const,
                        text: infoText
                    },
                    {
                        type: "image" as const,
                        data: result.data.toString("base64"),
                        mimeType: "image/png"
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

// Tool: iOS install app
server.registerTool(
    "ios_install_app",
    {
        description: "Install an app bundle (.app) on an iOS simulator",
        inputSchema: {
            appPath: z.string().describe("Path to the .app bundle to install"),
            udid: z
                .string()
                .optional()
                .describe("Optional simulator UDID. Uses booted simulator if not specified.")
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
server.registerTool(
    "ios_launch_app",
    {
        description: "Launch an app on an iOS simulator by bundle ID",
        inputSchema: {
            bundleId: z.string().describe("Bundle ID of the app (e.g., com.example.myapp)"),
            udid: z
                .string()
                .optional()
                .describe("Optional simulator UDID. Uses booted simulator if not specified.")
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
server.registerTool(
    "ios_open_url",
    {
        description: "Open a URL in the iOS simulator (opens in default handler or Safari)",
        inputSchema: {
            url: z.string().describe("URL to open (e.g., https://example.com or myapp://path)"),
            udid: z
                .string()
                .optional()
                .describe("Optional simulator UDID. Uses booted simulator if not specified.")
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
server.registerTool(
    "ios_terminate_app",
    {
        description: "Terminate a running app on an iOS simulator",
        inputSchema: {
            bundleId: z.string().describe("Bundle ID of the app to terminate"),
            udid: z
                .string()
                .optional()
                .describe("Optional simulator UDID. Uses booted simulator if not specified.")
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
server.registerTool(
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

// Tool: iOS tap
server.registerTool(
    "ios_tap",
    {
        description:
            "Tap at specific coordinates on an iOS simulator screen. NOTE: Prefer using ios_tap_element instead, which finds elements by accessibility label and is more reliable. Requires IDB (brew install idb-companion).",
        inputSchema: {
            x: z.number().describe("X coordinate in pixels"),
            y: z.number().describe("Y coordinate in pixels"),
            duration: z
                .number()
                .optional()
                .describe("Optional tap duration in seconds (for long press)"),
            udid: z
                .string()
                .optional()
                .describe("Optional simulator UDID. Uses booted simulator if not specified.")
        }
    },
    async ({ x, y, duration, udid }) => {
        const result = await iosTap(x, y, { duration, udid });

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

// Tool: iOS tap element by label
server.registerTool(
    "ios_tap_element",
    {
        description:
            "PREFERRED: Tap an element by its accessibility label. More reliable than coordinate-based tapping. Automatically finds the element and taps its center. Requires IDB (brew install idb-companion).",
        inputSchema: {
            label: z
                .string()
                .optional()
                .describe("Exact accessibility label to match (e.g., 'Home', 'Settings')"),
            labelContains: z
                .string()
                .optional()
                .describe("Partial label match, case-insensitive (e.g., 'Circular' matches 'Circulars, 3, 12 total')"),
            index: z
                .number()
                .optional()
                .describe("If multiple elements match, tap the nth one (0-indexed, default: 0)"),
            duration: z
                .number()
                .optional()
                .describe("Optional tap duration in seconds (for long press)"),
            udid: z
                .string()
                .optional()
                .describe("Optional simulator UDID. Uses booted simulator if not specified.")
        }
    },
    async ({ label, labelContains, index, duration, udid }) => {
        const result = await iosTapElement({ label, labelContains, index, duration, udid });

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

// Tool: iOS swipe
server.registerTool(
    "ios_swipe",
    {
        description:
            "Swipe gesture on an iOS simulator screen. Requires IDB to be installed (brew install idb-companion).",
        inputSchema: {
            startX: z.number().describe("Starting X coordinate in pixels"),
            startY: z.number().describe("Starting Y coordinate in pixels"),
            endX: z.number().describe("Ending X coordinate in pixels"),
            endY: z.number().describe("Ending Y coordinate in pixels"),
            duration: z.number().optional().describe("Optional swipe duration in seconds"),
            delta: z.number().optional().describe("Optional delta between touch events (step size)"),
            udid: z
                .string()
                .optional()
                .describe("Optional simulator UDID. Uses booted simulator if not specified.")
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
            udid: z
                .string()
                .optional()
                .describe("Optional simulator UDID. Uses booted simulator if not specified.")
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
            duration: z.number().optional().describe("Optional button press duration in seconds"),
            udid: z
                .string()
                .optional()
                .describe("Optional simulator UDID. Uses booted simulator if not specified.")
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
            keycode: z.number().describe("iOS keycode to send"),
            duration: z.number().optional().describe("Optional key press duration in seconds"),
            udid: z
                .string()
                .optional()
                .describe("Optional simulator UDID. Uses booted simulator if not specified.")
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
            keycodes: z.array(z.number()).describe("Array of iOS keycodes to send in sequence"),
            udid: z
                .string()
                .optional()
                .describe("Optional simulator UDID. Uses booted simulator if not specified.")
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
            udid: z
                .string()
                .optional()
                .describe("Optional simulator UDID. Uses booted simulator if not specified.")
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
            x: z.number().describe("X coordinate in pixels"),
            y: z.number().describe("Y coordinate in pixels"),
            udid: z
                .string()
                .optional()
                .describe("Optional simulator UDID. Uses booted simulator if not specified.")
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

// Tool: Get debug server info
server.registerTool(
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

// Main function
async function main() {
    // Start debug HTTP server for buffer inspection (finds available port automatically)
    await startDebugHttpServer();

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[rn-ai-debugger] Server started on stdio");
}

main().catch((error) => {
    console.error("[rn-ai-debugger] Fatal error:", error);
    process.exit(1);
});
