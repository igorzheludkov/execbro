# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

An MCP (Model Context Protocol) server for AI-powered React Native debugging. It connects to Metro bundler via CDP (Chrome DevTools Protocol) WebSocket, captures console logs and network requests, and enables JavaScript execution in running React Native apps.

## Common Commands

```bash
npm run build    # Compile TypeScript and make build/index.js executable
npm start        # Run the compiled server
```

To lint a specific file:

```bash
npx tsc --noEmit src/index.ts
```

## Architecture

Modular MCP server with entry point at `src/index.ts` and core logic in `src/core/`:

1. **Metro Discovery**: Scans common ports (8081, 8082, 19000-19002) for running Metro bundlers
2. **Device Selection**: Fetches `/json` endpoint from Metro, prioritizes devices in order:
    - React Native Bridgeless (Expo SDK 54+)
    - Hermes React Native
    - Any React Native (excluding Reanimated/Experimental)
3. **CDP Connection**: Connects via WebSocket to device's debugger URL
4. **Log Capture**: Enables `Runtime.enable` and `Log.enable` CDP domains to receive console events
5. **Network Tracking**: Enables `Network.enable` CDP domain to capture HTTP requests/responses
6. **Code Execution**: Uses `Runtime.evaluate` CDP method for REPL-style JavaScript execution

### Key Components

- `LogBuffer`: Circular buffer (500 entries) storing captured logs with level filtering and text search
- `NetworkBuffer`: Circular buffer (200 entries) storing captured network requests with filtering by method, URL, and status
- `connectedApps`: Map tracking active WebSocket connections to devices
- `pendingExecutions`: Map for tracking async `Runtime.evaluate` responses with timeout handling
- MCP tools registered via `server.registerTool()` from `@modelcontextprotocol/sdk`

### MCP Tools Exposed

- `get_usage_guide`: Get recommended workflows and best practices for all tools (call without params for overview, with topic for full guide)
- `scan_metro` / `connect_metro`: Discover and connect to Metro servers
- `disconnect_metro`: Disconnect from all Metro servers, free CDP slot for native debugger. Reconnect with `scan_metro`
- `get_apps`: List connected devices
- `get_logs` / `search_logs` / `clear_logs`: Log management
- `get_network_requests` / `search_network` / `get_request_details` / `get_network_stats` / `clear_network`: Network request tracking
- `execute_in_app`: Execute simple JS expressions using globals (no require/async/emoji — Hermes limitations)
- `list_debug_globals` / `inspect_global`: Discover and inspect global debugging objects
- `tap`: Unified tool to tap UI elements — auto-detects platform, tries fiber tree → accessibility → OCR → coordinates. Accepts text, testID, component name, or pixel coordinates.
- `toggle_element_inspector`: Toggle RN's Element Inspector overlay (auto-enabled by `get_inspector_selection`)
- `get_inspector_selection`: Identify component at screen coordinates — returns clean hierarchy with file paths (e.g. `HomeScreen > SneakerCard > PulseActionButton`)
- `inspect_at_point`: Layout debugging at coordinates — returns component props, frame (position/size), and path
- `reload_app`: Reload the React Native app (triggers JS bundle reload)
- `ios_screenshot` / `android_screenshot`: Capture simulator/device screen
- `ocr_screenshot`: Screenshot with OCR text recognition and tap coordinates
- `find_components`: Search the React fiber tree for components by name pattern

## Agent Usage Guidelines

When debugging React Native apps through this MCP server:

- **Hot Reloading**: React Native has Fast Refresh enabled by default. After editing JavaScript/TypeScript code, changes are automatically applied to the running app within 1-2 seconds. Do NOT use `reload_app` after every code change.
- **When to Reload**: Only use `reload_app` when:
    - Logs or app behavior don't reflect recent code changes after waiting a few seconds
    - The app is in a broken/error state
    - You need to completely reset the app state (e.g., clear navigation stack, reset context)
    - You made changes to native code or configuration files
- **Verify Changes**: After code edits, use `get_logs` to check if the app picked up changes (look for fresh log entries or changed behavior) before deciding to reload.
- **UI Interaction — Preferred Method**: Use the unified `tap` tool for all tapping:
    1. `tap(text="Submit")` — matches visible text, tries fiber tree → accessibility → OCR automatically
    2. `tap(testID="menu-btn")` — matches by testID prop
    3. `tap(component="HamburgerIcon")` — matches by React component name (fiber tree only)
    4. `tap(x=300, y=600)` — taps at pixel coordinates from screenshot (auto-converts to points)
    5. Use `strategy` param to skip strategies you know will fail: `tap(text="≡", strategy="ocr")`
    6. On failure, follow the `suggestion` field in the response — it tells you exactly what to try next
- **Icon-only buttons** (no text label inside the pressable): Use `tap(component="ComponentName")` to match by React component name. Use `find_components` first to discover actual component names. If multiple instances exist, use `index` param.
- **Non-ASCII text** (Cyrillic, CJK, Arabic, etc.): `tap(text="текст")` automatically skips fiber (Hermes limitation) and uses accessibility/OCR. For best results, use `testID` or `component` params instead.
- **Component Inspection — Identifying elements on screen**: When you need to find which React component renders a specific UI element (to fix layout, styling, or behavior):
    1. Take a screenshot (`ios_screenshot` / `android_screenshot`) or use `ocr_screenshot` to see the current screen
    2. Identify the target element visually and estimate its coordinates (convert screenshot pixels to points: divide by device pixel ratio)
    3. Use `get_inspector_selection(x, y)` to get the clean component hierarchy with file paths — this tells you the exact component name and source file (e.g. `HomeScreen(./(tabs)/index.tsx) > SneakerCard > PulseActionButton`)
    4. If you also need layout details (frame bounds, props, styles), use `inspect_at_point(x, y)` on the same coordinates
    5. To tap at a specific coordinate after inspection, use `tap(x=..., y=...)`
- **When to use which inspection tool**:
    - `get_inspector_selection` → finding component names and screen structure (returns hierarchy like RN's Element Inspector overlay)
    - `inspect_at_point` → layout debugging with props and exact frame measurements
    - `find_components` → searching for components by name pattern across the entire fiber tree

## Telemetry System

Anonymous usage telemetry is collected to understand how the MCP server is used. Located in `src/core/telemetry.ts`.

### How It Works

- **Installation ID**: Random UUID stored in `~/.rn-debugger-telemetry.json`
- **Batching**: Events are batched (10 events or 30-second intervals) before sending
- **Data Collected**: Tool invocations (name, success/failure, duration), session starts, platform, server version

### Configuration

Telemetry sends data to a Cloudflare Worker endpoint. The API key is a write-only token safe to embed in client code.

## Backend (Cloudflare Worker)

Located in `backend/` directory. Handles telemetry ingestion and provides dashboard API.

### Commands

```bash
cd backend
npx wrangler dev              # Run locally (uses .dev.vars for secrets)
npx wrangler deploy           # Deploy to Cloudflare
```

### Local Development

Create `backend/.dev.vars` with secrets (not committed to git):

```
TELEMETRY_API_KEY=<write-key>
DASHBOARD_KEY=<read-key>
CF_API_TOKEN=<cloudflare-api-token>
CF_ACCOUNT_ID=<cloudflare-account-id>
```

### Secrets (in Cloudflare)

- `TELEMETRY_API_KEY`: Write-only key for telemetry ingestion
- `DASHBOARD_KEY`: Secret key for dashboard API access
- `CF_API_TOKEN`: Cloudflare API token for Analytics Engine SQL queries
- `CF_ACCOUNT_ID`: Cloudflare account ID

### API Endpoints

- `POST /`: Telemetry ingestion (requires `X-API-Key` header)
- `GET /api/stats?days=7&key=<DASHBOARD_KEY>`: Dashboard statistics

### Worker Structure (`backend/worker.ts`)

- `handleTelemetry()`: Receives telemetry events, validates API key, writes to Analytics Engine
- `handleStats()`: Dashboard API - queries Analytics Engine SQL, aggregates data, returns JSON

### Data Schema (Analytics Engine)

Events are written with:

- `blob1`: Event name (`tool_invocation`, `session_start`)
- `blob2`: Tool name
- `blob3`: Status (`success` or `failure`)
- `blob4`: Platform
- `blob5`: Server version
- `double1`: Duration (ms)
- `double2`: isFirstRun (1 or 0)
- `index1`: Installation ID (first 8 chars)

### Analytics Engine Notes

- Custom datasets require SQL API, not GraphQL
- `GROUP BY` and `DISTINCT` don't work on index columns - fetch raw rows and aggregate in JS
- SQL endpoint: `https://api.cloudflare.com/client/v4/accounts/{account_id}/analytics_engine/sql`

## Dashboard

Located in `dashboard/index.html`. Static HTML/JS dashboard for visualizing telemetry.

### Deployment

```bash
cd dashboard
npx wrangler pages deploy . --project-name=rn-debugger-dashboard
```

### Features

- Time filters (24h, 7d, 30d)
- Stats: Total calls, unique installations, active/inactive users, success rate
- Charts: Tool usage bar chart, timeline, user activity pie chart
- Tables: Top tools, user activity, tools usage by user

### Active User Definition

A user is considered **active** if they invoke 5+ tools per week.
