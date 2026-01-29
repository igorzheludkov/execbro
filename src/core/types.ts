import WebSocket from "ws";

// Log entry interface
export interface LogEntry {
    timestamp: Date;
    level: "log" | "warn" | "error" | "info" | "debug";
    message: string;
    args?: unknown[];
}

// Device info from /json endpoint
export interface DeviceInfo {
    id: string;
    title: string;
    description: string;
    appId: string;
    type: string;
    webSocketDebuggerUrl: string;
    deviceName: string;
}

// Connected app info
export interface ConnectedApp {
    ws: WebSocket;
    deviceInfo: DeviceInfo;
    port: number;
}

// CDP RemoteObject type (result of Runtime.evaluate)
export interface RemoteObject {
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
export interface ExceptionDetails {
    exceptionId: number;
    text: string;
    lineNumber: number;
    columnNumber: number;
    exception?: RemoteObject;
}

// Pending execution tracker
export interface PendingExecution {
    resolve: (result: ExecutionResult) => void;
    timeoutId: NodeJS.Timeout;
}

// Result of code execution
export interface ExecutionResult {
    success: boolean;
    result?: string;
    error?: string;
}

// Log level type
export type LogLevel = "all" | "log" | "warn" | "error" | "info" | "debug";

// Network request entry
export interface NetworkRequest {
    requestId: string;
    timestamp: Date;
    method: string;
    url: string;
    headers: Record<string, string>;
    postData?: string;
    status?: number;
    statusText?: string;
    responseHeaders?: Record<string, string>;
    mimeType?: string;
    contentLength?: number;
    timing?: {
        requestTime?: number;
        responseTime?: number;
        duration?: number;
    };
    error?: string;
    completed: boolean;
}

// Connection state tracking for auto-reconnection
export interface ConnectionState {
    status: "connected" | "disconnected" | "reconnecting";
    lastConnectedTime: Date | null;
    lastDisconnectTime: Date | null;
    reconnectionAttempts: number;
    connectionGaps: ConnectionGap[];
}

// Record of a connection gap (when we were disconnected)
export interface ConnectionGap {
    disconnectedAt: Date;
    reconnectedAt: Date | null;
    durationMs: number | null;
    reason: string;
}

// Metadata stored for reconnection attempts
export interface ConnectionMetadata {
    port: number;
    deviceInfo: DeviceInfo;
    webSocketUrl: string;
}

// Configuration for reconnection behavior
export interface ReconnectionConfig {
    enabled: boolean;
    maxAttempts: number;
    initialDelayMs: number;
    maxDelayMs: number;
    backoffMultiplier: number;
}

// Options for connectToDevice
export interface ConnectOptions {
    isReconnection?: boolean;
    reconnectionConfig?: ReconnectionConfig;
}

// Context health tracking for page-level connection health
export interface ContextHealth {
    contextId: number | null;
    lastContextCreated: Date | null;
    lastContextDestroyed: Date | null;
    isStale: boolean;
    lastHealthCheck: Date | null;
    lastHealthCheckSuccess: boolean;
}

// Options for execute_in_app retry behavior
export interface ExecuteOptions {
    maxRetries?: number;      // Default: 2
    retryDelayMs?: number;    // Default: 1000
    autoReconnect?: boolean;  // Default: true
}

// Result of ensure_connection
export interface EnsureConnectionResult {
    connected: boolean;
    wasReconnected: boolean;
    healthCheckPassed: boolean;
    connectionInfo: {
        deviceTitle: string;
        port: number;
        uptime: string;
        contextId: number | null;
    } | null;
    error?: string;
}
