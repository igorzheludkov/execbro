import { ConnectedApp, PendingExecution } from "./types.js";
import { LogBuffer } from "./logs.js";
import { NetworkBuffer } from "./network.js";
import { BundleErrorBuffer, initBundleErrorBuffer } from "./bundle.js";

// Global log buffer
export const logBuffer = new LogBuffer(500);

// Global network buffer
export const networkBuffer = new NetworkBuffer(200);

// Global bundle error buffer
export const bundleErrorBuffer = new BundleErrorBuffer(100);

// Initialize bundle error buffer reference in bundle.ts
initBundleErrorBuffer(bundleErrorBuffer);

// Connected apps
export const connectedApps: Map<string, ConnectedApp> = new Map();

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
