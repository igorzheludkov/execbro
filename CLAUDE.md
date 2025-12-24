# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

An MCP (Model Context Protocol) server for AI-powered React Native debugging. It connects to Metro bundler via CDP (Chrome DevTools Protocol) WebSocket, captures console logs, and enables JavaScript execution in running React Native apps.

## Common Commands

```bash
npm run build    # Compile TypeScript and make build/index.js executable
npm start        # Run the compiled server
```

To lint a specific file:
```bash
npx tsc --noEmit src/index.ts
```

## Architecture

Single-file MCP server (`src/index.ts`) that:

1. **Metro Discovery**: Scans common ports (8081, 8082, 19000-19002) for running Metro bundlers
2. **Device Selection**: Fetches `/json` endpoint from Metro, prioritizes devices in order:
   - React Native Bridgeless (Expo SDK 54+)
   - Hermes React Native
   - Any React Native (excluding Reanimated/Experimental)
3. **CDP Connection**: Connects via WebSocket to device's debugger URL
4. **Log Capture**: Enables `Runtime.enable` and `Log.enable` CDP domains to receive console events
5. **Code Execution**: Uses `Runtime.evaluate` CDP method for REPL-style JavaScript execution

### Key Components

- `LogBuffer`: Circular buffer (1000 entries) storing captured logs with level filtering and text search
- `connectedApps`: Map tracking active WebSocket connections to devices
- `pendingExecutions`: Map for tracking async `Runtime.evaluate` responses with timeout handling
- MCP tools registered via `server.registerTool()` from `@modelcontextprotocol/sdk`

### MCP Tools Exposed

- `scan_metro` / `connect_metro`: Discover and connect to Metro servers
- `get_apps`: List connected devices
- `get_logs` / `search_logs` / `clear_logs`: Log management
- `execute_in_app`: Run JavaScript in the connected app
- `list_debug_globals` / `inspect_global`: Discover and inspect global debugging objects
