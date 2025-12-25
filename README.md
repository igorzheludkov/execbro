# React Native AI Debugger

An MCP (Model Context Protocol) server for AI-powered React Native debugging. Enables AI assistants like Claude to capture logs, execute code, inspect state, and control navigation in your React Native app.

## Features

-   Captures `console.log`, `console.warn`, `console.error` from React Native apps
-   **Network request tracking** - capture HTTP requests/responses with headers, timing, and status
-   Supports both **Expo SDK 54+** (React Native Bridgeless) and **RN 0.70+** (Hermes)
-   Auto-discovers running Metro servers on common ports
-   Filters logs by level (log, warn, error, info, debug)
-   Circular buffer stores last 1000 log entries and 500 network requests
-   **Execute JavaScript** directly in the running app (REPL-style)
-   **Inspect global objects** like Apollo Client, Redux store, Expo Router
-   **Discover debug globals** available in the app
-   **Android device control** - screenshots, tap, swipe, text input, key events via ADB
-   **iOS simulator control** - screenshots, app management, URL handling via simctl

## Requirements

-   Node.js 18+
-   React Native app running with Metro bundler

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
