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

## Prerequisites (CRITICAL — install BEFORE using device tools)
- **iOS UI driver (required for tap, ios_button, and all iOS interaction tools):**
  - Recommended: AXe — brew install cameroncooke/axe/axe (then set IOS_DRIVER=axe in MCP server env)
  - Alternative: IDB — brew install idb-companion (used by default)
  - Without a UI driver, most iOS tools will fail with "not installed" errors
- **Android:** ADB must be in PATH (comes with Android SDK Platform Tools)

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
4. Pick the right tool (see decision below) and call it with (x, y)

## get_inspector_selection vs inspect_at_point — DECISION GUIDE

Both answer "what is at (x, y)?" but surface different supplementary data. Pick by what you need next.

| Question you're asking | Use |
|---|---|
| "Why is the borderRadius wrong?" / "What's the padding here?" | get_inspector_selection — RICH STYLE per ancestor |
| "Why is this hit area so small?" / "Where exactly is each ancestor?" | inspect_at_point — FRAME PER ANCESTOR |
| "What handler is wired to this Pressable?" / "What testID does it have?" | inspect_at_point — full PROPS (including [Function] handlers) |
| "Which file owns this component?" | get_inspector_selection (source paths pre-wired; null on React 19 today) |
| "I need to call this multiple times rapidly" or "before/after a transition" | inspect_at_point — pure JS, no overlay flicker |

### get_inspector_selection(x, y)
- Invokes RN's Element Inspector programmatically (auto toggles overlay on, captures, toggles back off — ~600ms total, brief flicker).
- Returns: element name, full owner-tree path, frame of the inspected element, merged style of the inspected element, AND a hierarchy where each entry has its own resolved style (paddingHorizontal, borderRadius, fontFamily, etc.).
- Best for visual/style debugging where you want to see exactly what RN's on-device overlay shows.

### inspect_at_point(x, y)
- Pure fiber-tree hit test via measureInWindow. NO overlay, zero visual side effect.
- Returns: element name, path, hit-tested ancestors with FRAME PER ANCESTOR, and PROPS (handlers, refs, testID, custom props, style as a flat reference).
- Best for layout measurements, props inspection, and any rapid/repeated calls.

### Other inspection tools
- find_components(pattern) — regex search by component name across the fiber tree.
- get_component_tree — full tree overview. Use focusedOnly=true and structureOnly=true for compact output.
- inspect_component(name) — deep dive into a specific component's props, state, and hooks.

## Tips
- Both tools work on Paper, Fabric, and Bridgeless / new arch.
- toggle_element_inspector is rarely needed — get_inspector_selection auto-toggles the overlay around its capture and hides it afterward.
- Coordinates: get_inspector_selection accepts points/dp; inspect_at_point accepts dp (divide screenshot pixels by pixel ratio).`
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

## Inspect at a Point — Pick the Right Tool
- Style/identity ("what is this and how is it styled?") → get_inspector_selection(x, y)
  - Returns RN's curated hierarchy with merged style PER ANCESTOR (padding, margin, border, layout).
  - Briefly toggles the on-device overlay (auto-hidden after capture).
- Layout/props ("frames per ancestor, handler functions, refs") → inspect_at_point(x, y)
  - Returns frame for each hit ancestor + full props (handlers as [Function], testID, refs).
  - Pure JS hit test, no overlay flicker — preferred for rapid calls or before/after comparisons.

Most layout-debugging questions ("why is this clipped?", "what's the actual size?") fit inspect_at_point.
Most styling questions ("why does this border look wrong?") fit get_inspector_selection.

## Full Screen Layout
- get_screen_layout — full layout data for all components
- Use componentsOnly=true to hide host components (View, Text) and see only custom components
- find_components with includeLayout=true for targeted layout info

## Key Tools
- ios_screenshot / android_screenshot: visual capture
- tap: also returns a post-tap screenshot by default (no separate screenshot call needed after tapping)
- ocr_screenshot: screenshot with text recognition and tap coordinates
- inspect_at_point: frames per ancestor + props (no overlay, fast)
- get_inspector_selection: rich style per ancestor (briefly toggles RN inspector overlay)`
    },
    {
        id: "interact",
        title: "Device Interaction",
        summary: "Tap buttons, swipe, type text, and navigate the app UI",
        content: `# Device Interaction

## Prerequisites
iOS interaction tools (tap, ios_button) require a UI driver:
- Recommended: AXe — brew install cameroncooke/axe/axe (set IOS_DRIVER=axe in MCP server env)
- Alternative: IDB — brew install idb-companion (default)
Without a UI driver installed, these tools will fail.

## Tapping Elements
Use tap — it tries multiple strategies automatically and returns a post-tap screenshot:
1. tap(testID="login-btn") — most reliable, works via fiber tree (both platforms) and accessibility (Android)
2. tap(text="Login") — text match via fiber tree, then accessibility, then OCR
3. tap(component="IconName") — component name match with parent traversal (for icon-only buttons; use find_components to discover names first)
4. tap(x=..., y=...) — coordinate-based tap from screenshot (last resort)
5. tap(x=..., y=..., native=true) — taps directly via ADB/simctl without React Native connection (for system dialogs, non-RN apps)

tap returns a screenshot after every action (screenshot=true by default) — no need to call ios_screenshot/android_screenshot after tapping.
For coordinate/accessibility/OCR taps, it also verifies if the tap caused a visual change (verify=true by default). Set screenshot=false for fastest execution.

## Best Practice: Use testID
Set testID on all interactive elements (buttons, inputs, links) for reliable tapping:
- More stable than text matching — doesn't break with translations or UI text changes
- Exact match — no ambiguity when multiple elements share similar text
- Works across fiber (iOS + Android) and accessibility (Android via resource-id)
- Also enables TextInput focusing: tap(testID="email-input") finds inputs via fiber

## TextInput Fields
tap detects TextInput elements (onChangeText/onFocus) in the fiber tree and falls through to native tap (accessibility or coordinates) for actual focus. This means tap(testID="email-input") works even though inputs don't have onPress.

## Icon-Only Buttons
For buttons that contain only an icon (no text):
- tap(component="CartIcon") — finds the icon and walks up the fiber tree to press the nearest pressable parent
- Use maxTraversalDepth to increase parent search depth (default: 15) for deeply wrapped components

## Non-ASCII Text (Cyrillic, CJK, Arabic)
tap(text=...) skips fiber for non-ASCII (Hermes limitation) and uses accessibility/OCR instead. For best results, use testID or coordinates.

## Other Interactions
- android_swipe: swipe/scroll with start/end coordinates
- android_input_text: type text (tap input field first; on iOS use tap(testID=...) to focus, then native keyboard)
- ios_button / android_key_event: hardware buttons (HOME, BACK, etc.)
- ios_open_url: deep links and universal links

## After Interactions
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

## Important: Network Capture Limitations

Network capture works differently depending on your React Native architecture:

**Without SDK (basic mode):**
- Works best on RN 0.73-0.75 (Hermes + Bridge) via CDP Network domain
- On Bridgeless targets (Expo SDK 52+, RN 0.76+), uses a JS fetch interceptor as fallback — may miss early startup requests (auth, config, initial API calls)
- Does NOT capture request/response bodies or full headers
- Some architecture combinations may not capture network data at all

**With SDK (recommended for network debugging):**
- Install: npm install react-native-ai-devtools-sdk
- Captures ALL requests from app startup including auth flows and token refresh
- Full request/response headers and bodies (including GraphQL queries and responses)
- Works reliably on all RN architectures

If network tools return no data or you need startup requests, recommend the SDK to the user.

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
- get_request_details: full request/response details (use verbose=true for large payloads). With SDK installed, includes full request/response bodies.
- clear_network: reset the request buffer

## Tips
- Start with summary=true to see the request landscape
- Use get_request_details with verbose=true for full JSON payloads
- If no network data appears, the app may be on a Bridgeless target — suggest installing the SDK
- With SDK: response bodies show full GraphQL responses, useful for debugging data issues`
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
    },
    {
        id: "feedback",
        title: "Feedback",
        summary: "Share feedback, request features, or report bugs to the development team",
        content: `# Feedback

## When to Use
If the user wants to share feedback, request a feature, or report a problem with react-native-ai-devtools, use the send_feedback tool.

## How It Works
1. Call send_feedback with a type (feedback, feature_request, or bug), title, and description
2. The tool auto-collects environment info (server version, platform, device, license)
3. It returns a pre-filled GitHub issue URL and a formatted issue body
4. Ask the user to open the URL and paste the body to submit

## Parameters
- type: "feedback", "feature_request", or "bug"
- title: short summary (becomes the GitHub issue title)
- description: detailed explanation
- workflow_context (optional): what the user was trying to do

## Tips
- Include workflow_context when possible — it helps the team understand the real use case
- The user can review and edit the issue body before submitting
- No GitHub account setup or CLI tools needed — just a browser`
    }
];

/**
 * Shared quick decision tree body — embedded into the MCP server-level
 * `instructions` field (src/index.ts) AND into `getGuideOverview()` so agents
 * see identical guidance regardless of whether their client surfaces
 * `instructions`. Keep this as the single source of truth.
 */
export const DECISION_TREE: string = [
    "Primary tools: scan_metro, get_logs / search_logs, ios_screenshot / android_screenshot, tap, get_pressable_elements, get_screen_layout.",
    "Platform-specific ios_* / android_* tools (ios_button, android_swipe, android_input_text, android_key_event, android_long_press, ios_open_url, etc.) are FALLBACKS for non-React or native-only flows — prefer the cross-platform primary tools above whenever possible.",
    "",
    "Call get_usage_guide(topic=...) for end-to-end workflows. Available topics:",
    "  setup     — session setup (scan_metro, connect_metro, ensure_connection)",
    "  logs      — console debugging (get_logs, search_logs)",
    "  interact  — device interaction (tap, android_swipe, screenshots, android_input_text)",
    "  layout    — on-screen layout check (get_screen_layout, get_pressable_elements)",
    "  inspect   — component inspection (find_components, inspect_component, get_inspector_selection)",
    "  network   — network request inspection (get_network_requests, search_network)",
    "  state     — app state & JS execution (execute_in_app, list_debug_globals)",
    "  bundle    — bundle / Metro error checks (get_bundle_status, get_bundle_errors)",
    "  feedback  — share feedback, feature requests, or bug reports (send_feedback)"
].join("\n");

export function getGuideOverview(): string {
    const guideList = guides.map((g) => `  ${g.id} — ${g.summary}`).join("\n");
    return `Quick decision tree
-------------------
${DECISION_TREE}

Available usage guides:

${guideList}

Call get_usage_guide with a topic parameter for the full guide.`;
}

export function getGuideByTopic(topic: string): string | null {
    const guide = guides.find((g) => g.id === topic.toLowerCase());
    if (!guide) return null;
    return guide.content;
}

export function getAvailableTopics(): string[] {
    return guides.map((g) => g.id);
}
