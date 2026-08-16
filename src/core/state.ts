import { ConnectedApp, PendingExecution, LogEntry } from "./types.js";
import { LogBuffer } from "./logs.js";
import { NetworkBuffer } from "./network.js";
import { ImageBuffer } from "./imageBuffer.js";
import { logBufferSize, networkBufferSize } from "./bufferConfig.js";
import { clearHandlesForDevice } from "./promiseHandles.js";

// Per-device log buffers (keyed by deviceName)
export const logBuffers = new Map<string, LogBuffer>();
export const networkBuffers = new Map<string, NetworkBuffer>();

// Per-device app-run counter. Bumped when a new JS runtime is detected.
const _sessionEpochs = new Map<string, number>();

export function getEpoch(deviceName: string): number {
    return _sessionEpochs.get(deviceName) ?? 1;
}

export function bumpEpoch(deviceName: string): number {
    const next = getEpoch(deviceName) + 1;
    _sessionEpochs.set(deviceName, next);
    // A new JS runtime wipes every in-app promise slot, so any handle we
    // handed out for this device can never resolve. Dropping them here — the
    // one place every restart path funnels through — keeps us from offering a
    // `collect` id that is guaranteed to come back "__missing__".
    clearHandlesForDevice(deviceName);
    // The same runtime wipe takes globalThis.__rn__ and the Fast Refresh
    // recorder with it, so the "already bootstrapped" markers now describe a
    // context that no longer exists. Without this, a reload permanently
    // un-installs both for the rest of the server's life — and reload is
    // exactly when get_refresh_status is asked whether an edit landed.
    //
    // Cleared wholesale rather than per device: the marker set is keyed by
    // device name in some paths and by appKey ("<port>-<id>") in others, so
    // there is no reliable key to delete. Re-bootstrapping an unaffected
    // device costs one evaluation.
    bootstrappedApps.clear();
    return next;
}

/** Test-only: clear all epoch state. */
export function resetEpochs(): void {
    _sessionEpochs.clear();
}

/**
 * Resolve the "current run" epoch for a caller-supplied device argument.
 *
 * `device` is a user-facing substring (e.g. "iPhone"), not a buffer key
 * (e.g. "iPhone 17 Pro"), so getEpoch() must not be called on it directly —
 * that silently returns 1 and makes epoch:"current" serve pre-restart data
 * labelled as current. Omitted device means a merged read across devices, so
 * the newest run wins.
 */
export function resolveDeviceEpoch(device?: string): number {
    const keys = new Set([...logBuffers.keys(), ...networkBuffers.keys()]);
    if (device) {
        const needle = device.toLowerCase();
        for (const key of keys) {
            if (key.toLowerCase().includes(needle)) return getEpoch(key);
        }
        return getEpoch(device);
    }
    let max = 1;
    for (const key of keys) {
        max = Math.max(max, getEpoch(key));
    }
    return max;
}

// Helper: get or create a log buffer for a device
export function getLogBuffer(deviceName: string): LogBuffer {
    let buffer = logBuffers.get(deviceName);
    if (!buffer) {
        buffer = new LogBuffer(logBufferSize(), deviceName);
        logBuffers.set(deviceName, buffer);
    }
    return buffer;
}

// Helper: get or create a network buffer for a device
export function getNetworkBuffer(deviceName: string): NetworkBuffer {
    let buffer = networkBuffers.get(deviceName);
    if (!buffer) {
        buffer = new NetworkBuffer(networkBufferSize(), deviceName);
        networkBuffers.set(deviceName, buffer);
    }
    return buffer;
}

// Helper: get merged logs from all devices
export function getAllLogs(count?: number, level?: string): LogEntry[] {
    const allEntries: LogEntry[] = [];
    for (const buffer of logBuffers.values()) {
        allEntries.push(...buffer.getAll());
    }
    allEntries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    if (level) {
        const filtered = allEntries.filter(e => e.level === level);
        return count ? filtered.slice(-count) : filtered;
    }
    return count ? allEntries.slice(-count) : allEntries;
}

// Helper: total log count across all devices
export function getTotalLogCount(): number {
    let total = 0;
    for (const buffer of logBuffers.values()) {
        total += buffer.size;
    }
    return total;
}

// Global bundle error buffer — owned by bundle.ts to avoid a
// bundle ↔ connection ↔ state init cycle; re-exported here for callers
// that still import it from state.
export { bundleErrorBuffer } from "./bundle.js";

// Global image buffer (shared across all screenshot-producing tools)
export const imageBuffer = new ImageBuffer(50);

// Connected apps
export const connectedApps: Map<string, ConnectedApp> = new Map();

// Apps that have already had their globalThis.__rn__ fallback bootstrap
// attempted this session. Keyed by the same string we use for device targeting
// (either the explicit `device` param, or the first connectedApps key). The
// Set is unbounded but each entry is a small string, so accumulation across a
// long-running MCP session is negligible.
export const bootstrappedApps: Set<string> = new Set();

export function getTargetPlatform(): string | undefined {
    const firstApp = connectedApps.values().next().value;
    return firstApp?.platform;
}

// Pending code executions (for executeInApp)
export const pendingExecutions: Map<number, PendingExecution> = new Map();

/**
 * Fail every pending execution that was sent on `ws`, resolving each with
 * `error` and clearing its timeout. Returns how many were failed.
 *
 * Called when a socket closes. Without this, an in-flight CDP call whose socket
 * dies sits until its own timeoutMs expires and then reports a generic
 * "Expression took too long" — which classifies as a logical timeout, so
 * auto-reconnect never runs. Failing it here surfaces the real transport cause.
 */
/**
 * True when a DIFFERENT socket now holds `appKey` — i.e. this one has been
 * superseded by a reconnect and no longer owns the registry entry.
 *
 * A close handler captures its own socket, but the registry is keyed by device,
 * so a replacement lands under the same key. Without this check a dead socket's
 * close event evicts the live connection that replaced it, and the registry
 * reports no Metro while a working socket is open.
 *
 * Deliberately false when NO entry exists: a socket that dies during setup —
 * before it was ever registered — still has to run its own teardown and
 * schedule the reconnect. That is the common flap case, not an edge case.
 */
export function isSupersededSocket(appKey: string, ws: unknown): boolean {
    const current = connectedApps.get(appKey);
    return !!current && current.ws !== ws;
}

export function failPendingExecutionsForSocket(ws: unknown, error: string): number {
    let failed = 0;
    for (const [messageId, pending] of pendingExecutions) {
        if (!pending.ws || pending.ws !== ws) continue;
        clearTimeout(pending.timeoutId);
        pendingExecutions.delete(messageId);
        pending.resolve({ success: false, error });
        failed++;
    }
    return failed;
}

// CDP message ID counter
let _messageId = 1;

export function getNextMessageId(): number {
    return _messageId++;
}

// Active iOS simulator UDID (resolved from Metro connection)
// This links the Metro-connected device to its iOS simulator
let _activeSimulatorUdid: string | null = null;
let _activeSimulatorSourceAppKey: string | null = null;

export function getActiveSimulatorUdid(): string | null {
    return _activeSimulatorUdid;
}

export function setActiveSimulatorUdid(udid: string | null, sourceAppKey?: string): void {
    _activeSimulatorUdid = udid;
    _activeSimulatorSourceAppKey = sourceAppKey || null;
}

export function clearActiveSimulatorIfSource(appKey: string): void {
    if (_activeSimulatorSourceAppKey === appKey) {
        _activeSimulatorUdid = null;
        _activeSimulatorSourceAppKey = null;
    }
}

// Per-device last CDP message timestamps (for connection liveness detection)
const _lastCDPMessageTimes = new Map<string, Date>();

/**
 * Get last CDP message time for a specific device, or the most recent across all devices.
 */
export function getLastCDPMessageTime(appKey?: string): Date | null {
    if (appKey) {
        return _lastCDPMessageTimes.get(appKey) ?? null;
    }
    // Global fallback: return the most recent time across all devices
    let latest: Date | null = null;
    for (const time of _lastCDPMessageTimes.values()) {
        if (!latest || time.getTime() > latest.getTime()) {
            latest = time;
        }
    }
    return latest;
}

/**
 * Update last CDP message time for a specific device.
 */
export function updateLastCDPMessageTime(appKey: string, time: Date): void {
    _lastCDPMessageTimes.set(appKey, time);
}

/**
 * Clear last CDP message time for a specific device.
 */
export function clearLastCDPMessageTime(appKey: string): void {
    _lastCDPMessageTimes.delete(appKey);
}

/**
 * Clear all CDP message times (for cleanup/testing).
 */
export function clearAllCDPMessageTimes(): void {
    _lastCDPMessageTimes.clear();
}
