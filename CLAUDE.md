# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Repository: https://github.com/igorzheludkov/react-native-ai-devtools

## Monorepo Context

This repo is part of the **react-native-ai-devtools** monorepo at `~/rn-devtools/`. See [`../CLAUDE.md`](../CLAUDE.md) for the full map and cross-repo workflows.

**Sibling repos:**
- `react-native-ai-devtools-sdk/` — in-app SDK companion ([GitHub](https://github.com/igorzheludkov/react-native-ai-devtools-sdk))
- `infra/` — Cloudflare Worker backend (telemetry, OCR) + analytics dashboard
- `web/` — web platform (landing, user cabinet)
- `docs/` — **canonical location for all plans and specs** (`~/rn-devtools/docs/`)

**Plans and specs** must be written to `~/rn-devtools/docs/` (specs → `devtools-core/specs/`, plans → `devtools-core/plans/`). Never store plans/specs inside this repo.

## Project Overview

An MCP (Model Context Protocol) server that gives AI agents end-to-end control of a running React Native app across the iOS Simulator and Android emulators/devices. It is the agent-facing counterpart to React Native's developer tools — combining what Flipper, Chrome DevTools, the Element Inspector, `xcrun simctl`, and `adb` expose into a single tool surface designed for LLMs.

Capabilities:

- **Metro + CDP bridge**: Discovers Metro bundlers, connects to all Bridgeless/Hermes targets via Chrome DevTools Protocol WebSockets, and keeps connections healthy across reloads.
- **Observability**: Streams console logs (filterable, searchable) and network requests (via SDK in-app buffer, CDP `Network` domain, or injected fetch interceptor — auto-selected per RN version).
- **JS execution & app state**: REPL-style `Runtime.evaluate` against the app's JS context, plus discovery/inspection of `global` debug objects and app reload control.
- **UI automation**: Cross-platform `tap` with fiber tree → accessibility → OCR → coordinate fallback, plus swipes, text input, hardware buttons, key events, long press, and deep links.
- **Visual capture**: iOS/Android screenshots, OCR with tap-ready coordinates, burst-frame capture for transient feedback, and a shared image buffer for retrieval.
- **Component inspection**: Fiber-tree-backed screen layout map, regex component search, deep prop/hook/state inspection, full React tree dumps, and coordinate-based hit-testing with per-ancestor frames and styles (mirrors RN's Element Inspector).
- **Device & app management**: List/boot iOS simulators, list Android devices, install/launch/terminate apps, list packages.
- **Build diagnostics**: Metro bundle status, bundling/compilation errors with screenshot+OCR fallback when CDP is unavailable, and LogBox overlay control (dismiss, push, ignore, detect).
- **Account & telemetry**: License activation, anonymous usage telemetry to a Cloudflare Worker, and a `dev` meta-tool for hot-reload tool development.

Transport modes: stdio (default, production) and HTTP (dev, hot-reload friendly).

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
  "rn-ai-devtools-local": {
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
        "command": "cd /path/to/react-native-ai-devtools && (lsof -ti:8600 > /dev/null 2>&1 || npm run dev:mcp > /tmp/rn-ai-devtools-dev.log 2>&1 &)"
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
- `ImageBuffer`: Circular buffer (50 entries) storing screenshots from all image-producing tools (ios/android/ocr screenshots, tap verification frames). Supports grouping for burst frame sets.
- `connectedApps`: Map tracking active WebSocket connections to devices
- `pendingExecutions`: Map for tracking async `Runtime.evaluate` responses with timeout handling
- MCP tools registered via `server.registerTool()` from `@modelcontextprotocol/sdk`

### MCP Tools Exposed

**Connection & Setup:**
- `get_usage_guide`: Get recommended workflows and best practices for all tools (call without params for overview, with topic for full guide)
- `scan_metro` / `connect_metro`: Discover and connect to Metro servers
- `disconnect_metro`: Disconnect from all Metro servers, free CDP slot for native debugger. Reconnect with `scan_metro`
- `ensure_connection`: Health check with `healthCheck=true`, force refresh with `forceRefresh=true`
- `get_apps`: List connected devices
- `get_connection_status`: Check connection health — uptime, recent disconnects/reconnects, and connection gaps

**Logs & Network:**
- `get_logs` / `search_logs` / `clear_logs`: Log management with level filtering, text search, summary mode, and `device` targeting
- `get_network_requests` / `search_network` / `get_request_details` / `get_network_stats` / `clear_network`: Network request tracking with URL/method/status filtering

**App State & Execution:**
- `execute_in_app`: Execute simple JS expressions using globals (no require/async/emoji — Hermes limitations)
- `list_debug_globals` / `inspect_global`: Discover and inspect global debugging objects
- `reload_app`: Reload the React Native app (triggers JS bundle reload)
- `logbox`: Interact with React Native's LogBox overlay (dev mode only). Actions: "dismiss" clears entries and returns content, "push" displays a message in the error banner, "ignore" adds patterns to suppress future entries, "detect" reads current state.

**UI Interaction:**
- `tap`: Unified tool to tap UI elements — auto-detects platform, tries fiber tree → accessibility → OCR → coordinates. Accepts text, testID, component name, or pixel coordinates. Returns post-tap screenshot by default and verifies visual change via before/after diff. Use `native=true` for coordinate taps without React Native connection (system dialogs, non-RN apps). Use `device` (substring match on the connected app's deviceName) or `udid` (iOS simulator UDID — takes precedence, iOS-only) to pin the tap to a specific device when multiple are connected. Use `screenshot=false` to disable screenshots, `verify=false` to skip verification. Use `burst=true` to capture rapid sequential screenshots for detecting transient visual feedback (press animations, highlights) — results stored in image buffer accessible via `get_images`.
- `android_swipe`: Swipe/scroll gestures with start/end coordinates
- `android_input_text`: Type text into the focused input field
- `ios_button`: Press iOS hardware buttons (HOME, LOCK, SIDE_BUTTON, SIRI, APPLE_PAY)
- `android_key_event`: Send Android key events (HOME, BACK, ENTER, DEL, MENU, etc.)
- `android_long_press`: Long press at coordinates on Android
- `ios_open_url`: Open deep links or universal links on iOS simulator

**Screenshots & OCR:**
- `ios_screenshot` / `android_screenshot`: Capture simulator/device screen
- `ocr_screenshot`: Screenshot with OCR text recognition and tap-ready coordinates
- `get_images`: Access shared image buffer containing screenshots from all tools. Returns metadata by default; use `id` or `groupId`+`frameIndex` to retrieve specific images. Tap burst frames are stored here.

**Component Inspection (recommended workflow: get_screen_layout → find_components → inspect_component):**
- `get_screen_layout`: **Start here.** Screen map — indented tree of visible components with real screen positions (measureInWindow), text content, and identifiers. Shows only what's on screen, filters out off-screen and internal components. Use `extended=true` for layout styles (padding, flex, backgroundColor, etc.). Coordinates are in points (iOS) / dp (Android)
- `find_components`: Fast regex search across the fiber tree by component name pattern. Returns all matching instances with path and depth. Use after `get_screen_layout` to locate specific components
- `inspect_component`: Deep dive into a specific component's props, state (hooks), and optionally children tree. Use after finding a component name via `get_screen_layout` or `find_components`
- `get_component_tree`: Full React fiber tree including all providers, navigation wrappers, and internal components. Use when you need to understand the complete React architecture, not just what's visible. Use `structureOnly=true` for compact names-only output
- `get_inspector_selection`: Identity + RICH STYLE per ancestor at screen coordinates. Invokes RN's Element Inspector programmatically (briefly toggles overlay on, captures, hides it). Returns merged style for each ancestor (paddingHorizontal, borderRadius, fontFamily, etc.) — same data the on-device overlay shows. Best for visual/styling debugging.
- `inspect_at_point`: Layout + PROPS at coordinates. Pure JS hit test — no overlay flicker. Returns FRAME PER ANCESTOR (position/size in dp) plus full props (handlers as `[Function]`, refs, testID, custom props). Best for layout measurements, props inspection, or rapid/repeated calls.
- `toggle_element_inspector`: Toggle RN's Element Inspector overlay manually (rarely needed — `get_inspector_selection` toggles on→off automatically around its capture).

**Device Management:**
- `list_ios_simulators` / `list_android_devices`: Find available simulators and devices
- `ios_boot_simulator`: Boot an iOS simulator by UDID
- `ios_install_app` / `android_install_app`: Install app on device
- `ios_launch_app` / `android_launch_app`: Launch app by bundle ID or package name
- `ios_terminate_app`: Terminate app on iOS simulator
- `android_list_packages`: List installed packages on Android device

**Accessibility Tree (native UI inspection):**
- `android_get_screen_size`: Get device pixel resolution

For React Native UI inspection, prefer the cross-platform tools: `get_screen_layout` (visible component tree), `inspect_at_point` (component at coordinates), `find_components` (regex search by component name), and `tap(text=...)` (tap by visible text).

**Bundle & Errors:**
- `get_bundle_status`: Check Metro build state
- `get_bundle_errors` / `clear_bundle_errors`: Compilation/bundling errors with screenshot+OCR fallback

**Account:**
- `get_license_status`: Installation ID and license tier
- `activate_license` / `delete_account`: License and account management

**Dev Mode:**
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
- **Component Inspection — Understanding what's on screen**:
    1. Call `get_screen_layout` — returns a tree of visible components with positions, text, and identifiers. This is the fastest way to understand the current UI
    2. To find a specific component by name, use `find_components(pattern="Button")` — fast regex search across the fiber tree
    3. To inspect a component's props, state, and hooks, use `inspect_component(componentName="SneakerCard")`
    4. To see the full React architecture (providers, navigation, hidden modals), use `get_component_tree(structureOnly=true)`
- **Component Inspection — Identifying elements at coordinates**: When you need to find which React component renders at a specific screen position:
    1. Take a screenshot (`ios_screenshot` / `android_screenshot`) to see the current screen
    2. Pick `get_inspector_selection(x, y)` if you want **identity + rich style** (padding, margin, border, layout) — answers "what is this and why does it look this way?"
    3. Pick `inspect_at_point(x, y)` if you want **per-ancestor frames + props** (handlers, refs, testID) — answers "where exactly is each ancestor and what props does the touched component expose?"
    4. The two tools overlap on identity (component name + path) but their supplementary data is different. Both work on Bridgeless / new arch.
- **When to use which inspection tool**:
    - `get_screen_layout` → **start here** — screen map with component tree, real positions, and text content
    - `find_components` → fast regex search by component name across the entire fiber tree
    - `inspect_component` → deep dive into props, hooks, and state of a specific component
    - `get_component_tree` → full React fiber tree including internals, providers, hidden components
    - `get_inspector_selection` → identity + rich per-ancestor style at coordinates (briefly toggles RN inspector overlay)
    - `inspect_at_point` → per-ancestor frames + props at coordinates (no overlay, fast — preferred for tight loops)
- **Multi-Device Debugging**: When multiple devices are connected:
    1. Use `get_apps` to see all connected devices and their names
    2. Use `device="iPhone"` or `device="sdk_gphone"` to target specific devices (case-insensitive substring match)
    3. Omitting `device` uses the first connected device for execution tools, or merges data from all devices for log/network tools
    4. Example workflow: `ios_screenshot` on iPhone, `android_screenshot` on Android, compare layouts
    5. `scan_metro` now connects ALL Bridgeless targets instead of picking one — no manual `connect_metro` needed
- **Tap Verification — Burst Mode**: When `tap()` reports `meaningful: false` but you suspect the tap hit a real button (e.g., the handler may be buggy or the visual feedback is transient), retry with `burst=true`. This captures 4 rapid screenshots after the tap to detect momentary visual feedback (press animations, highlights) that settles before the standard after-screenshot. Check `verification.transientChangeDetected` and use `get_images(groupId=verification.burstGroupId)` to inspect individual frames.
- **LogBox Overlay**: In development mode, React Native's LogBox may display error/warning banners at the bottom of the screen, obstructing tab bars and bottom UI. Screenshot, OCR, and describe_all tools automatically detect this and append a warning. Use `logbox` with action "dismiss" to clear the overlay — it returns the full error content so nothing is lost. Use action "ignore" to suppress known noisy warnings from reappearing. Use action "push" to display a message to the developer watching the device. LogBox does not exist in production builds.

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
