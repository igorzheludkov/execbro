# Connection-Aware Buffer Tools

## Problem

Buffer-reading tools (`get_logs`, `search_logs`, `get_network_requests`, `search_network`, `get_request_details`, `get_network_stats`) silently return empty or stale results when the CDP connection is dead. The agent has no way to distinguish "app has no logs" from "connection is broken."

Common trigger: user starts Metro, then Claude Code agent, then the simulator. The MCP server auto-connects to a phantom Metro target before the app is running, the connection goes stale, and buffer-reading tools return empty results with no warning.

## Solution: Last-Activity Tracking + Conditional Ping + Inline Auto-Reconnect

### 1. Last CDP Activity Timestamp

Add a `lastCDPMessageAt: Date | null` field tracked in connection state. Updated on every CDP message received in `handleCDPMessage()`. This is the cheapest signal for "is the connection actually alive."

Location: `src/core/state.ts` (new global) + `src/core/connection.ts` (update in `handleCDPMessage`)

### 2. Passive Connection Check (cheap, every call)

On every buffer-reading tool call, before returning results:

```
1. hasConnectedApp() → false?              → trigger reconnect
2. contextHealth.isStale?                   → trigger reconnect
3. lastCDPMessageAt is null?                → trigger reconnect
4. lastCDPMessageAt > STALE_THRESHOLD ago?  → trigger ping (step 3)
5. Otherwise                               → connection alive, return data
```

`STALE_THRESHOLD` = 30 seconds.

### 3. Active Ping (expensive, only when suspicious)

When passive checks pass but no CDP activity for >30s:

- Call `runQuickHealthCheck()` (evaluates `1+1`, 2s timeout)
- If ping succeeds → connection is alive, return data normally
- If ping fails → trigger reconnect (step 4)

### 4. Inline Auto-Reconnect

When reconnect is triggered:

1. Call `ensureConnection({ forceRefresh: true })` — closes stale WS, re-scans Metro, connects to best device
2. Wait briefly for CDP domains to initialize (~500ms)
3. Return buffer contents + status message:
   - Reconnected: `"[CONNECTION] Was stale, re-established. Logs from before reconnection are shown; new logs will appear on next call."`
   - Failed: `"[CONNECTION] No active connection. Could not reconnect. Ensure Metro and the app are running, then call scan_metro."`
   - Healthy + empty: return normally (genuinely no data)

### 5. Shared Helper

New function in `src/core/connection.ts`:

```typescript
export interface ConnectionCheckResult {
    connected: boolean;
    wasReconnected: boolean;
    message: string | null;  // warning to append to response, or null
}

export async function checkAndEnsureConnection(): Promise<ConnectionCheckResult>
```

This encapsulates steps 2-4 above. All 6 buffer-reading tool handlers call it with the same pattern:

```typescript
// In tool handler, after reading buffer:
if (count === 0 || /* other empty condition */) {
    const status = await checkAndEnsureConnection();
    if (status.message) {
        // append status.message to response text
    }
}
```

For tools where buffer has entries: still run the passive check (steps 1-2 only, no ping) to detect "has old data but connection died." Append a warning if connection is dead:

```typescript
// Even when buffer has entries, do the cheap passive check:
const passiveStatus = getPassiveConnectionStatus();
if (!passiveStatus.connected) {
    warning += "\n[CONNECTION] Disconnected. Showing cached data. Call ensure_connection to restore.";
}
```

## Affected Tools

| Tool | Buffer | Change |
|------|--------|--------|
| `get_logs` | `logBuffer` | Add check before returning |
| `search_logs` | `logBuffer` | Add check before returning |
| `get_network_requests` | `networkBuffer` | Add check before returning |
| `search_network` | `networkBuffer` | Add check before returning |
| `get_request_details` | `networkBuffer` | Add check when request not found |
| `get_network_stats` | `networkBuffer` | Add check before returning |

## Not Affected

Tools using `executeInApp()` already have auto-reconnect: `execute_in_app`, `get_component_tree`, `inspect_component`, `find_components`, `get_screen_layout`, `reload_app`.

## What Stays the Same

- `autoConnectToMetro()` on startup — still captures early logs when timing works out
- Background reconnection timers — still handles brief mid-session blips
- Buffer sizes and circular buffer behavior
- Existing `recentGaps` warning system (complements this, covers "had entries but there was a gap")

## Constants

```typescript
const STALE_ACTIVITY_THRESHOLD_MS = 30_000;  // 30 seconds without CDP message = suspicious
const RECONNECT_SETTLE_MS = 500;              // wait after reconnect for CDP domains to init
```

## Edge Cases

- **Half-open WebSocket**: Socket reports OPEN but remote side dropped. Caught by activity timeout → ping → reconnect.
- **App genuinely quiet**: Ping confirms connection alive. No false alarm.
- **Multiple rapid tool calls**: `ensureConnection` has connection locks preventing concurrent attempts.
- **Buffer has entries + connection dead >30s**: Passive check catches this and appends warning. Does NOT auto-reconnect (data is still useful), just warns.
- **`get_request_details` with unknown ID + dead connection**: Shows "request not found" + connection warning.
