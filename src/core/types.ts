import WebSocket from "ws";

// Log entry interface
export interface LogEntry {
    timestamp: Date;
    level: "log" | "warn" | "error" | "info" | "debug" | "fatal";
    message: string;
    args?: unknown[];
    // Process-global monotonic sequence, assigned by LogBuffer.add(). Stable
    // for the lifetime of the server, which is what lets a JS log event carry
    // an addressable id (`j12`) rather than a position in the last response.
    seq: number;
    // Per-device app-run counter, stamped by LogBuffer.add(). Bumps when a new
    // JS runtime is detected (app restart / reload), which is what lets readers
    // draw a restart boundary and keeps ids from colliding across runs.
    epoch: number;
    // Raw CDP frames, stored unresolved. Symbolication is a network call to
    // Metro, so it happens lazily at read time — the capture path must never
    // block or fail on it. Only kept for warn/error/fatal (see logStack.ts).
    stackTrace?: CDPStackFrame[];
}

// One frame of a CDP `stackTrace.callFrames` array. Line and column are
// 0-based here, unlike the 1-based frames parseStackString() produces from JS
// stack strings — see toStackFrames() in logStack.ts.
export interface CDPStackFrame {
    functionName?: string;
    scriptId?: string;
    url?: string;
    lineNumber: number;
    columnNumber: number;
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
    platform: "ios" | "android";
    simulatorUdid?: string;
    // Android emulator/device serial (e.g. "emulator-5554"). Populated at
    // connect time when getAdbIdForAvd matches deviceName to a running
    // emulator. Stays undefined for physical Android devices unless we add
    // a dedicated matcher later. Used by deviceResolver to short-circuit
    // OS-level lookups.
    adbSerial?: string;
    lastScreenshot?: {
        originalWidth: number;
        originalHeight: number;
        scaleFactor: number;
    };
    cdpNetworkSupported?: boolean;
    // True when the in-app execbro-sdk is detected
    // (globalThis.__EXECBRO__). When true, we skip CDP/JS-interceptor
    // buffer writes since the SDK becomes the single source of truth and
    // would otherwise duplicate every entry. Probed periodically because the
    // SDK's init() may run after we connect.
    sdkPresent?: boolean;
    sdkProbeTimer?: NodeJS.Timeout;
    // Consecutive SDK-absent probe results while sdkPresent was true. Used as
    // hysteresis so a single missed probe right after a reload (the new JS
    // context recreated but the SDK's init() hasn't re-run yet) does not flip
    // sdkPresent false and restore duplicate-prone CDP/interceptor writes.
    sdkMissCount?: number;
    appDetection?: AppDetectionResult;
    // Resolves when scheduleAppDetection's probe finishes (success, error, or
    // timeout). Callers that want to display detection info — e.g. get_apps —
    // can race this against a cap to avoid showing presumptive "RN unknown".
    appDetectionPromise?: Promise<void>;
}

export interface AppDetectionResult {
    reactNativeVersion: string;
    architecture: "new" | "old";
    jsEngine: "hermes" | "jsc";
    appPlatform: "ios" | "android";
    osVersion: string;
    expoSdkVersion?: string;
    // "probe" = full Runtime.evaluate succeeded; "device-info" = inferred from
    // Metro /json DeviceInfo at connect time. Presumptive entries may be upgraded
    // later when the probe completes.
    detectionSource?: "probe" | "device-info";
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
    /**
     * The socket this call went out on. Lets a close handler fail exactly the
     * calls that died with that socket instead of leaving them parked until
     * their own timeout fires. Optional: callers that manage their own short
     * timeout (e.g. the 2s health check) may omit it.
     */
    ws?: unknown;
}

// Result of code execution
export interface ExecutionResult {
    success: boolean;
    result?: string;
    error?: string;
    // Short, low-cardinality failure tag (e.g. "no_metro", "connect_failed").
    // Tools forward it as `_errorContext` so telemetry can cluster failures
    // without regex-matching the human-facing message.
    errorContext?: string;
    _meta?: {
        reconnected?: boolean;
        transportError?: string;
        timeoutClampedFrom?: number;
    };
}

// Log level type
// Filter sentinel "all" is included here because get_logs uses this type for
// its `level` param. Severity ordering lives in EventLevel (logEvents.ts),
// which excludes "all" — ranking a sentinel is meaningless.
export type LogLevel = "all" | "log" | "warn" | "error" | "info" | "debug" | "fatal";

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
    // See LogEntry.epoch.
    epoch: number;
    // Response payload. Populated by the SDK mirror and by the injected JS
    // interceptor's XHR layer (capped at 32 KB in-app before serialization).
    // The CDP path does not capture response bodies.
    responseBody?: string;
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
    maxRetries?: number;          // Default: 2
    retryDelayMs?: number;        // Default: 1000
    autoReconnect?: boolean;      // Default: true
    timeoutMs?: number;           // Default: 10000
    originatingToolName?: string; // For telemetry attribution on auto-reconnect outcomes
    // Internal: when true, skip the one-shot globalThis.__rn__ fallback
    // bootstrap. Set by the bootstrap itself to prevent infinite recursion
    // (the bootstrap runs through executeInApp).
    skipBootstrap?: boolean;
}

export interface ConnectionCheckResult {
    connected: boolean;
    wasReconnected: boolean;
    message: string | null;
}

// Per-device entry surfaced by ensure_connection. `healthCheckPassed` is
// per-device so callers can tell which of N connected apps went stale; the
// top-level `healthCheckPassed` aggregates with AND (conservative).
// `deviceName` matches the identifier tools like `tap` accept via `device=...`.
export interface EnsureConnectionDeviceInfo {
    deviceName: string;
    deviceTitle: string;
    platform: "ios" | "android";
    port: number;
    uptime: string;
    contextId: number | null;
    healthCheckPassed: boolean;
}

// Result of ensure_connection. `connected` is true when at least one app has
// an OPEN WebSocket; `healthCheckPassed` requires ALL connected apps to pass.
export interface EnsureConnectionResult {
    connected: boolean;
    wasReconnected: boolean;
    healthCheckPassed: boolean;
    connectionInfos: EnsureConnectionDeviceInfo[];
    error?: string;
}
