import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerToolWithTelemetry } from "../core/register.js";
import {
    scanMetroPorts,
    fetchDevices,
    filterDebuggableDevices,
    connectToDevice,
    ensureConnection,
    getConnectedAppByDevice,
    getConnectedApps,
    getContextHealth,
    getAllConnectionMetadata,
    getAllConnectionStates,
    formatDuration,
    cancelAllReconnectionTimers,
    cancelReconnectionTimer,
    clearAllCDPMessageTimes,
    clearAllConnectionState,
    suppressReconnection,
    clearReconnectionSuppression,
    purgeStaleConnectionsForPorts,
    connectMetroBuildEvents,
    disconnectMetroBuildEvents,
    reloadApp,
    connectedApps,
    isUiDriverAvailable,
    getTotalLogCount,
    suppressReconnectionForKey,
    getWebSocketStateName,
} from "../core/index.js";
import type { DeviceInfo, ConnectionGap } from "../core/index.js";

export function registerConnectionTools(server: McpServer): void {
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
            // Brief settle: if any entry is non-OPEN, wait once for sibling
            // sockets to finish handshaking (e.g. an Android target that
            // connected microseconds after scan_metro returned but isn't
            // yet OPEN). Avoids flapping the listing right after scan_metro.
            let apps = getConnectedApps();
            if (apps.length > 0 && apps.some(({ isConnected }) => !isConnected)) {
                await new Promise((r) => setTimeout(r, 250));
                apps = getConnectedApps();
            }

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

            // Show every tracked entry, marking non-OPEN sockets with their
            // WebSocket state (CONNECTING / CLOSING / CLOSED) so flapping is
            // visible instead of silently filtered out.
            const deviceLines = apps.map(({ app, isConnected }, i) => {
                const name = app.deviceInfo.deviceName || app.deviceInfo.title;
                const appId = app.deviceInfo.appId || app.deviceInfo.title.split(" (")[0] || "unknown";
                const statusSuffix = isConnected
                    ? ""
                    : ` [${getWebSocketStateName(app.ws.readyState).toLowerCase()} — reconnecting]`;
                const lines = [`  ${i + 1}. ${name} — ${appId} (${app.platform}, port ${app.port})${statusSuffix}`];
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
}
