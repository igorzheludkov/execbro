# Test Infrastructure Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Jest test infrastructure with unit and integration tests for the MCP server's core modules.

**Architecture:** Jest with ts-jest for ESM TypeScript. Unit tests cover pure-logic modules (buffers, validation, device selection). Integration tests use a fake WebSocket CDP server to test the full executeInApp flow and tool handlers.

**Tech Stack:** Jest, ts-jest, @types/jest, ws (already installed, reused for fake server)

---

### Task 1: Install Jest and configure for ESM TypeScript

**Files:**
- Modify: `package.json` (add devDependencies and scripts)
- Create: `jest.config.ts`

**Step 1: Install dependencies**

Run: `npm install --save-dev jest @types/jest ts-jest`

**Step 2: Create jest.config.ts**

```typescript
import type { Config } from "jest";

const config: Config = {
    preset: "ts-jest/presets/default-esm",
    testEnvironment: "node",
    roots: ["<rootDir>/src"],
    testMatch: ["**/__tests__/**/*.test.ts"],
    moduleNameMapper: {
        "^(\\.{1,2}/.*)\\.js$": "$1",
    },
    transform: {
        "^.+\\.tsx?$": [
            "ts-jest",
            {
                useESM: true,
            },
        ],
    },
    extensionsToTreatAsEsm: [".ts"],
};

export default config;
```

**Step 3: Add test scripts to package.json**

Add to `"scripts"`:
```json
"test": "NODE_OPTIONS='--experimental-vm-modules' jest",
"test:unit": "NODE_OPTIONS='--experimental-vm-modules' jest --testPathPattern='__tests__/unit'",
"test:integration": "NODE_OPTIONS='--experimental-vm-modules' jest --testPathPattern='__tests__/integration'"
```

**Step 4: Create directory structure**

Run:
```bash
mkdir -p src/__tests__/unit src/__tests__/integration src/__tests__/helpers
```

**Step 5: Verify Jest runs (empty)**

Run: `npm test -- --passWithNoTests`
Expected: Jest runs with 0 tests, exits 0.

**Step 6: Commit**

```bash
git add package.json package-lock.json jest.config.ts src/__tests__/
git commit -m "chore: add Jest test infrastructure with ESM support"
```

---

### Task 2: Export validation functions from executor.ts

The expression validation functions (`containsProblematicUnicode`, `stripLeadingComments`, `validateAndPreprocessExpression`) are private. Export them for direct unit testing.

**Files:**
- Modify: `src/core/executor.ts` (add `export` to 3 functions)

**Step 1: Export the three validation functions**

In `src/core/executor.ts`, change these function declarations from `function` to `export function`:
- Line 26: `function containsProblematicUnicode` → `export function containsProblematicUnicode`
- Line 37: `function stripLeadingComments` → `export function stripLeadingComments`
- Line 70: `function validateAndPreprocessExpression` → `export function validateAndPreprocessExpression`

**Step 2: Verify build still passes**

Run: `npm run build`
Expected: Clean build, no errors.

**Step 3: Commit**

```bash
git add src/core/executor.ts
git commit -m "refactor: export validation functions from executor for testing"
```

---

### Task 3: Unit tests — executor validation functions

**Files:**
- Create: `src/__tests__/unit/executor.test.ts`

**Step 1: Write the tests**

```typescript
import {
    containsProblematicUnicode,
    stripLeadingComments,
    validateAndPreprocessExpression,
} from "../../core/executor.js";

describe("containsProblematicUnicode", () => {
    it("returns false for ASCII text", () => {
        expect(containsProblematicUnicode("hello world")).toBe(false);
    });

    it("returns false for basic Unicode (BMP)", () => {
        expect(containsProblematicUnicode("café")).toBe(false);
    });

    it("returns true for emoji (surrogate pairs)", () => {
        expect(containsProblematicUnicode("hello 😀")).toBe(true);
    });

    it("returns true for flag emoji", () => {
        expect(containsProblematicUnicode("🇺🇸")).toBe(true);
    });

    it("returns false for empty string", () => {
        expect(containsProblematicUnicode("")).toBe(false);
    });
});

describe("stripLeadingComments", () => {
    it("returns expression unchanged when no comments", () => {
        expect(stripLeadingComments("1 + 1")).toBe("1 + 1");
    });

    it("strips single-line comment", () => {
        expect(stripLeadingComments("// comment\n1 + 1")).toBe("1 + 1");
    });

    it("strips multiple single-line comments", () => {
        expect(stripLeadingComments("// one\n// two\n1 + 1")).toBe("1 + 1");
    });

    it("strips multi-line comment", () => {
        expect(stripLeadingComments("/* comment */1 + 1")).toBe("1 + 1");
    });

    it("returns empty string when entire expression is a comment", () => {
        expect(stripLeadingComments("// just a comment")).toBe("");
    });

    it("returns expression with unclosed multi-line comment", () => {
        expect(stripLeadingComments("/* unclosed")).toBe("/* unclosed");
    });

    it("strips leading whitespace before comments", () => {
        expect(stripLeadingComments("  // comment\n42")).toBe("42");
    });
});

describe("validateAndPreprocessExpression", () => {
    it("accepts valid simple expression", () => {
        const result = validateAndPreprocessExpression("1 + 1");
        expect(result.valid).toBe(true);
        expect(result.expression).toBe("1 + 1");
    });

    it("rejects expression with emoji", () => {
        const result = validateAndPreprocessExpression("console.log('😀')");
        expect(result.valid).toBe(false);
        expect(result.error).toContain("emoji");
    });

    it("rejects empty expression after stripping comments", () => {
        const result = validateAndPreprocessExpression("// just a comment");
        expect(result.valid).toBe(false);
        expect(result.error).toContain("empty");
    });

    it("rejects top-level async function", () => {
        const result = validateAndPreprocessExpression("async () => { await fetch() }");
        expect(result.valid).toBe(false);
        expect(result.error).toContain("async");
    });

    it("rejects async IIFE", () => {
        const result = validateAndPreprocessExpression("(async () => { await fetch() })()");
        expect(result.valid).toBe(false);
        expect(result.error).toContain("async");
    });

    it("strips comments and validates remaining expression", () => {
        const result = validateAndPreprocessExpression("// setup\n__DEV__");
        expect(result.valid).toBe(true);
        expect(result.expression).toBe("__DEV__");
    });

    it("accepts multi-statement expression", () => {
        const result = validateAndPreprocessExpression("var x = 1; x");
        expect(result.valid).toBe(true);
    });
});
```

**Step 2: Run test to verify it passes**

Run: `npm run test:unit -- --verbose`
Expected: All tests PASS.

**Step 3: Commit**

```bash
git add src/__tests__/unit/executor.test.ts
git commit -m "test: add unit tests for executor validation functions"
```

---

### Task 4: Unit tests — LogBuffer

**Files:**
- Create: `src/__tests__/unit/logs.test.ts`

**Step 1: Write the tests**

```typescript
import { LogBuffer, mapConsoleType } from "../../core/logs.js";
import { LogEntry } from "../../core/types.js";

function makeLog(message: string, level: LogEntry["level"] = "log"): LogEntry {
    return { timestamp: new Date(), level, message };
}

describe("LogBuffer", () => {
    let buffer: LogBuffer;

    beforeEach(() => {
        buffer = new LogBuffer(5);
    });

    it("starts empty", () => {
        expect(buffer.size).toBe(0);
        expect(buffer.getAll()).toEqual([]);
    });

    it("adds and retrieves logs", () => {
        buffer.add(makeLog("hello"));
        expect(buffer.size).toBe(1);
        expect(buffer.getAll()[0].message).toBe("hello");
    });

    it("evicts oldest when exceeding maxSize", () => {
        for (let i = 0; i < 7; i++) {
            buffer.add(makeLog(`msg-${i}`));
        }
        expect(buffer.size).toBe(5);
        expect(buffer.getAll()[0].message).toBe("msg-2");
        expect(buffer.getAll()[4].message).toBe("msg-6");
    });

    it("get() limits count", () => {
        for (let i = 0; i < 5; i++) buffer.add(makeLog(`msg-${i}`));
        const result = buffer.get(2);
        expect(result).toHaveLength(2);
    });

    it("get() filters by level", () => {
        buffer.add(makeLog("info msg", "info"));
        buffer.add(makeLog("error msg", "error"));
        buffer.add(makeLog("warn msg", "warn"));
        const errors = buffer.get(undefined, "error");
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toBe("error msg");
    });

    it("get() with startFromText finds last match and returns from there", () => {
        buffer.add(makeLog("start"));
        buffer.add(makeLog("marker"));
        buffer.add(makeLog("after1"));
        buffer.add(makeLog("marker"));
        buffer.add(makeLog("after2"));
        const result = buffer.get(undefined, undefined, "marker");
        expect(result).toHaveLength(2);
        expect(result[0].message).toBe("marker");
        expect(result[1].message).toBe("after2");
    });

    it("search() is case-insensitive", () => {
        buffer.add(makeLog("Hello World"));
        buffer.add(makeLog("goodbye"));
        const results = buffer.search("hello");
        expect(results).toHaveLength(1);
        expect(results[0].message).toBe("Hello World");
    });

    it("search() limits maxResults", () => {
        for (let i = 0; i < 5; i++) buffer.add(makeLog("match"));
        expect(buffer.search("match", 2)).toHaveLength(2);
    });

    it("clear() empties buffer and returns count", () => {
        buffer.add(makeLog("a"));
        buffer.add(makeLog("b"));
        const cleared = buffer.clear();
        expect(cleared).toBe(2);
        expect(buffer.size).toBe(0);
    });
});

describe("mapConsoleType", () => {
    it("maps error to error", () => expect(mapConsoleType("error")).toBe("error"));
    it("maps warning to warn", () => expect(mapConsoleType("warning")).toBe("warn"));
    it("maps warn to warn", () => expect(mapConsoleType("warn")).toBe("warn"));
    it("maps info to info", () => expect(mapConsoleType("info")).toBe("info"));
    it("maps debug to debug", () => expect(mapConsoleType("debug")).toBe("debug"));
    it("maps unknown to log", () => expect(mapConsoleType("trace")).toBe("log"));
});
```

**Step 2: Run tests**

Run: `npm run test:unit -- --verbose`
Expected: All tests PASS.

**Step 3: Commit**

```bash
git add src/__tests__/unit/logs.test.ts
git commit -m "test: add unit tests for LogBuffer and mapConsoleType"
```

---

### Task 5: Unit tests — NetworkBuffer

**Files:**
- Create: `src/__tests__/unit/network.test.ts`

**Step 1: Write the tests**

```typescript
import { NetworkBuffer } from "../../core/network.js";
import { NetworkRequest } from "../../core/types.js";

function makeRequest(id: string, overrides: Partial<NetworkRequest> = {}): NetworkRequest {
    return {
        requestId: id,
        timestamp: new Date(),
        method: "GET",
        url: `https://api.example.com/${id}`,
        headers: {},
        completed: false,
        ...overrides,
    };
}

describe("NetworkBuffer", () => {
    let buffer: NetworkBuffer;

    beforeEach(() => {
        buffer = new NetworkBuffer(5);
    });

    it("starts empty", () => {
        expect(buffer.size).toBe(0);
    });

    it("set and get a request", () => {
        const req = makeRequest("1");
        buffer.set("1", req);
        expect(buffer.get("1")).toBe(req);
        expect(buffer.size).toBe(1);
    });

    it("updates existing request without increasing size", () => {
        buffer.set("1", makeRequest("1"));
        buffer.set("1", makeRequest("1", { status: 200, completed: true }));
        expect(buffer.size).toBe(1);
        expect(buffer.get("1")?.status).toBe(200);
    });

    it("evicts oldest when exceeding maxSize", () => {
        for (let i = 0; i < 7; i++) {
            buffer.set(`${i}`, makeRequest(`${i}`));
        }
        expect(buffer.size).toBe(5);
        expect(buffer.get("0")).toBeUndefined();
        expect(buffer.get("1")).toBeUndefined();
        expect(buffer.get("2")).toBeDefined();
    });

    it("getAll() filters by method", () => {
        buffer.set("1", makeRequest("1", { method: "GET" }));
        buffer.set("2", makeRequest("2", { method: "POST" }));
        const posts = buffer.getAll({ method: "POST" });
        expect(posts).toHaveLength(1);
        expect(posts[0].method).toBe("POST");
    });

    it("getAll() filters by method case-insensitively", () => {
        buffer.set("1", makeRequest("1", { method: "GET" }));
        const results = buffer.getAll({ method: "get" });
        expect(results).toHaveLength(1);
    });

    it("getAll() filters by urlPattern (case-insensitive substring)", () => {
        buffer.set("1", makeRequest("1", { url: "https://api.example.com/users" }));
        buffer.set("2", makeRequest("2", { url: "https://api.example.com/posts" }));
        const results = buffer.getAll({ urlPattern: "users" });
        expect(results).toHaveLength(1);
    });

    it("getAll() filters by status", () => {
        buffer.set("1", makeRequest("1", { status: 200 }));
        buffer.set("2", makeRequest("2", { status: 404 }));
        const results = buffer.getAll({ status: 200 });
        expect(results).toHaveLength(1);
    });

    it("getAll() filters completedOnly", () => {
        buffer.set("1", makeRequest("1", { completed: true }));
        buffer.set("2", makeRequest("2", { completed: false }));
        const results = buffer.getAll({ completedOnly: true });
        expect(results).toHaveLength(1);
    });

    it("getAll() limits count (takes last N)", () => {
        for (let i = 0; i < 5; i++) {
            buffer.set(`${i}`, makeRequest(`${i}`));
        }
        const results = buffer.getAll({ count: 2 });
        expect(results).toHaveLength(2);
    });

    it("getAll() sorts by timestamp", () => {
        const earlier = new Date("2024-01-01T00:00:00Z");
        const later = new Date("2024-01-01T01:00:00Z");
        buffer.set("late", makeRequest("late", { timestamp: later }));
        buffer.set("early", makeRequest("early", { timestamp: earlier }));
        const results = buffer.getAll({});
        expect(results[0].requestId).toBe("early");
        expect(results[1].requestId).toBe("late");
    });

    it("search() finds by URL pattern", () => {
        buffer.set("1", makeRequest("1", { url: "https://api.example.com/users" }));
        buffer.set("2", makeRequest("2", { url: "https://api.example.com/posts" }));
        const results = buffer.search("users");
        expect(results).toHaveLength(1);
    });

    it("clear() empties buffer and returns count", () => {
        buffer.set("1", makeRequest("1"));
        buffer.set("2", makeRequest("2"));
        expect(buffer.clear()).toBe(2);
        expect(buffer.size).toBe(0);
    });
});
```

**Step 2: Run tests**

Run: `npm run test:unit -- --verbose`
Expected: All tests PASS.

**Step 3: Commit**

```bash
git add src/__tests__/unit/network.test.ts
git commit -m "test: add unit tests for NetworkBuffer"
```

---

### Task 6: Unit tests — BundleErrorBuffer and metro selectMainDevice

**Files:**
- Create: `src/__tests__/unit/bundle.test.ts`
- Create: `src/__tests__/unit/metro.test.ts`

**Step 1: Write bundle tests**

```typescript
import { BundleErrorBuffer, BundleError } from "../../core/bundle.js";

function makeError(message: string, type: BundleError["type"] = "other"): BundleError {
    return { timestamp: new Date(), type, message };
}

describe("BundleErrorBuffer", () => {
    let buffer: BundleErrorBuffer;

    beforeEach(() => {
        buffer = new BundleErrorBuffer(3);
    });

    it("starts empty", () => {
        expect(buffer.size).toBe(0);
        expect(buffer.getLatest()).toBeNull();
    });

    it("adds errors and sets hasError status", () => {
        buffer.add(makeError("syntax error", "syntax"));
        expect(buffer.size).toBe(1);
        expect(buffer.getStatus().hasError).toBe(true);
    });

    it("getLatest() returns most recent error", () => {
        buffer.add(makeError("first"));
        buffer.add(makeError("second"));
        expect(buffer.getLatest()?.message).toBe("second");
    });

    it("evicts oldest when exceeding maxSize", () => {
        for (let i = 0; i < 5; i++) buffer.add(makeError(`err-${i}`));
        expect(buffer.size).toBe(3);
        const all = buffer.get();
        expect(all[0].message).toBe("err-2");
    });

    it("get(count) returns last N errors", () => {
        for (let i = 0; i < 3; i++) buffer.add(makeError(`err-${i}`));
        const last2 = buffer.get(2);
        expect(last2).toHaveLength(2);
        expect(last2[0].message).toBe("err-1");
    });

    it("clear() empties buffer and resets hasError", () => {
        buffer.add(makeError("err"));
        expect(buffer.clear()).toBe(1);
        expect(buffer.size).toBe(0);
        expect(buffer.getStatus().hasError).toBe(false);
    });

    it("updateStatus() merges partial status", () => {
        buffer.updateStatus({ isBuilding: true, buildTime: 500 });
        const status = buffer.getStatus();
        expect(status.isBuilding).toBe(true);
        expect(status.buildTime).toBe(500);
        expect(status.hasError).toBe(false);
    });
});
```

**Step 2: Write metro tests**

```typescript
import { selectMainDevice } from "../../core/metro.js";
import { DeviceInfo } from "../../core/types.js";

function makeDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
    return {
        id: "test-id",
        title: "Test Device",
        description: "Test Description",
        appId: "com.test.app",
        type: "node",
        webSocketDebuggerUrl: "ws://localhost:8081/inspector/device?page=1",
        deviceName: "Test",
        ...overrides,
    };
}

describe("selectMainDevice", () => {
    it("returns null for empty list", () => {
        expect(selectMainDevice([])).toBeNull();
    });

    it("prefers Bridgeless device (Expo SDK 54+)", () => {
        const devices = [
            makeDevice({ id: "hermes", title: "Hermes React Native" }),
            makeDevice({ id: "bridgeless", description: "React Native Bridgeless [C++ (Hermes)]" }),
        ];
        expect(selectMainDevice(devices)?.id).toBe("bridgeless");
    });

    it("prefers Hermes when no Bridgeless available", () => {
        const devices = [
            makeDevice({ id: "generic", title: "React Native" }),
            makeDevice({ id: "hermes", title: "Hermes React Native" }),
        ];
        expect(selectMainDevice(devices)?.id).toBe("hermes");
    });

    it("selects Hermes by title containing 'Hermes'", () => {
        const devices = [
            makeDevice({ id: "hermes", title: "Some Hermes Runtime" }),
        ];
        expect(selectMainDevice(devices)?.id).toBe("hermes");
    });

    it("falls back to React Native excluding Reanimated", () => {
        const devices = [
            makeDevice({ id: "reanimated", title: "Reanimated React Native" }),
            makeDevice({ id: "rn", title: "React Native" }),
        ];
        expect(selectMainDevice(devices)?.id).toBe("rn");
    });

    it("excludes Experimental devices from React Native fallback", () => {
        const devices = [
            makeDevice({ id: "exp", title: "Experimental React Native" }),
            makeDevice({ id: "other", title: "Unknown Device" }),
        ];
        expect(selectMainDevice(devices)?.id).toBe("other");
    });

    it("falls back to first device when no RN match", () => {
        const devices = [
            makeDevice({ id: "first", title: "Unknown Device" }),
            makeDevice({ id: "second", title: "Other Device" }),
        ];
        expect(selectMainDevice(devices)?.id).toBe("first");
    });
});
```

**Step 3: Run all unit tests**

Run: `npm run test:unit -- --verbose`
Expected: All tests PASS.

**Step 4: Commit**

```bash
git add src/__tests__/unit/bundle.test.ts src/__tests__/unit/metro.test.ts
git commit -m "test: add unit tests for BundleErrorBuffer and selectMainDevice"
```

---

### Task 7: Create fake CDP server helper

**Files:**
- Create: `src/__tests__/helpers/fake-cdp-server.ts`

**Step 1: Write the fake CDP server**

```typescript
import { WebSocketServer, WebSocket } from "ws";

interface CDPResponse {
    result?: {
        result?: {
            type: string;
            value?: unknown;
            subtype?: string;
            description?: string;
        };
        exceptionDetails?: {
            exceptionId: number;
            text: string;
            lineNumber: number;
            columnNumber: number;
            exception?: {
                type: string;
                subtype?: string;
                className?: string;
                description?: string;
                value?: unknown;
            };
        };
    };
    error?: {
        message: string;
        code?: number;
    };
}

type ResponseHandler = (params: Record<string, unknown>) => CDPResponse;

export class FakeCDPServer {
    private server: WebSocketServer | null = null;
    private connections: WebSocket[] = [];
    private evaluateHandler: ResponseHandler | null = null;
    private _receivedMessages: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
    port = 0;

    async start(): Promise<number> {
        return new Promise((resolve) => {
            this.server = new WebSocketServer({ port: 0 }, () => {
                this.port = (this.server!.address() as { port: number }).port;
                resolve(this.port);
            });

            this.server.on("connection", (ws) => {
                this.connections.push(ws);
                ws.on("message", (data) => {
                    const msg = JSON.parse(data.toString());
                    this._receivedMessages.push(msg);
                    this.handleMessage(ws, msg);
                });
                ws.on("close", () => {
                    this.connections = this.connections.filter((c) => c !== ws);
                });
            });
        });
    }

    private handleMessage(ws: WebSocket, msg: { id: number; method: string; params?: Record<string, unknown> }): void {
        // Auto-respond to domain enable messages
        if (msg.method === "Runtime.enable" || msg.method === "Log.enable" || msg.method === "Network.enable") {
            ws.send(JSON.stringify({ id: msg.id, result: {} }));
            return;
        }

        // Handle Runtime.evaluate with custom handler
        if (msg.method === "Runtime.evaluate") {
            if (this.evaluateHandler) {
                const response = this.evaluateHandler(msg.params || {});
                ws.send(JSON.stringify({ id: msg.id, ...response }));
            } else {
                // Default: return undefined
                ws.send(JSON.stringify({
                    id: msg.id,
                    result: { result: { type: "undefined" } },
                }));
            }
            return;
        }
    }

    /** Set a handler for Runtime.evaluate — receives params, returns CDP response shape */
    onEvaluate(handler: ResponseHandler): void {
        this.evaluateHandler = handler;
    }

    /** Convenience: respond with a successful value */
    respondWithValue(value: unknown, type = "object"): void {
        this.onEvaluate(() => ({
            result: { result: { type, value } },
        }));
    }

    /** Convenience: respond with a JS exception */
    respondWithError(errorType: string, message: string): void {
        this.onEvaluate(() => ({
            result: {
                exceptionDetails: {
                    exceptionId: 1,
                    text: "Uncaught",
                    lineNumber: 0,
                    columnNumber: 0,
                    exception: {
                        type: "object",
                        subtype: "error",
                        className: errorType,
                        description: `${errorType}: ${message}`,
                    },
                },
            },
        }));
    }

    /** Convenience: respond with timeout (no response sent) */
    respondWithTimeout(): void {
        this.onEvaluate(() => {
            // Return nothing — the handler doesn't send a response, causing timeout
            return {} as CDPResponse;
        });
        // Override to not send anything
        this.evaluateHandler = null;
    }

    /** Get all received messages */
    get receivedMessages() {
        return this._receivedMessages;
    }

    /** Get the WebSocket URL for connecting as a device */
    get wsUrl(): string {
        return `ws://localhost:${this.port}`;
    }

    async stop(): Promise<void> {
        for (const ws of this.connections) {
            ws.close();
        }
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => resolve());
            } else {
                resolve();
            }
        });
    }
}
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit src/__tests__/helpers/fake-cdp-server.ts`

Note: This may fail because ts config rootDir is `src/` but tsconfig `include` should already cover it. If tsc complains, just verify the main build still works: `npm run build`

**Step 3: Commit**

```bash
git add src/__tests__/helpers/fake-cdp-server.ts
git commit -m "test: add fake CDP WebSocket server for integration tests"
```

---

### Task 8: Integration tests — executeInApp

**Files:**
- Create: `src/__tests__/integration/execute-in-app.test.ts`

**Step 1: Write the tests**

```typescript
import { connectToDevice } from "../../core/connection.js";
import { executeInApp } from "../../core/executor.js";
import { connectedApps, pendingExecutions } from "../../core/state.js";
import { DeviceInfo } from "../../core/types.js";
import { FakeCDPServer } from "../helpers/fake-cdp-server.js";

describe("executeInApp (integration)", () => {
    let server: FakeCDPServer;
    let device: DeviceInfo;

    beforeEach(async () => {
        // Clean up any existing state
        for (const [key, app] of connectedApps.entries()) {
            app.ws.close();
            connectedApps.delete(key);
        }
        pendingExecutions.clear();

        // Start fake CDP server
        server = new FakeCDPServer();
        const port = await server.start();

        // Create device info pointing to fake server
        device = {
            id: "test-device",
            title: "Hermes React Native",
            description: "Test Device",
            appId: "com.test.app",
            type: "node",
            webSocketDebuggerUrl: `${server.wsUrl}/inspector/device?page=1`,
            deviceName: "Test",
        };

        // Connect to the fake server (sets up message handlers and adds to connectedApps)
        await connectToDevice(device, port);
    });

    afterEach(async () => {
        for (const [key, app] of connectedApps.entries()) {
            app.ws.close();
            connectedApps.delete(key);
        }
        pendingExecutions.clear();
        await server.stop();
    });

    it("returns value for simple expression", async () => {
        server.respondWithValue(42, "number");
        const result = await executeInApp("21 + 21", false, { timeoutMs: 5000 });
        expect(result.success).toBe(true);
        expect(result.result).toBe("42");
    });

    it("returns string value", async () => {
        server.respondWithValue("hello", "string");
        const result = await executeInApp("'hello'", false, { timeoutMs: 5000 });
        expect(result.success).toBe(true);
        expect(result.result).toBe("hello");
    });

    it("returns object value as JSON", async () => {
        server.respondWithValue({ key: "value" }, "object");
        const result = await executeInApp("({key: 'value'})", false, { timeoutMs: 5000 });
        expect(result.success).toBe(true);
        const parsed = JSON.parse(result.result!);
        expect(parsed.key).toBe("value");
    });

    it("returns error for JS exception", async () => {
        server.respondWithError("ReferenceError", "x is not defined");
        const result = await executeInApp("x", false, { timeoutMs: 5000 });
        expect(result.success).toBe(false);
        expect(result.error).toContain("ReferenceError");
    });

    it("sends expression with global polyfill prepended", async () => {
        server.respondWithValue(true, "boolean");
        await executeInApp("__DEV__", false, { timeoutMs: 5000 });
        const evalMsg = server.receivedMessages.find((m) => m.method === "Runtime.evaluate");
        expect(evalMsg).toBeDefined();
        const expr = (evalMsg!.params as { expression: string }).expression;
        expect(expr).toContain("var global");
        expect(expr).toContain("__DEV__");
    });

    it("rejects emoji in expression", async () => {
        const result = await executeInApp("'😀'", false, { timeoutMs: 5000 });
        expect(result.success).toBe(false);
        expect(result.error).toContain("emoji");
    });

    it("handles timeout gracefully", async () => {
        // Don't set any handler — no response will come back
        server.respondWithTimeout();
        const result = await executeInApp("slow()", false, { timeoutMs: 500, maxRetries: 0 });
        expect(result.success).toBe(false);
        expect(result.error).toContain("Timeout");
    }, 10000);
});
```

**Step 2: Run integration tests**

Run: `npm run test:integration -- --verbose`
Expected: All tests PASS. If there are issues with connection setup or teardown, adjust the `beforeEach`/`afterEach` hooks.

**Step 3: Commit**

```bash
git add src/__tests__/integration/execute-in-app.test.ts
git commit -m "test: add integration tests for executeInApp with fake CDP server"
```

---

### Task 9: Integration tests — tool handlers

**Files:**
- Create: `src/__tests__/integration/tools.test.ts`

**Step 1: Write the tests**

These test `listDebugGlobals`, `getComponentTree`, `getScreenLayout`, and `findComponents` by configuring the fake CDP server to return realistic fiber-tree-like responses.

```typescript
import { connectToDevice } from "../../core/connection.js";
import { listDebugGlobals, getComponentTree, getScreenLayout, findComponents } from "../../core/executor.js";
import { connectedApps, pendingExecutions } from "../../core/state.js";
import { DeviceInfo } from "../../core/types.js";
import { FakeCDPServer } from "../helpers/fake-cdp-server.js";

describe("Tool handlers (integration)", () => {
    let server: FakeCDPServer;

    beforeEach(async () => {
        for (const [key, app] of connectedApps.entries()) {
            app.ws.close();
            connectedApps.delete(key);
        }
        pendingExecutions.clear();

        server = new FakeCDPServer();
        const port = await server.start();

        const device: DeviceInfo = {
            id: "test-device",
            title: "Hermes React Native",
            description: "Test Device",
            appId: "com.test.app",
            type: "node",
            webSocketDebuggerUrl: `${server.wsUrl}/inspector/device?page=1`,
            deviceName: "Test",
        };

        await connectToDevice(device, port);
    });

    afterEach(async () => {
        for (const [key, app] of connectedApps.entries()) {
            app.ws.close();
            connectedApps.delete(key);
        }
        pendingExecutions.clear();
        await server.stop();
    });

    describe("listDebugGlobals", () => {
        it("returns categorized globals on success", async () => {
            server.respondWithValue({
                "Apollo Client": [],
                "Redux": ["__REDUX_STORE__"],
                "React DevTools": ["__REACT_DEVTOOLS_GLOBAL_HOOK__"],
                "Reanimated": [],
                "Expo": ["expo"],
                "Metro": [],
                "Other Debug": ["__DEV__"],
            });
            const result = await listDebugGlobals();
            expect(result.success).toBe(true);
            expect(result.result).toContain("Redux");
            expect(result.result).toContain("__REDUX_STORE__");
        });
    });

    describe("getComponentTree", () => {
        it("returns formatted tree on success", async () => {
            server.respondWithValue({
                tree: {
                    name: "App",
                    children: [
                        { name: "HomeScreen", children: [] },
                    ],
                },
            });
            const result = await getComponentTree({ format: "json" });
            expect(result.success).toBe(true);
            expect(result.result).toContain("App");
            expect(result.result).toContain("HomeScreen");
        });

        it("returns error when no fiber roots found", async () => {
            server.respondWithValue({ error: "No fiber roots found. The app may not have rendered yet." });
            const result = await getComponentTree();
            expect(result.success).toBe(true);
            expect(result.result).toContain("No fiber roots");
        });
    });

    describe("getScreenLayout", () => {
        it("returns layout data on success", async () => {
            server.respondWithValue({
                elements: [
                    { name: "View", path: "App > View", layout: { width: 375, height: 812 } },
                ],
            });
            const result = await getScreenLayout({ format: "json" });
            expect(result.success).toBe(true);
            expect(result.result).toContain("View");
        });
    });

    describe("findComponents", () => {
        it("returns matching components", async () => {
            server.respondWithValue({
                matches: [
                    { name: "HomeScreen", path: "App > HomeScreen", depth: 2 },
                ],
                total: 1,
            });
            const result = await findComponents("Screen", { format: "json" });
            expect(result.success).toBe(true);
            expect(result.result).toContain("HomeScreen");
        });
    });
});
```

**Step 2: Run all tests**

Run: `npm test -- --verbose`
Expected: All unit and integration tests PASS.

**Step 3: Commit**

```bash
git add src/__tests__/integration/tools.test.ts
git commit -m "test: add integration tests for tool handlers with fake CDP server"
```

---

### Task 10: Verify full suite and final commit

**Step 1: Run full test suite**

Run: `npm test -- --verbose`
Expected: All tests pass. Check for any flaky timeout-related tests.

**Step 2: Run build to ensure no regressions**

Run: `npm run build`
Expected: Clean build, no errors.

**Step 3: Run linter on modified source files**

Run: `npx tsc --noEmit src/core/executor.ts`
Expected: No type errors.

**Step 4: Final summary commit (if any adjustments were needed)**

```bash
git add -A
git commit -m "test: finalize test infrastructure — all tests passing"
```
