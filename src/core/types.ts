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
