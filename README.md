# React Native AI DevTools

An MCP server that gives AI assistants real-time access to a running React Native app. It bridges the gap between static code and live runtime, turning AI assistants from guessing machines into informed development partners.

<p align="center">
  <img src="https://raw.githubusercontent.com/igorzheludkov/react-native-ai-devtools/main/docs/demo/get_logs_demo.gif" alt="React Native AI DevTools demo" width="800" />
</p>

**Positioning:** This is not a debugger. This is not a QA tool. This is a Runtime AI Bridge — the missing layer between AI coding assistants and live mobile applications. Without it, your AI assistant is blind. With it, the AI sees everything happening in your app in real time.

## Feedback & Feature Requests

Have an idea or found something that could be better? Head over to [GitHub Discussions](https://github.com/igorzheludkov/react-native-ai-devtools/discussions) to share feedback, request features, and vote on what gets built next.

## Features

### Runtime Interaction

- **Console Log Capture** - Capture `console.log`, `warn`, `error`, `info`, `debug` with filtering and search. Note: on a cold start (first app launch), logs emitted before the MCP server connects are missed — subsequent reloads capture everything. Install the optional [SDK](https://www.npmjs.com/package/react-native-ai-devtools-sdk) to buffer logs from the very first line of app startup
- **Network Request Tracking** - Monitor HTTP requests/responses with headers, timing, and body content. Like logs, early network requests on cold start may be missed before the connection is established. Install the optional [SDK](https://www.npmjs.com/package/react-native-ai-devtools-sdk) for full capture from app startup including request/response bodies
- **JavaScript Execution** - Run code directly in your app (REPL-style) and inspect results
- **Global State Debugging** - Discover and inspect Apollo Client, Redux stores, Expo Router, and custom globals
- **Bundle Error Detection** - Get Metro bundler errors and compilation issues with file locations

### Device Control

- **iOS Simulator** - Screenshots, app management, URL handling, boot/terminate (via simctl)
- **Android Devices** - Screenshots, app install/launch, package management (via ADB)
- **Unified Tap** - Single `tap` tool with automatic fallback chain: fiber tree → accessibility → OCR → coordinates. Auto-detects platform, accepts pixels from screenshots. Returns post-tap screenshot and verifies visual change by default
- **UI Automation** - Swipe, long press, text input, and key events on both platforms
- **Accessibility Inspection** - Query UI hierarchy to find elements by text, label, or resource ID
- **OCR Text Extraction** - Extract visible text with tap-ready coordinates via Google Cloud Vision (works on any screen content)

### Multi-Device Debugging

- **Connect All Devices** - `scan_metro` automatically discovers and connects to all Bridgeless targets on each Metro port
- **Device Targeting** - Every tool accepts an optional `device` parameter for targeting specific devices by name (case-insensitive substring match)
- **Per-Device Buffers** - Logs and network requests are captured separately per device for clean debugging
- **Cross-Platform Comparison** - Debug iOS and Android side-by-side, comparing logs, network traffic, and component trees

### Under the Hood

- **Auto-Discovery** - Scans Metro on ports 8081, 8082, 19000-19002 automatically
- **Multi-Device Support** - Connects to all Bridgeless targets simultaneously, with per-device log and network buffers
- **Auto-Reconnection** - Exponential backoff (up to 8 attempts) when connection drops
- **Efficient Buffering** - Circular buffers: 500 logs, 200 network requests
- **Platform Support** - Expo SDK 54+ (Bridgeless) and React Native 0.70+ (Hermes)

## Platform Setup

### Android

Android works out of the box — all device control tools use ADB, which ships with Android Studio. Verify it's available:

```bash
adb devices
```

### iOS Simulator — UI Automation Setup

iOS UI automation tools (tap, swipe, text input, accessibility queries) require a UI driver. Install one of the following:

**Option A: AXe CLI (experimental)**

[AXe](https://github.com/cameroncooke/AXe) is a standalone CLI for iOS simulator automation. No daemon required — single binary, simple setup.

```bash
brew install cameroncooke/axe/axe
```

Verify: `axe --version`

Add `env` to your MCP server configuration:

```json
{
  "mcpServers": {
    "rn-ai-devtools": {
      "type": "stdio",
      "command": "npx",
      "args": ["react-native-ai-devtools"],
      "env": { "IOS_DRIVER": "axe" }
    }
  }
}
```

> **Note:** AXe text input only supports US keyboard layout characters.

**Option B: IDB**

[IDB (iOS Development Bridge)](https://github.com/facebook/idb) is a tool built by Meta for automating iOS Simulators. Requires a background daemon.

```bash
brew install idb-companion
```

Verify: `idb_companion --list 1`

IDB is the default driver — no `IOS_DRIVER` env var needed.

**What works without a UI driver:**

| Capability                        | Without IDB/AXe | With IDB/AXe |
| --------------------------------- | --------------- | ------------ |
| Screenshots                       | Yes (simctl)    | Yes          |
| App install/launch/terminate      | Yes (simctl)    | Yes          |
| URL opening                       | Yes (simctl)    | Yes          |
| Boot simulator                    | Yes (simctl)    | Yes          |
| **Tap / swipe / gestures**        | **No**          | Yes          |
| **Text input**                    | **No**          | Yes          |
| **Accessibility tree queries**    | **No**          | Yes          |
| **Element finding / waiting**     | **No**          | Yes          |
| **Hardware buttons (Home, Lock)** | **No**          | Yes          |

> **Troubleshooting**: If you see errors like `"IDB is not installed"` or `"AXe is not installed"` in tap results, install the appropriate driver with the commands above and retry.

## Requirements

- Node.js 18+
- React Native app running with Metro bundler
- **iOS UI automation**: [Facebook IDB](https://fbidb.io/) (`brew install idb-companion`) or [AXe CLI](https://github.com/cameroncooke/AXe) (`brew install cameroncooke/axe/axe`) — required for tap, swipe, text input, accessibility on iOS Simulator
- **Optional for offline OCR fallback**: Python 3.6+ (only needed when cloud OCR is unavailable, see [OCR Setup](#ocr-text-extraction))

## Claude Code Setup

No installation required - Claude Code uses `npx` to run the latest version automatically.

### Global (all projects)

```bash
claude mcp add rn-ai-devtools --scope user -- npx react-native-ai-devtools
```

### Project-specific

```bash
claude mcp add rn-ai-devtools --scope project -- npx react-native-ai-devtools
```

### Manual Configuration

Add to `~/.claude.json` (user scope) or `.mcp.json` (project scope):

```json
{
  "mcpServers": {
    "rn-ai-devtools": {
      "type": "stdio",
      "command": "npx",
      "args": ["react-native-ai-devtools"]
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
    "rn-ai-devtools": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "react-native-ai-devtools"]
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
    "rn-ai-devtools": {
      "command": "npx",
      "args": ["-y", "react-native-ai-devtools"]
    }
  }
}
```

## Claude Code Skills

Pre-built skills for common debugging workflows — session setup, log inspection, network debugging, and more. See the [skills guide](docs/skills.md) for the full list and installation instructions.

## Available Tools

See the [full tool reference](docs/tools.md) for all tools with descriptions. Key tools:

| Tool                                    | Description                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `scan_metro`                            | **Start here** — scan for Metro servers and auto-connect                                 |
| `get_logs` / `search_logs`              | Capture and search console logs with filtering and summaries                             |
| `get_network_requests`                  | Monitor HTTP requests with method/status filtering                                       |
| `get_screen_layout`                     | Screen map of visible components with positions, sizes, and text content                 |
| `tap`                                   | **Unified tap** — auto-detects platform, tries fiber → accessibility → OCR → coordinates |
| `get_pressable_elements`                | Find all visible pressable/input elements with tap-ready coordinates and component names  |
| `execute_in_app`                        | Run JS expressions in the app runtime (REPL-style)                                       |
| `ios_screenshot` / `android_screenshot` | Take device screenshots                                                                  |

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

## Detailed Guides

| Guide                                                      | Description                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [Console Logging](docs/logging.md)                         | `get_logs` parameters, filtering, summary mode, TONL format, token optimization |
| [Network Tracking](docs/network.md)                        | SDK setup for full capture, filtering, request details, statistics              |
| [App Inspection](docs/app-inspection.md)                   | Debug globals (Apollo, Redux, Expo Router), `execute_in_app`, limitations       |
| [Layout & Component Inspection](docs/layout-inspection.md) | `get_screen_layout`, component tree, `inspect_at_point`, `find_components`      |
| [Device Interaction](docs/device-interaction.md)           | Unified `tap`, platform-specific gestures, text input, key events               |
| [OCR Text Extraction](docs/ocr.md)                         | Cloud Vision OCR, offline fallback, language config, workflows                  |
| [Claude Code Skills](docs/skills.md)                       | Pre-built skills for session setup, debugging, and automation                   |
| [Full Tool Reference](docs/tools.md)                       | Complete list of all 40+ tools with descriptions                                |

## Supported React Native Versions

| Version        | Architecture          | Engine       | Status                                           |
| -------------- | --------------------- | ------------ | ------------------------------------------------ |
| Expo SDK 54+   | Bridgeless (New Arch) | Hermes       | ✓ Fully supported                                |
| RN 0.76+       | Bridgeless (New Arch) | Hermes       | ✓ Fully supported                                |
| RN 0.73 - 0.75 | Bridge (Old Arch)     | Hermes       | ✓ Fully supported (best network capture via CDP) |
| RN 0.70 - 0.72 | Bridge (Old Arch)     | Hermes / JSC | ✓ Supported                                      |
| RN < 0.70      | Bridge                | JSC          | Not tested                                       |

## How It Works

1. Fetches device list from Metro's `/json` endpoint
2. Connects to the main JS runtime via CDP (Chrome DevTools Protocol) WebSocket
3. Enables `Runtime.enable` to receive `Runtime.consoleAPICalled` events
4. Network capture via two paths:
   - **With SDK**: Reads from the SDK's in-app buffer via `Runtime.evaluate` — captures all requests from startup with full headers and bodies, including cold-start events that CDP would miss
   - **Without SDK**: Enables CDP `Network.enable` (on supported targets) or injects a JS fetch interceptor as fallback. On cold start, events emitted before the CDP connection is established are lost; subsequent reloads capture everything
5. Stores logs and network requests in circular buffers for retrieval

## Connection Management

### Explicit Connection

The server does **not** auto-connect on startup. Call `scan_metro` to discover and connect to Metro servers. This prevents multiple MCP server instances (from parallel agent sessions) from competing for the single CDP WebSocket slot, which would cause connection thrashing and dropped tools.

### Graceful Shutdown

When the MCP server process is terminated (`SIGINT`/`SIGTERM`), it closes all CDP WebSocket connections and cancels reconnection timers, freeing the CDP slot immediately for other sessions.

### Reconnection on Disconnect

When the connection to Metro is lost (e.g., app restart, Metro restart, or network issues):

1. The server automatically attempts to reconnect
2. Uses exponential backoff: 500ms, 1s, 2s, 4s, 8s (up to 8 attempts)
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

- Make sure the app is running on a simulator/device
- Check that Metro bundler is running (`npm start`)

### Wrong device connected

The server prioritizes devices in this order:

1. React Native Bridgeless (SDK 54+)
2. Hermes React Native
3. Any React Native (excluding Reanimated/Experimental)

### Logs not appearing

- Ensure the app is actively running (not just Metro)
- Try `clear_logs` then trigger some actions in the app
- Check `get_apps` to verify connection status
- **On cold start (first launch):** The CDP connection is established after the app's early initialization code has already run, so startup logs and network requests are missed. Once connected, use `reload_app` — the subsequent reload captures everything from the beginning because the connection is already in place. To capture startup events on every launch, install the optional [SDK](https://www.npmjs.com/package/react-native-ai-devtools-sdk)

## Telemetry & Data Collection

This package collects anonymous usage telemetry to help improve the product. No personal information is collected.

### What is collected

| Data              | Purpose                                  |
| ----------------- | ---------------------------------------- |
| Tool names        | Which MCP tools are used most            |
| Success/failure   | Error rates for reliability improvements |
| Duration (ms)     | Performance monitoring                   |
| Session start/end | Retention analysis                       |
| Platform          | macOS/Linux/Windows distribution         |
| Server version    | Adoption of new versions                 |

**Not collected**: No file paths, code content, network data, or personally identifiable information.

### Auto-registration

On first tool use, the package automatically registers your installation with our backend. No account or login is required — the Tool works fully out of the box.

**Why we do this:** The product roadmap includes features that build on installation identity — project memory (your AI assistant gets smarter with every session by remembering navigation maps, element signatures, and debug patterns), cloud sync across machines, team collaboration with shared debugging context, and a Pro dashboard for managing installations and subscriptions. Auto-registration lays the groundwork so these features work seamlessly when they ship, without requiring a disruptive setup step later.

**What is sent:**

- A random installation ID (UUID)
- A device fingerprint (one-way SHA-256 hash — cannot be reversed to recover its components)
- Platform, hostname, OS version, and server version

**What is NOT sent:** No source code, file paths, console logs, network data, component names, or any content from your app. The fingerprint exists solely to prevent installation hijacking — it ties your installation to your physical machine so no one else can claim it.

Registration is fire-and-forget — it never blocks your work, fails silently if the network is unavailable, and can be disabled entirely (see Opt-out below). See [PRIVACY.md](./PRIVACY.md) for full details on data handling, storage, and your rights.

### Opt-out

To disable telemetry and auto-registration, add `RN_DEBUGGER_TELEMETRY` to the `env` field in your MCP server configuration:

```json
{
  "mcpServers": {
    "rn-ai-devtools": {
      "type": "stdio",
      "command": "npx",
      "args": ["react-native-ai-devtools"],
      "env": { "RN_DEBUGGER_TELEMETRY": "false" }
    }
  }
}
```

All debugging tools work normally with telemetry disabled. For the complete privacy policy, see [PRIVACY.md](./PRIVACY.md).

## License

MIT
