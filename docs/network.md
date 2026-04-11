# Network Request Tracking

Monitor HTTP requests and responses from your running React Native app, with filtering, search, and detailed inspection.

## SDK for Full Network Capture (Recommended)

For complete network capture including **startup requests**, **full headers**, and **response bodies**, install the companion SDK in your React Native app:

```bash
npm install react-native-ai-devtools-sdk
```

Add to your app's entry file (e.g., `index.js` or `app/_layout.tsx`) — **must be the first import**:

```js
import { init } from 'react-native-ai-devtools-sdk';
if (__DEV__) {
  init();
}
```

**What the SDK captures that basic mode doesn't:**

| | Without SDK | With SDK |
|---|---|---|
| Startup requests (auth, config) | Missed | Captured |
| Request/response headers | Partial | Full |
| Request body (GraphQL queries) | No | Full |
| Response body | No | Full |
| Works on Bridgeless (Expo SDK 52+) | Partial | Full |
| Setup required | None | One import |

The SDK patches `fetch` at import time and stores data in an in-app buffer. The MCP tools automatically detect the SDK and read from it — no configuration needed.

**Without the SDK**, network tracking still works via CDP (Chrome DevTools Protocol) on supported targets, but may miss early requests and won't include response bodies.

## Quick Start

```
# Connect first
scan_metro

# Overview
get_network_requests with summary=true

# Recent requests
get_network_requests with maxRequests=20
```

## View Recent Requests

```
get_network_requests with maxRequests=20
```

## Filter by Method

```
get_network_requests with method="POST"
```

## Filter by Status Code

Useful for debugging auth issues:

```
get_network_requests with status=401
```

## Search by URL

```
search_network with urlPattern="api/auth"
```

## Get Full Request Details

After finding a request ID from `get_network_requests`:

```
get_request_details with requestId="sdk-abc-1"
```

Shows full headers, request body, response headers, response body, and timing.

Body is truncated by default (500 chars). For full body:

```
get_request_details with requestId="sdk-abc-1" verbose=true
```

## Summary Mode (Recommended First Step)

Get statistics overview before fetching full requests:

```
get_network_requests with summary=true
```

This returns the same output as `get_network_stats` - counts by method, status, and domain.

## TONL Format

Use TONL for ~30-50% smaller output:

```
get_network_requests with format="tonl"
```

## View Statistics

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
