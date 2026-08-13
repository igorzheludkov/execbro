# Available Tools

Reference for the MCP tools provided by React Native AI DevTools. For the exact tool list your installed version exposes, ask the agent — the server advertises them on connection.

## Usage Guide

| Tool              | Description                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_usage_guide` | Get recommended workflows for all tools. Call without params for overview, with a topic (`setup`, `inspect`, `layout`, `interact`, `logs`, `network`, `state`, `bundle`) for the full guide |

The server also sends instructions on connection, so MCP clients automatically learn about `get_usage_guide`.

## Connection & Logs

| Tool                    | Description                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `scan_metro`            | Scan for Metro servers and auto-connect. **Called automatically by the agent** at session start — no need to invoke manually |
| `connect_metro`         | Connect to a specific Metro port. **Usually called automatically** — use manually only when you need a non-standard port     |
| `disconnect_metro`      | Disconnect from all Metro servers. Frees the CDP slot for the built-in RN debugger. Reconnect with `scan_metro`              |
| `get_apps`              | List connected apps. Run `scan_metro` first if none connected                                                                |
| `get_connection_status` | Get detailed connection health, uptime, and recent disconnects                                                               |
| `ensure_connection`     | Verify/establish connection with health checks                                                                               |
| `get_logs`              | Retrieve console logs (filtering, truncation, summary)                                                                       |
| `search_logs`           | Search logs for specific text (truncation)                                                                                   |
| `clear_logs`            | Clear the log buffer                                                                                                         |

## Network Tracking

| Tool                   | Description                                                   |
| ---------------------- | ------------------------------------------------------------- |
| `get_network_requests` | Retrieve network requests (filtering, summary)                |
| `search_network`       | Search requests by URL pattern                                |
| `get_request_details`  | Get full details of a request (headers, body with truncation) |
| `clear_network`        | Clear the network request buffer                              |
| `network_mock`         | Replace or tamper with responses (add / list / remove / clear) |
| `network_condition`    | Simulate offline / slow / normal network                      |
| `network_replay`       | Re-issue a captured request, with optional overrides          |

## App Inspection & Execution

| Tool                 | Description                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `execute_in_app`     | Run a JS expression in the app. `state`/`store`, `apollo`/`cache()`/`deref()`, `router`, `summary()` and `require()` are pre-resolved in scope; oversized results are bounded structurally |
| `app_request`        | Issue an HTTP request from inside the app as the logged-in user. `auth="auto"` resolves the bearer token in-app, so no credential enters the transcript |
| `list_debug_globals` | Discover available debug objects (Apollo, Redux, Expo Router, etc.)                         |
| `inspect_global`     | Inspect a global object to see its properties and callable methods                          |
| `reload_app`         | Reload the app (auto-connects if needed). Use sparingly - Fast Refresh handles most changes |

> **Tip:** Install the optional [SDK](https://www.npmjs.com/package/execbro-sdk) for a more robust approach — it provides full network capture from app startup (including request/response bodies), enhanced log collection, and access to global variables for navigation, state management, and more.

## Layout & Component Inspection

| Tool                       | Description                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `get_screen_state`         | Screenshot-free orientation snapshot — active route + navigation stack, overlays, and every on-screen pressable, text, and image with a tap-ready `(x, y)`. Use `pressablesOnly=true` for just the tappable list |
| `get_screen_layout`        | Screen map of visible components with positions, sizes, and text content. Use `extended=true` for layout styles |
| `get_component_tree`       | React fiber tree. Compact names-only by default; pass `structureOnly=false` for the full detailed tree          |
| `find_components`          | Find components by name pattern. Use `includeLayout=true` for styles                                            |
| `inspect_component`        | Inspect a component's props, state (hooks), and children                                                        |
| `inspect_at_point`         | Per-ancestor frames + props + style + `source: {file, line, column}` at (x, y) — pure JS, no overlay flicker    |
| `get_images`               | Access shared image buffer (screenshots, tap verification frames)                                               |

All of these tools — plus the screenshot summaries and `tap` — speak one screen-space coordinate system. A coordinate from any of them can be passed to any other unchanged, with no conversion.

See [Layout & Component Inspection guide](layout-inspection.md) for detailed workflows.

## Bundle Tools

| Tool                  | Description                                |
| --------------------- | ------------------------------------------ |
| `get_bundle_status`   | Get Metro bundler status and build state   |
| `get_bundle_errors`   | Get compilation errors with file locations. `clear=true` also resets the buffer |

## UI Interaction (Cross-Platform)

| Tool                          | Description                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `navigate`   | Navigate the router directly and verify the route actually changed. Expo Router takes paths, React Navigation takes route names; unknown names are rejected before dispatch with nearest-match suggestions |
| `tap`                         | **Unified tap** — auto-detects platform, tries fiber tree → accessibility → OCR → coordinates. Accepts text, testID, component name, or coordinates from any layout tool or screenshot summary. Returns a post-tap screenshot by default and verifies visual change via before/after diff. Use `native=true` for coordinate taps without React Native connection (system dialogs, non-RN apps). Use `duration` (ms) to long press — held touch for context menus, drag starts and multi-select, reported back with `longPress.handlerFound`. Use `device` (substring match) or `udid` (iOS, exact) to pin to a specific device when multiple are connected |
| `swipe`                       | **Unified swipe** — auto-detects platform (iOS/Android), dispatches to the native driver, and returns a `verification` block. `verification.meaningful` is false when the swipe produced no visual change, and `warning` then names which one it was — end-of-list, non-scrollable surface, wrong axis, missed coordinates, or (with no React Native connection) that the screen could not be inspected at all. Set `burst:true` to surface transient overscroll/bounce feedback. Set `verify:false, screenshot:false` for the fastest path. |
| `pinch`                       | **Real two-finger pinch-to-zoom — ANDROID EMULATOR ONLY (iOS in progress).** Sends two genuine kernel touch contacts through the emulator's multi-touch bridge, so it drives any surface on screen (React Native, native views, WebViews, maps), not just RN. `direction:"out"` zooms in, `"in"` zooms out; `x`/`y` set the focal point in the shared screenshot-pixel space; `scale` is the finger-separation ratio and chains into multiple gestures when too large for one; `angle` picks the finger axis. `span` is the fraction of the screen the gesture occupies — 1 by default for `"out"`, 0.5 for `"in"` (a pinch-in starts with the fingers far apart, so a full span lands them on a top bar or bottom sheet). Lower it further if a gesture still lands on surrounding UI. Returns `verification.meaningful` like `swipe`. Physical Android devices and iOS return an explicit error rather than a partial result |
| `ocr_screenshot`              | Extract all visible text with tap-ready coordinates (works on iOS/Android)                                                                                                                                                                                                                                                                                                 |

**Examples:**

```
tap with text="Submit"                    # Finds and taps by visible text
tap with testID="login-btn"               # Finds by testID prop
tap with component="HamburgerIcon"        # Finds by React component name
tap with x=300 y=600                      # Taps at coordinates from any layout tool or screenshot
tap with text="Menu" strategy="ocr"       # Forces OCR strategy only
tap with x=300 y=600 native=true          # Taps directly via ADB/simctl (no RN connection needed)
tap with testID="row-3" duration=800      # Long press — holds the touch (RN's onLongPress fires at 500ms)
swipe with startX=200 startY=600 endX=200 endY=200            # Scroll up; reads verification.meaningful
swipe with startX=200 startY=600 endX=200 endY=200 burst=true # Catches overscroll/bounce feedback
```

## Android (ADB)

| Tool                       | Description                                                 |
| -------------------------- | ----------------------------------------------------------- |
| `android_screenshot`       | Take a screenshot from an Android device/emulator           |
| `android_launch_app`       | Launch an app by package name                               |
| `android_list_packages`    | List installed packages (with optional filter)              |
| `android_long_press`       | Long press at raw coordinates, for holds with no RN connection (prefer `tap` with `duration`) |
| `android_input_text`       | Type text at current focus point                            |
| `android_key_event`        | Send key events (HOME, BACK, ENTER, etc.)                   |

## iOS (Simulator)

| Tool                   | Description                                               |
| ---------------------- | --------------------------------------------------------- |
| `ios_screenshot`       | Take a screenshot from an iOS simulator                   |
| `ios_launch_app`       | Launch an app by bundle ID                                |
| `ios_open_url`         | Open a URL (deep links or web URLs)                       |
| `ios_terminate_app`    | Terminate a running app                                   |
| `ios_boot_simulator`   | Boot a simulator by UDID                                  |
| `ios_button`           | Press hardware button: HOME, LOCK, SIRI (requires IDB)    |
