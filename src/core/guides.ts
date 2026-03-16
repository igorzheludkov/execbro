/**
 * Usage guides for MCP tools.
 * Returned by the get_usage_guide tool to help agents understand recommended workflows.
 */

export interface Guide {
    id: string;
    title: string;
    summary: string;
    content: string;
}

const guides: Guide[] = [
    {
        id: "setup",
        title: "Session Setup",
        summary: "Connect to a running React Native app via Metro bundler",
        content: `# Session Setup

## Quick Start
1. scan_metro — auto-discovers Metro on common ports (8081, 8082, 19000-19002) and connects. Note: this occupies the CDP slot, which prevents the built-in React Native debugger from connecting. See "Switch to Native Debugger" below.
2. get_apps — verify the app appears in connected list
3. get_connection_status — check connection health

## If No App Running
- list_ios_simulators / list_android_devices — find available devices
- ios_boot_simulator — boot an iOS simulator if needed
- ios_launch_app / android_launch_app — launch the app
- Wait 2-3 seconds, then scan_metro

## Switch to Native Debugger
- disconnect_metro — closes all CDP connections and stops auto-reconnect
- The built-in React Native debugger can now connect
- Use scan_metro to reconnect when done with native debugger

## Key Tools
- scan_metro: auto-discover and connect (preferred)
- connect_metro: connect to specific port (when you know it)
- disconnect_metro: close all connections (free CDP slot for native debugger)
- ensure_connection: health check with healthCheck=true
- get_connection_status: check uptime and gaps`
    },
    {
        id: "inspect",
        title: "Component Inspection",
        summary: "Identify which React component renders a UI element, get hierarchy and file paths",
        content: `# Component Inspection

## Recommended Workflow: Identify a Component on Screen
1. Take a screenshot (ios_screenshot / android_screenshot) or use ocr_screenshot
2. Identify the target element visually, estimate its coordinates
3. Convert screenshot pixels to points: divide by device pixel ratio (e.g. pixel_x / 3 for @3x iPhones)
4. Call get_inspector_selection(x, y) — returns clean component hierarchy with file paths
   Example output: HomeScreen(./(tabs)/index.tsx) > SneakerCard > PulseActionButton
5. If you also need layout details, call inspect_at_point(x, y) on the same coordinates

## When to Use Which Tool
- get_inspector_selection(x, y) — finding component NAMES and screen structure. Returns hierarchy with source file paths. Auto-enables the Element Inspector, taps at coordinates, reads the result.
- inspect_at_point(x, y) — layout debugging. Returns component props, measured frame (position/size in dp), and path. Skips RN primitives and common library wrappers (Expo, SVG, gesture handlers).
- find_components(pattern) — search for components by name regex across the entire fiber tree.
- get_component_tree — full tree overview. Use focusedOnly=true and structureOnly=true for a compact view.
- inspect_component(name) — deep dive into a specific component's props, state, and hooks.

## Tips
- Both inspect_at_point and get_inspector_selection work on Paper and Fabric (New Architecture)
- get_inspector_selection returns the most complete hierarchy — prefer it for finding component names
- toggle_element_inspector is rarely needed — get_inspector_selection auto-enables the inspector`
    },
    {
        id: "layout",
        title: "Layout Debugging",
        summary: "Capture screenshots, verify UI changes, inspect layout frames and styles",
        content: `# Layout Debugging

## Verify UI Changes
1. ios_screenshot / android_screenshot — capture current screen
2. Compare visually against expected result or Figma design
3. If an issue is spotted, drill down with inspection tools

## Inspect Layout at a Point
1. inspect_at_point(x, y) — returns component frame (position, size in dp), props, and styles
2. Use includeProps=true (default) to see style objects, colors, flex properties
3. Use includeFrame=true (default) to see exact position and dimensions

## Identify Component to Fix
1. get_inspector_selection(x, y) — returns hierarchy with file paths
   Example: HomeScreen(./(tabs)/index.tsx) > SneakerCard > PulseActionButton
2. Use the file path to find and edit the source code

## Full Screen Layout
- get_screen_layout — full layout data for all components
- Use componentsOnly=true to hide host components (View, Text) and see only custom components
- find_components with includeLayout=true for targeted layout info

## Key Tools
- ios_screenshot / android_screenshot: visual capture
- ocr_screenshot: screenshot with text recognition and tap coordinates
- inspect_at_point: frame measurements, props, styles
- get_inspector_selection: component names and source files`
    },
    {
        id: "interact",
        title: "Device Interaction",
        summary: "Tap buttons, swipe, type text, and navigate the app UI",
        content: `# Device Interaction

## Pressing Buttons (Fallback Chain)
Use tap — it handles fallbacks automatically in this order:
1. tap(text="Login") — text match via JS fiber tree (preferred)
2. tap(component="ButtonName", index=N) — component name match (for icon-only buttons; use find_components to discover names first)
3. tap(testID="login-btn") — accessibility testID match
4. tap(x=..., y=...) — coordinate-based tap (last resort)

## Non-ASCII Text (Cyrillic, CJK, Arabic)
tap(text=...) only supports ASCII (Hermes limitation). Use testID or component params instead, or fall back to ocr_screenshot -> tap(x=..., y=...).

## Other Interactions
- ios_swipe / android_swipe: swipe/scroll with start/end coordinates
- ios_input_text / android_input_text: type text (tap input field first)
- ios_button / android_key_event: hardware buttons (HOME, BACK, etc.)
- ios_open_url: deep links and universal links

## After Interactions
- ios_wait_for_element / android_wait_for_element: wait for UI to update
- Take a screenshot to verify the result`
    },
    {
        id: "logs",
        title: "Debug Logs",
        summary: "Read console logs, errors, and warnings from the running app",
        content: `# Debug Logs

## Workflow
1. get_logs with summary=true — get counts by level and last 5 messages (overview first)
2. Based on what you see:
   - get_logs with level="error" — errors only
   - search_logs with text="..." — find specific messages
   - get_logs with verbose=true and maxLogs=10 — full details for recent entries
3. clear_logs — reset buffer, then re-capture after a specific action

## Key Tools
- get_logs: retrieve logs with filtering (level, maxLogs, summary, verbose, startFromText)
- search_logs: text search across all captured logs
- clear_logs: reset the log buffer

## Tips
- Always start with summary=true to avoid token overload
- Use verbose=true with low maxLogs for full error details
- Use startFromText to begin reading from a specific point`
    },
    {
        id: "network",
        title: "Network Inspection",
        summary: "Debug API calls, check request/response data, find failed requests",
        content: `# Network Inspection

## Workflow
1. get_network_stats or get_network_requests with summary=true — overview of all requests
2. Filter by what you need:
   - get_network_requests with urlPattern, method, or status filters
   - search_network with urlPattern for text search
3. get_request_details with requestId — full headers, body, timing for a specific request
4. clear_network — reset buffer, then re-capture

## Key Tools
- get_network_requests: list requests with filters (urlPattern, method, status, summary)
- get_network_stats: quick stats overview
- search_network: search by URL pattern
- get_request_details: full request/response details (use verbose=true for large payloads)
- clear_network: reset the request buffer

## Tips
- Start with summary=true to see the request landscape
- Use get_request_details with verbose=true for full JSON payloads
- Increase maxBodyLength for large request/response bodies`
    },
    {
        id: "state",
        title: "App State",
        summary: "Inspect Redux store, global variables, and execute JavaScript in the app",
        content: `# App State

## Workflow
1. list_debug_globals — discover what's exposed (Redux store, navigation refs, action creators)
2. inspect_global with objectName — see properties and methods before calling them
3. execute_in_app — run JavaScript expressions in the app context

## Common Patterns
- Read Redux: execute_in_app("globalThis.__REDUX_STORE__.getState().sliceName")
- Dispatch action: execute_in_app("globalThis.__dispatch__(globalThis.__REDUX_ACTIONS__.slice.action(args))")
- Navigate: execute_in_app("globalThis.__navigate__('ScreenName')")
- Current route: execute_in_app("globalThis.__getCurrentRoute__()")

## Hermes Limitations
- NO require() or import — only pre-existing globals
- NO async/await — use simple expressions or .then() chains
- NO emoji or non-ASCII in string literals
- Use globalThis instead of global

## Tips
- Always inspect_global before calling methods on unfamiliar objects
- Use verbose=true with caution — Redux stores can return 10KB+
- Set higher maxResultLength when default 2000 chars isn't enough`
    },
    {
        id: "bundle",
        title: "Bundle Health",
        summary: "Check Metro bundler status, fix compilation errors, reload the app",
        content: `# Bundle Health

## Workflow
1. get_bundle_status — check if Metro is running and its build state
2. get_bundle_errors — check for compilation/bundling errors
3. Fix errors in code
4. clear_bundle_errors — clear the error buffer
5. reload_app — trigger full JS bundle reload (only if needed)

## When to Reload
React Native has Fast Refresh by default. Only reload_app when:
- Changes aren't appearing after a few seconds
- App is in a broken/error state
- Need to reset full app state (navigation, context)
- Made changes to native code or config files

## Red Screen Errors
If no errors captured via CDP, use get_bundle_errors with platform="ios" or "android" — this triggers screenshot+OCR fallback to read errors from the device screen.

## Key Tools
- get_bundle_status: Metro health check
- get_bundle_errors: compilation errors
- clear_bundle_errors: clear error buffer
- reload_app: full JS bundle reload
- ensure_connection: verify connection with healthCheck=true`
    }
];

export function getGuideOverview(): string {
    const lines = ["Available usage guides:\n"];
    for (const guide of guides) {
        lines.push(`  ${guide.id} — ${guide.summary}`);
    }
    lines.push("\nCall get_usage_guide with a topic parameter for the full guide.");
    lines.push(
        "\nQuick start: scan_metro → get_logs / search_logs (console debugging) → ios_screenshot → get_inspector_selection(x, y) (identify components)"
    );
    return lines.join("\n");
}

export function getGuideByTopic(topic: string): string | null {
    const guide = guides.find((g) => g.id === topic.toLowerCase());
    if (!guide) return null;
    return guide.content;
}

export function getAvailableTopics(): string[] {
    return guides.map((g) => g.id);
}
