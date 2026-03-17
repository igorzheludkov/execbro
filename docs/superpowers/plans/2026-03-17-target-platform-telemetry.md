# Target Platform Telemetry Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track which platform (iOS vs Android) each user debugs against, and display a pie chart on the dashboard.

**Architecture:** Add `targetPlatform` field to telemetry events, derived from the `connectedApps` map's `platform` property at tool invocation time. Store in Analytics Engine blob10. Backend aggregates per-user platform from tool invocations. Dashboard renders a doughnut chart.

**Tech Stack:** TypeScript (MCP server), Cloudflare Worker (backend), Chart.js (dashboard)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/core/telemetry.ts` | Modify | Add `targetPlatform` to event type and `trackToolInvocation` |
| `src/core/state.ts` | Modify | Add `getTargetPlatform()` helper |
| `src/index.ts` | Modify | Pass target platform to `trackToolInvocation` |
| `backend/worker.ts` | Modify | Store blob10, add platform query, return `platformDistribution` |
| `dashboard/index.html` | Modify | Add platform doughnut chart |

---

### Task 1: Add `getTargetPlatform()` helper to state

**Files:**
- Modify: `src/core/state.ts:19` (near connectedApps)
- Modify: `src/core/index.ts` (add export)

- [ ] **Step 1: Add helper function to `src/core/state.ts`**

After the `connectedApps` declaration, add:

```typescript
export function getTargetPlatform(): string | undefined {
    const firstApp = connectedApps.values().next().value;
    return firstApp?.platform;
}
```

- [ ] **Step 2: Export from `src/core/index.ts`**

Add `getTargetPlatform` to the state exports.

- [ ] **Step 3: Build to verify**

Run: `npm run build`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/core/state.ts src/core/index.ts
git commit -m "feat(telemetry): add getTargetPlatform helper"
```

---

### Task 2: Add `targetPlatform` to telemetry tracking

**Files:**
- Modify: `src/core/telemetry.ts:38-51` (TelemetryEvent interface)
- Modify: `src/core/telemetry.ts:262-299` (trackToolInvocation function)

- [ ] **Step 1: Add field to `TelemetryEvent` interface**

In `src/core/telemetry.ts`, add to the `TelemetryEvent` interface:

```typescript
targetPlatform?: string;
```

- [ ] **Step 2: Add `targetPlatform` parameter to `trackToolInvocation`**

Update the function signature:

```typescript
export function trackToolInvocation(
    toolName: string,
    success: boolean,
    durationMs: number,
    errorMessage?: string,
    errorContext?: string,
    inputTokens?: number,
    outputTokens?: number,
    targetPlatform?: string
): void {
```

Add to the event object construction (after `isFirstRun`):

```typescript
if (targetPlatform) {
    event.targetPlatform = targetPlatform;
}
```

- [ ] **Step 3: Build to verify**

Run: `npm run build`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/core/telemetry.ts
git commit -m "feat(telemetry): add targetPlatform to event tracking"
```

---

### Task 3: Pass target platform from tool invocation wrapper

**Files:**
- Modify: `src/index.ts:120` (import)
- Modify: `src/index.ts:254-255` (trackToolInvocation call)

- [ ] **Step 1: Import `getTargetPlatform`**

Add `getTargetPlatform` to the import from `./core/index.js` (line 120 area).

- [ ] **Step 2: Pass platform in `registerToolWithTelemetry`**

In the `finally` block (~line 254), change:

```typescript
trackToolInvocation(toolName, success, duration, errorMessage, errorContext, inputTokens, outputTokens);
```

to:

```typescript
trackToolInvocation(toolName, success, duration, errorMessage, errorContext, inputTokens, outputTokens, getTargetPlatform());
```

- [ ] **Step 3: Build to verify**

Run: `npm run build`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(telemetry): pass target platform on tool invocation"
```

---

### Task 4: Store target platform in Analytics Engine (backend)

**Files:**
- Modify: `backend/worker.ts:17-29` (TelemetryEvent interface)
- Modify: `backend/worker.ts:100-124` (handleTelemetry - writeDataPoint)

- [ ] **Step 1: Add `targetPlatform` to backend `TelemetryEvent` interface**

```typescript
targetPlatform?: string;
```

- [ ] **Step 2: Add blob10 for target platform in `writeDataPoint`**

In `handleTelemetry`, in the blobs array after blob9 (sessionId), add:

```typescript
(event.targetPlatform || "").slice(0, 20)   // blob10 - target platform (ios/android)
```

- [ ] **Step 3: Commit**

```bash
git add backend/worker.ts
git commit -m "feat(telemetry): store target platform as blob10 in Analytics Engine"
```

---

### Task 5: Add platform distribution query to stats endpoint (backend)

**Files:**
- Modify: `backend/worker.ts:533-984` (handleStats function)

- [ ] **Step 1: Add platform distribution SQL query**

Add a new query alongside the existing ones (after `userToolCountsQuery`):

```typescript
const platformQuery = `
    SELECT
        index1,
        blob10 as target_platform,
        _sample_interval as weight
    FROM rn_debugger_events
    WHERE
        blob1 = 'tool_invocation'
        AND blob10 != ''
        AND ${timeFilter}
        ${userExclusionFilter}
    LIMIT 100000
`;
```

- [ ] **Step 2: Execute the query**

Add it to the second batch of queries (after the first `Promise.all` group is consumed, alongside the retention query). Parse the response:

```typescript
const platformRes = await fetch(sqlEndpoint, {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.CF_API_TOKEN}` },
    body: platformQuery
});
const platformRaw = await parseResponse<{
    index1: string;
    target_platform: string;
    weight: number;
}>(platformRes, 'platform');
```

- [ ] **Step 3: Aggregate per-user platform classification**

After parsing, add aggregation logic:

```typescript
// Aggregate platform distribution per user
const userPlatformCounts = new Map<string, { ios: number; android: number }>();
for (const row of platformRaw.data || []) {
    const userId = row.index1 || "unknown";
    const platform = (row.target_platform || "").toLowerCase();
    const weight = Number(row.weight) || 1;
    if (!userPlatformCounts.has(userId)) {
        userPlatformCounts.set(userId, { ios: 0, android: 0 });
    }
    const counts = userPlatformCounts.get(userId)!;
    if (platform === "ios") counts.ios += weight;
    else if (platform === "android") counts.android += weight;
}

// Classify each user by their dominant platform
let iosUsers = 0;
let androidUsers = 0;
let bothUsers = 0;
for (const [, counts] of userPlatformCounts) {
    if (counts.ios > 0 && counts.android > 0) {
        bothUsers++;
    } else if (counts.ios > 0) {
        iosUsers++;
    } else if (counts.android > 0) {
        androidUsers++;
    }
}
```

- [ ] **Step 4: Add `platformDistribution` to the JSON response**

In the final `JSON.stringify`, add:

```typescript
platformDistribution: {
    ios: iosUsers,
    android: androidUsers,
    both: bothUsers,
    unknown: allUniqueUserIds.size - userPlatformCounts.size
}
```

- [ ] **Step 5: Commit**

```bash
git add backend/worker.ts
git commit -m "feat(telemetry): add platform distribution to stats API"
```

---

### Task 6: Add platform pie chart to dashboard

**Files:**
- Modify: `dashboard/index.html`

- [ ] **Step 1: Add canvas element in the stat cards section**

After the User Activity stat card (~line 509), before `</div>` closing the stats-grid, add:

```html
<div class="stat-card stat-card-chart">
    <div class="label">Platform</div>
    <div class="mini-chart-container">
        <canvas id="platformChart"></canvas>
    </div>
</div>
```

- [ ] **Step 2: Add chart variable**

Near the existing chart variables (~line 725), add:

```javascript
let platformChart = null;
```

- [ ] **Step 3: Add `updatePlatformChart` function**

After `updateUserActivityChart` function (~line 1097), add:

```javascript
function updatePlatformChart(platformData) {
    const ctx = document.getElementById('platformChart').getContext('2d');

    if (platformChart) {
        platformChart.destroy();
    }

    const ios = platformData?.ios || 0;
    const android = platformData?.android || 0;
    const both = platformData?.both || 0;

    if (ios === 0 && android === 0 && both === 0) {
        ctx.font = '14px sans-serif';
        ctx.fillStyle = '#94a3b8';
        ctx.textAlign = 'center';
        ctx.fillText('No data yet', ctx.canvas.width / 2, ctx.canvas.height / 2);
        return;
    }

    const labels = [];
    const values = [];
    const colors = [];

    if (ios > 0) { labels.push('iOS'); values.push(ios); colors.push('#60a5fa'); }
    if (android > 0) { labels.push('Android'); values.push(android); colors.push('#4ade80'); }
    if (both > 0) { labels.push('Both'); values.push(both); colors.push('#fbbf24'); }

    platformChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{
                data: values,
                backgroundColor: colors,
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '60%',
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => `${ctx.label}: ${ctx.raw}`
                    }
                }
            }
        }
    });
}
```

- [ ] **Step 4: Call `updatePlatformChart` in the data refresh flow**

After `updateUserActivityChart(userActivity);` (~line 900), add:

```javascript
// Update platform distribution chart
updatePlatformChart(data.platformDistribution);
```

- [ ] **Step 5: Commit**

```bash
git add dashboard/index.html
git commit -m "feat(dashboard): add platform distribution pie chart"
```

---

### Task 7: Build, verify, and final commit

- [ ] **Step 1: Build the MCP server**

Run: `npm run build`
Expected: No errors

- [ ] **Step 2: Verify the changes look correct**

Review the diff to ensure all changes are consistent.

- [ ] **Step 3: Final commit if any remaining changes**

```bash
git add -A
git commit -m "feat: track target platform (iOS/Android) in telemetry with dashboard chart"
```
