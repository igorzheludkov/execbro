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

  get(count?: number, level?: string): LogEntry[] {
    let filtered = this.logs;

    if (level && level !== "all") {
      filtered = filtered.filter((log) => log.level === level);
    }

    if (count && count > 0) {
      filtered = filtered.slice(-count);
    }

    return filtered;
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
async function scanMetroPorts(
  startPort: number = 8081,
  endPort: number = 19002
): Promise<number[]> {
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
    const devices = await response.json() as DeviceInfo[];
    return devices.filter(d => d.webSocketDebuggerUrl);
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
        console.error(`[metro-logs-mcp] Connected to ${device.title}`);

        // Enable Runtime domain to receive console messages
        ws.send(JSON.stringify({
          id: messageId++,
          method: "Runtime.enable"
        }));

        // Also enable Log domain
        ws.send(JSON.stringify({
          id: messageId++,
          method: "Log.enable"
        }));

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
        console.error(`[metro-logs-mcp] Disconnected from ${device.title}`);
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
function handleCDPMessage(message: Record<string, unknown>, device: DeviceInfo): void {
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
          const props = arg.preview.properties
            .map(p => `${p.name}: ${p.value}`)
            .join(", ");
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
        args: args.map((a) => a.value),
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
        message: params.entry.text || "",
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
  name: "metro-logs-mcp",
  version: "1.0.0",
});

// Tool: Scan for Metro servers
server.registerTool(
  "scan_metro",
  {
    description: "Scan for running Metro bundler servers on common ports",
    inputSchema: {
      startPort: z
        .number()
        .optional()
        .default(8081)
        .describe("Start port for scanning (default: 8081)"),
      endPort: z
        .number()
        .optional()
        .default(19002)
        .describe("End port for scanning (default: 19002)"),
    },
  },
  async ({ startPort, endPort }) => {
    const openPorts = await scanMetroPorts(startPort, endPort);

    if (openPorts.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No Metro servers found. Make sure Metro bundler is running (npm start or expo start).",
          },
        ],
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
      const mainDevice = devices.find(d =>
        // SDK 54+ uses "React Native Bridgeless" in description
        d.description.includes("React Native Bridgeless")
      ) || devices.find(d =>
        // Hermes runtime (RN 0.70+)
        d.title === "Hermes React Native" ||
        d.title.includes("Hermes")
      ) || devices.find(d =>
        // Fallback: any React Native in title, excluding Reanimated/Experimental
        d.title.includes("React Native") &&
        !d.title.includes("Reanimated") &&
        !d.title.includes("Experimental")
      ) || devices[0];

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
          text: `Metro scan results:\n${results.join("\n")}`,
        },
      ],
    };
  }
);

// Tool: Get connected apps
server.registerTool(
  "get_apps",
  {
    description: "List connected React Native apps and Metro server status",
    inputSchema: {},
  },
  async () => {
    const connections = Array.from(connectedApps.entries());

    if (connections.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: 'No apps connected. Run "scan_metro" first to discover and connect to running apps.',
          },
        ],
      };
    }

    const status = connections.map(([key, app]) => {
      const state =
        app.ws.readyState === WebSocket.OPEN ? "Connected" : "Disconnected";
      return `${app.deviceInfo.title} (${app.deviceInfo.deviceName}): ${state}`;
    });

    return {
      content: [
        {
          type: "text",
          text: `Connected apps:\n${status.join("\n")}\n\nTotal logs in buffer: ${logBuffer.size}`,
        },
      ],
    };
  }
);

// Tool: Get console logs
server.registerTool(
  "get_logs",
  {
    description: "Retrieve console logs from connected React Native app",
    inputSchema: {
      maxLogs: z
        .number()
        .optional()
        .default(50)
        .describe("Maximum number of logs to return (default: 50)"),
      level: z
        .enum(["all", "log", "warn", "error", "info", "debug"])
        .optional()
        .default("all")
        .describe("Filter by log level (default: all)"),
    },
  },
  async ({ maxLogs, level }) => {
    const logs = logBuffer.get(maxLogs, level);
    const formatted = formatLogs(logs);

    return {
      content: [
        {
          type: "text",
          text: `React Native Console Logs (${logs.length} entries):\n\n${formatted}`,
        },
      ],
    };
  }
);

// Tool: Clear logs
server.registerTool(
  "clear_logs",
  {
    description: "Clear the log buffer",
    inputSchema: {},
  },
  async () => {
    const count = logBuffer.size;
    logBuffer.clear();

    return {
      content: [
        {
          type: "text",
          text: `Cleared ${count} log entries from buffer.`,
        },
      ],
    };
  }
);

// Tool: Connect to specific Metro port
server.registerTool(
  "connect_metro",
  {
    description: "Connect to a specific Metro server port",
    inputSchema: {
      port: z
        .number()
        .default(8081)
        .describe("Metro server port (default: 8081)"),
    },
  },
  async ({ port }) => {
    try {
      const devices = await fetchDevices(port);
      if (devices.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No devices found on port ${port}. Make sure the app is running.`,
            },
          ],
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
            text: results.join("\n"),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to connect: ${error}`,
          },
        ],
      };
    }
  }
);

// Main function
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[metro-logs-mcp] Server started on stdio");
}

main().catch((error) => {
  console.error("[metro-logs-mcp] Fatal error:", error);
  process.exit(1);
});
