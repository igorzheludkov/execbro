# React Native AI Debugger

An MCP (Model Context Protocol) server for AI-powered React Native debugging. Enables AI assistants like Claude to capture logs, execute code, inspect state, and control navigation in your React Native app.

## Features

-   Captures `console.log`, `console.warn`, `console.error` from React Native apps
-   **Network request tracking** - capture HTTP requests/responses with headers, timing, and status
-   **Debug Web Dashboard** - browser-based UI to view logs and network requests in real-time
-   Supports both **Expo SDK 54+** (React Native Bridgeless) and **RN 0.70+** (Hermes)
-   **Auto-connect on startup** - automatically scans and connects to Metro when the server starts
-   **Auto-reconnection** - automatically reconnects when connection is lost (e.g., app restart)
-   Auto-discovers running Metro servers on common ports
-   Filters logs by level (log, warn, error, info, debug)
-   Circular buffer stores last 1000 log entries and 500 network requests
-   **Execute JavaScript** directly in the running app (REPL-style)
-   **Inspect global objects** like Apollo Client, Redux store, Expo Router
-   **Discover debug globals** available in the app
-   **Android device control** - screenshots, tap, swipe, text input, key events via ADB
-   **iOS simulator control** - screenshots, app management, URL handling via simctl
-   **iOS UI automation** - tap, swipe, text input, button presses via IDB (optional)
-   **Element-based UI automation** - find and wait for elements by text/label without screenshots (faster, cheaper)
-   **OCR-based text extraction** - extract visible text with tap-ready coordinates using OCR (works on any visible text)

## Requirements

-   Node.js 18+
-   React Native app running with Metro bundler
-   **Optional for iOS UI automation**: [Facebook IDB](https://fbidb.io/) - `brew install idb-companion`
-   **Optional for enhanced OCR**: Python 3.10+ with EasyOCR (see [OCR Setup](#ocr-text-extraction))

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

| Tool                    | Description                                                        |
| ----------------------- | ------------------------------------------------------------------ |
| `scan_metro`            | Scan for running Metro servers and auto-connect                    |
| `connect_metro`         | Connect to a specific Metro port                                   |
| `get_apps`              | List connected React Native apps                                   |
| `get_connection_status` | Get detailed connection health, uptime, and recent disconnects     |
| `get_logs`              | Retrieve console logs (filtering, truncation, summary, TONL format) |
| `search_logs`           | Search logs for specific text (truncation, TONL format)            |
| `clear_logs`            | Clear the log buffer                                               |

### Network Tracking

| Tool                   | Description                                                |
| ---------------------- | ---------------------------------------------------------- |
| `get_network_requests` | Retrieve network requests (filtering, summary, TONL format) |
| `search_network`       | Search requests by URL pattern (TONL format)               |
| `get_request_details`  | Get full details of a request (headers, body with truncation) |
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

| Tool                        | Description                                                   |
| --------------------------- | ------------------------------------------------------------- |
| `list_android_devices`      | List connected Android devices and emulators via ADB          |
| `android_screenshot`        | Take a screenshot from an Android device/emulator             |
| `android_install_app`       | Install an APK on an Android device/emulator                  |
| `android_launch_app`        | Launch an app by package name                                 |
| `android_list_packages`     | List installed packages (with optional filter)                |
| `android_tap`               | Tap at specific coordinates on screen                         |
| `android_long_press`        | Long press at specific coordinates                            |
| `android_swipe`             | Swipe from one point to another                               |
| `android_input_text`        | Type text at current focus point                              |
| `android_key_event`         | Send key events (HOME, BACK, ENTER, etc.)                     |
| `android_get_screen_size`   | Get device screen resolution                                  |
| `android_find_element`      | Find element by text/contentDesc/resourceId (no screenshot)   |
| `android_wait_for_element`  | Wait for element to appear (useful for screen transitions)    |

### iOS (Simulator)

| Tool                    | Description                                                     |
| ----------------------- | --------------------------------------------------------------- |
| `list_ios_simulators`   | List available iOS simulators                                   |
| `ios_screenshot`        | Take a screenshot from an iOS simulator                         |
| `ios_install_app`       | Install an app bundle (.app) on a simulator                     |
| `ios_launch_app`        | Launch an app by bundle ID                                      |
| `ios_open_url`          | Open a URL (deep links or web URLs)                             |
| `ios_terminate_app`     | Terminate a running app                                         |
| `ios_boot_simulator`    | Boot a simulator by UDID                                        |
| `ios_find_element`      | Find element by label/value (requires IDB, no screenshot)       |
| `ios_wait_for_element`  | Wait for element to appear (requires IDB)                       |

### OCR (Cross-Platform)

| Tool             | Description                                                              |
| ---------------- | ------------------------------------------------------------------------ |
| `ocr_screenshot` | Extract all visible text with tap-ready coordinates (works on iOS/Android) |

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

### Token-Optimized Output

The tools include several options to reduce token usage when working with AI assistants:

#### Summary Mode (Recommended First Step)

Get a quick overview before fetching full logs:

```
get_logs with summary=true
```

Returns count by level + last 5 messages:

```
Total: 847 logs

By Level:
  LOG: 612
  WARN: 180
  ERROR: 55

Last 5 messages:
  14:32:45 [LOG] User clicked button...
  14:32:46 [WARN] Slow query detected...
  14:32:47 [ERROR] Network request failed...
```

#### Message Truncation

Long log messages are truncated by default (500 chars). Adjust as needed:

```
# Shorter for overview
get_logs with maxMessageLength=200

# Full messages (use with lower maxLogs)
get_logs with maxLogs=10 verbose=true

# Unlimited
get_logs with maxMessageLength=0
```

#### TONL Format

Use TONL (Token-Optimized Notation Language) for ~30-50% smaller output:

```
get_logs with format="tonl"
```

Output:

```
[Format: TONL - compact token-optimized format. Fields in header, values in rows.]
{logs:[{time:"14:32:45",level:"LOG",msg:"App started"},{time:"14:32:46",level:"WARN",msg:"Slow query"}]}
```

TONL is also available for `search_logs`, `get_network_requests`, and `search_network`.

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

Request body is truncated by default (500 chars). For full body:

```
get_request_details with requestId="123.45" verbose=true
```

### Summary Mode (Recommended First Step)

Get statistics overview before fetching full requests:

```
get_network_requests with summary=true
```

This returns the same output as `get_network_stats` - counts by method, status, and domain.

### TONL Format

Use TONL for ~30-50% smaller output:

```
get_network_requests with format="tonl"
```

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

## Efficient UI Automation (No Screenshots)

For action triggering without layout debugging, use element-based tools instead of screenshots. This is **2-3x faster** and uses fewer tokens.

### Android - Find and Tap by Text

```
# Wait for screen to load
android_wait_for_element with text="Login"

# Find element (returns tap coordinates)
android_find_element with textContains="submit"

# Tap the element (use coordinates from find_element)
android_tap with x=540 y=960
```

Search options:
- `text` - exact text match
- `textContains` - partial text (case-insensitive)
- `contentDesc` - accessibility content description
- `contentDescContains` - partial content description
- `resourceId` - resource ID (e.g., "button" or "com.app:id/button")

### iOS - Find and Tap by Label (requires IDB)

```bash
# Install IDB first
brew install idb-companion
```

```
# Wait for element
ios_wait_for_element with label="Sign In"

# Find element by partial label
ios_find_element with labelContains="welcome"
```

Search options:
- `label` - exact accessibility label
- `labelContains` - partial label (case-insensitive)
- `value` - accessibility value
- `valueContains` - partial value
- `type` - element type (e.g., "Button", "TextField")

### Wait for Screen Transitions

Both platforms support waiting with timeout:

```
android_wait_for_element with text="Dashboard" timeoutMs=15000 pollIntervalMs=500
ios_wait_for_element with label="Home" timeoutMs=10000
```

### Recommended Workflow (Priority Order)

**Always try accessibility tools first, fall back to screenshots only when needed:**

1. **Wait for screen** → Use `wait_for_element` with expected text/label
2. **Find target** → Use `find_element` to get tap coordinates
3. **Tap** → Use `tap` with coordinates from step 2
4. **Fallback** → If element not in accessibility tree, use `screenshot`

```
# Example: Tap "Submit" button after screen loads
android_wait_for_element with text="Submit"     # Step 1: Wait
android_find_element with text="Submit"         # Step 2: Find (returns center coordinates)
android_tap with x=540 y=1200                   # Step 3: Tap (use returned coordinates)
```

**Why this order?**
- `find_element`: ~100-200 tokens, <100ms
- `screenshot`: ~400-500 tokens, 200-500ms

### When to Use Screenshots vs Element Tools

| Use Case | Recommended Tool |
|----------|------------------|
| Trigger button taps | `find_element` + `tap` |
| Wait for screen load | `wait_for_element` |
| Navigate through flow | `wait_for_element` + `tap` |
| Debug layout issues | `screenshot` |
| Verify visual appearance | `screenshot` |
| Find elements without labels | `screenshot` |

## OCR Text Extraction

The `ocr_screenshot` tool extracts all visible text from a screenshot with tap-ready coordinates. This is useful when accessibility labels are missing or when you need to find text that isn't exposed in the accessibility tree.

### Why OCR?

| Approach | Pros | Cons |
|----------|------|------|
| Accessibility tree (`find_element`) | Fast, reliable, low token usage | Only finds elements with accessibility labels |
| Screenshot + Vision | Visual layout understanding | High token usage, slow |
| **OCR** | Works on ANY visible text, returns tap coordinates | Requires text to be visible, may miss small text |

### Usage

```
ocr_screenshot with platform="ios"
```

Returns all visible text with tap-ready coordinates:

```json
{
  "platform": "ios",
  "engine": "easyocr",
  "processingTimeMs": 850,
  "elementCount": 24,
  "elements": [
    { "text": "Settings", "confidence": 98, "tapX": 195, "tapY": 52 },
    { "text": "Login", "confidence": 95, "tapX": 187, "tapY": 420 }
  ]
}
```

Then tap the element:

```
ios_tap with x=187 y=420
```

### OCR Engines

The tool uses two OCR engines with automatic fallback:

| Engine | Description | Requirements |
|--------|-------------|--------------|
| **EasyOCR** (preferred) | Python-based, better accuracy on colored backgrounds | Python 3.10+, ~100MB for models |
| **Tesseract.js** (fallback) | JavaScript-based, no Python needed | None (included in npm package) |

### Installing EasyOCR (Optional)

For better OCR accuracy, especially on colored backgrounds and stylized text:

```bash
# Install Python 3.10+ if not already installed
brew install python@3.11

# Install EasyOCR
pip3 install easyocr
```

First run will download models (~100MB for English). Additional language models are downloaded automatically when configured. If EasyOCR is not available, the tool automatically falls back to Tesseract.js.

### OCR Language Configuration

By default, OCR recognizes English text. To add more languages, set the `EASYOCR_LANGUAGES` environment variable. English is always included as a fallback.

```bash
# Add Spanish and French (English always included)
EASYOCR_LANGUAGES=es,fr
```

Add to your MCP configuration:

```json
{
    "mcpServers": {
        "rn-debugger": {
            "command": "npx",
            "args": ["react-native-ai-debugger"],
            "env": {
                "EASYOCR_LANGUAGES": "es,fr"
            }
        }
    }
}
```

See [EasyOCR supported languages](https://www.jaided.ai/easyocr/) for the full list of language codes.

### Recommended Workflow

1. **Try accessibility first** - Use `find_element` / `wait_for_element` (faster, cheaper)
2. **Fall back to OCR** - When element isn't in accessibility tree
3. **Use screenshot** - For visual debugging or layout verification

```
# Step 1: Try accessibility-based approach
android_find_element with text="Submit"

# Step 2: If not found, use OCR
ocr_screenshot with platform="android"

# Step 3: Tap using coordinates from OCR result
android_tap with x=540 y=1200
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

## Auto-Reconnection

The server automatically handles connection interruptions:

### Auto-Connect on Startup

When the MCP server starts, it automatically scans common Metro ports (8081, 8082, 19000-19002) and connects to any running Metro bundlers. No need to manually call `scan_metro` if Metro is already running.

### Reconnection on Disconnect

When the connection to Metro is lost (e.g., app restart, Metro restart, or network issues):

1. The server automatically attempts to reconnect
2. Uses exponential backoff: immediate, 500ms, 1s, 2s, 4s, 8s (up to 8 attempts)
3. Re-fetches device list to handle new WebSocket URLs
4. Preserves existing log and network buffers

### Connection Gap Warnings

If there was a recent disconnect, `get_logs` and `get_network_requests` will include a warning:

```
[WARNING] Connection was restored 5s ago. Some logs may have been missed during the 3s gap.
```

### Monitor Connection Health

Use `get_connection_status` to see detailed connection information:

```
=== Connection Status ===

--- React Native (Port 8081) ---
  Status: CONNECTED
  Connected since: 2:45:30 PM
  Uptime: 5m 23s
  Recent gaps: 1
    - 2:43:15 PM (2s): Connection closed
```

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

## Telemetry

This package collects anonymous usage telemetry to help improve the product. No personal information is collected.

### What is collected

| Data | Purpose |
|------|---------|
| Tool names | Which MCP tools are used most |
| Success/failure | Error rates for reliability improvements |
| Duration (ms) | Performance monitoring |
| Session start/end | Retention analysis |
| Platform | macOS/Linux/Windows distribution |
| Server version | Adoption of new versions |

**Not collected**: No file paths, code content, network data, or personally identifiable information.

### Opt-out

To disable telemetry, set the environment variable:

```bash
export RN_DEBUGGER_TELEMETRY=false
```

Or inline:

```bash
RN_DEBUGGER_TELEMETRY=false npx react-native-ai-debugger
```

## License

MIT
