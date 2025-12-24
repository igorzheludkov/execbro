#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import WebSocket from "ws";
import * as net from "net";

// Log entry interface
interface LogEntry {
    timestamp: Date;
    level: "log" | "warn" | "error" | "info" | "debug";
    message: string;
    args?: unknown[];
}

// Device info from /json endpoint
interface DeviceInfo {
    id: string;
    title: string;
    description: string;
    appId: string;
    type: string;
    webSocketDebuggerUrl: string;
    deviceName: string;
}

// Connected app info
interface ConnectedApp {
    ws: WebSocket;
    deviceInfo: DeviceInfo;
    port: number;
}

// CDP RemoteObject type (result of Runtime.evaluate)
interface RemoteObject {
    type: "object" | "function" | "undefined" | "string" | "number" | "boolean" | "symbol" | "bigint";
    subtype?:
        | "array"
        | "null"
        | "node"
        | "regexp"
        | "date"
        | "map"
        | "set"
        | "weakmap"
        | "weakset"
        | "iterator"
        | "generator"
        | "error"
        | "proxy"
        | "promise"
        | "typedarray"
        | "arraybuffer"
        | "dataview";
    className?: string;
    value?: unknown;
    unserializableValue?: string;
    description?: string;
    objectId?: string;
}

// CDP Exception details
interface ExceptionDetails {
    exceptionId: number;
    text: string;
    lineNumber: number;
    columnNumber: number;
    exception?: RemoteObject;
}

// Pending execution tracker
interface PendingExecution {
    resolve: (result: { success: boolean; result?: string; error?: string }) => void;
    timeoutId: NodeJS.Timeout;
}

// Circular buffer for storing logs
class LogBuffer {
    private logs: LogEntry[] = [];
    private maxSize: number;

    constructor(maxSize: number = 1000) {
        this.maxSize = maxSize;
    }

    add(entry: LogEntry): void {
        this.logs.push(entry);
        if (this.logs.length > this.maxSize) {
            this.logs.shift();
        }
    }

    get(count?: number, level?: string, startFromText?: string): LogEntry[] {
        let filtered = this.logs;

        // If startFromText is provided, find the LAST matching line and start from there
        if (startFromText) {
            let startIndex = -1;
            for (let i = filtered.length - 1; i >= 0; i--) {
                if (filtered[i].message.includes(startFromText)) {
                    startIndex = i;
                    break;
                }
            }
            if (startIndex !== -1) {
                filtered = filtered.slice(startIndex);
            }
        }

        if (level && level !== "all") {
            filtered = filtered.filter((log) => log.level === level);
        }

        if (count && count > 0) {
            filtered = filtered.slice(0, count);
        }

        return filtered;
    }

    search(text: string): LogEntry[] {
        return this.logs.filter((log) => log.message.toLowerCase().includes(text.toLowerCase()));
    }

    clear(): void {
        this.logs = [];
    }

    get size(): number {
        return this.logs.length;
    }
}

// Global log buffer
const logBuffer = new LogBuffer(1000);

// Connected apps
const connectedApps: Map<string, ConnectedApp> = new Map();

// Pending code executions (for executeInApp)
const pendingExecutions: Map<number, PendingExecution> = new Map();

// Format CDP RemoteObject to readable string
function formatRemoteObject(result: RemoteObject): string {
    if (result.type === "undefined") {
        return "undefined";
    }

    if (result.subtype === "null") {
        return "null";
    }

    // For objects/arrays with a value, stringify it
    if (result.value !== undefined) {
        if (typeof result.value === "object") {
            return JSON.stringify(result.value, null, 2);
        }
        return String(result.value);
    }

    // Use description for complex objects
    if (result.description) {
        return result.description;
    }

    // Handle unserializable values (NaN, Infinity, etc.)
    if (result.unserializableValue) {
        return result.unserializableValue;
    }

    return `[${result.type}${result.subtype ? ` ${result.subtype}` : ""}]`;
}

// Execute JavaScript in the connected React Native app
async function executeInApp(
    expression: string,
    awaitPromise: boolean = true
): Promise<{ success: boolean; result?: string; error?: string }> {
    // Get the first connected app
    const apps = Array.from(connectedApps.values());
    if (apps.length === 0) {
        return { success: false, error: "No apps connected. Run 'scan_metro' first." };
    }

    const app = apps[0];
    if (app.ws.readyState !== WebSocket.OPEN) {
        return { success: false, error: "WebSocket connection is not open." };
    }

    const TIMEOUT_MS = 10000;
    const currentMessageId = messageId++;

    return new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
            pendingExecutions.delete(currentMessageId);
            resolve({ success: false, error: "Timeout: Expression took too long to evaluate" });
        }, TIMEOUT_MS);

        pendingExecutions.set(currentMessageId, { resolve, timeoutId });

        app.ws.send(
            JSON.stringify({
                id: currentMessageId,
                method: "Runtime.evaluate",
                params: {
                    expression,
                    returnByValue: true,
                    awaitPromise,
                    userGesture: true,
                    generatePreview: true
                }
            })
        );
    });
}

// Common Metro ports
const COMMON_PORTS = [8081, 8082, 19000, 19001, 19002];

// CDP message ID counter
let messageId = 1;

// Check if a port is open
async function isPortOpen(port: number, host: string = "localhost"): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(1000);

        socket.on("connect", () => {
            socket.destroy();
            resolve(true);
        });

        socket.on("timeout", () => {
            socket.destroy();
            resolve(false);
        });

        socket.on("error", () => {
            socket.destroy();
            resolve(false);
        });

        socket.connect(port, host);
    });
}

// Scan for running Metro servers
async function scanMetroPorts(startPort: number = 8081, endPort: number = 19002): Promise<number[]> {
    const portsToCheck =
        startPort === 8081 && endPort === 19002
            ? COMMON_PORTS
            : Array.from({ length: endPort - startPort + 1 }, (_, i) => startPort + i);

    const openPorts: number[] = [];

    for (const port of portsToCheck) {
        if (await isPortOpen(port)) {
            openPorts.push(port);
        }
    }

    return openPorts;
}

// Fetch connected devices from Metro /json endpoint
async function fetchDevices(port: number): Promise<DeviceInfo[]> {
    try {
        const response = await fetch(`http://localhost:${port}/json`);
        if (!response.ok) {
            return [];
        }
        const devices = (await response.json()) as DeviceInfo[];
        return devices.filter((d) => d.webSocketDebuggerUrl);
    } catch {
        return [];
    }
}

// Connect to a device via CDP WebSocket
async function connectToDevice(device: DeviceInfo, port: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const appKey = `${port}-${device.id}`;

        if (connectedApps.has(appKey)) {
            resolve(`Already connected to ${device.title}`);
            return;
        }

        try {
            const ws = new WebSocket(device.webSocketDebuggerUrl);

            ws.on("open", () => {
                connectedApps.set(appKey, { ws, deviceInfo: device, port });
                console.error(`[rn-ai-debugger] Connected to ${device.title}`);

                // Enable Runtime domain to receive console messages
                ws.send(
                    JSON.stringify({
                        id: messageId++,
                        method: "Runtime.enable"
                    })
                );

                // Also enable Log domain
                ws.send(
                    JSON.stringify({
                        id: messageId++,
                        method: "Log.enable"
                    })
                );

                resolve(`Connected to ${device.title} (${device.deviceName})`);
            });

            ws.on("message", (data: WebSocket.Data) => {
                try {
                    const message = JSON.parse(data.toString());
                    handleCDPMessage(message, device);
                } catch {
                    // Ignore non-JSON messages
                }
            });

            ws.on("close", () => {
                connectedApps.delete(appKey);
                console.error(`[rn-ai-debugger] Disconnected from ${device.title}`);
            });

            ws.on("error", (error: Error) => {
                connectedApps.delete(appKey);
                reject(`Failed to connect to ${device.title}: ${error.message}`);
            });

            // Timeout after 5 seconds
            setTimeout(() => {
                if (ws.readyState !== WebSocket.OPEN) {
                    ws.terminate();
                    reject(`Connection to ${device.title} timed out`);
                }
            }, 5000);
        } catch (error) {
            reject(`Failed to create WebSocket connection: ${error}`);
        }
    });
}

// Handle CDP messages
function handleCDPMessage(message: Record<string, unknown>, _device: DeviceInfo): void {
    // Handle responses to our requests (e.g., Runtime.evaluate)
    if (typeof message.id === "number") {
        const pending = pendingExecutions.get(message.id);
        if (pending) {
            clearTimeout(pending.timeoutId);
            pendingExecutions.delete(message.id);

            // Check for error
            if (message.error) {
                const error = message.error as { message: string };
                pending.resolve({ success: false, error: error.message });
                return;
            }

            // Check for exception in result
            const result = message.result as
                | {
                      result?: RemoteObject;
                      exceptionDetails?: ExceptionDetails;
                  }
                | undefined;

            if (result?.exceptionDetails) {
                const exception = result.exceptionDetails;
                const errorMessage = exception.exception?.description || exception.text;
                pending.resolve({ success: false, error: errorMessage });
                return;
            }

            // Success - format the result
            if (result?.result) {
                pending.resolve({ success: true, result: formatRemoteObject(result.result) });
                return;
            }

            pending.resolve({ success: true, result: "undefined" });
        }
        return;
    }

    const method = message.method as string;

    // Handle Runtime.consoleAPICalled
    if (method === "Runtime.consoleAPICalled") {
        const params = message.params as {
            type?: string;
            args?: Array<{
                type?: string;
                value?: unknown;
                description?: string;
                preview?: { properties?: Array<{ name: string; value: string }> };
            }>;
            timestamp?: number;
        };

        const type = params.type || "log";
        const level = mapConsoleType(type);
        const args = params.args || [];

        const messageText = args
            .map((arg) => {
                if (arg.type === "string" || arg.type === "number" || arg.type === "boolean") {
                    return String(arg.value);
                }
                if (arg.description) {
                    return arg.description;
                }
                if (arg.preview?.properties) {
                    const props = arg.preview.properties.map((p) => `${p.name}: ${p.value}`).join(", ");
                    return `{${props}}`;
                }
                if (arg.value !== undefined) {
                    return JSON.stringify(arg.value);
                }
                return "[object]";
            })
            .join(" ");

        if (messageText.trim()) {
            logBuffer.add({
                timestamp: new Date(),
                level,
                message: messageText,
                args: args.map((a) => a.value)
            });
        }
    }

    // Handle Log.entryAdded
    if (method === "Log.entryAdded") {
        const params = message.params as {
            entry?: {
                level?: string;
                text?: string;
                timestamp?: number;
            };
        };

        if (params.entry) {
            const level = mapConsoleType(params.entry.level || "log");
            logBuffer.add({
                timestamp: new Date(),
                level,
                message: params.entry.text || ""
            });
        }
    }
}

// Map console type to log level
function mapConsoleType(type: string): LogEntry["level"] {
    switch (type) {
        case "error":
            return "error";
        case "warning":
        case "warn":
            return "warn";
        case "info":
            return "info";
        case "debug":
            return "debug";
        default:
            return "log";
    }
}

// Format logs for output
function formatLogs(logs: LogEntry[]): string {
    if (logs.length === 0) {
        return "No logs captured yet. Make sure Metro is running and the app is connected.";
    }

    return logs
        .map((log) => {
            const time = log.timestamp.toLocaleTimeString();
            const levelTag = `[${log.level.toUpperCase()}]`;
            return `${time} ${levelTag} ${log.message}`;
        })
        .join("\n");
}

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

            // Select the main JS runtime device (priority order)
            const mainDevice =
                devices.find((d) =>
                    // SDK 54+ uses "React Native Bridgeless" in description
                    d.description.includes("React Native Bridgeless")
                ) ||
                devices.find(
                    (d) =>
                        // Hermes runtime (RN 0.70+)
                        d.title === "Hermes React Native" || d.title.includes("Hermes")
                ) ||
                devices.find(
                    (d) =>
                        // Fallback: any React Native in title, excluding Reanimated/Experimental
                        d.title.includes("React Native") &&
                        !d.title.includes("Reanimated") &&
                        !d.title.includes("Experimental")
                ) ||
                devices[0];

            try {
                const connectionResult = await connectToDevice(mainDevice, port);
                results.push(`  - ${connectionResult}`);
            } catch (error) {
                results.push(`  - Failed: ${error}`);
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
        const connections = Array.from(connectedApps.entries());

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

        const status = connections.map(([_key, app]) => {
            const state = app.ws.readyState === WebSocket.OPEN ? "Connected" : "Disconnected";
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
        const logs = logBuffer.get(maxLogs, level, startFromText);
        const formatted = formatLogs(logs);

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
        const logs = logBuffer.search(text).slice(0, maxResults);
        const formatted = formatLogs(logs);

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
        const count = logBuffer.size;
        logBuffer.clear();

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
        const expression = `
            (function() {
                const globals = Object.keys(globalThis);
                const categories = {
                    'Apollo Client': globals.filter(k => k.includes('APOLLO')),
                    'Redux': globals.filter(k => k.includes('REDUX')),
                    'React DevTools': globals.filter(k => k.includes('REACT_DEVTOOLS')),
                    'Reanimated': globals.filter(k => k.includes('reanimated') || k.includes('worklet')),
                    'Expo': globals.filter(k => k.includes('Expo') || k.includes('expo')),
                    'Metro': globals.filter(k => k.includes('METRO')),
                    'Other Debug': globals.filter(k => k.startsWith('__') && !k.includes('APOLLO') && !k.includes('REDUX') && !k.includes('REACT_DEVTOOLS') && !k.includes('reanimated') && !k.includes('worklet') && !k.includes('Expo') && !k.includes('expo') && !k.includes('METRO'))
                };
                return categories;
            })()
        `;

        const result = await executeInApp(expression, false);

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
        const expression = `
            (function() {
                const obj = ${objectName};
                if (obj === undefined) return { error: 'Object not found' };
                const result = {};
                for (const key of Object.keys(obj)) {
                    const val = obj[key];
                    const type = typeof val;
                    if (type === 'function') {
                        result[key] = { type: 'function', callable: true };
                    } else if (type === 'object' && val !== null) {
                        result[key] = { type: Array.isArray(val) ? 'array' : 'object', callable: false, preview: JSON.stringify(val).slice(0, 100) };
                    } else {
                        result[key] = { type, callable: false, value: val };
                    }
                }
                return result;
            })()
        `;

        const result = await executeInApp(expression, false);

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
