import { ConnectedApp, PendingExecution } from "./types.js";
import { LogBuffer } from "./logs.js";
import { NetworkBuffer } from "./network.js";
import { BundleErrorBuffer, initBundleErrorBuffer } from "./bundle.js";

// Global log buffer
export const logBuffer = new LogBuffer(1000);

// Global network buffer
export const networkBuffer = new NetworkBuffer(500);

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
