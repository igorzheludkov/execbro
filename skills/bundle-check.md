# Bundle Check Skill

Check Metro bundler status, compilation errors, and manage app reloading for the running React Native app.

## When to Trigger

Use this skill when the task involves:
- Checking if Metro bundler is running and healthy
- Investigating build or compilation errors
- Fixing import resolution, syntax errors, or transform errors
- The app shows a red screen or error overlay
- Reloading the app after code changes aren't reflected
- Checking why the app isn't loading or updating

## Instructions

### 1. Check Metro Status

Get the current state of the Metro bundler:
- Use `mcp__rn-debugger-local__get_bundle_status` to check if Metro is running and its build state

### 2. Check for Bundle Errors

Look for compilation/bundling errors:
- Use `mcp__rn-debugger-local__get_bundle_errors` to get captured errors
- These include: import resolution failures, syntax errors, transform errors
- If no errors are captured via CDP but Metro is running without connected apps, provide `platform` parameter to enable screenshot+OCR fallback to read the error from the device screen

### 3. Fix Errors

Based on the errors found:
- Fix import paths, syntax issues, or missing modules in the code
- Use `mcp__rn-debugger-local__clear_bundle_errors` to clear the error buffer after fixing

### 4. Reload the App

After fixing errors or when changes aren't reflected:
- Use `mcp__rn-debugger-local__reload_app` to trigger a full JavaScript bundle reload
- This is equivalent to pressing 'r' in Metro terminal
- Note: React Native has Fast Refresh by default - only reload when:
  - Changes aren't appearing after a few seconds
  - App is in a broken/error state
  - Need to reset full app state (navigation stack, context, etc.)

### 5. Verify Connection

If the app isn't responding:
- Use `mcp__rn-debugger-local__ensure_connection` with `healthCheck=true` to verify connection
- Use `forceRefresh=true` if connection seems stale
- Use `mcp__rn-debugger-local__scan_metro` if no connection exists

### 6. Present Findings

- Show the exact error message and file/line where it occurs
- Provide the fix for the error
- Confirm the app is running correctly after the fix

## Arguments

- `$ARGUMENTS` - Optional: "status" for quick status check, "errors" for error list, "reload" to reload the app

## Usage Examples

- `/bundle-check` - Full status check: Metro health + any errors
- `/bundle-check errors` - Show only compilation errors
- `/bundle-check reload` - Reload the JavaScript bundle
- `/bundle-check status` - Quick Metro bundler status

## MCP Tools Used

- `mcp__rn-debugger-local__get_bundle_status`
- `mcp__rn-debugger-local__get_bundle_errors`
- `mcp__rn-debugger-local__clear_bundle_errors`
- `mcp__rn-debugger-local__reload_app`
- `mcp__rn-debugger-local__ensure_connection`
- `mcp__rn-debugger-local__scan_metro`

## Notes

- Requires the rn-debugger-local MCP server to be running
- Bundle errors are different from runtime errors - they prevent the JS bundle from loading
- Fast Refresh handles most code changes automatically - only use reload for specific scenarios
- The screenshot+OCR fallback for errors requires specifying the `platform` parameter ("ios" or "android")
