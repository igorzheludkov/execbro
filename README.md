# Metro Logs MCP

An MCP (Model Context Protocol) server that captures React Native console logs from Metro bundler, enabling AI assistants like Claude to access app logs without manual copy/paste.

## Features

- Captures `console.log`, `console.warn`, `console.error` from React Native apps
- Supports both **Expo SDK 54+** (React Native Bridgeless) and **RN 0.70+** (Hermes)
- Auto-discovers running Metro servers on common ports
- Filters logs by level (log, warn, error, info, debug)
- Circular buffer stores last 1000 log entries

## Requirements

- Node.js 18+
- React Native app running with Metro bundler

## Installation

> **Note:** This package is not published to npm. Only local build installation is available.

### Option 1: Clone and Build

```bash
git clone <repo-url> ~/metro-logs-mcp
cd ~/metro-logs-mcp
npm install
npm run build
```

### Option 2: Manual Setup

```bash
mkdir ~/metro-logs-mcp
cd ~/metro-logs-mcp
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
claude mcp add metro-logs node ~/metro-logs-mcp/build/index.js --scope user
```

### Project-specific

```bash
claude mcp add metro-logs node ~/metro-logs-mcp/build/index.js --scope project
```

### Manual Configuration

Add to `~/.claude.json` (user scope) or `.mcp.json` (project scope):

```json
{
  "mcpServers": {
    "metro-logs": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/metro-logs-mcp/build/index.js"]
    }
  }
}
```

Restart Claude Code after adding the configuration.

## Available Tools

| Tool | Description |
|------|-------------|
| `scan_metro` | Scan for running Metro servers and auto-connect |
| `connect_metro` | Connect to a specific Metro port |
| `get_apps` | List connected React Native apps |
| `get_logs` | Retrieve console logs (with optional filtering) |
| `clear_logs` | Clear the log buffer |

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
