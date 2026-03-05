# Connection-Aware Buffer Tools Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make buffer-reading MCP tools (get_logs, search_logs, get_network_requests, etc.) detect stale/missing CDP connections and auto-reconnect inline, so agents never silently receive empty results from a broken connection.

**Architecture:** Add a `lastCDPMessageAt` timestamp updated on every CDP message. Before returning results, buffer-reading tools run a passive connection check (WebSocket state + context health + activity recency). If suspicious, run an active ping. If dead, auto-reconnect via `ensureConnection`. All logic lives in a shared `checkAndEnsureConnection()` helper.

**Tech Stack:** TypeScript, WebSocket (ws), CDP protocol, Jest for testing

---

### Task 1: Add lastCDPMessageAt timestamp to state

**Files:**
- Modify: `src/core/state.ts`
- Modify: `src/core/connection.ts:151` (in `handleCDPMessage`)
- Test: `src/__tests__/unit/connection-health.test.ts` (new file)

**Step 1: Write the failing test**

Create `src/__tests__/unit/connection-health.test.ts`:

```typescript
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { getLastCDPMessageTime, updateLastCDPMessageTime } from "../../core/state.js";

describe("lastCDPMessageAt tracking", () => {
    beforeEach(() => {
        // Reset to null
        updateLastCDPMessageTime(null);
    });

    it("starts as null", () => {
        expect(getLastCDPMessageTime()).toBeNull();
    });

    it("updates when called with a date", () => {
        const now = new Date();
        updateLastCDPMessageTime(now);
        expect(getLastCDPMessageTime()).toBe(now);
    });

    it("updates to latest value on subsequent calls", () => {
        const first = new Date("2026-01-01");
        const second = new Date("2026-01-02");
        updateLastCDPMessageTime(first);
        updateLastCDPMessageTime(second);
        expect(getLastCDPMessageTime()).toBe(second);
    });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test:unit -- --testPathPattern=connection-health`
Expected: FAIL — `getLastCDPMessageTime` and `updateLastCDPMessageTime` don't exist

**Step 3: Implement lastCDPMessageAt in state.ts**

Add to `src/core/state.ts`:

```typescript
// Last CDP message received timestamp (for connection liveness detection)
let _lastCDPMessageAt: Date | null = null;

export function getLastCDPMessageTime(): Date | null {
    return _lastCDPMessageAt;
}

export function updateLastCDPMessageTime(time: Date | null): void {
    _lastCDPMessageAt = time;
}
```

**Step 4: Update handleCDPMessage to record timestamp**

In `src/core/connection.ts`, at the top of `handleCDPMessage()` (line ~151), add:

```typescript
import { ..., updateLastCDPMessageTime } from "./state.js";

export function handleCDPMessage(message: Record<string, unknown>, _device: DeviceInfo): void {
    // Track last CDP activity for connection liveness detection
    updateLastCDPMessageTime(new Date());

    // ... rest of existing code
```

Also export `getLastCDPMessageTime` and `updateLastCDPMessageTime` from `src/core/index.ts`.

**Step 5: Run test to verify it passes**

Run: `npm run test:unit -- --testPathPattern=connection-health`
Expected: PASS

**Step 6: Commit**

```bash
git add src/core/state.ts src/core/connection.ts src/core/index.ts src/__tests__/unit/connection-health.test.ts
git commit -m "feat: add lastCDPMessageAt timestamp for connection liveness tracking"
```

---

### Task 2: Implement checkAndEnsureConnection helper

**Files:**
- Modify: `src/core/connection.ts` (add new function)
- Modify: `src/core/types.ts` (add `ConnectionCheckResult` interface)
- Modify: `src/core/index.ts` (re-export)
- Test: `src/__tests__/unit/connection-health.test.ts` (extend)

**Step 1: Add ConnectionCheckResult type**

In `src/core/types.ts`, add:

```typescript
export interface ConnectionCheckResult {
    connected: boolean;
    wasReconnected: boolean;
    message: string | null;
}
```

**Step 2: Write failing tests for checkAndEnsureConnection**

Extend `src/__tests__/unit/connection-health.test.ts`:

```typescript
import { getLastCDPMessageTime, updateLastCDPMessageTime, connectedApps } from "../../core/state.js";
import { checkAndEnsureConnection, getPassiveConnectionStatus } from "../../core/connection.js";

describe("getPassiveConnectionStatus", () => {
    beforeEach(() => {
        updateLastCDPMessageTime(null);
        connectedApps.clear();
    });

    it("returns not connected when no apps in connectedApps", () => {
        const status = getPassiveConnectionStatus();
        expect(status.connected).toBe(false);
        expect(status.reason).toBe("no_connection");
    });
});

describe("checkAndEnsureConnection", () => {
    beforeEach(() => {
        updateLastCDPMessageTime(null);
        connectedApps.clear();
    });

    it("returns reconnect message when no connection exists and reconnect fails", async () => {
        const result = await checkAndEnsureConnection();
        expect(result.connected).toBe(false);
        expect(result.wasReconnected).toBe(false);
        expect(result.message).toContain("No active connection");
    });
});
```

**Step 3: Run test to verify it fails**

Run: `npm run test:unit -- --testPathPattern=connection-health`
Expected: FAIL — functions don't exist

**Step 4: Implement getPassiveConnectionStatus**

In `src/core/connection.ts`, add:

```typescript
import { ..., getLastCDPMessageTime } from "./state.js";

const STALE_ACTIVITY_THRESHOLD_MS = 30_000;
const RECONNECT_SETTLE_MS = 500;

export interface PassiveConnectionStatus {
    connected: boolean;
    needsPing: boolean;
    reason: "ok" | "no_connection" | "context_stale" | "no_activity" | "activity_stale";
}

export function getPassiveConnectionStatus(): PassiveConnectionStatus {
    // 1. Check if any app is connected with OPEN WebSocket
    if (!hasConnectedApp()) {
        return { connected: false, needsPing: false, reason: "no_connection" };
    }

    // 2. Check context health (any connected app)
    const app = getFirstConnectedApp();
    if (app) {
        const appKey = `${app.port}-${app.deviceInfo.id}`;
        const health = getContextHealth(appKey);
        if (health?.isStale) {
            return { connected: false, needsPing: false, reason: "context_stale" };
        }
    }

    // 3. Check last CDP message timestamp
    const lastMessage = getLastCDPMessageTime();
    if (!lastMessage) {
        return { connected: false, needsPing: false, reason: "no_activity" };
    }

    // 4. Check if last message is too old
    const elapsed = Date.now() - lastMessage.getTime();
    if (elapsed > STALE_ACTIVITY_THRESHOLD_MS) {
        return { connected: true, needsPing: true, reason: "activity_stale" };
    }

    // 5. All good
    return { connected: true, needsPing: false, reason: "ok" };
}
```

**Step 5: Implement checkAndEnsureConnection**

In `src/core/connection.ts`, add:

```typescript
export async function checkAndEnsureConnection(): Promise<ConnectionCheckResult> {
    const passive = getPassiveConnectionStatus();

    // Connection looks healthy
    if (passive.connected && !passive.needsPing) {
        return { connected: true, wasReconnected: false, message: null };
    }

    // Connection looks healthy but no recent activity — run ping
    if (passive.connected && passive.needsPing) {
        const app = getFirstConnectedApp();
        if (app) {
            const healthy = await runQuickHealthCheck(app);
            if (healthy) {
                return { connected: true, wasReconnected: false, message: null };
            }
            // Ping failed — fall through to reconnect
        }
    }

    // Connection is dead or ping failed — try to reconnect
    const result = await ensureConnection({ forceRefresh: true, healthCheck: true });

    if (result.connected && result.healthCheckPassed) {
        // Wait for CDP domains to initialize
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
```

Export both from `src/core/index.ts`.

**Step 6: Run test to verify it passes**

Run: `npm run test:unit -- --testPathPattern=connection-health`
Expected: PASS

**Step 7: Commit**

```bash
git add src/core/connection.ts src/core/types.ts src/core/index.ts src/__tests__/unit/connection-health.test.ts
git commit -m "feat: add checkAndEnsureConnection helper for buffer-reading tools"
```

---

### Task 3: Integration test with fake CDP server

**Files:**
- Test: `src/__tests__/integration/connection-health.test.ts` (new file)

**Step 1: Write integration test**

Create `src/__tests__/integration/connection-health.test.ts`:

```typescript
import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { connectToDevice } from "../../core/connection.js";
import { checkAndEnsureConnection, getPassiveConnectionStatus } from "../../core/connection.js";
import { connectedApps, pendingExecutions, updateLastCDPMessageTime } from "../../core/state.js";
import { DeviceInfo } from "../../core/types.js";
import { FakeCDPServer } from "../helpers/fake-cdp-server.js";

describe("Connection health (integration)", () => {
    let server: FakeCDPServer;

    beforeAll(() => {
        jest.spyOn(console, "error").mockImplementation(() => {});
    });

    afterAll(() => {
        jest.restoreAllMocks();
    });

    beforeEach(async () => {
        for (const [key, app] of connectedApps.entries()) {
            try { app.ws.close(); } catch { /* ignore */ }
            connectedApps.delete(key);
        }
        pendingExecutions.clear();
        updateLastCDPMessageTime(null);
    });

    afterEach(async () => {
        const closePromises: Promise<void>[] = [];
        for (const [key, app] of connectedApps.entries()) {
            closePromises.push(
                new Promise<void>((resolve) => {
                    if (app.ws.readyState === app.ws.CLOSED) {
                        resolve();
                    } else {
                        app.ws.on("close", () => resolve());
                        try { app.ws.close(); } catch { resolve(); }
                    }
                })
            );
            connectedApps.delete(key);
        }
        await Promise.all(closePromises);
        pendingExecutions.clear();
        if (server) await server.stop();
    });

    it("getPassiveConnectionStatus returns no_connection when disconnected", () => {
        const status = getPassiveConnectionStatus();
        expect(status.connected).toBe(false);
        expect(status.reason).toBe("no_connection");
    });

    it("getPassiveConnectionStatus returns ok when connected with recent activity", async () => {
        server = new FakeCDPServer();
        const port = await server.start();

        const device: DeviceInfo = {
            id: "test-device",
            title: "Hermes React Native",
            description: "Test",
            appId: "com.test",
            type: "node",
            webSocketDebuggerUrl: `${server.wsUrl}/inspector/device?page=1`,
            deviceName: "Test",
        };

        await connectToDevice(device, port, {
            reconnectionConfig: { enabled: false, maxAttempts: 0, initialDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1 },
        });

        // Simulate recent CDP activity
        updateLastCDPMessageTime(new Date());

        const status = getPassiveConnectionStatus();
        expect(status.connected).toBe(true);
        expect(status.reason).toBe("ok");
    });

    it("getPassiveConnectionStatus returns activity_stale when no recent messages", async () => {
        server = new FakeCDPServer();
        const port = await server.start();

        const device: DeviceInfo = {
            id: "test-device",
            title: "Hermes React Native",
            description: "Test",
            appId: "com.test",
            type: "node",
            webSocketDebuggerUrl: `${server.wsUrl}/inspector/device?page=1`,
            deviceName: "Test",
        };

        await connectToDevice(device, port, {
            reconnectionConfig: { enabled: false, maxAttempts: 0, initialDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1 },
        });

        // Set last activity to 60 seconds ago
        updateLastCDPMessageTime(new Date(Date.now() - 60_000));

        const status = getPassiveConnectionStatus();
        expect(status.connected).toBe(true);
        expect(status.needsPing).toBe(true);
        expect(status.reason).toBe("activity_stale");
    });

    it("checkAndEnsureConnection returns failure when no Metro server is available", async () => {
        const result = await checkAndEnsureConnection();
        expect(result.connected).toBe(false);
        expect(result.message).toContain("No active connection");
    });
});
```

**Step 2: Run integration test**

Run: `npm run test:integration -- --testPathPattern=connection-health`
Expected: PASS (all tests should pass since the implementations exist from Task 2)

**Step 3: Commit**

```bash
git add src/__tests__/integration/connection-health.test.ts
git commit -m "test: add integration tests for connection health checking"
```

---

### Task 4: Wire up get_logs and search_logs tools

**Files:**
- Modify: `src/index.ts:549-605` (get_logs handler)
- Modify: `src/index.ts:609-660` (search_logs handler)

**Step 1: Update get_logs handler**

In `src/index.ts`, import `checkAndEnsureConnection` and `getPassiveConnectionStatus` (add to existing imports from core).

Modify the `get_logs` handler (around line 549). The key change: after reading the buffer, check connection health. Two scenarios:

**A) Buffer empty — full check with reconnect:**

```typescript
async ({ maxLogs, level, startFromText, maxMessageLength, verbose, format, summary }) => {
    // Return summary if requested
    if (summary) {
        const summaryText = getLogSummary(logBuffer, { lastN: 5, maxMessageLength: 100 });

        // Check connection even for summary
        const connectionStatus = logBuffer.size === 0
            ? await checkAndEnsureConnection()
            : null;
        const connectionWarning = connectionStatus?.message || "";

        return {
            content: [{
                type: "text",
                text: `Log Summary:\n\n${summaryText}${connectionWarning}`
            }]
        };
    }

    const { logs, count, formatted } = getLogs(logBuffer, { maxLogs, level, startFromText, maxMessageLength, verbose });

    // Connection health check
    let connectionWarning = "";
    if (count === 0) {
        // Empty buffer — full check with auto-reconnect
        const status = await checkAndEnsureConnection();
        if (status.message) {
            connectionWarning = `\n\n${status.message}`;
        }
    } else {
        // Has data — cheap passive check only
        const passive = getPassiveConnectionStatus();
        if (!passive.connected) {
            connectionWarning = "\n\n[CONNECTION] Disconnected. Showing cached data. New logs are not being captured.";
        }
    }

    // Existing recentGaps warning (keep as-is, it covers different scenario)
    const warningThresholdMs = 30000;
    const recentGaps = getRecentGaps(warningThresholdMs);
    let gapWarning = "";
    // ... keep existing gap warning logic ...

    const startNote = startFromText ? ` (starting from "${startFromText}")` : "";

    if (format === "tonl") {
        const tonlOutput = formatLogsAsTonl(logs, { maxMessageLength: verbose ? 0 : maxMessageLength });
        return {
            content: [{
                type: "text",
                text: `React Native Console Logs (${count} entries)${startNote}:\n\n${tonlOutput}${gapWarning}${connectionWarning}`
            }]
        };
    }

    return {
        content: [{
            type: "text",
            text: `React Native Console Logs (${count} entries)${startNote}:\n\n${formatted}${gapWarning}${connectionWarning}`
        }]
    };
}
```

**B) Apply the same pattern to search_logs** (around line 609).

After `searchLogs()`, if `count === 0`, call `checkAndEnsureConnection()`. If `count > 0`, call `getPassiveConnectionStatus()`.

**Step 2: Run the build to check for type errors**

Run: `npx tsc --noEmit src/index.ts`
Expected: No errors

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add connection health checks to get_logs and search_logs"
```

---

### Task 5: Wire up network tools

**Files:**
- Modify: `src/index.ts:1430-1604` (get_network_requests, search_network, get_request_details, get_network_stats)

**Step 1: Update get_network_requests handler**

Same pattern as get_logs. After reading from `networkBuffer`:
- Empty results → `checkAndEnsureConnection()`
- Has results → `getPassiveConnectionStatus()`

**Step 2: Update search_network handler**

Same pattern. After `searchNetworkRequests()`, check connection if results are empty.

**Step 3: Update get_request_details handler**

When request is not found (`!request`), before returning the error, check connection:

```typescript
if (!request) {
    const status = await checkAndEnsureConnection();
    const connectionNote = status.message ? `\n\n${status.message}` : "";
    return {
        content: [{
            type: "text",
            text: `Request not found: ${requestId}${connectionNote}`
        }],
        isError: true
    };
}
```

**Step 4: Update get_network_stats handler**

Check if networkBuffer is empty. If so, run `checkAndEnsureConnection()`.

```typescript
async () => {
    const stats = getNetworkStats(networkBuffer);

    let connectionWarning = "";
    if (networkBuffer.size === 0) {
        const status = await checkAndEnsureConnection();
        if (status.message) {
            connectionWarning = `\n\n${status.message}`;
        }
    } else {
        const passive = getPassiveConnectionStatus();
        if (!passive.connected) {
            connectionWarning = "\n\n[CONNECTION] Disconnected. Showing cached data. New requests are not being captured.";
        }
    }

    return {
        content: [{
            type: "text",
            text: `Network Statistics:\n\n${stats}${connectionWarning}`
        }]
    };
}
```

**Step 5: Verify NetworkBuffer has a `size` getter**

Check `src/core/network.ts` — if `NetworkBuffer` doesn't expose `.size`, add it (same pattern as `LogBuffer.size`).

**Step 6: Run the build**

Run: `npx tsc --noEmit src/index.ts`
Expected: No errors

**Step 7: Commit**

```bash
git add src/index.ts src/core/network.ts
git commit -m "feat: add connection health checks to network tools"
```

---

### Task 6: Verify build and run full test suite

**Files:** None (verification only)

**Step 1: Build the project**

Run: `npm run build`
Expected: Successful build, no errors

**Step 2: Run all unit tests**

Run: `npm run test:unit`
Expected: All tests pass

**Step 3: Run all integration tests**

Run: `npm run test:integration`
Expected: All tests pass

**Step 4: Type-check modified files**

Run: `npx tsc --noEmit`
Expected: No type errors

**Step 5: Commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: address build/test issues from connection health feature"
```
