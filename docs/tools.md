# Available Tools

Complete reference for all MCP tools provided by React Native AI DevTools.

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
| `get_logs`              | Retrieve console logs (filtering, truncation, summary, TONL format)                                                          |
| `search_logs`           | Search logs for specific text (truncation, TONL format)                                                                      |
| `clear_logs`            | Clear the log buffer                                                                                                         |

## Network Tracking

| Tool                   | Description                                                   |
| ---------------------- | ------------------------------------------------------------- |
| `get_network_requests` | Retrieve network requests (filtering, summary, TONL format)   |
| `search_network`       | Search requests by URL pattern (TONL format)                  |
| `get_request_details`  | Get full details of a request (headers, body with truncation) |
| `get_network_stats`    | Get statistics: counts by method, status code, domain         |
| `clear_network`        | Clear the network request buffer                              |

## App Inspection & Execution

| Tool                 | Description                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `execute_in_app`     | Execute simple JS expressions using globals discovered via `list_debug_globals`             |
| `list_debug_globals` | Discover available debug objects (Apollo, Redux, Expo Router, etc.)                         |
| `inspect_global`     | Inspect a global object to see its properties and callable methods                          |
| `reload_app`         | Reload the app (auto-connects if needed). Use sparingly - Fast Refresh handles most changes |

> **Tip:** Install the optional [SDK](https://www.npmjs.com/package/react-native-ai-devtools-sdk) for a more robust approach — it provides full network capture from app startup (including request/response bodies), enhanced log collection, and access to global variables for navigation, state management, and more.

## Layout & Component Inspection

| Tool                       | Description                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `get_screen_layout`        | Screen map of visible components with positions, sizes, and text content. Use `extended=true` for layout styles |
| `get_component_tree`       | Full React fiber tree. Use `structureOnly=true` for compact output                                              |
| `find_components`          | Find components by name pattern. Use `includeLayout=true` for styles                                            |
| `inspect_component`        | Inspect a component's props, state (hooks), and children                                                        |
| `inspect_at_point`         | Inspect component at (x, y) coordinates — frame, props, styles                                                  |
| `get_inspector_selection`  | Identify component at screen location with file paths and hierarchy                                             |
| `toggle_element_inspector` | Toggle RN's built-in Element Inspector overlay                                                                  |
| `get_images`               | Access shared image buffer (screenshots, tap verification frames)                                               |

See [Layout & Component Inspection guide](layout-inspection.md) for detailed workflows.

## Bundle Tools

| Tool                  | Description                                |
| --------------------- | ------------------------------------------ |
| `get_bundle_status`   | Get Metro bundler status and build state   |
| `get_bundle_errors`   | Get compilation errors with file locations |
| `clear_bundle_errors` | Clear the bundle error buffer              |

## UI Interaction (Cross-Platform)

| Tool                          | Description                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tap`                         | **Unified tap** — auto-detects platform, tries fiber tree → accessibility → OCR → coordinates. Accepts text, testID, component name, or pixel coordinates from screenshots. Returns a post-tap screenshot by default and verifies visual change via before/after diff. Use `native=true` for coordinate taps without React Native connection (system dialogs, non-RN apps) |
| `ios_swipe` / `android_swipe` | Swipe gesture with start/end coordinates (scroll lists, navigate between screens, pull-to-refresh)                                                                                                                                                                                                                                                                         |
| `ocr_screenshot`              | Extract all visible text with tap-ready coordinates (works on iOS/Android)                                                                                                                                                                                                                                                                                                 |

**Examples:**

```
tap with text="Submit"                    # Finds and taps by visible text
tap with testID="login-btn"               # Finds by testID prop
tap with component="HamburgerIcon"        # Finds by React component name
tap with x=300 y=600                      # Taps at pixel coordinates (auto-converts)
tap with text="Menu" strategy="ocr"       # Forces OCR strategy only
tap with x=300 y=600 native=true          # Taps directly via ADB/simctl (no RN connection needed)
```

## Android (ADB)

| Tool                       | Description                                                 |
| -------------------------- | ----------------------------------------------------------- |
| `list_android_devices`     | List connected Android devices and emulators via ADB        |
| `android_screenshot`       | Take a screenshot from an Android device/emulator           |
| `android_install_app`      | Install an APK on an Android device/emulator                |
| `android_launch_app`       | Launch an app by package name                               |
| `android_list_packages`    | List installed packages (with optional filter)              |
| `android_long_press`       | Long press at specific coordinates                          |
| `android_swipe`            | Swipe from one point to another                             |
| `android_input_text`       | Type text at current focus point                            |
| `android_key_event`        | Send key events (HOME, BACK, ENTER, etc.)                   |
| `android_get_screen_size`  | Get device screen resolution                                |
| `android_describe_all`     | Get full UI accessibility tree via uiautomator              |
| `android_describe_point`   | Get UI element info at specific coordinates                 |
| `android_find_element`     | Find element by text/contentDesc/resourceId (no screenshot) |
| `android_wait_for_element` | Wait for element to appear (useful for screen transitions)  |

## iOS (Simulator)

| Tool                   | Description                                               |
| ---------------------- | --------------------------------------------------------- |
| `list_ios_simulators`  | List available iOS simulators                             |
| `ios_screenshot`       | Take a screenshot from an iOS simulator                   |
| `ios_install_app`      | Install an app bundle (.app) on a simulator               |
| `ios_launch_app`       | Launch an app by bundle ID                                |
| `ios_open_url`         | Open a URL (deep links or web URLs)                       |
| `ios_terminate_app`    | Terminate a running app                                   |
| `ios_boot_simulator`   | Boot a simulator by UDID                                  |
| `ios_swipe`            | Swipe gesture (requires IDB)                              |
| `ios_input_text`       | Type text into active field (requires IDB)                |
| `ios_button`           | Press hardware button: HOME, LOCK, SIRI (requires IDB)    |
| `ios_key_event`        | Send key event by keycode (requires IDB)                  |
| `ios_key_sequence`     | Send sequence of key events (requires IDB)                |
| `ios_describe_all`     | Get full accessibility tree (requires IDB)                |
| `ios_describe_point`   | Get element at point (requires IDB)                       |
| `ios_find_element`     | Find element by label/value (requires IDB, no screenshot) |
| `ios_wait_for_element` | Wait for element to appear (requires IDB)                 |
