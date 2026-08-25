# Network Inspect Skill

Inspect network requests from the running React Native app — and change what the
app gets back, so error paths are reached through its real code rather than
faked.

## When to Trigger

Use this skill when the task involves:
- Debugging API calls, failed requests, or unexpected responses
- Checking request/response headers, bodies, or status codes
- Investigating slow network performance or timeouts
- Verifying that the correct API endpoints are being called
- Debugging authentication or authorization issues (401/403 errors)
- Checking what data is being sent to or received from the server
- Asking what the app *would* do — on a 500, with a null field, with no network
- Retrying a captured request with one field changed

## Instructions

### 1. Ensure Connection

First, verify the debugger is connected:
- Use `mcp__execbro__ensure_connection` to check/establish connection
- If not connected, use `mcp__execbro__scan_metro` to find and connect to Metro

### 2. Get Network Overview

Start with statistics to understand the request landscape:
- Use `mcp__execbro__get_network_requests` with `summary=true` to get counts by method, status, and domain
- Alternatively, use `mcp__execbro__get_network_requests(summary=true)` for a quick stats overview

### 3. Filter and Find Requests

Based on the task, narrow down to relevant requests:

**By URL pattern:**
- Use `mcp__execbro__search_network` with `urlPattern` to find requests to specific endpoints
- Use `mcp__execbro__get_network_requests` with `urlPattern` filter

**By HTTP method:**
- Use `mcp__execbro__get_network_requests` with `method` filter (GET, POST, PUT, DELETE)

**By status code:**
- Use `mcp__execbro__get_network_requests` with `status` filter (e.g., 401, 500)

### 4. Inspect Request Details

For specific requests that need deeper investigation:
- Use `mcp__execbro__get_request_details` with the `requestId` from the list
- The first call returns the body's shape (key paths, array sizes) — then narrow with `query="data.orders[0].status"`, which returns that field in full
- A `query` renders only the queried body; pass `include:"request"` / `"response"` / `"both"` when you need headers or the other side
- Authorization and Cookie headers print as scheme + length. `verbose=true` unredacts them and drops all bounding — it writes a live token into the transcript, so use it only when the token itself is what you are checking
- Increase `maxBodyLength` when you want a bigger shape rather than a single field

### 5. Clear and Re-capture (if needed)

When you need to capture fresh network activity:
- Use `mcp__execbro__clear_network` to reset the request buffer
- Ask the user to perform the action that triggers the API call
- Then capture new requests

### 6. Experiment: change what comes back

Inspection answers "what happened". These answer "what happens if". Reach for
them whenever the question is about a branch the backend will not produce on
demand.

**Mock a failure** — `mcp__execbro__network_mock`:

```
network_mock({action:"add", url:"/orders", status:500, body:"{\"error\":\"boom\"}"})
```

Then reproduce the action and look at the screen. The app runs its real request
builder, its real error branch, its real retry. Writing the post-failure state
directly with `redux_dispatch` skips exactly the code you are trying to test.

**Mutate a real response** — when the question is about one field, not the whole
call:

```
network_mock({action:"add", url:"/me", mode:"tamper", remove:["data.email"]})
network_mock({action:"add", url:"/me", mode:"tamper", set:{"data.plan":"expired"}})
```

**Test a retry** — `times: 1` fires once and then passes through, so the first
attempt fails and the second succeeds:

```
network_mock({action:"add", url:"/sync", status:503, times:1})
```

**Take the network away** — `mcp__execbro__network_condition`:

```
network_condition({mode:"offline"})   ... reproduce ...   network_condition({mode:"normal"})
```

**Re-issue a captured request** — `mcp__execbro__network_replay`, using an id
from `get_network_requests`:

```
network_replay({requestId:"js-x1-7", body:"{\"qty\":99}"})
```

**Always clean up.** Rules are per-device and survive `reload_app`. Finish with
`network_mock({action:"clear"})` — otherwise the next investigation starts
against altered traffic, and the symptom looks like a real bug.

If a rule seems not to fire, check `network_mock({action:"list"})` first.
Matching is first-rule-wins, so `hits=0` on a rule you expected to work usually
means a broader rule above it is shadowing it.

### 7. Worked example: does the orders screen handle a 500?

```
1. network_mock({action:"add", url:"/orders", status:500})
2. tap(text:"Orders")                     # or reload the screen
3. get_screen_state()                     # is there an error state at all?
4. get_network_requests({urlPattern:"/orders"})
                                          # row tagged [MOCK m1]; banner names the active rule
5. network_mock({action:"list"})          # hits=1 confirms it fired
6. network_mock({action:"clear"})
```

A blank screen at step 3 is the finding: the error branch does not exist.

### 8. Present Findings

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
- `/network-inspect 500` then mock one - Find server errors, then reproduce one on demand

## MCP Tools Used

- `mcp__execbro__ensure_connection`
- `mcp__execbro__scan_metro`
- `mcp__execbro__get_network_requests`
- `mcp__execbro__search_network`
- `mcp__execbro__get_request_details`
- `mcp__execbro__clear_network`
- `mcp__execbro__network_mock`
- `mcp__execbro__network_condition`
- `mcp__execbro__network_replay`

## Notes

- Requires the ExecBro MCP server to be running and connected to the app
- Use `summary=true` first to get an overview before diving into individual requests
- For large response bodies (images, base64), use targeted `maxBodyLength` to avoid token overload
- Use `device` param on request tools to target a specific device when multiple are connected

### Network Capture Modes

Network data capture works differently depending on the app's architecture:

- **Without SDK (basic mode):** Works best on RN 0.73-0.75 (Hermes + Bridge) via CDP Network domain. On Bridgeless targets (Expo SDK 52+, RN 0.76+), uses a JS fetch interceptor fallback — may miss early startup requests. Does NOT capture request/response bodies or full headers.
- **With SDK (recommended):** Install `execbro-sdk` in the app. Captures ALL requests from startup with full headers and bodies (including GraphQL). Works reliably on all RN architectures.

If network tools return no data or you need startup/auth requests, suggest the SDK to the user.

Mocking works the same either way — it lives in the injected interceptor, not
the SDK. With the SDK installed, individual rows are not tagged `[MOCK]`
(the SDK captures them under its own ids), but the active-rules banner on every
read and the per-rule hit counts still tell you traffic is being altered.

Mocking covers JS-originated HTTP only. Native-module traffic — native SDKs,
`<Image>` loading — goes around it.
- **MCP server alias note:** examples use the alias `execbro` (tools prefixed `mcp__execbro__`). If you previously registered the server with the older alias `rn-ai-devtools`, substitute `mcp__rn-ai-devtools__` in these examples — both work, only the alias differs.
