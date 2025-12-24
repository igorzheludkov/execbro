#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
    logBuffer,
    networkBuffer,
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
    // Android
    listAndroidDevices,
    androidScreenshot,
    androidInstallApp,
    androidLaunchApp,
    androidListPackages,
    // iOS
    listIOSSimulators,
    iosScreenshot,
    iosInstallApp,
    iosLaunchApp,
    iosOpenUrl,
    iosTerminateApp,
    iosBootSimulator
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
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Screenshot saved to: ${result.result}`
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
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Screenshot saved to: ${result.result}`
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

// Main function
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[rn-ai-debugger] Server started on stdio");
}

main().catch((error) => {
    console.error("[rn-ai-debugger] Fatal error:", error);
    process.exit(1);
});
