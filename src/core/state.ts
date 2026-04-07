import { ConnectedApp, PendingExecution, LogEntry } from "./types.js";
import { LogBuffer } from "./logs.js";
import { NetworkBuffer } from "./network.js";
import { BundleErrorBuffer, initBundleErrorBuffer } from "./bundle.js";
import { ImageBuffer } from "./imageBuffer.js";

// Per-device log buffers (keyed by deviceName)
export const logBuffers = new Map<string, LogBuffer>();
export const networkBuffers = new Map<string, NetworkBuffer>();

// Helper: get or create a log buffer for a device
export function getLogBuffer(deviceName: string): LogBuffer {
    let buffer = logBuffers.get(deviceName);
    if (!buffer) {
        buffer = new LogBuffer(500);
        logBuffers.set(deviceName, buffer);
    }
    return buffer;
}

// Helper: get or create a network buffer for a device
export function getNetworkBuffer(deviceName: string): NetworkBuffer {
    let buffer = networkBuffers.get(deviceName);
    if (!buffer) {
        buffer = new NetworkBuffer(200);
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

// Global bundle error buffer
export const bundleErrorBuffer = new BundleErrorBuffer(100);

// Global image buffer (shared across all screenshot-producing tools)
export const imageBuffer = new ImageBuffer(50);

// Initialize bundle error buffer reference in bundle.ts
initBundleErrorBuffer(bundleErrorBuffer);

// Connected apps
export const connectedApps: Map<string, ConnectedApp> = new Map();

export function getTargetPlatform(): string | undefined {
    const firstApp = connectedApps.values().next().value;
    return firstApp?.platform;
}

// Pending code executions (for executeInApp)
export const pendingExecutions: Map<number, PendingExecution> = new Map();

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

// Last CDP message received timestamp (for connection liveness detection)
let _lastCDPMessageAt: Date | null = null;

export function getLastCDPMessageTime(): Date | null {
    return _lastCDPMessageAt;
}

export function updateLastCDPMessageTime(time: Date | null): void {
    _lastCDPMessageAt = time;
}
