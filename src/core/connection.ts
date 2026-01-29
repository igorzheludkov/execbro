import WebSocket from "ws";
import { DeviceInfo, RemoteObject, ExceptionDetails, ConnectedApp, NetworkRequest, ConnectOptions, ReconnectionConfig, EnsureConnectionResult, ExecutionResult } from "./types.js";
import { connectedApps, pendingExecutions, getNextMessageId, logBuffer, networkBuffer, setActiveSimulatorUdid, clearActiveSimulatorIfSource } from "./state.js";
import { mapConsoleType } from "./logs.js";
import { findSimulatorByName } from "./ios.js";
import { fetchDevices, selectMainDevice, scanMetroPorts } from "./metro.js";
import {
    DEFAULT_RECONNECTION_CONFIG,
    MIN_STABLE_CONNECTION_MS,
    initConnectionState,
    updateConnectionState,
    getConnectionState,
    recordConnectionGap,
    closeConnectionGap,
    saveConnectionMetadata,
    getConnectionMetadata,
    saveReconnectionTimer,
    cancelReconnectionTimer,
    calculateBackoffDelay,
    initContextHealth,
    markContextHealthy,
    markContextStale,
    getContextHealth,
    updateContextHealth,
    formatDuration,
} from "./connectionState.js";

// Connection locks to prevent concurrent connection attempts to the same device
const connectionLocks: Set<string> = new Set();

// Helper to find appKey from device info by searching connectedApps
function findAppKeyForDevice(device: DeviceInfo): string | null {
    for (const [key, app] of connectedApps.entries()) {
        if (app.deviceInfo.id === device.id) {
            return key;
        }
    }
    return null;
}

// Helper to convert WebSocket readyState to readable name
function getWebSocketStateName(state: number): string {
    switch (state) {
        case WebSocket.CONNECTING: return "CONNECTING";
        case WebSocket.OPEN: return "OPEN";
        case WebSocket.CLOSING: return "CLOSING";
        case WebSocket.CLOSED: return "CLOSED";
        default: return `UNKNOWN(${state})`;
    }
}

// Format CDP RemoteObject to readable string
export function formatRemoteObject(result: RemoteObject): string {
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

// Handle CDP messages
export function handleCDPMessage(message: Record<string, unknown>, _device: DeviceInfo): void {
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

    // Handle Network.requestWillBeSent
    if (method === "Network.requestWillBeSent") {
        const params = message.params as {
            requestId: string;
            request: {
                url: string;
                method: string;
                headers: Record<string, string>;
                postData?: string;
            };
            timestamp?: number;
        };

        const request: NetworkRequest = {
            requestId: params.requestId,
            timestamp: new Date(),
            method: params.request.method,
            url: params.request.url,
            headers: params.request.headers || {},
            postData: params.request.postData,
            timing: {
                requestTime: params.timestamp
            },
            completed: false
        };

        networkBuffer.set(params.requestId, request);
    }

    // Handle Network.responseReceived
    if (method === "Network.responseReceived") {
        const params = message.params as {
            requestId: string;
            response: {
                url: string;
                status: number;
                statusText: string;
                headers: Record<string, string>;
                mimeType?: string;
            };
            timestamp?: number;
        };

        const existing = networkBuffer.get(params.requestId);
        if (existing) {
            existing.status = params.response.status;
            existing.statusText = params.response.statusText;
            existing.responseHeaders = params.response.headers || {};
            existing.mimeType = params.response.mimeType;

            if (params.timestamp && existing.timing?.requestTime) {
                existing.timing.responseTime = params.timestamp;
            }

            networkBuffer.set(params.requestId, existing);
        }
    }

    // Handle Network.loadingFinished
    if (method === "Network.loadingFinished") {
        const params = message.params as {
            requestId: string;
            timestamp?: number;
            encodedDataLength?: number;
        };

        const existing = networkBuffer.get(params.requestId);
        if (existing) {
            existing.completed = true;
            existing.contentLength = params.encodedDataLength;

            if (params.timestamp && existing.timing?.requestTime) {
                existing.timing.duration = Math.round((params.timestamp - existing.timing.requestTime) * 1000);
            }

            networkBuffer.set(params.requestId, existing);
        }
    }

    // Handle Network.loadingFailed
    if (method === "Network.loadingFailed") {
        const params = message.params as {
            requestId: string;
            errorText?: string;
            canceled?: boolean;
        };

        const existing = networkBuffer.get(params.requestId);
        if (existing) {
            existing.completed = true;
            existing.error = params.canceled ? "Canceled" : (params.errorText || "Request failed");

            networkBuffer.set(params.requestId, existing);
        }
    }

    // Handle Runtime context lifecycle events for health tracking
    const appKey = findAppKeyForDevice(_device);
    if (appKey) {
        // Handle Runtime.executionContextCreated
        if (method === "Runtime.executionContextCreated") {
            const params = message.params as { context: { id: number; name?: string } };
            markContextHealthy(appKey, params.context.id);
            console.error(`[rn-ai-debugger] Context created: ${params.context.id}`);
        }

        // Handle Runtime.executionContextDestroyed
        if (method === "Runtime.executionContextDestroyed") {
            markContextStale(appKey);
            console.error(`[rn-ai-debugger] Context destroyed`);
        }

        // Handle Runtime.executionContextsCleared
        if (method === "Runtime.executionContextsCleared") {
            markContextStale(appKey);
            console.error(`[rn-ai-debugger] All contexts cleared`);
        }
    }
}

// Connect to a device via CDP WebSocket
export async function connectToDevice(
    device: DeviceInfo,
    port: number,
    options: ConnectOptions = {}
): Promise<string> {
    const { isReconnection = false, reconnectionConfig = DEFAULT_RECONNECTION_CONFIG } = options;

    return new Promise((resolve, reject) => {
        const appKey = `${port}-${device.id}`;

        // Check if already connected with a valid WebSocket
        const existingApp = connectedApps.get(appKey);
        if (existingApp) {
            if (existingApp.ws.readyState === WebSocket.OPEN) {
                resolve(`Already connected to ${device.title}`);
                return;
            }
            // WebSocket exists but not OPEN - clean up stale entry
            console.error(`[rn-ai-debugger] Cleaning up stale connection for ${device.title} (state: ${getWebSocketStateName(existingApp.ws.readyState)})`);
            connectedApps.delete(appKey);
        }

        // Prevent concurrent connection attempts to the same device
        if (connectionLocks.has(appKey)) {
            resolve(`Connection already in progress for ${device.title}`);
            return;
        }
        connectionLocks.add(appKey);

        // Cancel any pending reconnection timer for this appKey
        cancelReconnectionTimer(appKey);

        // Save connection metadata for potential reconnection
        saveConnectionMetadata(appKey, {
            port,
            deviceInfo: device,
            webSocketUrl: device.webSocketDebuggerUrl
        });

        try {
            const ws = new WebSocket(device.webSocketDebuggerUrl);

            ws.on("open", async () => {
                // Release connection lock
                connectionLocks.delete(appKey);

                connectedApps.set(appKey, { ws, deviceInfo: device, port });

                // Initialize or update connection state
                // Note: We do NOT reset reconnectionAttempts here - that happens
                // only when connection has been stable for MIN_STABLE_CONNECTION_MS
                if (isReconnection) {
                    closeConnectionGap(appKey);
                    updateConnectionState(appKey, {
                        status: "connected",
                        lastConnectedTime: new Date()
                        // reconnectionAttempts NOT reset here - see ws.on("close") for stable connection check
                    });
                    // Reset context health for reconnection
                    initContextHealth(appKey);
                    console.error(`[rn-ai-debugger] Reconnected to ${device.title}`);
                } else {
                    initConnectionState(appKey);
                    initContextHealth(appKey);
                    console.error(`[rn-ai-debugger] Connected to ${device.title}`);
                }

                // Enable Runtime domain to receive console messages
                ws.send(
                    JSON.stringify({
                        id: getNextMessageId(),
                        method: "Runtime.enable"
                    })
                );

                // Also enable Log domain
                ws.send(
                    JSON.stringify({
                        id: getNextMessageId(),
                        method: "Log.enable"
                    })
                );

                // Enable Network domain to track requests
                ws.send(
                    JSON.stringify({
                        id: getNextMessageId(),
                        method: "Network.enable"
                    })
                );

                // Try to resolve iOS simulator UDID from device name
                // This enables automatic device scoping for iOS tools
                if (device.deviceName) {
                    const simulatorUdid = await findSimulatorByName(device.deviceName);
                    if (simulatorUdid) {
                        setActiveSimulatorUdid(simulatorUdid, appKey);
                        console.error(`[rn-ai-debugger] Linked to iOS simulator: ${simulatorUdid}`);
                    }
                }

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
                // Release connection lock if still held
                connectionLocks.delete(appKey);

                connectedApps.delete(appKey);
                // Clear active simulator UDID if this connection set it
                clearActiveSimulatorIfSource(appKey);

                // Check if connection was stable before resetting attempts
                const state = getConnectionState(appKey);
                let wasStable = false;
                if (state?.lastConnectedTime) {
                    const connectionDuration = Date.now() - state.lastConnectedTime.getTime();
                    wasStable = connectionDuration >= MIN_STABLE_CONNECTION_MS;
                    if (wasStable) {
                        // Connection was stable - reset attempts for fresh start
                        updateConnectionState(appKey, { reconnectionAttempts: 0 });
                        console.error(`[rn-ai-debugger] Connection was stable for ${Math.round(connectionDuration / 1000)}s, resetting reconnection attempts`);
                    }
                }

                // Record the gap and trigger reconnection
                recordConnectionGap(appKey, "Connection closed");
                updateConnectionState(appKey, {
                    status: "disconnected",
                    lastDisconnectTime: new Date()
                });

                console.error(`[rn-ai-debugger] Disconnected from ${device.title}`);

                // Schedule auto-reconnection if enabled
                if (reconnectionConfig.enabled) {
                    scheduleReconnection(appKey, reconnectionConfig);
                }
            });

            ws.on("error", (error: Error) => {
                // Release connection lock
                connectionLocks.delete(appKey);

                // Cancel any pending reconnection timer to prevent orphaned loops
                cancelReconnectionTimer(appKey);

                connectedApps.delete(appKey);
                // Clear active simulator UDID if this connection set it
                clearActiveSimulatorIfSource(appKey);

                // Only reject if this is initial connection, not reconnection attempt
                if (!isReconnection) {
                    reject(`Failed to connect to ${device.title}: ${error.message}`);
                } else {
                    console.error(`[rn-ai-debugger] Reconnection error: ${error.message}`);
                }
            });

            // Timeout after 5 seconds
            setTimeout(() => {
                if (ws.readyState !== WebSocket.OPEN) {
                    // Release connection lock on timeout
                    connectionLocks.delete(appKey);
                    ws.terminate();
                    if (!isReconnection) {
                        reject(`Connection to ${device.title} timed out`);
                    }
                }
            }, 5000);
        } catch (error) {
            // Release connection lock on exception
            connectionLocks.delete(appKey);
            if (!isReconnection) {
                reject(`Failed to create WebSocket connection: ${error}`);
            }
        }
    });
}

/**
 * Schedule a reconnection attempt with exponential backoff
 */
function scheduleReconnection(
    appKey: string,
    config: ReconnectionConfig = DEFAULT_RECONNECTION_CONFIG
): void {
    const state = getConnectionState(appKey);
    if (!state) return;

    const attempts = state.reconnectionAttempts;
    if (attempts >= config.maxAttempts) {
        console.error(`[rn-ai-debugger] Max reconnection attempts (${config.maxAttempts}) reached for ${appKey}`);
        updateConnectionState(appKey, { status: "disconnected" });
        return;
    }

    const delay = calculateBackoffDelay(attempts, config);
    console.error(`[rn-ai-debugger] Scheduling reconnection attempt ${attempts + 1}/${config.maxAttempts} in ${delay}ms`);

    updateConnectionState(appKey, {
        status: "reconnecting",
        reconnectionAttempts: attempts + 1
    });

    const timer = setTimeout(() => {
        attemptReconnection(appKey, config);
    }, delay);

    saveReconnectionTimer(appKey, timer);
}

/**
 * Attempt to reconnect to a previously connected device
 */
async function attemptReconnection(
    appKey: string,
    config: ReconnectionConfig = DEFAULT_RECONNECTION_CONFIG
): Promise<boolean> {
    const metadata = getConnectionMetadata(appKey);
    if (!metadata) {
        console.error(`[rn-ai-debugger] No metadata for reconnection: ${appKey}`);
        return false;
    }

    try {
        // Re-fetch devices to get fresh WebSocket URL (may have changed)
        const devices = await fetchDevices(metadata.port);

        // Try to find the same device first, otherwise select main device
        const device = devices.find(d => d.id === metadata.deviceInfo.id)
            || selectMainDevice(devices);

        if (!device) {
            console.error(`[rn-ai-debugger] Device no longer available for ${appKey}`);
            // Schedule next attempt
            scheduleReconnection(appKey, config);
            return false;
        }

        await connectToDevice(device, metadata.port, { isReconnection: true, reconnectionConfig: config });
        return true;
    } catch (error) {
        console.error(`[rn-ai-debugger] Reconnection failed: ${error}`);
        // Schedule next attempt
        scheduleReconnection(appKey, config);
        return false;
    }
}

// Get list of connected apps
export function getConnectedApps(): Array<{
    key: string;
    app: ConnectedApp;
    isConnected: boolean;
}> {
    return Array.from(connectedApps.entries()).map(([key, app]) => ({
        key,
        app,
        isConnected: app.ws.readyState === WebSocket.OPEN
    }));
}

// Get first connected app with an OPEN WebSocket (or null if none)
export function getFirstConnectedApp(): ConnectedApp | null {
    // Find first app with OPEN WebSocket, cleaning up stale entries
    for (const [key, app] of connectedApps.entries()) {
        if (app.ws.readyState === WebSocket.OPEN) {
            return app;
        }
        // Clean up stale entry
        console.error(`[rn-ai-debugger] Cleaning up stale connection in getFirstConnectedApp: ${key} (state: ${getWebSocketStateName(app.ws.readyState)})`);
        connectedApps.delete(key);
    }
    return null;
}

// Check if any app is connected with an OPEN WebSocket
export function hasConnectedApp(): boolean {
    for (const [, app] of connectedApps.entries()) {
        if (app.ws.readyState === WebSocket.OPEN) {
            return true;
        }
    }
    return false;
}

/**
 * Run a quick health check to verify the page context is responsive
 * Returns true if the context can execute code, false otherwise
 */
export async function runQuickHealthCheck(app: ConnectedApp): Promise<boolean> {
    const HEALTH_CHECK_TIMEOUT = 2000;
    const messageId = getNextMessageId();

    return new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
            pendingExecutions.delete(messageId);
            resolve(false);
        }, HEALTH_CHECK_TIMEOUT);

        pendingExecutions.set(messageId, {
            resolve: (result: ExecutionResult) => {
                clearTimeout(timeoutId);
                pendingExecutions.delete(messageId);

                // Update context health tracking
                const appKey = findAppKeyForDevice(app.deviceInfo);
                if (appKey) {
                    updateContextHealth(appKey, {
                        lastHealthCheck: new Date(),
                        lastHealthCheckSuccess: result.success,
                        isStale: !result.success,
                    });
                }

                resolve(result.success);
            },
            timeoutId,
        });

        try {
            app.ws.send(
                JSON.stringify({
                    id: messageId,
                    method: "Runtime.evaluate",
                    params: { expression: "1+1", returnByValue: true },
                })
            );
        } catch {
            clearTimeout(timeoutId);
            pendingExecutions.delete(messageId);
            resolve(false);
        }
    });
}

/**
 * Find the first available Metro port
 */
async function findFirstMetroPort(): Promise<number | null> {
    const ports = await scanMetroPorts();
    return ports.length > 0 ? ports[0] : null;
}

/**
 * Ensure a healthy connection to a React Native app
 * This will verify or establish a connection, optionally running a health check
 */
export async function ensureConnection(options: {
    port?: number;
    healthCheck?: boolean;
    forceRefresh?: boolean;
} = {}): Promise<EnsureConnectionResult> {
    const { port, healthCheck = true, forceRefresh = false } = options;

    let app = getFirstConnectedApp();
    let wasReconnected = false;

    // Force refresh if requested - close existing connection
    if (forceRefresh && app) {
        const appKey = `${app.port}-${app.deviceInfo.id}`;
        cancelReconnectionTimer(appKey);
        try {
            app.ws.close();
        } catch {
            // Ignore close errors
        }
        connectedApps.delete(appKey);
        app = null;
    }

    // Attempt connection if not connected
    if (!app) {
        const targetPort = port ?? await findFirstMetroPort();
        if (!targetPort) {
            return {
                connected: false,
                wasReconnected: false,
                healthCheckPassed: false,
                connectionInfo: null,
                error: "No Metro server found. Make sure Metro bundler is running.",
            };
        }

        const devices = await fetchDevices(targetPort);
        const mainDevice = selectMainDevice(devices);
        if (!mainDevice) {
            return {
                connected: false,
                wasReconnected: false,
                healthCheckPassed: false,
                connectionInfo: null,
                error: `No debuggable devices found on port ${targetPort}. Make sure the app is running.`,
            };
        }

        try {
            await connectToDevice(mainDevice, targetPort);
            app = getFirstConnectedApp();
            wasReconnected = true;
        } catch (error) {
            return {
                connected: false,
                wasReconnected: false,
                healthCheckPassed: false,
                connectionInfo: null,
                error: `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }

    if (!app) {
        return {
            connected: false,
            wasReconnected: false,
            healthCheckPassed: false,
            connectionInfo: null,
            error: "Connection succeeded but app is not available",
        };
    }

    // Run health check if requested
    let healthCheckPassed = true;
    if (healthCheck) {
        healthCheckPassed = await runQuickHealthCheck(app);

        // If health check failed and we haven't just reconnected, try reconnecting
        if (!healthCheckPassed && !wasReconnected) {
            console.error(`[rn-ai-debugger] Health check failed, attempting reconnection...`);

            // Close and reconnect
            const appKey = `${app.port}-${app.deviceInfo.id}`;
            const targetPort = app.port;
            cancelReconnectionTimer(appKey);
            try {
                app.ws.close();
            } catch {
                // Ignore
            }
            connectedApps.delete(appKey);

            // Re-fetch devices and reconnect
            const devices = await fetchDevices(targetPort);
            const mainDevice = selectMainDevice(devices);
            if (mainDevice) {
                try {
                    await connectToDevice(mainDevice, targetPort);
                    app = getFirstConnectedApp();
                    wasReconnected = true;

                    // Re-run health check after reconnection
                    if (app) {
                        healthCheckPassed = await runQuickHealthCheck(app);
                    }
                } catch {
                    // Failed to reconnect
                    healthCheckPassed = false;
                }
            }
        }
    }

    // Build connection info
    const appKey = app ? `${app.port}-${app.deviceInfo.id}` : null;
    const connectionState = appKey ? getConnectionState(appKey) : null;
    const contextHealth = appKey ? getContextHealth(appKey) : null;

    let uptime = "unknown";
    if (connectionState?.lastConnectedTime) {
        const uptimeMs = Date.now() - connectionState.lastConnectedTime.getTime();
        uptime = formatDuration(uptimeMs);
    }

    return {
        connected: app !== null && app.ws.readyState === WebSocket.OPEN,
        wasReconnected,
        healthCheckPassed,
        connectionInfo: app ? {
            deviceTitle: app.deviceInfo.title,
            port: app.port,
            uptime,
            contextId: contextHealth?.contextId ?? null,
        } : null,
    };
}
