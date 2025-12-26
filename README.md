# React Native AI Debugger

An MCP (Model Context Protocol) server for AI-powered React Native debugging. Enables AI assistants like Claude to capture logs, execute code, inspect state, and control navigation in your React Native app.

## Features

-   Captures `console.log`, `console.warn`, `console.error` from React Native apps
-   **Network request tracking** - capture HTTP requests/responses with headers, timing, and status
-   **Debug Web Dashboard** - browser-based UI to view logs and network requests in real-time
-   Supports both **Expo SDK 54+** (React Native Bridgeless) and **RN 0.70+** (Hermes)
-   Auto-discovers running Metro servers on common ports
-   Filters logs by level (log, warn, error, info, debug)
-   Circular buffer stores last 1000 log entries and 500 network requests
-   **Execute JavaScript** directly in the running app (REPL-style)
-   **Inspect global objects** like Apollo Client, Redux store, Expo Router
-   **Discover debug globals** available in the app
-   **Android device control** - screenshots, tap, swipe, text input, key events via ADB
-   **iOS simulator control** - screenshots, app management, URL handling via simctl
-   **iOS UI automation** - tap, swipe, text input, button presses via IDB (optional)
-   **iOS accessibility inspection** - get UI element tree and element info at coordinates via IDB

## Requirements

-   Node.js 18+
-   React Native app running with Metro bundler
-   **Optional for iOS UI automation**: [Facebook IDB](https://fbidb.io/) - `brew install idb-companion`

## Claude Code Setup

No installation required - Claude Code uses `npx` to run the latest version automatically.

### Global (all projects)

```bash
claude mcp add rn-debugger --scope user -- npx react-native-ai-debugger
```

### Project-specific

```bash
claude mcp add rn-debugger --scope project -- npx react-native-ai-debugger
```

### Manual Configuration

Add to `~/.claude.json` (user scope) or `.mcp.json` (project scope):

```json
{
    "mcpServers": {
        "rn-debugger": {
            "type": "stdio",
            "command": "npx",
            "args": ["react-native-ai-debugger"]
        }
    }
}
```

Restart Claude Code after adding the configuration.

## VS Code Copilot Setup

Requires VS Code 1.102+ with Copilot ([docs](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)).

**Via Command Palette**: `Cmd+Shift+P` → "MCP: Add Server"

**Manual config** - add to `.vscode/mcp.json`:

```json
{
    "servers": {
        "rn-debugger": {
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "react-native-ai-debugger"]
        }
    }
}
```

## Cursor Setup

[Docs](https://docs.cursor.com/context/model-context-protocol)

**Via Command Palette**: `Cmd+Shift+P` → "View: Open MCP Settings"

**Manual config** - add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
    "mcpServers": {
        "rn-debugger": {
            "command": "npx",
            "args": ["-y", "react-native-ai-debugger"]
        }
    }
}
```

## Available Tools

### Connection & Logs

| Tool            | Description                                                        |
| --------------- | ------------------------------------------------------------------ |
| `scan_metro`    | Scan for running Metro servers and auto-connect                    |
| `connect_metro` | Connect to a specific Metro port                                   |
| `get_apps`      | List connected React Native apps                                   |
| `get_logs`      | Retrieve console logs (with optional filtering and start position) |
| `search_logs`   | Search logs for specific text (case-insensitive)                   |
| `clear_logs`    | Clear the log buffer                                               |

### Network Tracking

| Tool                   | Description                                                |
| ---------------------- | ---------------------------------------------------------- |
| `get_network_requests` | Retrieve captured network requests with optional filtering |
| `search_network`       | Search requests by URL pattern (case-insensitive)          |
| `get_request_details`  | Get full details of a request (headers, body, timing)      |
| `get_network_stats`    | Get statistics: counts by method, status code, domain      |
| `clear_network`        | Clear the network request buffer                           |

### App Inspection & Execution

| Tool                 | Description                                                         |
| -------------------- | ------------------------------------------------------------------- |
| `execute_in_app`     | Execute JavaScript code in the connected app and return the result  |
| `list_debug_globals` | Discover available debug objects (Apollo, Redux, Expo Router, etc.) |
| `inspect_global`     | Inspect a global object to see its properties and callable methods  |
| `reload_app`         | Reload the app (like pressing 'r' in Metro or shaking the device)   |
| `get_debug_server`   | Get the debug HTTP server URL for browser-based viewing             |

### Android (ADB)

| Tool                      | Description                                          |
| ------------------------- | ---------------------------------------------------- |
| `list_android_devices`    | List connected Android devices and emulators via ADB |
| `android_screenshot`      | Take a screenshot from an Android device/emulator    |
| `android_install_app`     | Install an APK on an Android device/emulator         |
| `android_launch_app`      | Launch an app by package name                        |
| `android_list_packages`   | List installed packages (with optional filter)       |
| `android_tap`             | Tap at specific coordinates on screen                |
| `android_long_press`      | Long press at specific coordinates                   |
| `android_swipe`           | Swipe from one point to another                      |
| `android_input_text`      | Type text at current focus point                     |
| `android_key_event`       | Send key events (HOME, BACK, ENTER, etc.)            |
| `android_get_screen_size` | Get device screen resolution                         |

### iOS (Simulator)

| Tool                  | Description                                 |
| --------------------- | ------------------------------------------- |
| `list_ios_simulators` | List available iOS simulators               |
| `ios_screenshot`      | Take a screenshot from an iOS simulator     |
| `ios_install_app`     | Install an app bundle (.app) on a simulator |
| `ios_launch_app`      | Launch an app by bundle ID                  |
| `ios_open_url`        | Open a URL (deep links or web URLs)         |
| `ios_terminate_app`   | Terminate a running app                     |
| `ios_boot_simulator`  | Boot a simulator by UDID                    |

### iOS UI Interaction (requires IDB)

These tools require [Facebook IDB](https://fbidb.io/) to be installed: `brew install idb-companion`

| Tool                | Description                                           |
| ------------------- | ----------------------------------------------------- |
| `ios_tap`           | Tap at specific coordinates on screen                 |
| `ios_swipe`         | Swipe from one point to another                       |
| `ios_input_text`    | Type text into the active input field                 |
| `ios_button`        | Press hardware buttons (HOME, LOCK, SIRI, etc.)       |
| `ios_key_event`     | Send a key event by keycode                           |
| `ios_key_sequence`  | Send multiple key events in sequence                  |
| `ios_describe_all`  | Get accessibility tree for entire screen              |
| `ios_describe_point`| Get accessibility info for element at specific point  |

## Usage

1. Start your React Native app:

    ```bash
    npm start
    # or
    expo start
    ```

2. In Claude Code, scan for Metro:

    ```
    Use scan_metro to find and connect to Metro
    ```

3. Get logs:
    ```
    Use get_logs to see recent console output
    ```

### Filtering Logs

```
get_logs with maxLogs=20 and level="error"
```

Available levels: `all`, `log`, `warn`, `error`, `info`, `debug`

### Start from Specific Line

```
get_logs with startFromText="iOS Bundled" and maxLogs=100
```

This finds the **last** (most recent) line containing the text and returns logs from that point forward. Useful for getting logs since the last app reload.

### Search Logs

```
search_logs with text="error" and maxResults=20
```

Case-insensitive search across all log messages.

## Network Tracking

### View Recent Requests

```
get_network_requests with maxRequests=20
```

### Filter by Method

```
get_network_requests with method="POST"
```

### Filter by Status Code

Useful for debugging auth issues:

```
get_network_requests with status=401
```

### Search by URL

```
search_network with urlPattern="api/auth"
```

### Get Full Request Details

After finding a request ID from `get_network_requests`:

```
get_request_details with requestId="123.45"
```

Shows full headers, request body, response headers, and timing.

### View Statistics

```
get_network_stats
```

Example output:

```
Total requests: 47
Completed: 45
Errors: 2
Avg duration: 234ms

By Method:
  GET: 32
  POST: 15

By Status:
  2xx: 43
  4xx: 2

By Domain:
  api.example.com: 40
  cdn.example.com: 7
```

## Debug Web Dashboard

The MCP server includes a built-in web dashboard for viewing logs and network requests in your browser. This is useful for real-time monitoring without using MCP tools.

### Getting the Dashboard URL

Use the `get_debug_server` tool to find the dashboard URL:

```
get_debug_server
```

The server automatically finds an available port starting from 3456. Each MCP instance gets its own port, so multiple Claude Code sessions can run simultaneously.

### Available Pages

| URL        | Description                                    |
| ---------- | ---------------------------------------------- |
| `/`        | Dashboard with overview stats                  |
| `/logs`    | Console logs with color-coded levels           |
| `/network` | Network requests with expandable details       |
| `/apps`    | Connected React Native apps                    |

### Features

-   **Auto-refresh** - Pages update automatically every 3 seconds
-   **Color-coded logs** - Errors (red), warnings (yellow), info (blue), debug (gray)
-   **Expandable network requests** - Click any request to see full details:
    -   Request/response headers
    -   Request body (with JSON formatting)
    -   Timing information
    -   Error details
-   **GraphQL support** - Shows operation name and variables in compact view:
    ```
    POST  200  https://api.example.com/graphql         1ms  ▶
               GetMeetingsBasic (timeFilter: "Future", first: 20)
    ```
-   **REST body preview** - Shows JSON body preview for non-GraphQL requests

### JSON API Endpoints

For programmatic access, JSON endpoints are also available:

| URL                  | Description                   |
| -------------------- | ----------------------------- |
| `/api/status`        | Server status and buffer sizes |
| `/api/logs`          | All logs as JSON              |
| `/api/network`       | All network requests as JSON  |
| `/api/bundle-errors` | Metro bundle errors as JSON   |
| `/api/apps`          | Connected apps as JSON        |

## App Inspection

### Discover Debug Globals

Find what debugging objects are available in your app:

```
list_debug_globals
```

Example output:

```json
{
    "Apollo Client": ["__APOLLO_CLIENT__"],
    "Redux": ["__REDUX_STORE__"],
    "Expo": ["__EXPO_ROUTER__"],
    "Reanimated": ["__reanimatedModuleProxy"]
}
```

### Inspect an Object

Before calling methods on an unfamiliar object, inspect it to see what's callable:

```
inspect_global with objectName="__EXPO_ROUTER__"
```

Example output:

```json
{
    "navigate": { "type": "function", "callable": true },
    "push": { "type": "function", "callable": true },
    "currentPath": { "type": "string", "callable": false, "value": "/" },
    "routes": { "type": "array", "callable": false }
}
```

### Execute Code in App

Run JavaScript directly in the connected app:

```
execute_in_app with expression="__DEV__"
// Returns: true

execute_in_app with expression="__APOLLO_CLIENT__.cache.extract()"
// Returns: Full Apollo cache contents

execute_in_app with expression="__EXPO_ROUTER__.navigate('/settings')"
// Navigates the app to /settings
```

### Async Code

For async operations, promises are awaited by default:

```
execute_in_app with expression="AsyncStorage.getItem('userToken')"
```

Set `awaitPromise=false` for synchronous execution only.

## Device Interaction

### Android (requires ADB)

List connected devices:

```
list_android_devices
```

Take a screenshot:

```
android_screenshot
```

Tap on screen (coordinates in pixels):

```
android_tap with x=540 y=960
```

Swipe gesture:

```
android_swipe with startX=540 startY=1500 endX=540 endY=500
```

Type text (tap input field first):

```
android_tap with x=540 y=400
android_input_text with text="hello@example.com"
```

Send key events:

```
android_key_event with key="BACK"
android_key_event with key="HOME"
android_key_event with key="ENTER"
```

### iOS Simulator (requires Xcode)

List available simulators:

```
list_ios_simulators
```

Boot a simulator:

```
ios_boot_simulator with udid="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
```

Take a screenshot:

```
ios_screenshot
```

Launch an app:

```
ios_launch_app with bundleId="com.example.myapp"
```

Open a deep link:

```
ios_open_url with url="myapp://settings"
```

### iOS UI Automation (requires IDB)

Install IDB first: `brew install idb-companion`

**Important: Coordinate System**
- iOS IDB uses **points** (logical coordinates), not pixels
- For 2x Retina displays: 1 point = 2 pixels
- Example: 1640x2360 pixel screenshot = 820x1180 points
- Use `ios_describe_all` to get exact element coordinates in points

Tap on screen (coordinates in points):

```
ios_tap with x=200 y=400
```

Long press (hold for 2 seconds):

```
ios_tap with x=200 y=400 duration=2
```

Swipe gesture:

```
ios_swipe with startX=200 startY=600 endX=200 endY=200
```

Type text (tap input field first):

```
ios_tap with x=200 y=300
ios_input_text with text="hello@example.com"
```

Press hardware buttons:

```
ios_button with button="HOME"
ios_button with button="LOCK"
ios_button with button="SIRI"
```

Get accessibility info for the screen:

```
ios_describe_all
```

Get accessibility info at a specific point:

```
ios_describe_point with x=200 y=400
```

## Supported React Native Versions

| Version        | Runtime                 | Status     |
| -------------- | ----------------------- | ---------- |
| Expo SDK 54+   | React Native Bridgeless | ✓          |
| RN 0.70 - 0.76 | Hermes React Native     | ✓          |
| RN < 0.70      | JSC                     | Not tested |

## How It Works

1. Fetches device list from Metro's `/json` endpoint
2. Connects to the main JS runtime via CDP (Chrome DevTools Protocol) WebSocket
3. Enables `Runtime.enable` to receive `Runtime.consoleAPICalled` events
4. Enables `Network.enable` to receive network request/response events
5. Stores logs and network requests in circular buffers for retrieval

## Troubleshooting

### No devices found

-   Make sure the app is running on a simulator/device
-   Check that Metro bundler is running (`npm start`)

### Wrong device connected

The server prioritizes devices in this order:

1. React Native Bridgeless (SDK 54+)
2. Hermes React Native
3. Any React Native (excluding Reanimated/Experimental)

### Logs not appearing

-   Ensure the app is actively running (not just Metro)
-   Try `clear_logs` then trigger some actions in the app
-   Check `get_apps` to verify connection status

## License

MIT
