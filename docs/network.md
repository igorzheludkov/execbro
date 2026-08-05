# Network Request Tracking

Monitor HTTP requests and responses from your running React Native app, with filtering, search, and detailed inspection.

## SDK for Full Network Capture (Recommended)

For complete network capture including **startup requests**, **full headers**, and **response bodies**, install the companion SDK in your React Native app:

```bash
npm install execbro-sdk
```

Add to your app's entry file (e.g., `index.js` or `app/_layout.tsx`) — **must be the first import**:

```js
import { init } from 'execbro-sdk';
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

This returns counts by method, status, and domain.

## View Statistics

```
get_network_requests with summary=true
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

## Changing responses

Inspection tells you what the app asked for. These three tools change what it
gets back, so an error branch is reached through the app's real code — the
request builder, the error handler, the retry, the toast — instead of being
faked by writing the post-failure state directly.

### `network_mock`

```
network_mock({action:"add", url:"/orders", status:500})
network_mock({action:"add", url:"/me", mode:"tamper", remove:["data.email"]})
network_mock({action:"list"})
network_mock({action:"clear"})
```

- **`replace`** returns a canned response and the app's request never reaches
  the wire. Set `status`, `body`, `headers`, or `networkError` to fail it
  outright.
- **`tamper`** fetches the real response on a separate request and mutates it
  before the app sees it. `set` and `remove` take dotted paths
  (`{"data.user.email": null}`, `["data.email"]`); `bodyReplace` swaps the whole
  body; `status` overrides the real status. A response that is not JSON passes
  through untouched with a warning rather than being mangled.
- **`url`** is a substring by default. Wrap it in slashes for a regex
  (`"/\\/orders\\/\\d+$/"`). Patterns are validated server-side and a
  catastrophically-backtracking one is rejected, because it would run inside
  the app's JS thread and freeze it.
- **`times: 1`** fires once and then passes through — how you test retry logic.
- **`delayMs`** delays delivery.

Matching is **first-rule-wins**, so add specific rules before broad ones.
`network_mock({action:"list"})` shows a hit count per rule; a rule with `hits=0`
that you expected to fire is almost always shadowed by a broader one above it.

### `network_condition`

```
network_condition({mode:"offline"})
network_condition({mode:"slow", latencyMs:3000})
network_condition({mode:"normal"})
```

`offline` fails every JS-originated request; `slow` delays them; `normal`
clears. It owns exactly one rule per device and replaces it on each call, so it
never disturbs rules you added with `network_mock`.

`offline` also tries to patch NetInfo, because many apps gate their offline UI
on `useNetInfo()` rather than on a failed request. The script verifies itself
and reports `patched`, `reads-patched-only`, `not-installed`, or `unknown` — it
never claims to have patched something it did not. Request failure works
regardless of the outcome.

### `network_replay`

```
network_replay({requestId:"js-x1-7"})
network_replay({requestId:"js-x1-7", body:"{\"qty\":99}"})
```

Re-issues a request the app already made, so you can vary one field at a time
without driving the UI back to the screen that made it. Ids come from
`get_network_requests`. Overrides replace rather than merge, headers included,
so a header on the original can be dropped.

It goes through the app's own network stack — the same TLS trust, proxy config
and credentials as the original — which also means an active mock rule
intercepts the replay. That is correct, and the response says so when it
happens.

### Mocks are never invisible

Altered traffic that looks real is the one failure this feature must not cause.

- Mocked rows are tagged `[MOCK m1]`; `get_request_details` names the rule and
  any tamper warning.
- Every network read carries a banner while any rule is active, listing the
  count per device. This is what covers the case where the SDK is installed:
  the SDK captures rows under its own ids, so individual rows are not tagged,
  but the banner and the hit counts still are.

### Limits

- **JS-originated HTTP only.** Traffic from native modules — native SDKs,
  `<Image>` loading, anything that never touches `XMLHttpRequest` — is not
  intercepted.
- **Rules are per-device.** A rule added while an iPhone and an emulator are
  both connected fires only on the one it was added to.
- **Rules survive `reload_app`.** They live server-side and are re-pushed to
  every new JS context, which is the point — a mock that vanished on reload
  would be useless for startup-path bugs. Clear them when you are done.
- A JS context created before an execbro upgrade keeps the interceptor it
  started with. If mocking silently does nothing after an upgrade, `reload_app`.
