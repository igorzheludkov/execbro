# Network Inspect Skill

Inspect network requests from the running React Native app to debug API calls, authentication issues, failed requests, and data flow.

## When to Trigger

Use this skill when the task involves:
- Debugging API calls, failed requests, or unexpected responses
- Checking request/response headers, bodies, or status codes
- Investigating slow network performance or timeouts
- Verifying that the correct API endpoints are being called
- Debugging authentication or authorization issues (401/403 errors)
- Checking what data is being sent to or received from the server

## Instructions

### 1. Ensure Connection

First, verify the debugger is connected:
- Use `mcp__rn-debugger-local__ensure_connection` to check/establish connection
- If not connected, use `mcp__rn-debugger-local__scan_metro` to find and connect to Metro

### 2. Get Network Overview

Start with statistics to understand the request landscape:
- Use `mcp__rn-debugger-local__get_network_requests` with `summary=true` to get counts by method, status, and domain
- Alternatively, use `mcp__rn-debugger-local__get_network_stats` for a quick stats overview

### 3. Filter and Find Requests

Based on the task, narrow down to relevant requests:

**By URL pattern:**
- Use `mcp__rn-debugger-local__search_network` with `urlPattern` to find requests to specific endpoints
- Use `mcp__rn-debugger-local__get_network_requests` with `urlPattern` filter

**By HTTP method:**
- Use `mcp__rn-debugger-local__get_network_requests` with `method` filter (GET, POST, PUT, DELETE)

**By status code:**
- Use `mcp__rn-debugger-local__get_network_requests` with `status` filter (e.g., 401, 500)

### 4. Inspect Request Details

For specific requests that need deeper investigation:
- Use `mcp__rn-debugger-local__get_request_details` with the `requestId` from the list
- Use `verbose=true` to see full JSON payloads
- Increase `maxBodyLength` for large request/response bodies

### 5. Clear and Re-capture (if needed)

When you need to capture fresh network activity:
- Use `mcp__rn-debugger-local__clear_network` to reset the request buffer
- Ask the user to perform the action that triggers the API call
- Then capture new requests

### 6. Present Findings

- Show request URL, method, status code, and timing
- Highlight failed requests (4xx, 5xx status codes)
- Show relevant request/response bodies
- Suggest fixes based on error patterns

## Arguments

- `$ARGUMENTS` - Optional: URL pattern to search, HTTP method, or status code (e.g., "users", "POST", "500", "auth")

## Usage Examples

- `/network-inspect` - Get an overview of all network activity
- `/network-inspect auth` - Find requests related to authentication
- `/network-inspect 500` - Find server errors
- `/network-inspect "transits/vedic"` - Search for specific API endpoint calls

## MCP Tools Used

- `mcp__rn-debugger-local__ensure_connection`
- `mcp__rn-debugger-local__scan_metro`
- `mcp__rn-debugger-local__get_network_requests`
- `mcp__rn-debugger-local__get_network_stats`
- `mcp__rn-debugger-local__search_network`
- `mcp__rn-debugger-local__get_request_details`
- `mcp__rn-debugger-local__clear_network`

## Notes

- Requires the rn-debugger-local MCP server to be running and connected to the app
- Network interception captures XHR/fetch requests from the JS layer
- Use `summary=true` first to get an overview before diving into individual requests
- For large response bodies (images, base64), use targeted `maxBodyLength` to avoid token overload
