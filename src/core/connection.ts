import WebSocket from "ws";
import { DeviceInfo, RemoteObject, ExceptionDetails, ConnectedApp, NetworkRequest, ConnectOptions, ReconnectionConfig, EnsureConnectionResult, ExecutionResult, ConnectionCheckResult } from "./types.js";
import { connectedApps, pendingExecutions, failPendingExecutionsForSocket, getNextMessageId, getEpoch, bumpEpoch, getLogBuffer, getNetworkBuffer, logBuffers, networkBuffers, setActiveSimulatorUdid, clearActiveSimulatorIfSource, updateLastCDPMessageTime, getLastCDPMessageTime, clearLastCDPMessageTime, clearAllCDPMessageTimes } from "./state.js";
import { mapConsoleType, LogBuffer } from "./logs.js";
import { injectNetworkInterceptor, sendNetworkEnable, isInterceptorEvent, applyInterceptedEvent, pushMockRules, isMockEvent, isMockedTrafficEvent } from "./networkInterceptor.js";
import { serializeRules } from "./mockRules.js";
import { findSimulatorByName } from "./ios.js";
import { captureStack } from "./logStack.js";
import { getAdbIdForAvd } from "./android.js";
import { fetchDevices, selectMainDevice, scanMetroPorts } from "./metro.js";
import { probeCdpAlive } from "./probe.js";
import { UserInputError } from "./errors.js";
import { scheduleAppDetection } from "./appDetection.js";
import { markConnectionEstablished } from "./jsExecute.js";
import { startSdkMirrorPoller, stopSdkMirrorPoller } from "./sdkMirrorPoller.js";
import {
    DEFAULT_RECONNECTION_CONFIG,
    MIN_STABLE_CONNECTION_MS,
    initConnectionState,
    updateConnectionState,
    getConnectionState,
    recordConnectionGap,
    closeConnectionGap,
    saveConnectionMetadata,
    clearConnectionMetadata,
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
    recordConnectionEvent,
} from "./connectionState.js";

// Connection locks to prevent concurrent connection attempts to the same device
const connectionLocks: Set<string> = new Set();

// Last CDP target id seen per device name, used to detect app relaunches.
const lastTargetIdByDevice = new Map<string, string>();

/**
 * Every device name that has been connected at any point in this server
 * session, with the time it was last seen. Never pruned on disconnect — that is
 * the whole point.
 *
 * A name that worked for a dozen calls and then stopped is a *disconnect*, not
 * a typo, but the resolver could not tell the two apart and reported both as
 * "no connected device matches". The natural response to that wording is to
 * re-check the spelling, which is exactly the wrong move: the spelling is fine
 * and the device is gone.
 */
const devicesSeenThisSession = new Map<string, number>();

/** Record a device name as having been connected. Called on every successful attach. */
export function recordDeviceSeen(name: string | null | undefined): void {
    const key = (name || "").trim();
    if (key) devicesSeenThisSession.set(key, Date.now());
}

/**
 * The session-seen name matching `device`, or null. Uses the same normalized
 * substring rule as live resolution, so a name that *would* have matched while
 * the device was attached is recognised as the same device now that it is not.
 */
export function findDisconnectedDeviceName(device: string): { name: string; lastSeenAt: number } | null {
    const needle = normalizeDeviceId(device);
    if (!needle) return null;
    for (const [name, lastSeenAt] of devicesSeenThisSession.entries()) {
        const norm = normalizeDeviceId(name);
        if (norm.includes(needle) || needle.includes(norm)) return { name, lastSeenAt };
    }
    return null;
}

/** Test seam: forget every session-seen device. */
export function resetDevicesSeenThisSession(): void {
    devicesSeenThisSession.clear();
}

// Track Network.enable message IDs to detect CDP network support
const pendingNetworkEnableIds: Set<number> = new Set();

// Track SDK-probe message IDs so we can decode their responses and set
// app.sdkPresent. The probe runs on connect and then periodically because
// the SDK's init() may execute after we attach.
const pendingSdkProbeIds: Map<number, string> = new Map(); // msgId -> appKey
const SDK_PROBE_INITIAL_DELAY_MS = 200;
const SDK_PROBE_INTERVAL_MS = 3000;
// Consecutive SDK-absent probes required to flip sdkPresent true→false.
// Hysteresis against the post-reload window where the JS context exists but
// the SDK's init() hasn't re-run yet (see ConnectedApp.sdkMissCount).
const SDK_ABSENCE_CONFIRM_COUNT = 2;
// Fast re-probe schedule after a context is (re)created, so the SDK is
// re-detected within a few hundred ms instead of waiting up to a full
// SDK_PROBE_INTERVAL_MS tick. Covers reloads not driven by reload_app
// (shake-to-reload, Metro "r").
const SDK_REPROBE_DELAYS_MS = [200, 500, 1000, 2000];

function sendSdkProbe(ws: WebSocket, appKey: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const id = getNextMessageId();
    pendingSdkProbeIds.set(id, appKey);
    try {
        ws.send(
            JSON.stringify({
                id,
                method: "Runtime.evaluate",
                params: {
                    expression: 'typeof (globalThis.__EXECBRO__ ?? globalThis.__RN_AI_DEVTOOLS__)?.getNetworkEntries === "function"',
                    returnByValue: true
                }
            })
        );
    } catch {
        pendingSdkProbeIds.delete(id);
    }
}

function startSdkProbeLoop(ws: WebSocket, appKey: string): void {
    const initial = setTimeout(() => sendSdkProbe(ws, appKey), SDK_PROBE_INITIAL_DELAY_MS);
    const interval = setInterval(() => {
        const app = connectedApps.get(appKey);
        if (!app || ws.readyState !== WebSocket.OPEN) {
            clearInterval(interval);
            return;
        }
        sendSdkProbe(ws, appKey);
    }, SDK_PROBE_INTERVAL_MS);
    const app = connectedApps.get(appKey);
    if (app) {
        app.sdkProbeTimer = interval;
    }
    // Best-effort cleanup if the socket closes before the initial probe fires
    ws.once("close", () => {
        clearTimeout(initial);
        clearInterval(interval);
    });
}

// Fire a burst of SDK probes on the heels of a (re)created execution context.
// After a reload the context is recreated but the SDK's init() re-runs slightly
// later; without this, sdkPresent only recovers on the next 3s interval tick,
// widening the window where get_network_requests falls off the SDK buffer.
function scheduleFastSdkReprobe(ws: WebSocket, appKey: string): void {
    for (const delay of SDK_REPROBE_DELAYS_MS) {
        const t = setTimeout(() => {
            if (!connectedApps.has(appKey) || ws.readyState !== WebSocket.OPEN) return;
            sendSdkProbe(ws, appKey);
        }, delay);
        ws.once("close", () => clearTimeout(t));
    }
}

// Write the JS interceptor's emit flag into the app. The flag lives on
// globalThis, so its lifetime is the execution context's — shorter than the
// CDP connection's. Every write site must therefore be a *context* event or a
// detection edge, never one alone: an in-app reload (DevSettings.reload(),
// ⌘R, Fast Refresh full reload) recreates the context without dropping the
// connection, and the SDK-presence edge detector — held true across that
// window by SDK_ABSENCE_CONFIRM_COUNT hysteresis — sees no edge to act on.
// Fire-and-forget; the flag is idempotent and the next probe edge retries.
function sendNetSuppressionFlag(ws: WebSocket, disabled: boolean): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
        ws.send(
            JSON.stringify({
                id: getNextMessageId(),
                method: "Runtime.evaluate",
                params: {
                    expression: `globalThis.__RN_NET_DISABLED__ = ${disabled ? "true" : "false"}`,
                    returnByValue: true
                }
            })
        );
    } catch {
        // ignore — next probe will retry
    }
}

// Suppress auto-reconnection for intentionally disconnected devices
const reconnectionSuppressed: Set<string> = new Set();

/**
 * Suppress auto-reconnection for all current connections.
 * Used by disconnect_metro to prevent close handlers from re-connecting.
 */
export function suppressReconnection(): void {
    for (const key of connectedApps.keys()) {
        reconnectionSuppressed.add(key);
    }
}

/**
 * Suppress auto-reconnection for a specific connection key.
 * Used by disconnect_metro with device targeting.
 */
export function suppressReconnectionForKey(appKey: string): void {
    reconnectionSuppressed.add(appKey);
}

/**
 * Clear reconnection suppression (called when user explicitly reconnects via scan_metro).
 */
export function clearReconnectionSuppression(): void {
    reconnectionSuppressed.clear();
}

const STALE_ACTIVITY_THRESHOLD_MS = 30_000;
const PING_INTERVAL_MS = 1_000; // WebSocket ping/pong keepalive interval

/**
 * Max time (ms) to wait for a Runtime.evaluate("1+1") reply during liveness probing.
 * Tight budget: live targets respond in under 50ms; zombie CDP targets never respond.
 */
const PROBE_TIMEOUT_MS = 1500;
const RECONNECT_SETTLE_MS = 500;

/**
 * Creates a WebSocket connection with Origin header fallback.
 * RN 0.85+ Metro requires the Origin header, but Expo SDK 55 Bridgeless
 * rejects connections that include one. The rejection can manifest as:
 *   - Connection refused before open (error/close before open event)
 *   - Immediate close after open (open fires, then close with code 1006)
 * Tries with Origin first, falls back to without on quick failure.
 */
export function createWebSocketWithOriginFallback(url: string, timeoutMs = 5000): Promise<WebSocket> {
    const STABILIZE_MS = 500; // Wait after open to detect immediate close

    return new Promise((resolve, reject) => {
        const wsUrl = new URL(url);
        const origin = `http://${wsUrl.hostname}:${wsUrl.port}`;
        let settled = false;

        const tryConnect = (withOrigin: boolean) => {
            const options = withOrigin ? { headers: { Origin: origin } } : undefined;
            const ws = new WebSocket(url, options);
            let opened = false;

            ws.on("open", () => {
                opened = true;
                if (withOrigin) {
                    // Wait briefly to detect immediate close (Expo SDK 55 pattern)
                    setTimeout(() => {
                        if (settled) return;
                        if (ws.readyState === WebSocket.OPEN) {
                            settled = true;
                            console.error("[execbro] WebSocket connected with Origin header");
                            resolve(ws);
                        }
                        // If not OPEN, the close handler will trigger fallback
                    }, STABILIZE_MS);
                } else {
                    if (settled) return;
                    settled = true;
                    console.error("[execbro] WebSocket connected without Origin header");
                    resolve(ws);
                }
            });

            const handleFailure = (error?: Error) => {
                if (settled) return;
                ws.removeAllListeners();
                ws.terminate();
                if (withOrigin) {
                    const reason = opened ? "immediately closed after open" : "rejected before open";
                    console.error(`[execbro] Origin header connection ${reason}, retrying without...`);
                    tryConnect(false);
                } else {
                    settled = true;
                    reject(error || new Error("WebSocket connection failed"));
                }
            };

            ws.on("error", (err: Error) => handleFailure(err));
            ws.on("close", () => handleFailure());
        };

        tryConnect(true);

        setTimeout(() => {
            if (!settled) {
                settled = true;
                reject(new Error("WebSocket connection timed out"));
            }
        }, timeoutMs);
    });
}

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
export function getWebSocketStateName(state: number): string {
    switch (state) {
        case WebSocket.CONNECTING: return "CONNECTING";
        case WebSocket.OPEN: return "OPEN";
        case WebSocket.CLOSING: return "CLOSING";
        case WebSocket.CLOSED: return "CLOSED";
        default: return `UNKNOWN(${state})`;
    }
}

/**
 * Purge stale connections for scanned ports.
 * When Metro restarts with a different app, /json returns new device IDs.
 * Old connections keyed by the previous device IDs remain in connectedApps.
 * This function removes connections on scanned ports whose device IDs
 * are no longer present in the fresh device list from Metro.
 */
export function purgeStaleConnectionsForPorts(
    freshDevicesByPort: Map<number, DeviceInfo[]>
): string[] {
    const purged: string[] = [];
    const scannedPorts = new Set(freshDevicesByPort.keys());

    for (const [appKey, app] of connectedApps.entries()) {
        // Only check connections on ports we just scanned
        if (!scannedPorts.has(app.port)) continue;

        const freshDevices = freshDevicesByPort.get(app.port) || [];
        // Check both device ID and appId — device IDs are per-physical-device
        // (stable across Metro restarts), so a different app on the same device
        // would have the same ID but a different appId
        const matchingDevice = freshDevices.find(d => d.id === app.deviceInfo.id);
        const stillValid = matchingDevice && matchingDevice.appId === app.deviceInfo.appId;

        if (!stillValid) {
            const name = app.deviceInfo.deviceName || app.deviceInfo.title;
            const reason = !matchingDevice
                ? "device no longer in Metro /json"
                : `appId changed: ${app.deviceInfo.appId} → ${matchingDevice.appId}`;
            console.error(`[execbro] Purging stale connection: ${name} (port ${app.port}, id ${app.deviceInfo.id}) — ${reason}`);

            // Suppress reconnection so close handler doesn't try to reconnect
            reconnectionSuppressed.add(appKey);
            cancelReconnectionTimer(appKey);
            clearLastCDPMessageTime(appKey);
            clearActiveSimulatorIfSource(appKey);

            try { app.ws.close(); } catch { /* ignore */ }
            connectedApps.delete(appKey);

            purged.push(name);
        }
    }

    return purged;
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

/**
 * Extract a clean, informative error message from CDP exception details
 * Handles various error formats from Hermes and other JS engines
 */
function extractExceptionMessage(exceptionDetails: ExceptionDetails): string {
    const parts: string[] = [];

    // Get the exception object if available
    const exc = exceptionDetails.exception;

    if (exc) {
        // For error objects, className tells us the error type (ReferenceError, TypeError, etc.)
        const errorType = exc.className || (exc.subtype === 'error' ? 'Error' : '');

        // The description usually contains "ErrorType: message" or full stack trace
        // We want to extract just the first line (the actual error message)
        if (exc.description) {
            const firstLine = exc.description.split('\n')[0].trim();

            // If description already includes the error type, use it directly
            if (firstLine.includes(':')) {
                parts.push(firstLine);
            } else if (errorType) {
                // Combine error type with description
                parts.push(`${errorType}: ${firstLine}`);
            } else {
                parts.push(firstLine);
            }
        } else if (exc.value !== undefined) {
            // For primitive exceptions (throw "string" or throw 123)
            const valueStr = typeof exc.value === 'string' ? exc.value : JSON.stringify(exc.value);
            if (errorType) {
                parts.push(`${errorType}: ${valueStr}`);
            } else {
                parts.push(valueStr);
            }
        } else if (errorType) {
            // Just the error type, no message
            parts.push(errorType);
        }
    }

    // Fall back to exceptionDetails.text if we couldn't extract from exception object
    // But avoid just "Uncaught" which is not helpful
    if (parts.length === 0) {
        const text = exceptionDetails.text;
        if (text && text.toLowerCase() !== 'uncaught') {
            parts.push(text);
        }
    }

    // Add location info for syntax/compilation errors (helps identify the problem)
    if (exceptionDetails.lineNumber !== undefined && exceptionDetails.columnNumber !== undefined) {
        // Only add location if it's meaningful (not 0:0 which is often just wrapper)
        if (exceptionDetails.lineNumber > 0 || exceptionDetails.columnNumber > 0) {
            parts.push(`at line ${exceptionDetails.lineNumber}:${exceptionDetails.columnNumber}`);
        }
    }

    // If we still have nothing, provide a generic message
    if (parts.length === 0) {
        return 'JavaScript execution failed (no error details available)';
    }

    return parts.join(' ');
}

// CDP console argument type
interface CDPConsoleArg {
    type?: string;
    subtype?: string;
    value?: unknown;
    description?: string;
    objectId?: string;
    preview?: CDPObjectPreview;
}

// CDP object preview (used for objects, arrays, etc.)
interface CDPObjectPreview {
    type?: string;
    subtype?: string;
    description?: string;
    overflow?: boolean;
    properties?: Array<{
        name: string;
        type?: string;
        value?: string;
        subtype?: string;
        valuePreview?: CDPObjectPreview;
    }>;
}

// Format a CDP object preview recursively
function formatPreview(preview: CDPObjectPreview): string {
    const isArray = preview.subtype === "array";
    const props = preview.properties || [];

    const formatted = props.map((p) => {
        let value: string;
        if (p.valuePreview) {
            value = formatPreview(p.valuePreview);
        } else if (p.subtype === "null") {
            value = "null";
        } else if (p.type === "string") {
            value = `"${p.value}"`;
        } else {
            value = p.value ?? "undefined";
        }
        return isArray ? value : `${p.name}: ${value}`;
    });

    const overflow = preview.overflow ? ", ..." : "";
    return isArray
        ? `[${formatted.join(", ")}${overflow}]`
        : `{${formatted.join(", ")}${overflow}}`;
}

// Format a single CDP console argument (sync — without object resolution)
function formatConsoleArg(arg: CDPConsoleArg): string {
    // Explicit undefined (matches browser: console.log(undefined) → "undefined")
    if (arg.type === "undefined") {
        return "undefined";
    }

    // Primitives
    if (arg.type === "string" || arg.type === "number" || arg.type === "boolean") {
        return String(arg.value);
    }

    // Objects/arrays with preview — expand inline
    if (arg.preview?.properties) {
        return formatPreview(arg.preview);
    }

    // Raw value (e.g. null sent as value)
    if (arg.value !== undefined) {
        return JSON.stringify(arg.value);
    }

    // Description fallback (functions, symbols, errors without preview)
    if (arg.description) {
        return arg.description;
    }

    // Object without any resolved data
    if (arg.type === "object") {
        return "[Object]";
    }

    return `[${arg.type || "unknown"}]`;
}

// Fetch object properties via CDP Runtime.getProperties
function fetchObjectProperties(ws: WebSocket, objectId: string, depth: number = 2): Promise<string> {
    return new Promise((resolve) => {
        const msgId = getNextMessageId();
        const timeout = setTimeout(() => {
            resolve("Object"); // Fallback on timeout
        }, 3000);

        const handler = (data: WebSocket.Data) => {
            try {
                const response = JSON.parse(data.toString());
                if (response.id === msgId) {
                    clearTimeout(timeout);
                    ws.removeListener("message", handler);
                    if (response.result?.result) {
                        resolve(formatCDPProperties(ws, response.result.result, depth));
                    } else {
                        resolve("Object");
                    }
                }
            } catch {
                // Ignore parse errors
            }
        };

        ws.on("message", handler);
        ws.send(JSON.stringify({
            id: msgId,
            method: "Runtime.getProperties",
            params: { objectId, ownProperties: true, generatePreview: true }
        }));
    });
}

// Format CDP property descriptors into a readable string
async function formatCDPProperties(ws: WebSocket, properties: Array<Record<string, unknown>>, depth: number): Promise<string> {
    const parts: string[] = [];
    let isArrayLike = false;

    // Detect arrays by checking for numeric keys and "length" property
    const propNames = properties.filter((p) => !p.isAccessor && p.name !== "__proto__").map((p) => p.name as string);
    const hasLength = propNames.includes("length");
    const numericKeys = propNames.filter((n) => /^\d+$/.test(n));
    if (hasLength && numericKeys.length > 0 && numericKeys.length >= propNames.length - 1) {
        isArrayLike = true;
    }

    const filteredProps = properties.filter((p) =>
        !p.isAccessor && p.name !== "__proto__" && (!isArrayLike || p.name !== "length")
    );

    for (const prop of filteredProps) {
        const val = prop.value as Record<string, unknown> | undefined;
        if (!val) continue;

        const formatted = await formatPropertyValue(ws, val, depth - 1);
        if (isArrayLike) {
            parts.push(formatted);
        } else {
            parts.push(`${prop.name}: ${formatted}`);
        }
    }

    return isArrayLike
        ? `[${parts.join(", ")}]`
        : `{${parts.join(", ")}}`;
}

// Format a single property value
async function formatPropertyValue(ws: WebSocket, val: Record<string, unknown>, remainingDepth: number): Promise<string> {
    const type = val.type as string;
    const subtype = val.subtype as string | undefined;

    if (subtype === "null") return "null";
    if (type === "undefined") return "undefined";
    if (type === "string") return `"${val.value}"`;
    if (type === "number" || type === "boolean") return String(val.value);
    if (type === "function") return "[Function]";

    // Nested object — recurse if depth allows
    if (type === "object" && val.objectId && remainingDepth > 0) {
        return fetchObjectProperties(ws, val.objectId as string, remainingDepth);
    }

    // Object but no depth left — use description
    if (type === "object") {
        return (val.description as string) || "[Object]";
    }

    if (val.value !== undefined) return JSON.stringify(val.value);
    if (val.description) return val.description as string;
    return `[${type}]`;
}

// Resolve all object args in a console message, returning formatted text
async function resolveConsoleArgs(ws: WebSocket, args: CDPConsoleArg[]): Promise<string> {
    const parts = await Promise.all(args.map(async (arg) => {
        // Primitives — format synchronously
        if (arg.type === "string" || arg.type === "number" || arg.type === "boolean") {
            return String(arg.value);
        }

        // Objects/arrays with preview — expand inline
        if (arg.preview?.properties) {
            return formatPreview(arg.preview);
        }

        // Object with objectId — fetch properties via CDP
        if (arg.type === "object" && arg.objectId) {
            return fetchObjectProperties(ws, arg.objectId);
        }

        // Raw value
        if (arg.value !== undefined) {
            return JSON.stringify(arg.value);
        }

        // Description fallback
        if (arg.description) {
            return arg.description;
        }

        return "[object]";
    }));

    return parts.join(" ");
}

// Handle CDP messages
export function handleCDPMessage(message: Record<string, unknown>, device: DeviceInfo, ws?: WebSocket): void {
    // Track last CDP activity for connection liveness detection (per-device)
    const cdpAppKey = findAppKeyForDevice(device);
    if (cdpAppKey) {
        updateLastCDPMessageTime(cdpAppKey, new Date());
    }
    const deviceName = device.deviceName || device.title || "unknown";

    // Handle responses to our requests (e.g., Runtime.evaluate)
    if (typeof message.id === "number") {
        const pending = pendingExecutions.get(message.id);
        if (pending) {
            clearTimeout(pending.timeoutId);
            pendingExecutions.delete(message.id);

            // Check for CDP-level error (protocol error, not JS exception)
            if (message.error) {
                const error = message.error as { message?: string; code?: number; data?: string };
                // Build comprehensive error message including code and data if available
                const parts: string[] = [];
                if (error.message) parts.push(error.message);
                if (error.code !== undefined) parts.push(`(code: ${error.code})`);
                if (error.data) parts.push(`- ${error.data}`);
                const errorMessage = parts.length > 0 ? parts.join(' ') : 'Unknown CDP protocol error';
                pending.resolve({ success: false, error: errorMessage });
                return;
            }

            // Check for JavaScript exception in result
            const result = message.result as
                | {
                      result?: RemoteObject;
                      exceptionDetails?: ExceptionDetails;
                  }
                | undefined;

            if (result?.exceptionDetails) {
                const errorMessage = extractExceptionMessage(result.exceptionDetails);
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
        // Track SDK-probe responses
        if (pendingSdkProbeIds.has(message.id as number)) {
            const appKey = pendingSdkProbeIds.get(message.id as number)!;
            pendingSdkProbeIds.delete(message.id as number);
            const app = connectedApps.get(appKey);
            if (app) {
                const result = (message.result as { result?: { value?: unknown } } | undefined)?.result;
                const present = result?.value === true;
                const wasPresent = app.sdkPresent === true;
                // Hysteresis on the true→false edge: tolerate transient SDK
                // absence right after a reload (context recreated, init() not
                // re-run yet) so we don't restore duplicate-prone CDP/interceptor
                // writes and bounce get_network_requests off the SDK buffer.
                let nextPresent = present;
                if (!present && wasPresent) {
                    app.sdkMissCount = (app.sdkMissCount ?? 0) + 1;
                    if (app.sdkMissCount < SDK_ABSENCE_CONFIRM_COUNT) {
                        nextPresent = true; // hold "present" until absence is confirmed
                    } else {
                        app.sdkMissCount = 0;
                    }
                } else {
                    app.sdkMissCount = 0;
                }
                app.sdkPresent = nextPresent;
                if (nextPresent !== wasPresent) {
                    console.error(`[execbro] SDK ${present ? "detected" : "no longer detected"} on ${app.deviceInfo.title}; CDP/JS-interceptor buffer writes ${present ? "suppressed" : "restored"}`);
                    // Toggle the in-app interceptor's emit flag so it stops
                    // (or resumes) producing console.debug lines and CDP
                    // traffic.
                    sendNetSuppressionFlag(app.ws, nextPresent);
                }
            }
            return;
        }

        // Track Network.enable responses to detect CDP network support
        if (pendingNetworkEnableIds.has(message.id as number)) {
            pendingNetworkEnableIds.delete(message.id as number);
            const nAppKey = findAppKeyForDevice(device);
            if (nAppKey) {
                const app = connectedApps.get(nAppKey);
                if (app) {
                    if (message.error) {
                        app.cdpNetworkSupported = false;
                        console.error(`[execbro] CDP Network domain not supported, using JS interceptor`);
                    } else {
                        app.cdpNetworkSupported = true;
                        console.error(`[execbro] CDP Network domain supported`);
                    }
                }
            }
        }
        return;
    }

    const method = message.method as string;

    // Handle Runtime.consoleAPICalled
    if (method === "Runtime.consoleAPICalled") {
        const params = message.params as {
            type?: string;
            args?: Array<CDPConsoleArg>;
            timestamp?: number;
            stackTrace?: unknown;
        };

        const type = params.type || "log";
        const level = mapConsoleType(type);
        const args = params.args || [];
        // Stored raw and resolved lazily at read time — symbolication is a
        // network call to Metro and must never block or fail log capture.
        const stackTrace = captureStack(level, params.stackTrace);

        // Check for network interceptor events before processing as logs
        const interceptorJson = isInterceptorEvent(args);
        if (interceptorJson !== null) {
            const iAppKey = findAppKeyForDevice(device);
            const iApp = iAppKey ? connectedApps.get(iAppKey) : null;
            // Skip when CDP Network domain is the source, OR when the in-app
            // SDK is the source — both would otherwise produce duplicate
            // entries for every request.
            //
            // Mock events are exempt: neither of those layers knows the mock
            // layer exists, so a mock event is never a duplicate. Dropping it
            // pegged every rule's hit count at zero whenever the SDK was
            // installed, which reads as "the rule never matched" — the exact
            // opposite of what had happened.
            const suppressed = iApp?.cdpNetworkSupported || iApp?.sdkPresent;
            // Mocked traffic is exempt from the CDP half of the gate: the
            // request never reaches the network, so CDP cannot report it and
            // ours is the only record. Without this a mocked request vanishes
            // from get_network_requests on every CDP-capture target — the one
            // thing a mock must never do.
            const mockedUnderCdp =
                iApp?.cdpNetworkSupported && !iApp?.sdkPresent && isMockedTrafficEvent(interceptorJson);
            if (!suppressed || isMockEvent(interceptorJson) || mockedUnderCdp) {
                applyInterceptedEvent(interceptorJson, getNetworkBuffer(deviceName), deviceName);
            }
            return;
        }

        // Check if any args need async object resolution
        const hasObjectArgs = ws && args.some((a) => a.type === "object" && a.objectId && !a.preview?.properties);

        if (hasObjectArgs) {
            // Resolve object args asynchronously via CDP
            resolveConsoleArgs(ws, args).then((messageText) => {
                getLogBuffer(deviceName).add({
                    timestamp: new Date(),
                    level,
                    message: messageText || "[console call with empty resolution]",
                    args: args.map((a) => a.value),
                    stackTrace
                });
            }).catch(() => {
                // Fallback to sync formatting on error
                const messageText = args.map(formatConsoleArg).join(" ");
                getLogBuffer(deviceName).add({
                    timestamp: new Date(),
                    level,
                    message: messageText || "[console call with unresolvable args]",
                    args: args.map((a) => a.value),
                    stackTrace
                });
            });
        } else {
            const messageText = args.map(formatConsoleArg).join(" ");
            if (messageText.trim()) {
                getLogBuffer(deviceName).add({
                    timestamp: new Date(),
                    level,
                    message: messageText,
                    args: args.map((a) => a.value),
                    stackTrace
                });
            }
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
            getLogBuffer(deviceName).add({
                timestamp: new Date(),
                level,
                message: params.entry.text || ""
            });
        }
    }

    // Handle Network.requestWillBeSent
    if (method === "Network.requestWillBeSent") {
        // Skip CDP capture when the in-app SDK is the source of truth —
        // otherwise every request lands in both buffers under different ids.
        // The follow-up Network.responseReceived/loadingFinished/loadingFailed
        // handlers below only mutate existing entries, so they self-skip.
        const nAppKey = findAppKeyForDevice(device);
        const nApp = nAppKey ? connectedApps.get(nAppKey) : null;
        if (nApp?.sdkPresent) {
            return;
        }

        // An arriving Network.requestWillBeSent is proof the CDP Network domain
        // is active. Some backends (e.g. RN 0.85 Bridgeless/Hermes) enable the
        // domain but never send a response to Network.enable, so the
        // response-based detection above never fires and cdpNetworkSupported
        // stays undefined — leaving the JS interceptor un-suppressed and every
        // request double-captured (CDP + interceptor). Mark support here so the
        // interceptor dedup guard (see Runtime.consoleAPICalled handler) trips.
        if (nApp && !nApp.cdpNetworkSupported) {
            nApp.cdpNetworkSupported = true;
            console.error(`[execbro] CDP Network domain active (detected via requestWillBeSent on ${nApp.deviceInfo.title})`);
        }

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
            completed: false,
            epoch: getEpoch(deviceName)
        };

        getNetworkBuffer(deviceName).set(params.requestId, request);
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

        const existing = getNetworkBuffer(deviceName).get(params.requestId);
        if (existing) {
            existing.status = params.response.status;
            existing.statusText = params.response.statusText;
            existing.responseHeaders = params.response.headers || {};
            existing.mimeType = params.response.mimeType;

            if (params.timestamp && existing.timing?.requestTime) {
                existing.timing.responseTime = params.timestamp;
            }

            getNetworkBuffer(deviceName).set(params.requestId, existing);
        }
    }

    // Handle Network.loadingFinished
    if (method === "Network.loadingFinished") {
        const params = message.params as {
            requestId: string;
            timestamp?: number;
            encodedDataLength?: number;
        };

        const existing = getNetworkBuffer(deviceName).get(params.requestId);
        if (existing) {
            existing.completed = true;
            existing.contentLength = params.encodedDataLength;

            if (params.timestamp && existing.timing?.requestTime) {
                existing.timing.duration = Math.round((params.timestamp - existing.timing.requestTime) * 1000);
            }

            getNetworkBuffer(deviceName).set(params.requestId, existing);
        }
    }

    // Handle Network.loadingFailed
    if (method === "Network.loadingFailed") {
        const params = message.params as {
            requestId: string;
            errorText?: string;
            canceled?: boolean;
        };

        const existing = getNetworkBuffer(deviceName).get(params.requestId);
        if (existing) {
            existing.completed = true;
            existing.error = params.canceled ? "Canceled" : (params.errorText || "Request failed");

            getNetworkBuffer(deviceName).set(params.requestId, existing);
        }
    }

    // Handle Runtime context lifecycle events for health tracking
    const appKey = findAppKeyForDevice(device);
    if (appKey) {
        // Handle Runtime.executionContextCreated
        if (method === "Runtime.executionContextCreated") {
            const params = message.params as { context: { id: number; name?: string } };
            markContextHealthy(appKey, params.context.id);
            console.error(`[execbro] Context created: ${params.context.id}`);

            // Re-inject network interceptor and re-check CDP Network support
            const ctxApp = connectedApps.get(appKey);
            if (ctxApp?.ws?.readyState === WebSocket.OPEN) {
                injectNetworkInterceptor(ctxApp.ws);
                // The fresh context starts with __RN_NET_DISABLED__ undefined,
                // so the just-injected interceptor would emit alongside the SDK
                // until something flips it back. The probe's edge detector
                // cannot supply that flip — sdkPresent is held true across this
                // window by design, so true→true produces no edge. Context
                // recreation is the state change, so re-assert it here from the
                // current belief; a later probe edge corrects it if the SDK has
                // genuinely gone away.
                sendNetSuppressionFlag(ctxApp.ws, ctxApp.sdkPresent === true);
                // Re-apply mock rules to the new JS context. The server is
                // authoritative; without this every reload_app would silently
                // drop the agent's mocks — precisely when reproducing a
                // startup-path bug. Ordered after the injection because the
                // interceptor initialises the list it writes into.
                pushMockRules(ctxApp.ws, serializeRules(device.deviceName || device.title || "unknown"));
                const nEnableId = sendNetworkEnable(ctxApp.ws);
                pendingNetworkEnableIds.add(nEnableId);
                // The context was just recreated (e.g. reload). Re-probe the SDK
                // quickly so sdkPresent re-establishes within a few hundred ms
                // instead of on the next 3s interval tick.
                scheduleFastSdkReprobe(ctxApp.ws, appKey);
            }
        }

        // Handle Runtime.executionContextDestroyed
        if (method === "Runtime.executionContextDestroyed") {
            markContextStale(appKey);
            console.error(`[execbro] Context destroyed`);
        }

        // Handle Runtime.executionContextsCleared
        if (method === "Runtime.executionContextsCleared") {
            markContextStale(appKey);
            // A replaced JS runtime starts a new app run. Bump so pre-restart
            // entries stay addressable and readers can draw the boundary.
            const clearedDevice = device.deviceName || device.title || "unknown";
            const nextEpoch = bumpEpoch(clearedDevice);
            console.error(`[execbro] All contexts cleared — ${clearedDevice} now epoch ${nextEpoch}`);
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

    return new Promise(async (resolve, reject) => {
        const appKey = `${port}-${device.id}`;

        // Check if already connected with a valid WebSocket
        const existingApp = connectedApps.get(appKey);
        if (existingApp) {
            if (existingApp.ws.readyState === WebSocket.OPEN) {
                // Verify WebSocket is actually alive with a ping/pong check.
                // readyState can show OPEN even when the remote end is gone
                // (TCP hasn't timed out yet, especially after Metro restart).
                const isAlive = await new Promise<boolean>((pongResolve) => {
                    const timeout = setTimeout(() => pongResolve(false), 2000);
                    existingApp.ws.once("pong", () => {
                        clearTimeout(timeout);
                        pongResolve(true);
                    });
                    try {
                        existingApp.ws.ping();
                    } catch {
                        clearTimeout(timeout);
                        pongResolve(false);
                    }
                });

                if (isAlive) {
                    resolve(`Already connected to ${device.title}`);
                    return;
                }

                // Ping failed — connection is dead, clean up
                console.error(`[execbro] Existing connection to ${device.title} failed liveness check (no pong), reconnecting`);
                recordConnectionEvent("liveness-failed", appKey, device.title, "no pong within 2000ms");
                reconnectionSuppressed.add(appKey);
                try { existingApp.ws.terminate(); } catch { /* ignore */ }
                connectedApps.delete(appKey);
                clearLastCDPMessageTime(appKey);
                clearActiveSimulatorIfSource(appKey);
            } else {
                // WebSocket exists but not OPEN - clean up stale entry
                console.error(`[execbro] Cleaning up stale connection for ${device.title} (state: ${getWebSocketStateName(existingApp.ws.readyState)})`);
                connectedApps.delete(appKey);
            }
        }

        // Skip if this device is already connected on a different port
        // (Metro's /json advertises all devices it can see, even ones built by other Metro servers)
        const deviceName = device.deviceName || device.title;
        for (const [existingKey, existingApp] of connectedApps.entries()) {
            if (existingKey !== appKey && existingApp.ws.readyState === WebSocket.OPEN) {
                const existingName = existingApp.deviceInfo.deviceName || existingApp.deviceInfo.title;
                if (existingName === deviceName) {
                    resolve(`Skipped ${deviceName} (already connected on port ${existingApp.port})`);
                    return;
                }
            }
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
            const ws = await createWebSocketWithOriginFallback(device.webSocketDebuggerUrl);

            // Register close/error handlers IMMEDIATELY — before any async work
            // below (probeCdpAlive, Runtime.enable, simctl/adb lookups). Previously
            // they were attached only at the end of the setup block, so any close
            // event during that window was silently swallowed: the entry stayed
            // in connectedApps, readyState flipped to CLOSED, but no reconnect
            // was scheduled and no `closed` event was recorded.
            let pingInterval: NodeJS.Timeout | null = null;
            let staleRejected = false;

            const handleClose = () => {
                if (staleRejected) return; // probe-fail path handles its own cleanup
                if (pingInterval) {
                    clearInterval(pingInterval);
                    pingInterval = null;
                }

                // Fail anything still in flight on this socket. Otherwise each
                // call parks until its own timeoutMs and then reports a generic
                // "Expression took too long", which classifies as logical and
                // never triggers auto-reconnect.
                const failedCount = failPendingExecutionsForSocket(ws, "WebSocket connection is not open.");
                if (failedCount > 0) {
                    console.error(`[execbro] Failed ${failedCount} in-flight call(s) on closed socket for ${device.title}`);
                }

                // Release connection lock if still held
                connectionLocks.delete(appKey);

                // Stop mirroring — the socket is gone, so every tick would just
                // fail. No drain attempt here: there is nothing left to read.
                stopSdkMirrorPoller(device.deviceName || device.title || "unknown");

                connectedApps.delete(appKey);
                clearLastCDPMessageTime(appKey);
                // Clear active simulator UDID if this connection set it
                clearActiveSimulatorIfSource(appKey);

                // Keep log and network buffers across reconnections
                // They are only cleared on demand via clear_logs / clear_network tools

                // Check if connection was stable before resetting attempts
                const state = getConnectionState(appKey);
                let wasStable = false;
                if (state?.lastConnectedTime) {
                    const connectionDuration = Date.now() - state.lastConnectedTime.getTime();
                    wasStable = connectionDuration >= MIN_STABLE_CONNECTION_MS;
                    if (wasStable) {
                        // Connection was stable - reset attempts for fresh start
                        updateConnectionState(appKey, { reconnectionAttempts: 0 });
                        console.error(`[execbro] Connection was stable for ${Math.round(connectionDuration / 1000)}s, resetting reconnection attempts`);
                    }
                }

                // Record the gap and trigger reconnection
                recordConnectionGap(appKey, "Connection closed");
                if (state) {
                    updateConnectionState(appKey, {
                        status: "disconnected",
                        lastDisconnectTime: new Date()
                    });
                }

                const uptimeMs = state?.lastConnectedTime ? Date.now() - state.lastConnectedTime.getTime() : 0;
                const earlyPhase = state ? "" : " (before state init)";
                console.error(`[execbro] Disconnected from ${device.title}${earlyPhase}`);
                recordConnectionEvent("closed", appKey, device.title, `uptime ${formatDuration(uptimeMs)}${wasStable ? " (stable)" : " (unstable)"}${earlyPhase}`);

                // Schedule auto-reconnection if enabled (skip if intentionally disconnected)
                if (reconnectionConfig.enabled && !reconnectionSuppressed.has(appKey)) {
                    // If close fired before initConnectionState, scheduleReconnection
                    // would early-return (it requires existing state). Init it now
                    // so the reconnect loop can still run.
                    if (!state) initConnectionState(appKey);
                    scheduleReconnection(appKey, reconnectionConfig);
                } else if (reconnectionSuppressed.has(appKey)) {
                    reconnectionSuppressed.delete(appKey);
                    console.error(`[execbro] Reconnection suppressed for ${device.title} (intentional disconnect)`);
                    recordConnectionEvent("reconnect-suppressed", appKey, device.title, "intentional disconnect");
                } else if (!reconnectionConfig.enabled) {
                    recordConnectionEvent("reconnect-suppressed", appKey, device.title, "reconnect disabled by caller");
                }
            };

            ws.on("close", handleClose);
            ws.on("error", (error: Error) => {
                console.error(`[execbro] WebSocket error for ${device.title}: ${error?.message || error}`);
            });

            // Verify the JS context is actually alive. Metro's /json can advertise
            // zombie CDP pages that complete the WS handshake but no longer execute.
            // A stale target here causes every downstream tool to time out or return
            // degenerate state (e.g. __DEV__ === false on a debug bundle).
            const alive = await probeCdpAlive(ws, PROBE_TIMEOUT_MS);
            if (!alive) {
                staleRejected = true;
                ws.off("close", handleClose);
                connectionLocks.delete(appKey);
                try { ws.terminate(); } catch { /* ignore */ }
                clearConnectionMetadata(appKey);
                console.error(`[execbro] Rejecting stale CDP target for ${device.title} (no probe response)`);
                recordConnectionEvent("stale-target", appKey, device.title, `no probe response within ${PROBE_TIMEOUT_MS}ms${isReconnection ? " (during reconnect)" : ""}`);
                resolve(`Skipped ${device.deviceName || device.title} (stale CDP target — no response from JS context)`);
                return;
            }

            // Connection established — run setup
            connectionLocks.delete(appKey);
            connectedApps.set(appKey, { ws, deviceInfo: device, port, platform: "android" });
            recordDeviceSeen(device.deviceName || device.title);
            markConnectionEstablished();

            // A new CDP target id under a device name we have buffered before
            // means the app process was replaced. Bump so pre-restart entries
            // stay addressable and readers can draw the boundary.
            const bufferKey = device.deviceName || device.title || "unknown";
            const previousTargetId = lastTargetIdByDevice.get(bufferKey);
            if (previousTargetId && previousTargetId !== device.id) {
                bumpEpoch(bufferKey);
            }
            lastTargetIdByDevice.set(bufferKey, device.id);

            // Mirror the in-app SDK buffers into ours so a hard app restart
            // does not take the only copy with it. No-op when the SDK is absent
            // or EXECBRO_DISABLE_SDK_MIRROR=1.
            startSdkMirrorPoller(device.deviceName);

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
                console.error(`[execbro] Reconnected to ${device.title}`);
                recordConnectionEvent("reconnect-success", appKey, device.title);
            } else {
                initConnectionState(appKey);
                initContextHealth(appKey);
                console.error(`[execbro] Connected to ${device.title}`);
                recordConnectionEvent("connect-success", appKey, device.title);
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

            // Inject JS network interceptor (immediate capture, may fail if context not ready)
            injectNetworkInterceptor(ws);
            // Rules for this device may already exist — from a previous session
            // of the same server process, or a reconnect after the app was
            // killed. Runtime.executionContextCreated is not guaranteed to
            // follow a connect, so this cannot rely on the re-push alone.
            pushMockRules(ws, serializeRules(device.deviceName || device.title || "unknown"));

            // Route history accrues from connect, so the first includeHistory read
            // is not an empty trail. Non-fatal by contract: a failure here just
            // leaves the reader on the sampled path.
            //
            // Imported lazily: routeHistory reaches this module through jsExecute,
            // and deferring to call time keeps that cycle out of module init.
            void import("./routeHistory.js")
                .then((m) => m.installRouteHistory(device.deviceName))
                .catch(() => {});

            // Also try CDP Network.enable (takes priority if supported)
            const networkEnableId = sendNetworkEnable(ws);
            pendingNetworkEnableIds.add(networkEnableId);

            // Resolve native identifiers from the device name in parallel:
            //   - iOS: simulator UDID via findSimulatorByName
            //   - Android: adb serial via getAdbIdForAvd (maps AVD name → emulator-NNNN)
            // Both are best-effort; failures are swallowed. Identifiers enable
            // automatic device scoping and power the registry-first resolver fast path.
            if (device.deviceName) {
                const [simulatorUdid, adbSerial] = await Promise.all([
                    findSimulatorByName(device.deviceName).catch(() => null),
                    getAdbIdForAvd(device.deviceName).catch(() => null)
                ]);

                const connectedApp = connectedApps.get(appKey);
                if (connectedApp) {
                    if (simulatorUdid) {
                        setActiveSimulatorUdid(simulatorUdid, appKey);
                        connectedApp.platform = "ios";
                        connectedApp.simulatorUdid = simulatorUdid;
                        console.error(`[execbro] Linked to iOS simulator: ${simulatorUdid}`);
                    }
                    if (adbSerial) {
                        connectedApp.platform = "android";
                        connectedApp.adbSerial = adbSerial;
                        console.error(`[execbro] Linked to Android emulator: ${adbSerial}`);
                    }
                }
            }

            // Fire-and-forget app detection (500ms delayed, non-blocking)
            const appForDetection = connectedApps.get(appKey);
            if (appForDetection) {
                scheduleAppDetection(appForDetection);
            }

            // Start periodic SDK probe. When __RN_AI_DEVTOOLS__ is detected,
            // app.sdkPresent flips to true and CDP/JS-interceptor buffer
            // writes are suppressed (SDK becomes the single source).
            startSdkProbeLoop(ws, appKey);

            // Start WebSocket ping/pong keepalive to detect dead connections
            // (especially important for physical devices over Wi-Fi).
            // pingInterval was declared up-top so the early-registered close
            // handler can clear it; close/error handlers are already attached.
            let pongReceived = true;
            pingInterval = setInterval(() => {
                if (!pongReceived) {
                    console.error(`[execbro] No pong from ${device.title}, terminating connection`);
                    if (pingInterval) {
                        clearInterval(pingInterval);
                        pingInterval = null;
                    }
                    ws.terminate();
                    return;
                }
                pongReceived = false;
                ws.ping();
            }, PING_INTERVAL_MS);

            ws.on("pong", () => {
                pongReceived = true;
            });

            ws.on("message", (data: WebSocket.Data) => {
                try {
                    const message = JSON.parse(data.toString());
                    handleCDPMessage(message, device, ws);
                } catch {
                    // Ignore non-JSON messages
                }
            });

            resolve(`Connected to ${device.title} (${device.deviceName})`);
        } catch (error) {
            // Connection failed (both with and without Origin header)
            connectionLocks.delete(appKey);
            cancelReconnectionTimer(appKey);
            connectedApps.delete(appKey);
            clearLastCDPMessageTime(appKey);
            clearActiveSimulatorIfSource(appKey);

            const errorMsg = error instanceof Error ? error.message : String(error);
            if (!isReconnection) {
                reject(`Failed to connect to ${device.title}: ${errorMsg}`);
            } else {
                console.error(`[execbro] Reconnection error: ${errorMsg}`);
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

    const meta = getConnectionMetadata(appKey);
    const deviceTitle = meta?.deviceInfo.title;

    const attempts = state.reconnectionAttempts;
    if (attempts >= config.maxAttempts) {
        console.error(`[execbro] Max reconnection attempts (${config.maxAttempts}) reached for ${appKey}`);
        updateConnectionState(appKey, { status: "disconnected" });
        recordConnectionEvent("max-attempts-reached", appKey, deviceTitle, `${config.maxAttempts} attempts exhausted`);
        return;
    }

    const delay = calculateBackoffDelay(attempts, config);
    console.error(`[execbro] Scheduling reconnection attempt ${attempts + 1}/${config.maxAttempts} in ${delay}ms`);
    recordConnectionEvent("reconnect-scheduled", appKey, deviceTitle, `attempt ${attempts + 1}/${config.maxAttempts} in ${delay}ms`);

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
        console.error(`[execbro] No metadata for reconnection: ${appKey}`);
        recordConnectionEvent("reconnect-failed", appKey, undefined, "no metadata");
        return false;
    }
    const deviceTitle = metadata.deviceInfo.title;
    recordConnectionEvent("reconnect-attempt", appKey, deviceTitle);

    // Quick check: is Metro even running on this port?
    const { scanMetroPorts } = await import("./metro.js");
    const openPorts = await scanMetroPorts(metadata.port, metadata.port);
    if (openPorts.length === 0) {
        console.error(`[execbro] Metro not running on port ${metadata.port}, stopping reconnection for ${appKey}`);
        updateConnectionState(appKey, { status: "disconnected" });
        recordConnectionEvent("metro-down", appKey, deviceTitle, `port ${metadata.port} not open`);
        return false;
    }

    try {
        // Re-fetch devices to get fresh WebSocket URL (may have changed)
        const devices = await fetchDevices(metadata.port);

        // Try to find the same device first, otherwise select main device
        const device = devices.find(d => d.id === metadata.deviceInfo.id)
            || selectMainDevice(devices);

        if (!device) {
            console.error(`[execbro] Device no longer available for ${appKey}`);
            recordConnectionEvent("reconnect-failed", appKey, deviceTitle, "device no longer advertised by Metro");
            // Schedule next attempt
            scheduleReconnection(appKey, config);
            return false;
        }

        await connectToDevice(device, metadata.port, { isReconnection: true, reconnectionConfig: config });
        return true;
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[execbro] Reconnection failed: ${msg}`);
        recordConnectionEvent("reconnect-failed", appKey, deviceTitle, msg);
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
        console.error(`[execbro] Cleaning up stale connection in getFirstConnectedApp: ${key} (state: ${getWebSocketStateName(app.ws.readyState)})`);
        connectedApps.delete(key);
    }
    return null;
}

/**
 * Find the connected RN app running on a specific iOS simulator (by UDID).
 * Returns null if no connected app matches — caller should skip any CDP-based
 * enrichment to avoid pulling data from a different simulator's app.
 */
export function getConnectedAppBySimulatorUdid(udid: string): ConnectedApp | null {
    for (const [key, app] of connectedApps.entries()) {
        if (app.ws.readyState !== WebSocket.OPEN) {
            connectedApps.delete(key);
            continue;
        }
        if (app.platform === "ios" && app.simulatorUdid === udid) {
            return app;
        }
    }
    return null;
}

/**
 * Find the connected RN app running on a specific Android device.
 * Falls back to the sole connected Android app when `deviceId` is not provided
 * or cannot be resolved via deviceName substring match — this keeps the common
 * single-device case working while preventing cross-device data leakage when
 * multiple Android apps are connected.
 */
export function getConnectedAppByAndroidDeviceId(deviceId?: string): ConnectedApp | null {
    const androidApps: ConnectedApp[] = [];
    for (const [key, app] of connectedApps.entries()) {
        if (app.ws.readyState !== WebSocket.OPEN) {
            connectedApps.delete(key);
            continue;
        }
        if (app.platform === "android") androidApps.push(app);
    }

    if (androidApps.length === 0) return null;
    if (androidApps.length === 1) return androidApps[0];

    if (deviceId) {
        const lower = deviceId.toLowerCase();
        const match = androidApps.find(a => {
            const name = (a.deviceInfo.deviceName || a.deviceInfo.title || "").toLowerCase();
            return name.includes(lower) || lower.includes(name);
        });
        if (match) return match;
    }

    return null;
}

/**
 * Lowercase and strip separators (whitespace, `_`, `-`) so substring matches
 * survive punctuation drift between caller input and the device's reported
 * identifier (e.g. "SM_A356N" vs "SM-A356N - 15 - API 35").
 */
function normalizeDeviceId(value: string | null | undefined): string {
    if (!value) return "";
    return value.toLowerCase().replace(/[\s_\-]+/g, "");
}

/**
 * Outcome of matching a caller-supplied `device` string against the currently
 * connected apps. Split out of getConnectedAppByDevice so callers that can
 * *recover* from a miss (reload_app auto-connects, then re-resolves) can
 * inspect the failure instead of catching a thrown UserInputError — a throw
 * on the first resolve is what made reload_app skip its own auto-connect path
 * whenever a device argument was supplied.
 */
export type DeviceResolution =
    | { kind: "ok"; app: ConnectedApp }
    | { kind: "ambiguous"; device: string; matches: ConnectedApp[] }
    | { kind: "none"; device?: string; connected: ConnectedApp[] };

/** Guess which platform a caller-supplied device string refers to. */
function guessRequestedPlatform(device: string): "ios" | "android" | null {
    const lower = device.toLowerCase();
    // Simulator UDIDs are uppercase UUIDs; adb serials are not.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(lower)) return "ios";
    if (/iphone|ipad|ipod|\bios\b|simulator/.test(lower)) return "ios";
    if (/emulator-|sdk_gphone|pixel|galaxy|nexus|\bsm-|moto|xiaomi|redmi|oneplus|android|api \d+/.test(lower)) return "android";
    return null;
}

function deviceLabel(app: ConnectedApp): string {
    return app.deviceInfo.deviceName || app.deviceInfo.title || "";
}

/** "12s ago" / "4m ago" / "2h ago" — coarse on purpose; only the order of magnitude matters. */
function formatAgo(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return "just now";
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    return `${Math.round(m / 60)}h ago`;
}

/**
 * Human-facing explanation for a `kind: "none"` / `kind: "ambiguous"` resolution.
 * Kept next to the matcher so the message always reflects the matching rules.
 */
export function describeDeviceResolution(resolution: DeviceResolution): string {
    if (resolution.kind === "ok") return "";

    if (resolution.kind === "ambiguous") {
        const names = resolution.matches.map(deviceLabel).join(", ");
        return `Multiple devices match "${resolution.device}": ${names}. Be more specific (use the full device name for an exact match).`;
    }

    const { device, connected } = resolution;
    if (!device) {
        return "No apps connected. Run scan_metro to discover and connect to Metro servers.";
    }

    // A name we have already driven this session is not a misspelling. Say so
    // before anything else, so the reader investigates the device rather than
    // re-reading their own argument.
    const dropped = findDisconnectedDeviceName(device);
    if (dropped) {
        const ago = formatAgo(Date.now() - dropped.lastSeenAt);
        const others = connected.length > 0
            ? ` Still connected: ${connected.map(a => `"${deviceLabel(a)}"`).join(", ")}.`
            : " No devices are connected right now.";
        return [
            `Device "${dropped.name}" DISCONNECTED — it was attached earlier in this session (last seen ${ago})`,
            `and no longer is. The name is correct; the device dropped off.${others}`,
            `Run scan_metro to re-attach. If that finds nothing, the emulator/simulator or the app itself has exited —`,
            `check list_devices, then relaunch the app.`
        ].join(" ");
    }

    if (connected.length === 0) {
        return `No connected device matches "${device}". No devices are currently connected — run scan_metro to discover and connect to Metro servers.`;
    }

    const quoted = connected.map(a => `"${deviceLabel(a)}"`).join(", ");
    // Cross-platform mismatch is the dominant shape of this failure: the agent
    // passes a name from list_devices while only the other
    // platform is attached to Metro. Saying so beats "retry with one of these".
    const requested = guessRequestedPlatform(device);
    const attachedPlatforms = new Set(connected.map(a => a.platform));
    if (requested && !attachedPlatforms.has(requested)) {
        const other = requested === "ios" ? "Android" : "iOS";
        const launchHint = requested === "ios"
            ? "ios_launch_app (boot the simulator first if needed)"
            : "android_launch_app";
        return [
            `No connected device matches "${device}". Only ${other} device(s) are attached to Metro: ${quoted}.`,
            `The ${requested === "ios" ? "iOS" : "Android"} app is not connected — start it with ${launchHint}, then run scan_metro.`,
            `Or omit the device argument / use get_apps to target an already-connected device.`
        ].join(" ");
    }
    return `No connected device matches "${device}". Connected devices: ${quoted}. Retry with one of these names (substring match, case-insensitive), or run get_apps to list them.`;
}

/**
 * Non-throwing device matcher. Prefer this in call sites that can retry
 * (auto-connect, rescan); use getConnectedAppByDevice when a miss is terminal.
 */
export function resolveConnectedAppByDevice(device?: string): DeviceResolution {
    const openApps: ConnectedApp[] = [];
    for (const [key, app] of connectedApps.entries()) {
        if (app.ws.readyState !== WebSocket.OPEN) {
            connectedApps.delete(key);
            continue;
        }
        openApps.push(app);
    }

    if (!device) {
        const app = getFirstConnectedApp();
        return app ? { kind: "ok", app } : { kind: "none", connected: openApps };
    }

    const lowerDevice = device.toLowerCase();
    const normDevice = normalizeDeviceId(device);
    const matches: ConnectedApp[] = [];

    for (const app of openApps) {
        // Match against deviceName + the underlying hardware identifiers, with
        // separator-insensitive normalization so "SM_A356N" finds
        // "SM-A356N - 15 - API 35" and "emulator-5554" finds the Android app
        // attached to that serial.
        const haystacks = [
            normalizeDeviceId(deviceLabel(app)),
            normalizeDeviceId(app.simulatorUdid),
            normalizeDeviceId(app.adbSerial)
        ].filter((s) => s.length > 0);
        if (haystacks.some((h) => h.includes(normDevice))) {
            matches.push(app);
        }
    }

    // Prefer exact (case-insensitive) match when present — disambiguates
    // "iPhone 17 Pro" from "iPhone 17 Pro Max" when both are connected.
    const exact = matches.find(a => deviceLabel(a).toLowerCase() === lowerDevice);
    if (exact) return { kind: "ok", app: exact };

    if (matches.length === 1) return { kind: "ok", app: matches[0] };
    if (matches.length > 1) return { kind: "ambiguous", device, matches };
    return { kind: "none", device, connected: openApps };
}

export function getConnectedAppByDevice(device?: string): ConnectedApp | null {
    const resolution = resolveConnectedAppByDevice(device);
    if (resolution.kind === "ok") return resolution.app;
    // No device argument: a miss just means "nothing connected" — callers
    // handle null themselves (historically getFirstConnectedApp's contract).
    if (!device) return null;
    const context = resolution.kind === "ambiguous"
        ? "ambiguous_device"
        : resolution.connected.length > 0 ? "device_mismatch" : "no_devices_connected";
    throw new UserInputError(describeDeviceResolution(resolution), context);
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

const LOG_PIPELINE_MARKER_PREFIX = "__rn_devtools_health_";

/**
 * Inject a sentinel console.log via CDP and wait for it to appear in the log buffer.
 * Returns true if the marker arrives within TIMEOUT_MS.
 */
async function sendAndWaitForMarker(app: ConnectedApp, buffer: LogBuffer): Promise<boolean> {
    const marker = `${LOG_PIPELINE_MARKER_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const TIMEOUT_MS = 3000;

    try {
        app.ws.send(
            JSON.stringify({
                id: getNextMessageId(),
                method: "Runtime.evaluate",
                params: { expression: `console.log("${marker}")`, returnByValue: true },
            })
        );
    } catch {
        return false;
    }

    // Poll the buffer for the marker (check every 50ms, up to TIMEOUT_MS)
    const startTime = Date.now();
    while (Date.now() - startTime < TIMEOUT_MS) {
        if (buffer.getAll().some(entry => entry.message.includes(marker))) {
            buffer.removeByText(marker);
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    return false;
}

export interface LogPipelineResult {
    ok: boolean;
    recovered: boolean;
    message: string | null;
}

/**
 * End-to-end log pipeline verification with automatic recovery.
 *
 * 1. Injects a sentinel console.log via CDP and verifies it appears in the buffer.
 * 2. If the marker doesn't arrive, attempts recovery:
 *    a. Re-sends Runtime.enable + Log.enable (fixes missing domain subscription)
 *    b. Retries the marker once
 * 3. If still broken, force-reconnects via ensureConnection and retries.
 *
 * Returns { ok, recovered, message } — the caller decides what to show.
 */
export async function verifyLogPipeline(app: ConnectedApp): Promise<LogPipelineResult> {
    const deviceName = app.deviceInfo.deviceName || app.deviceInfo.title || "unknown";
    const buffer = getLogBuffer(deviceName);

    // --- Attempt 1: quick check ---
    if (await sendAndWaitForMarker(app, buffer)) {
        return { ok: true, recovered: false, message: null };
    }

    // --- Attempt 2: re-enable Runtime/Log domains and retry ---
    try {
        app.ws.send(JSON.stringify({ id: getNextMessageId(), method: "Runtime.enable" }));
        app.ws.send(JSON.stringify({ id: getNextMessageId(), method: "Log.enable" }));
    } catch {
        // WS send failed — fall through to reconnect
    }

    // Brief pause for domain activation
    await new Promise(resolve => setTimeout(resolve, 300));

    if (await sendAndWaitForMarker(app, buffer)) {
        return { ok: true, recovered: true, message: "[CONNECTION] Log pipeline was stale — re-enabled CDP domains. Logs are flowing again." };
    }

    // --- Attempt 3: force reconnect and retry ---
    const appKey = `${app.port}-${app.deviceInfo.id}`;
    const port = app.port;

    cancelReconnectionTimer(appKey);
    try { app.ws.close(); } catch { /* ignore */ }
    connectedApps.delete(appKey);

    const result = await ensureConnection({ port, forceRefresh: false, healthCheck: true });
    if (!result.connected || !result.healthCheckPassed) {
        return {
            ok: false,
            recovered: false,
            message: "[CONNECTION] Log pipeline broken and reconnection failed. Ensure the app is running, then call scan_metro.",
        };
    }

    // Wait for the new connection to settle
    await new Promise(resolve => setTimeout(resolve, 500));

    // Get the fresh app reference after reconnection
    const freshApp = getFirstConnectedApp();
    if (!freshApp) {
        return {
            ok: false,
            recovered: false,
            message: "[CONNECTION] Reconnected but no app available. Call scan_metro.",
        };
    }

    const freshDeviceName = freshApp.deviceInfo.deviceName || freshApp.deviceInfo.title || "unknown";
    const freshBuffer = getLogBuffer(freshDeviceName);

    if (await sendAndWaitForMarker(freshApp, freshBuffer)) {
        return {
            ok: true,
            recovered: true,
            message: "[CONNECTION] Log pipeline was broken — reconnected and verified. Logs are flowing again.",
        };
    }

    return {
        ok: false,
        recovered: false,
        message: "[WARNING] Log pipeline verification failed after reconnection. Console events are not reaching the buffer. Try reload_app or scan_metro.",
    };
}

/**
 * Check if a log message is a health check marker (for filtering from output).
 */
export function isHealthCheckMarker(message: string): boolean {
    return message.includes(LOG_PIPELINE_MARKER_PREFIX);
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

    let wasReconnected = false;

    // forceRefresh: close every currently-connected app, then fall through to
    // single-device fresh connect. Full multi-device re-discovery is scan_metro's
    // job — ensureConnection only fresh-connects one when nothing is open.
    if (forceRefresh) {
        for (const { key, app } of getConnectedApps()) {
            cancelReconnectionTimer(key);
            try { app.ws.close(); } catch { /* ignore */ }
            connectedApps.delete(key);
        }
    }

    let openApps: ConnectedApp[] = getConnectedApps()
        .filter(a => a.isConnected)
        .map(a => a.app);

    // Nothing connected — establish a single-device connection from scratch.
    if (openApps.length === 0) {
        const targetPort = port ?? await findFirstMetroPort();
        if (!targetPort) {
            return {
                connected: false,
                wasReconnected: false,
                healthCheckPassed: false,
                connectionInfos: [],
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
                connectionInfos: [],
                error: `No debuggable devices found on port ${targetPort}. Make sure the app is running.`,
            };
        }

        try {
            // Clear any prior reconnection suppression — without this a stale
            // suppression entry from a previous disconnect_metro keeps the
            // close-handler from auto-recovering if Metro drops the WS just
            // after probe.
            clearReconnectionSuppression();

            const connectResult = await connectToDevice(mainDevice, targetPort);
            wasReconnected = true;

            if (connectResult.includes("stale CDP target")) {
                return {
                    connected: false,
                    wasReconnected: false,
                    healthCheckPassed: false,
                    connectionInfos: [],
                    error: `${connectResult}. The CDP page advertised by Metro is no longer responsive — restart the React Native app, then retry.`,
                };
            }

            // Race window: settle briefly and retry getting the open app list.
            for (let i = 0; i < 5 && openApps.length === 0; i++) {
                if (i > 0) await new Promise(resolve => setTimeout(resolve, 100));
                openApps = getConnectedApps().filter(a => a.isConnected).map(a => a.app);
            }
        } catch (error) {
            let errorMessage: string;
            if (error instanceof Error) {
                errorMessage = error.message;
            } else if (error !== undefined && error !== null) {
                errorMessage = String(error);
            } else {
                errorMessage = "WebSocket connection failed with no error details";
            }
            return {
                connected: false,
                wasReconnected: false,
                healthCheckPassed: false,
                connectionInfos: [],
                error: `Connection failed: ${errorMessage}`,
            };
        }
    }

    if (openApps.length === 0) {
        return {
            connected: false,
            wasReconnected: false,
            healthCheckPassed: false,
            connectionInfos: [],
            error: "Connection succeeded but app is not available",
        };
    }

    // Per-device health-check; reconnect failed devices individually so a dead
    // Android doesn't take down a healthy iOS report and vice versa.
    const perApp: Array<{ app: ConnectedApp; healthy: boolean }> = [];

    for (const candidate of openApps) {
        let app = candidate;
        let healthy = true;

        if (healthCheck) {
            healthy = await runQuickHealthCheck(app);

            if (!healthy && !wasReconnected) {
                const failedTitle = app.deviceInfo.title;
                console.error(`[execbro] Health check failed for ${failedTitle}, attempting reconnection...`);

                const appKey = `${app.port}-${app.deviceInfo.id}`;
                const appPort = app.port;
                cancelReconnectionTimer(appKey);
                try { app.ws.close(); } catch { /* ignore */ }
                connectedApps.delete(appKey);

                const devices = await fetchDevices(appPort);
                const mainDevice = selectMainDevice(devices);
                if (mainDevice) {
                    try {
                        await connectToDevice(mainDevice, appPort);
                        wasReconnected = true;
                        const fresh = getConnectedApps()
                            .filter(a => a.isConnected)
                            .map(a => a.app);
                        const replacement = fresh.find(a => a.deviceInfo.id === mainDevice.id);
                        if (replacement) {
                            app = replacement;
                            healthy = await runQuickHealthCheck(app);
                        } else {
                            healthy = false;
                        }
                    } catch {
                        healthy = false;
                    }
                } else {
                    healthy = false;
                }
            }
        }

        perApp.push({ app, healthy });
    }

    const connectionInfos = perApp.map(({ app, healthy }) => {
        const appKey = `${app.port}-${app.deviceInfo.id}`;
        const connectionState = getConnectionState(appKey);
        const contextHealth = getContextHealth(appKey);
        let uptime = "unknown";
        if (connectionState?.lastConnectedTime) {
            uptime = formatDuration(Date.now() - connectionState.lastConnectedTime.getTime());
        }
        return {
            deviceName: app.deviceInfo.deviceName || app.deviceInfo.title,
            deviceTitle: app.deviceInfo.title,
            platform: app.platform,
            port: app.port,
            uptime,
            contextId: contextHealth?.contextId ?? null,
            healthCheckPassed: healthy,
        };
    });

    const anyOpen = perApp.some(r => r.app.ws.readyState === WebSocket.OPEN);
    const allHealthy = perApp.every(r => r.healthy);

    return {
        connected: anyOpen,
        wasReconnected,
        healthCheckPassed: allHealthy,
        connectionInfos,
        ...(!anyOpen && {
            error: "App became unavailable after reconnection attempt. Try running scan_metro then ensure_connection."
        }),
    };
}

export interface PassiveConnectionStatus {
    connected: boolean;
    needsPing: boolean;
    reason: "ok" | "no_connection" | "context_stale" | "no_activity" | "activity_stale";
}

export function getPassiveConnectionStatus(targetAppKey?: string): PassiveConnectionStatus {
    if (targetAppKey) {
        // Check a specific device's connection
        const app = connectedApps.get(targetAppKey);
        if (!app || app.ws.readyState !== WebSocket.OPEN) {
            return { connected: false, needsPing: false, reason: "no_connection" };
        }

        const health = getContextHealth(targetAppKey);
        if (health?.isStale) {
            return { connected: false, needsPing: false, reason: "context_stale" };
        }

        const lastMessage = getLastCDPMessageTime(targetAppKey);
        if (!lastMessage) {
            return { connected: false, needsPing: false, reason: "no_activity" };
        }

        const elapsed = Date.now() - lastMessage.getTime();
        if (elapsed > STALE_ACTIVITY_THRESHOLD_MS) {
            return { connected: true, needsPing: true, reason: "activity_stale" };
        }

        return { connected: true, needsPing: false, reason: "ok" };
    }

    // Default: check first connected app (backwards compatible)
    if (!hasConnectedApp()) {
        return { connected: false, needsPing: false, reason: "no_connection" };
    }

    const app = getFirstConnectedApp();
    if (app) {
        const appKey = `${app.port}-${app.deviceInfo.id}`;
        const health = getContextHealth(appKey);
        if (health?.isStale) {
            return { connected: false, needsPing: false, reason: "context_stale" };
        }
    }

    const lastMessage = getLastCDPMessageTime();
    if (!lastMessage) {
        return { connected: false, needsPing: false, reason: "no_activity" };
    }

    const elapsed = Date.now() - lastMessage.getTime();
    if (elapsed > STALE_ACTIVITY_THRESHOLD_MS) {
        return { connected: true, needsPing: true, reason: "activity_stale" };
    }

    return { connected: true, needsPing: false, reason: "ok" };
}

export async function checkAndEnsureConnection(device?: string): Promise<ConnectionCheckResult> {
    // Resolve targeted device to appKey if specified
    let targetAppKey: string | undefined;
    let targetApp: ConnectedApp | null = null;

    if (device) {
        try {
            targetApp = getConnectedAppByDevice(device);
            if (targetApp) {
                targetAppKey = `${targetApp.port}-${targetApp.deviceInfo.id}`;
            }
        } catch {
            // Device not found — fall through to reconnection
        }
    }

    const passive = getPassiveConnectionStatus(targetAppKey);

    if (passive.connected && !passive.needsPing) {
        return { connected: true, wasReconnected: false, message: null };
    }

    if (passive.connected && passive.needsPing) {
        const app = targetApp ?? getFirstConnectedApp();
        if (app) {
            const healthy = await runQuickHealthCheck(app);
            if (healthy) {
                return { connected: true, wasReconnected: false, message: null };
            }
        }
    }

    const result = await ensureConnection({ forceRefresh: true, healthCheck: true });

    if (result.connected && result.healthCheckPassed) {
        await new Promise(resolve => setTimeout(resolve, RECONNECT_SETTLE_MS));
        return {
            connected: true,
            wasReconnected: true,
            message: "[CONNECTION] Was stale, re-established. Earlier data may be incomplete; new data will appear on next call.",
        };
    }

    return {
        connected: false,
        wasReconnected: false,
        message: "[CONNECTION] No active connection. Could not reconnect. Ensure Metro and the app are running, then call scan_metro.",
    };
}
