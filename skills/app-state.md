# App State Skill

Inspect and interact with the running React Native app's state: Redux store, global variables, and execute JavaScript expressions.

## When to Trigger

Use this skill when the task involves:
- Checking Redux state, dispatching actions, or debugging state management
- Inspecting global variables or debug objects in the running app
- Executing JavaScript code in the app context for debugging
- Reading or modifying app state at runtime
- Verifying that data is correctly stored in Redux slices
- Testing state changes without rebuilding the app

## Instructions

### 1. Ensure Connection

First, verify the debugger is connected:
- Use `mcp__rn-debugger-local__ensure_connection` to check/establish connection
- If not connected, use `mcp__rn-debugger-local__scan_metro` to find and connect to Metro

### 2. Discover Available Debug Objects

List what's exposed globally in the app:
- Use `mcp__rn-debugger-local__list_debug_globals` to see all available debugging objects
- This reveals Redux store, navigation refs, action creators, and other globals

### 3. Inspect Specific Objects

Before calling methods on any global object:
- Use `mcp__rn-debugger-local__inspect_global` with `objectName` to see its properties and methods
- This prevents errors from calling non-existent methods

### 4. Read and Modify State

**Read Redux state:**
```javascript
// Full state
globalThis.__REDUX_STORE__.getState()

// Specific slice
globalThis.__REDUX_STORE__.getState().personalData
```
- Use `mcp__rn-debugger-local__execute_in_app` with the expression above

**Dispatch Redux actions:**
```javascript
globalThis.__dispatch__(globalThis.__REDUX_ACTIONS__.locale.setLocale('en'))
```
- Use `mcp__rn-debugger-local__execute_in_app` to dispatch

**Navigate:**
```javascript
globalThis.__navigate__('PaywallScreen')
globalThis.__getCurrentRoute__()
```

### 5. Execute Custom JavaScript

For ad-hoc debugging:
- Use `mcp__rn-debugger-local__execute_in_app` with any valid Hermes expression
- Remember limitations: no `require()`, no `async/await`, no emoji in strings
- Use `globalThis` instead of `global` for Hermes compatibility
- Set `verbose=true` for full output when inspecting large objects
- Set higher `maxResultLength` when default 2000 chars isn't enough

### 6. Present Findings

- Show the relevant state values clearly
- Compare expected vs actual state
- Suggest actions to fix state issues
- Show the exact dispatch calls needed for corrections

## Arguments

- `$ARGUMENTS` - Optional: specific state path to inspect (e.g., "personalData", "locale", "settings"), or a JS expression to execute

## Usage Examples

- `/app-state` - List all available debug globals and show high-level state overview
- `/app-state personalData` - Inspect the personalData Redux slice
- `/app-state "globalThis.__REDUX_STORE__.getState().locale"` - Execute a specific JS expression
- `/app-state navigation` - Show current route and navigation state

## MCP Tools Used

- `mcp__rn-debugger-local__ensure_connection`
- `mcp__rn-debugger-local__scan_metro`
- `mcp__rn-debugger-local__list_debug_globals`
- `mcp__rn-debugger-local__inspect_global`
- `mcp__rn-debugger-local__execute_in_app`

## Notes

- Requires the rn-debugger-local MCP server to be running and connected to the app
- Hermes engine limitations: no `require()`, no `async/await`, no emoji/non-ASCII in string literals
- Use `inspect_global` before calling methods on unfamiliar objects to avoid errors
- For large state objects, use `verbose=true` with caution - Redux stores can return 10KB+
