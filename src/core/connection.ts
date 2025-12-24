import WebSocket from "ws";
import { DeviceInfo, RemoteObject, ExceptionDetails, ConnectedApp, NetworkRequest } from "./types.js";
import { connectedApps, pendingExecutions, getNextMessageId, logBuffer, networkBuffer } from "./state.js";
import { mapConsoleType } from "./logs.js";

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
}

// Connect to a device via CDP WebSocket
export async function connectToDevice(device: DeviceInfo, port: number): Promise<string> {
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

// Get first connected app (or null if none)
export function getFirstConnectedApp(): ConnectedApp | null {
    const apps = Array.from(connectedApps.values());
    if (apps.length === 0) {
        return null;
    }
    return apps[0];
}

// Check if any app is connected
export function hasConnectedApp(): boolean {
    return connectedApps.size > 0;
}
