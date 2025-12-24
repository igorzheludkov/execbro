# React Native AI Debugger

An MCP (Model Context Protocol) server for AI-powered React Native debugging. Enables AI assistants like Claude to capture logs, execute code, inspect state, and control navigation in your React Native app.

## Features

- Captures `console.log`, `console.warn`, `console.error` from React Native apps
- Supports both **Expo SDK 54+** (React Native Bridgeless) and **RN 0.70+** (Hermes)
- Auto-discovers running Metro servers on common ports
- Filters logs by level (log, warn, error, info, debug)
- Circular buffer stores last 1000 log entries
- **Execute JavaScript** directly in the running app (REPL-style)
- **Inspect global objects** like Apollo Client, Redux store, Expo Router
- **Discover debug globals** available in the app

## Requirements

- Node.js 18+
- React Native app running with Metro bundler

## Installation

> **Note:** This package is not published to npm. Only local build installation is available.

### Option 1: Clone and Build

```bash
git clone git@github.com:igorzheludkov/react-native-ai-debugger.git ~/react-native-ai-debugger
cd ~/react-native-ai-debugger
npm install
npm run build
```

### Option 2: Manual Setup

```bash
mkdir ~/react-native-ai-debugger
cd ~/react-native-ai-debugger
npm init -y
npm install @modelcontextprotocol/sdk zod@3 ws
npm install -D @types/node @types/ws typescript
```

Copy the source files and build:
```bash
npm run build
```

## Claude Code Setup

### Global (all projects)

```bash
claude mcp add rn-debugger node ~/react-native-ai-debugger/build/index.js --scope user
```

### Project-specific

```bash
claude mcp add rn-debugger node ~/react-native-ai-debugger/build/index.js --scope project
```

### Manual Configuration

Add to `~/.claude.json` (user scope) or `.mcp.json` (project scope):

```json
{
  "mcpServers": {
    "rn-debugger": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/react-native-ai-debugger/build/index.js"]
    }
  }
}
```

Restart Claude Code after adding the configuration.

## Available Tools

### Connection & Logs

| Tool | Description |
|------|-------------|
| `scan_metro` | Scan for running Metro servers and auto-connect |
| `connect_metro` | Connect to a specific Metro port |
| `get_apps` | List connected React Native apps |
| `get_logs` | Retrieve console logs (with optional filtering and start position) |
| `search_logs` | Search logs for specific text (case-insensitive) |
| `clear_logs` | Clear the log buffer |

### App Inspection & Execution

| Tool | Description |
|------|-------------|
| `execute_in_app` | Execute JavaScript code in the connected app and return the result |
| `list_debug_globals` | Discover available debug objects (Apollo, Redux, Expo Router, etc.) |
| `inspect_global` | Inspect a global object to see its properties and callable methods |

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

## Supported React Native Versions

| Version | Runtime | Status |
|---------|---------|--------|
| Expo SDK 54+ | React Native Bridgeless | ✓ |
| RN 0.70 - 0.76 | Hermes React Native | ✓ |
| RN < 0.70 | JSC | Not tested |

## How It Works

1. Fetches device list from Metro's `/json` endpoint
2. Connects to the main JS runtime via CDP (Chrome DevTools Protocol) WebSocket
3. Enables `Runtime.enable` to receive `Runtime.consoleAPICalled` events
4. Stores logs in a circular buffer for retrieval

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

## License

MIT
