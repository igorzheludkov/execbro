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

## Development with Hot Reload

For development, use HTTP transport mode to avoid restarting Claude Code sessions:

```bash
npm run dev:mcp    # Builds + runs with HTTP transport on port 8600, auto-restarts on file changes
```

Configure Claude Code to connect via HTTP (in `~/.claude.json` mcpServers):
```json
{
  "rn-debugger-local": {
    "type": "http",
    "url": "http://localhost:8600/mcp"
  }
}
```

A SessionStart hook can auto-launch the dev server (in `~/.claude/settings.json`):
```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "cd /path/to/react-native-ai-devtools && (lsof -ti:8600 > /dev/null 2>&1 || npm run dev:mcp > /tmp/rn-debugger-dev.log 2>&1 &)"
      }]
    }]
  }
}
```

Production users are unaffected — the default transport remains stdio.

### Dev Tool (`dev`)

In HTTP mode, a `dev` meta-tool is registered for full hot-reload testing. It proxies calls to any tool using the latest server code, so new/modified/removed tools are immediately testable without restarting the Claude Code session.

- `dev(action="list")` — returns the current list of all tools with descriptions
- `dev(action="call", tool="tool_name", args={...})` — invokes any tool by name using the latest handler

This tool is only available in `--http` mode (dev). It does not appear in production (stdio).

## Architecture

Modular MCP server with entry point at `src/index.ts` and core logic in `src/core/`:

1. **Metro Discovery**: Scans common ports (8081, 8082, 19000-19002) for running Metro bundlers
2. **Device Selection**: Fetches `/json` endpoint from Metro, prioritizes devices in order:
    - React Native Bridgeless (Expo SDK 54+)
    - Hermes React Native
    - Any React Native (excluding Reanimated/Experimental)
3. **CDP Connection**: Connects via WebSocket to device's debugger URL
4. **Log Capture**: Enables `Runtime.enable` and `Log.enable` CDP domains to receive console events
5. **Network Tracking**: Three capture strategies (auto-selected):
   - **SDK mode** (best): If `react-native-ai-devtools-sdk` is installed in the app, reads from its in-app buffer via `Runtime.evaluate`. Captures all requests from startup with full headers and bodies.
   - **CDP mode**: `Network.enable` CDP domain — works on RN 0.73-0.75 (Hermes + Bridge) and future RN 0.83+. Not supported on Bridgeless targets (Expo SDK 52-54).
   - **JS interceptor fallback**: Injects a fetch patch via `Runtime.evaluate` on Bridgeless targets. May miss early startup requests due to injection timing.
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
- `tap`: Unified tool to tap UI elements — auto-detects platform, tries fiber tree → accessibility → OCR → coordinates. Accepts text, testID, component name, or pixel coordinates. Returns post-tap screenshot by default and verifies visual change via before/after diff. Use `native=true` for coordinate taps without React Native connection (system dialogs, non-RN apps). Use `screenshot=false` to disable screenshots, `verify=false` to skip verification.
- `toggle_element_inspector`: Toggle RN's Element Inspector overlay (auto-enabled by `get_inspector_selection`)
- `get_inspector_selection`: Identify component at screen coordinates — returns clean hierarchy with file paths (e.g. `HomeScreen > SneakerCard > PulseActionButton`)
- `inspect_at_point`: Layout debugging at coordinates — returns component props, frame (position/size), and path
- `reload_app`: Reload the React Native app (triggers JS bundle reload)
- `ios_screenshot` / `android_screenshot`: Capture simulator/device screen
- `ocr_screenshot`: Screenshot with OCR text recognition and tap coordinates
- `find_components`: Search the React fiber tree for components by name pattern
- `dev`: (dev mode only) Meta-tool for hot-reload testing — list all tools or call any tool by name using latest code

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
    1. `tap(testID="login-btn")` — **most reliable**: matches by testID prop via fiber (both platforms) and accessibility (Android via resource-id)
    2. `tap(text="Submit")` — matches visible text, tries fiber tree → accessibility → OCR automatically
    3. `tap(component="HamburgerIcon")` — matches by React component name, walks up fiber tree to find nearest pressable parent
    4. `tap(x=300, y=600)` — taps at pixel coordinates from screenshot (auto-converts to points)
    5. `tap(x=300, y=600, native=true)` — taps directly via ADB/simctl without React Native connection (for system dialogs, non-RN apps, or pre-connection UI)
    6. Use `strategy` param to skip strategies you know will fail: `tap(text="≡", strategy="ocr")`
    7. On failure, follow the `suggestion` field in the response — it tells you exactly what to try next
- **Best practice — use testID**: Set `testID` on all interactive elements (buttons, inputs, links). It's more stable than text matching (doesn't break with translations), provides exact matching (no ambiguity), and works for TextInput focusing too.
- **TextInput fields**: `tap` detects TextInput elements (`onChangeText`/`onFocus`) in the fiber tree and falls through to native tap for actual focus. `tap(testID="email-input")` works even though inputs don't have `onPress`.
- **Icon-only buttons** (no text label inside the pressable): Use `tap(component="ComponentName")` to match by React component name — automatically walks up to the nearest pressable parent. Use `find_components` first to discover actual component names. Use `maxTraversalDepth` param to increase parent search depth for deeply wrapped components (default: 15).
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
- **Multi-Device Debugging**: When multiple devices are connected:
    1. Use `get_apps` to see all connected devices and their names
    2. Use `device="iPhone"` or `device="sdk_gphone"` to target specific devices (case-insensitive substring match)
    3. Omitting `device` uses the first connected device for execution tools, or merges data from all devices for log/network tools
    4. Example workflow: `ios_screenshot` on iPhone, `android_screenshot` on Android, compare layouts
    5. `scan_metro` now connects ALL Bridgeless targets instead of picking one — no manual `connect_metro` needed

## Telemetry System

Anonymous usage telemetry is collected to understand how the MCP server is used. Located in `src/core/telemetry.ts`.

### How It Works

- **Installation ID**: Random UUID stored in `~/.rn-debugger-telemetry.json`
- **Batching**: Events are batched (10 events or 30-second intervals) before sending
- **Data Collected**: Tool invocations (name, success/failure, duration), session starts, platform, server version

### Configuration

Telemetry sends data to a Cloudflare Worker endpoint. The API key is a write-only token safe to embed in client code.

## Backend & Dashboard (separate repo)

Telemetry backend (Cloudflare Worker) and analytics dashboard live in a **separate private repository**: `~/rn-debugger-infra/`.

The telemetry client that sends events lives here: `src/core/telemetry.ts`.

### Cross-repo relationship

| This repo (MCP server) | Infra repo (`~/rn-debugger-infra/`) |
|---|---|
| `src/core/telemetry.ts` — sends events | `backend/worker.ts` — receives and stores events |
| Tool names, success/failure, duration | Analytics Engine schema, SQL queries |
| Telemetry endpoint URL + API key (in telemetry.ts) | Worker deployment URL + API key (in wrangler secrets) |
| — | `dashboard/index.html` — visualizes tool usage, user activity |

### Common cross-repo workflows

- **Analyzing metrics then changing tools**: Check dashboard stats in infra repo → identify underperforming tools → come back here to fix them
- **Adding new telemetry fields**: Add field in `src/core/telemetry.ts` here → update `backend/worker.ts` schema in infra repo → update dashboard queries
- **Changing Analytics Engine schema**: Update `backend/worker.ts` blob/double mappings in infra repo → update `src/core/telemetry.ts` to send matching data
