# Debug Logs Skill

Inspect console logs from the running React Native app to diagnose issues, find errors, and trace behavior.

## When to Trigger

Use this skill when the task involves:
- Checking console output, logs, warnings, or errors
- Debugging runtime behavior or unexpected app state
- Finding specific log messages or tracing execution flow
- Investigating crashes or error messages
- Checking what the app is printing during a specific action

## Instructions

### 1. Ensure Connection

First, verify the debugger is connected to the running app:
- Use `mcp__rn-debugger-local__ensure_connection` to check/establish connection
- If not connected, use `mcp__rn-debugger-local__scan_metro` to find and connect to Metro

### 2. Get Log Overview

Start with a summary to understand the log landscape:
- Use `mcp__rn-debugger-local__get_logs` with `summary=true` to get counts by level and last 5 messages
- This helps decide what to focus on (errors? warnings? specific messages?)

### 3. Retrieve Relevant Logs

Based on the task, fetch targeted logs:

**For errors/crashes:**
- Use `mcp__rn-debugger-local__get_logs` with `level="error"` to get only errors
- Use `verbose=true` with low `maxLogs` (e.g., 10) for full error details

**For specific messages:**
- Use `mcp__rn-debugger-local__search_logs` with `text` parameter to find specific log output
- Use `verbose=true` when you need to see complete data structures

**For recent activity:**
- Use `mcp__rn-debugger-local__get_logs` with appropriate `maxLogs` count
- Use `startFromText` to begin from a specific point in the log stream

### 4. Clear and Re-capture (if needed)

When you need fresh logs after a specific action:
- Use `mcp__rn-debugger-local__clear_logs` to reset the log buffer
- Ask the user to perform the action
- Then capture new logs with `get_logs`

### 5. Present Findings

- Highlight errors and warnings prominently
- Group related log entries together
- Suggest fixes or next debugging steps based on what you find

## Arguments

- `$ARGUMENTS` - Optional: specific text to search for, or log level to filter (e.g., "error", "warn", "fetch response", "redux")

## Usage Examples

- `/debug-logs` - Get a summary overview of all logs
- `/debug-logs error` - Show only error-level logs
- `/debug-logs "API response"` - Search for specific log text
- `/debug-logs warn` - Show only warnings

## MCP Tools Used

- `mcp__rn-debugger-local__ensure_connection`
- `mcp__rn-debugger-local__scan_metro`
- `mcp__rn-debugger-local__get_logs`
- `mcp__rn-debugger-local__search_logs`
- `mcp__rn-debugger-local__clear_logs`

## Notes

- Requires the rn-debugger-local MCP server to be running and connected to the app
- Use `summary=true` first to avoid token overload from large log volumes
- For large objects in logs, use `verbose=true` with low `maxLogs` to see full content
