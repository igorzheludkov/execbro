# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Repository: https://github.com/igorzheludkov/execbro

## Monorepo Context

This repo is part of the **execbro** monorepo at `~/rn-devtools/`. See [`../CLAUDE.md`](../CLAUDE.md) for the full map and cross-repo workflows.

**Sibling repos:**
- `execbro-sdk/` — in-app SDK companion ([GitHub](https://github.com/igorzheludkov/execbro-sdk))
- `infra/` — Cloudflare Worker backend (telemetry, OCR) + analytics dashboard
- `web/` — web platform (landing, user cabinet)
- `docs/` — **canonical location for all plans and specs** (`~/rn-devtools/docs/`)

**Plans and specs** must be written to `~/rn-devtools/docs/` (specs → `devtools-core/specs/`, plans → `devtools-core/plans/`). Never store plans/specs inside this repo.

## Project Overview

An MCP (Model Context Protocol) server that gives AI agents end-to-end control of a running React Native app across the iOS Simulator and Android emulators/devices. It is the agent-facing counterpart to React Native's developer tools — combining what Flipper, Chrome DevTools, the Element Inspector, `xcrun simctl`, and `adb` expose into a single tool surface designed for LLMs.

Capabilities:

- **Metro + CDP bridge**: Discovers Metro bundlers, connects to all Bridgeless/Hermes targets via Chrome DevTools Protocol WebSockets, and keeps connections healthy across reloads.
- **Observability**: Streams console logs (filterable, searchable) and network requests (via SDK in-app buffer, CDP `Network` domain, or injected fetch interceptor — auto-selected per RN version).
- **JS execution & app state**: REPL-style `Runtime.evaluate` against the app's JS context, plus discovery/inspection of `global` debug objects and app reload control.
- **UI automation**: Cross-platform `tap` with fiber tree → accessibility → OCR → coordinate fallback, plus swipes, text input, hardware buttons, key events, long press, and deep links.
- **Visual capture**: iOS/Android screenshots, OCR with tap-ready coordinates, burst-frame capture for transient feedback, and a shared image buffer for retrieval.
- **Component inspection**: Fiber-tree-backed screen layout map, regex component search, deep prop/hook/state inspection, full React tree dumps, and coordinate-based hit-testing with per-ancestor frames and styles (mirrors RN's Element Inspector).
- **Device & app management**: List/boot iOS simulators, list Android devices, install/launch/terminate apps, list packages.
- **Build diagnostics**: Metro bundle status, bundling/compilation errors with screenshot+OCR fallback when CDP is unavailable, and LogBox overlay control (dismiss, push, ignore, detect).
- **Account & telemetry**: License activation, anonymous usage telemetry to a Cloudflare Worker, and a `dev` meta-tool for hot-reload tool development.

Transport modes: stdio (default, production) and HTTP (dev, hot-reload friendly).

## Common Commands

```bash
npm run build    # Compile TypeScript and make build/index.js executable
npm start        # Run the compiled server
```

To lint a specific file:

```bash
npx tsc --noEmit src/index.ts
```

## Testing policy — automated suite is unit-only

`npx jest` runs **unit tests only**. There is no integration directory, and
tests must never drive an attached simulator, emulator or phone.

Integration behaviour is verified **by an agent**, interactively, through the
`mcp__execbro-dev__*` tools against a running app — not by the automated suite.

This is a hard rule, learned the expensive way. The old integration suites were
gated on nothing but device *presence*, so an ordinary `npx jest` hijacked
whatever device happened to be attached: typing into the focused field, tapping
the screen, dumping the UI, repeatedly, for the length of every run. Device
presence is not consent.

When adding a test, if it needs a real device, it does not belong here — write
it as an agent-driven verification step in the relevant plan instead, the way
`docs/devtools-core/plans/` records device verification.

Run **specific files**, not the whole suite, while iterating:

```bash
NODE_OPTIONS='--experimental-vm-modules' npx jest --testPathPatterns='unit/tap.test'
```

To prove a change did not reintroduce device contact, put stub `adb` and `xcrun`
on PATH that log their arguments, and run the suite against them. A clean run
logs nothing. That is the only trustworthy check — reading the code is not
enough, because the calls arrive through helpers several layers down.

Do not "fix" this by guarding at the exec layer. That was tried: making `adb`
fail under test convinced production code that ADB was uninstalled, which then
pushed "ADB Not Installed" LogBox errors into the developer's running app. A
test harness must not lie to the code it is testing.

## Development with Hot Reload

For development, the `execbro-dev` MCP server uses HTTP transport so code changes apply without restarting Claude Code sessions. Spec: `~/rn-devtools/docs/devtools-core/specs/2026-06-12-http-dev-loop-activation-design.md`.

The configured setup (active on this machine):

- `~/.claude.json` mcpServers: `"execbro-dev": { "type": "http", "url": "http://localhost:8600/mcp" }`
- `scripts/dev-server.sh` — idempotent launcher: exits if port 8600 is busy, otherwise sets `EXECBRO_API_URL=https://execbro.com` and starts `npm run dev:mcp` detached, logging to `/tmp/execbro-dev-server.log`. Note: `--http` mode defaults the license/account API to `http://localhost:3000` (`src/core/config.ts`), so the script pins it to production; edit that line to test a local backend.
- A SessionStart hook in `~/.claude/settings.json` runs the launcher script (empty `matcher` — SessionStart matchers match the start source, not a project name).

Iteration loop: save a file → nodemon rebuilds and restarts the server (~5-15 s) → the next `mcp__execbro-dev__*` call hits the new code. Each restart drops Metro/CDP connections and buffers — run `scan_metro` once after a save if you need a device connection.

To run the dev server manually instead: `npm run dev:mcp` (port 8600, override with `MCP_HTTP_PORT`).

Production users are unaffected — the default transport remains stdio, and `--http` is refused outright in published builds (see below).

**The HTTP transport is checkout-only.** It is unauthenticated and registers the `dev` meta-tool, which proxies calls to every tool in the registry, so it must never be reachable from an npm install. Two guards enforce that:

- `isPublishedBuild()` (`src/core/buildInfo.ts`) compares the injected `BUILD_TOKEN` against its placeholder. A published artifact is stamped, so `--http` exits non-zero with an explanatory message and the `dev` tool is never registered. A source checkout or fork built from source keeps the placeholder and works normally.
- The listener binds `127.0.0.1` explicitly. `listen(port)` with no host binds `0.0.0.0`, which would put device control, JS eval, and screenshots on the LAN.

**`GET` and `DELETE` on `/mcp` are answered with 405 and never enter the queue.** In stateless mode there is no session to address a server-initiated message to, so there is nothing to stream — but the important part is the queue. A `GET` SSE stream stays open by design, so a queued one holds the single slot until the 30s drain timeout, and the SDK client reopens it the moment it closes. Every tool-call `POST` then queues behind a stream that is always there. The symptom is a server that looks perfectly healthy — listening, idle, accepting connections — and answers nothing; `execbro-dev` could not attach to a Claude Code session at all. If the dev server ever starts timing out on `initialize`, check this first.

`StreamableHTTPServerTransport` is constructed **per request**, not once at boot. Current SDKs treat the streamable-HTTP transport as single-use: a hoisted instance answers `initialize` and then fails every later request with a bare 500 and no log line, which looks exactly like a dead server. If the dev loop ever starts 500ing after one successful call, check that this is still per-request.

`/mcp` requests are also **serialized** through `createSerialQueue()` (`src/core/serialQueue.ts`). The transport is per-request but `server` is not, and `McpServer.connect()` throws `Already connected to a transport` if a second transport attaches before the first detaches — so two overlapping requests crashed the process outright. A fast request like `initialize` will not reproduce it; you need a slow tool call holding the server across an await with a second request landing mid-flight. Serializing costs nothing in a single-developer hot-reload loop and is why the dev server no longer dies when a client pipelines or fires a notification without awaiting it.

This is a release-channel gate, not a security boundary — `build/*.js` is editable. It exists so ordinary users cannot expose the dev surface by accident.

### Dev Tool (`dev`)

In HTTP mode, a `dev` meta-tool is registered for full hot-reload testing. It proxies calls to any tool using the latest server code, so new/modified/removed tools are immediately testable without restarting the Claude Code session.

- `dev(action="list")` — compact listing (name + first description line). Pass `filter="substring"` to narrow by name, or `verbose=true` for full descriptions.
- `dev(action="call", tool="tool_name", args={...})` — invokes any tool by name using the latest handler

This tool is only available in `--http` mode (dev). It does not appear in production (stdio).

**IMPORTANT — validating changes during development:** When modifying any tool's handler in this repo, verify the change through the `mcp__execbro-dev__*` (HTTP) tools, not the production `mcp__execbro__*` (stdio) tools. The stdio server runs the published npm build and won't pick up edits; the HTTP server is rebuilt by nodemon on every save. Two valid verification paths:

1. **Handler logic change** — call the tool directly via `mcp__execbro-dev__<tool>` (immediate, uses latest code) OR via `dev(action="call", tool="<tool>", args={...})`.
2. **Schema/description change** — the top-level `mcp__execbro-dev__*` schemas are cached by Claude Code at session start and do NOT refresh on rebuild. Use `dev(action="list", filter="<tool>")` or `dev(action="list", verbose=true, filter="<tool>")` to see the live schema. A session restart is only needed if you want the new schema visible as a top-level tool.

## Architecture

Modular MCP server with entry point at `src/index.ts` and core logic in `src/core/`:

1. **Metro Discovery**: Scans common ports (8081, 8082, 19000-19002) for running Metro bundlers
2. **Device Selection**: Fetches `/json` endpoint from Metro, prioritizes devices in order:
    - React Native Bridgeless (Expo SDK 54+)
    - Hermes React Native
    - Any React Native (excluding Reanimated/Experimental)
3. **CDP Connection**: Connects via WebSocket to device's debugger URL
4. **Log Capture**: Enables `Runtime.enable` and `Log.enable` CDP domains to receive console events
5. **Network Tracking**: Three capture strategies (auto-selected):
   - **SDK mode** (best): If `execbro-sdk` is installed in the app, its in-app buffer is *mirrored* into the server-side buffer every 3-10s via `Runtime.evaluate` (see `sdkMirrorPoller` below). Captures all requests from startup with full headers and bodies. Reads go through the server buffer, not a live query, so data survives an app restart.
   - **CDP mode**: `Network.enable` CDP domain — works on RN 0.73-0.75 (Hermes + Bridge) and future RN 0.83+. Not supported on Bridgeless targets (Expo SDK 52-54).
   - **JS interceptor fallback**: Injects an `XMLHttpRequest` + `fetch` patch via `Runtime.evaluate` on Bridgeless targets. XHR is the source of truth (RN's `fetch` is a polyfill on top of it, so reporting from both layers would double-count every request); the fetch wrapper reports only in a JS context with no `XMLHttpRequest`. Captures request headers, request body, response headers, response body, content type and post-redirect URL, with bodies capped in-app at 8 KB / 32 KB. May miss early startup requests due to injection timing. The XHR patch retries every 250 ms for ~10 s, because on a cold launch the connect can land before the bundle defines `XMLHttpRequest` and a one-shot retry loses that race silently.
6. **Response mocking**: The same injected interceptor matches server-side rules before the request reaches the wire and delivers a synthetic response (`replace`) or mutates the real one fetched on a shadow XHR (`tamper`). Rules live in `src/core/mockRules.ts`, are per-device, and are re-pushed on every `Runtime.executionContextCreated`, so they survive `reload_app`. `type:'mock'` events are exempt from the CDP/SDK dedupe gate — neither layer knows the mock layer exists, so a mock event is never a duplicate. Regex patterns are validated server-side: they execute in the app's JS thread, where catastrophic backtracking freezes the app under test.
7. **Code Execution**: Uses `Runtime.evaluate` CDP method for REPL-style JavaScript execution

### Key Components

- `LogBuffer`: Circular buffer (2000 entries, override `EXECBRO_LOG_BUFFER_SIZE`) storing captured logs with level filtering and text search. Entries evicted by the cap are counted and reported in tool output rather than silently dropped.
- `NetworkBuffer`: Circular buffer (1000 entries, override `EXECBRO_NET_BUFFER_SIZE`) storing captured network requests with filtering by method, URL, and status. Keyed by `epoch:requestId` — a fresh JS runtime restarts CDP/SDK id counters, so without the epoch a post-restart request would overwrite its pre-restart namesake.
- `sdkMirrorPoller`: Copies the in-app `execbro-sdk` console and network buffers into the server-side buffers every 3-10s, so a hard app restart no longer destroys the only copy (the SDK stores everything in the app's JS heap, and the server suppresses its own capture while the SDK is present). Also drains before `reload_app`. Detects restarts via a per-runtime nonce on `globalThis` — CDP is not a reliable signal here, since Metro's inspector proxy reuses the target id after a process kill and a killed runtime never emits `executionContextsCleared`. Disable with `EXECBRO_DISABLE_SDK_MIRROR=1`.
- **Session epochs**: every log and network entry carries a per-device `epoch` that increments on each new app run. `get_logs` / `get_network_requests` render a `── app restarted (epoch N) ──` divider at run boundaries and accept `epoch: "current" | <number> | "all"` (default `"all"`, so pre-restart data is never hidden by default).
- `ImageBuffer`: Circular buffer (50 entries) storing screenshots from all image-producing tools (ios/android/ocr screenshots, tap verification frames). Supports grouping for burst frame sets.
- `connectedApps`: Map tracking active WebSocket connections to devices
- `pendingExecutions`: Map for tracking async `Runtime.evaluate` responses with timeout handling
- MCP tools registered via `server.registerTool()` from `@modelcontextprotocol/sdk`

### MCP Tools Exposed

**Connection & Setup:**
- `get_usage_guide`: Get recommended workflows and best practices for all tools (call without params for overview, with topic for full guide)
- `scan_metro` / `connect_metro`: Discover and connect to Metro servers. Detects that the process serving a port **changed** (pid via `lsof`) and warns that Fast Refresh history is discontinuous — edits made while Metro was down are not in the running bundle, and reconnecting does not reconcile them. Devices attached on a restarted port are flagged, and `tap`, `swipe` and `get_screen_state` carry a `staleBundle` warning until `reload_app` clears it. Without this every signal reads healthy, so stale behaviour gets reported as "my fix didn't work" when the fix simply never loaded
- `disconnect_metro`: Disconnect from all Metro servers, free CDP slot for native debugger. Reconnect with `scan_metro`
- `ensure_connection`: Health check with `healthCheck=true`, force refresh with `forceRefresh=true`
- `get_apps`: List connected devices
- `get_connection_status`: Check connection health — uptime, recent disconnects/reconnects, and connection gaps

**Logs & Network:**
- `get_logs` / `search_logs` / `clear_logs`: Log management with level filtering, text search, summary mode, and `device` targeting. Use `source="native"` for device-level logs (Android logcat / iOS os_log) filtered to your app — surfaces crashes, ANRs and OOM kills that never reach the JS console. Native results are event-grouped (a backtrace is one row); expand with `get_log_details(id)`.
- `get_log_details`: Full payload for one log event — complete backtrace, stack trace, or oversized message. Ids come from `get_logs`.
- `get_network_requests` / `search_network` / `get_request_details` / `clear_network`: Network request tracking with URL/method/status filtering. `get_network_requests(summary=true)` returns counts by method, status, and domain
- `network_mock`: Replace or tamper with HTTP responses so an error branch is reached through the app's real code. `add` / `list` / `remove` / `clear`; `times:N` for retry tests; slash-wrapped `url` for regex. Rules are per-device and survive `reload_app`
- `network_condition`: Simulate `offline` / `slow` / `normal`. Owns one rule per device and replaces only its own, so it never clears the agent's mocks. `offline` also self-verifies a NetInfo patch and reports honestly what it achieved
- `network_replay`: Re-issue a captured request with optional overrides, through the app's own network stack

**App State & Execution:**
- `execute_in_app`: Execute simple JS expressions using globals (no require/async/emoji — Hermes limitations)
- `list_debug_globals` / `inspect_global`: Discover and inspect global debugging objects
- `reload_app`: Reload the React Native app (triggers JS bundle reload)
- `logbox`: Interact with React Native's LogBox overlay (dev mode only). Actions: "dismiss" clears entries and returns content, "push" displays a message in the error banner, "ignore" adds patterns to suppress future entries, "detect" reads current state.

**UI Interaction:**
- `tap`: Unified tool to tap UI elements — auto-detects platform, tries fiber tree → accessibility → OCR → coordinates. Accepts text, testID, component name, or pixel coordinates. Returns post-tap screenshot by default and verifies visual change via before/after diff. Use `native=true` for coordinate taps without React Native connection (system dialogs, non-RN apps). Use `device` to pin the tap to a specific device when multiple are connected — one param, accepting an iOS simulator UDID, an Android adb serial, a simulator/emulator name, or the connected app's deviceName (substring match). Use `screenshot=false` to disable screenshots, `verify=false` to skip verification. Use `burst=true` to capture rapid sequential screenshots for detecting transient visual feedback (press animations, highlights) — results stored in image buffer accessible via `get_images`. Use `duration` (ms) to **long press** — the touch is held rather than released, reaching context menus, drag starts and multi-select by testID/text/component instead of only by raw coordinates. RN fires `onLongPress` at 500ms, so 800 is a safe default. The response carries `longPress.handlerFound`: `true`/`false` when the fiber strategy inspected the element, `null` when the resolving strategy (accessibility, OCR, coordinates) cannot see handlers — `null` means "not knowable here", never "no handler". A hold on an element without `onLongPress` warns and still succeeds, because the gesture *was* delivered and RN fires `onPress` on release. Elements wired only for `onLongPress` are deliberately invisible to a plain `tap` and only resolvable when `duration` is passed.
- `swipe`: Cross-platform swipe/scroll gesture (auto-routes to iOS/Android). Returns `verification.meaningful`; when it is false, `warning` names the *specific* cause by probing the scroll surface under the start point — already at top, already at end, content not scrollable, wrong axis, or no scroll view there at all. Without an RN connection the probe cannot look, and says so instead of claiming the gesture missed a scroll surface — a statement about the screen it never saw. The probe only runs on a no-op, so the happy path pays nothing, and it never fails the gesture: `swipe` drives the device through adb/simctl and needs no RN connection. Use `burst:true` for overscroll/bounce detection, `verify:false, screenshot:false` for fastest path, `delta` for iOS touch step size.
    - **Android direction swipes are clamped to a safe content rect** using the system bars' insets. A gesture that *starts* inside the home-gesture strip is claimed by the system: the app goes to the background, the driver still reports success, and the next tap — aimed with pre-swipe coordinates — lands on the launcher. Explicit four-coordinate swipes are left unclamped, since those are a deliberate instruction.
    - **`foregroundLost`** appears when the focused package changed across the gesture. Compared against a reading taken *before* the swipe rather than against the connected-app registry, because backgrounding the app drops its CDP connection — the registry stops knowing the package exactly when the check needs it.
- `pinch`: **Android emulator only (iOS in progress).** Real two-finger pinch-to-zoom, delivered as genuine kernel multi-touch through the Android emulator's gRPC bridge — so it drives anything on screen (React Native, native views, WebViews, maps), not just RN surfaces. `direction:"out"` zooms in, `"in"` zooms out; `x`/`y` set the focal point in screenshot pixels; `scale` is the finger-separation ratio (large values chain automatically); `angle` picks the finger axis; `span` shrinks the gesture's footprint without changing the ratio, and defaults to 1 for `"out"` but 0.5 for `"in"` — a pinch-in starts with the fingers far apart, so a full span would land them at the screen extremes where a top bar or bottom sheet takes the gesture. Lower `span` further if a gesture still lands on surrounding UI. Returns `verification.meaningful` like `swipe`. Physical Android devices have no such bridge and iOS needs a multi-touch HID helper that no released idb ships, so both return an explicit error rather than a partial result. It never fakes a zoom by calling app code: success means real fingers moved.
- `input_text`: Unified text entry. Target with `testID`/`component`/`textMatch` — focuses itself, writes through React, reads back and compares exactly. `replace:true` clears first instead of appending. `native:true` types into whatever the OS reports as focused instead (system dialogs, non-RN screens), no targeting possible there; auto-applied when no fiber tree is reachable even without the flag.
- `ios_button`: Press iOS hardware buttons (HOME, LOCK, SIDE_BUTTON, SIRI, APPLE_PAY)
- `android_key_event`: Send Android key events (HOME, BACK, ENTER, DEL, MENU, etc.)
- `android_long_press`: Long press at raw coordinates on Android, for holds with no React Native connection. Anything reachable through RN should use `tap(duration=...)`, which resolves the target by testID/text/component and reports whether it has an `onLongPress` handler
- `ios_open_url`: Open deep links or universal links on iOS simulator

**Screenshots & OCR:**
- `ios_screenshot` / `android_screenshot`: Capture simulator/device screen
- `ocr_screenshot`: Screenshot with OCR text recognition and tap-ready coordinates
- `get_images`: Access shared image buffer containing screenshots from all tools. Returns metadata by default; use `id` or `groupId`+`frameIndex` to retrieve specific images. Tap burst frames are stored here.

**Component Inspection (recommended workflow: get_screen_state → find_components → inspect_component):**

> **One coordinate space.** Every tool below, both screenshot tools, `ocr_screenshot`, `swipe` and `tap` speak
> **delivered-screenshot pixels** — the pixels of the image a screenshot actually returns, after the downscale
> applied to fit the API limit. The factor is a property of the device (`deviceScale / deliveredDownscale`), not
> of a particular capture, so it is stable across calls. Pass coordinates between any of these tools unchanged;
> never multiply or divide by `devicePixelRatio` yourself.

- `get_screen_state`: **Orientation snapshot — call after any tap/navigation.** Screenshot-free view of the screen: active route + params, overlays, and every element merged top-to-bottom within reachability groups. Each line is tap-ready `(x, y)` + frame, typed by a marker — `🔘` pressable (component tag, label, testID, onPress hint), `📝` text, `🖼` image (`src`/`alt`). Overlay-covered elements are grouped under `🚫 Blocked`. Reads screen content (prices, labels, which image loaded) without screenshot+OCR. `pressablesOnly=true` for the lean tappable-only list; `fullText=true` to disable the 80-char text truncation; `fullParams=true` for route param *values* (by default only the key names print — the blob is usually hundreds of characters of ids and image URLs, on every call). Its coordinates are the shared screen space used by every layout tool, the screenshot summaries, and `tap` — pass them straight through, no conversion
    - **`⚠transformed` frames.** `measureInWindow` and `getBoundingClientRect` both read the shadow tree, so neither sees a native-driven transform (verified on RN 0.83/Fabric: a pinned sticky header sat at y=132pt while both APIs reported y=-1698pt). Static numeric translations are composed into the frame; Animated values are read via `__getValue()`; what remains unknowable is tagged inline rather than reported as fact. Off-screen-measuring transformed elements are **kept** in the listing — viewport-filtering them on a pre-transform frame is what made pinned headers vanish entirely, and silence reads as evidence. The tag is only raised when the transform is visibly doing something (non-zero offset, or a frame landing off-screen), so a resting tab bar stays quiet.
    - **LogBox is pruned from the listing, and the pruning is announced.** RN's error banner mounts above the app, so its own buttons used to be the only pressables a screen read returned. The subtree is skipped now, and a note names the banner whenever it contributed elements — a silently shortened list reads as "the screen is empty", which is worse than the poisoning it replaced.
    - **Unmeasured elements are counted, not dropped silently.** The measurement budget scales with node count (`min(3000, 400 + n*2)`) instead of a flat 300ms, and any callback that still misses is reported in a note.
- `get_screen_layout`: **Start here.** Screen map — indented tree of visible components with real screen positions (measureInWindow), text content, and identifiers. Shows only what's on screen, filters out off-screen and internal components. Use `extended=true` for layout styles (padding, flex, backgroundColor, etc.). Coordinates are in the shared screen space — interchangeable with `get_screen_state`, `measure`, `inspect_at_point`, screenshots, and `tap`
- `find_components`: Fast regex search across the fiber tree by component name pattern. Returns all matching instances with path and depth. Use after `get_screen_layout` to locate specific components
- `inspect_component`: Deep dive into a specific component's props, state (hooks), and optionally children tree. Use after finding a component name via `get_screen_layout` or `find_components`
- `get_component_tree`: React fiber tree including all providers, navigation wrappers, and internal components. Use when you need to understand the complete React architecture, not just what's visible. Returns compact names-only output by default; pass `structureOnly=false` for the full detailed tree (very large — prefer `inspect_component` for a specific node)
- `inspect_at_point`: Layout + PROPS at coordinates. Pure JS hit test — no overlay flicker. Returns FRAME PER ANCESTOR (position/size in the shared screen space) plus full props (handlers as `[Function]`, refs, testID, custom props). Best for layout measurements, props inspection, or rapid/repeated calls.

**Device Management:**
- `list_devices`: Find available simulators, emulators, and physical devices in one call
- `ios_boot_simulator`: Boot an iOS simulator by UDID
- `ios_launch_app` / `android_launch_app`: Launch app by bundle ID or package name
- `ios_terminate_app`: Terminate app on iOS simulator
- `android_list_packages`: List installed packages on Android device

For React Native UI inspection, prefer the cross-platform tools: `get_screen_state` (route + tap-ready elements, no screenshot), `get_screen_layout` (visible component tree), `inspect_at_point` (component at coordinates), `find_components` (regex search by component name), and `tap(text=...)` (tap by visible text).

**Bundle & Errors:**
- `get_bundle_status`: Check Metro build state
- `get_bundle_errors`: Compilation/bundling errors with screenshot+OCR fallback. Pass `clear=true` to reset the buffer after reading

**Account:**
- `get_license_status`: Installation ID and license tier
- `activate_license` / `delete_account`: License and account management

**Dev Mode:**
- `dev`: (dev mode only) Meta-tool for hot-reload testing — list all tools or call any tool by name using latest code

## Agent Usage Guidelines

When debugging React Native apps through this MCP server:

- **Hot Reloading**: React Native has Fast Refresh enabled by default. After editing JavaScript/TypeScript code, changes are automatically applied to the running app within 1-2 seconds. Do NOT use `reload_app` after every code change.
- **When to Reload**: Only use `reload_app` when:
    - Logs or app behavior don't reflect recent code changes after waiting a few seconds
    - The app is in a broken/error state
    - You need to completely reset the app state (e.g., clear navigation stack, reset context)
    - You made changes to native code or configuration files
- **Verify Changes**: After code edits, use `get_logs` to check if the app picked up changes (look for fresh log entries or changed behavior) before deciding to reload.
- **UI Interaction — Preferred Method**: Use the unified `tap` tool for all tapping:
    1. `tap(testID="login-btn")` — **most reliable**: matches by testID prop via fiber (both platforms) and accessibility (Android via resource-id)
    2. `tap(text="Submit")` — matches visible text, tries fiber tree → accessibility → OCR automatically
    3. `tap(component="HamburgerIcon")` — matches by React component name, walks up fiber tree to find nearest pressable parent
    4. `tap(x=300, y=600)` — taps at coordinates taken from a screenshot or any layout tool (same coordinate space, no conversion)
    5. `tap(x=300, y=600, native=true)` — taps directly via ADB/simctl without React Native connection (for system dialogs, non-RN apps, or pre-connection UI)
    6. Use `strategy` param to skip strategies you know will fail: `tap(text="≡", strategy="ocr")`
    7. On failure, follow the `suggestion` field in the response — it tells you exactly what to try next
- **Best practice — use testID**: Set `testID` on all interactive elements (buttons, inputs, links). It's more stable than text matching (doesn't break with translations), provides exact matching (no ambiguity), and works for TextInput focusing too.
- **TextInput fields**: `tap` detects TextInput elements (`onChangeText`/`onFocus`) in the fiber tree and falls through to native tap for actual focus. `tap(testID="email-input")` works even though inputs don't have `onPress`.
- **Long press**: `tap(testID="row-3", duration=800)` holds the touch instead of releasing it — context menus, drag starts, multi-select. Under 500ms will not trigger RN's `onLongPress`. Read `longPress.handlerFound` in the response: `false` means the hold landed on an element with no long-press handler (RN fired its `onPress` on release instead), `null` means the resolving strategy could not inspect handlers at all. An element wired *only* for `onLongPress` cannot be found by a plain `tap` — pass `duration` and it becomes resolvable.
- **Icon-only buttons** (no text label inside the pressable): Use `tap(component="ComponentName")` to match by React component name — automatically walks up to the nearest pressable parent. Use `find_components` first to discover actual component names. Use `maxTraversalDepth` param to increase parent search depth for deeply wrapped components (default: 15).
- **Non-ASCII text** (Cyrillic, CJK, Arabic, etc.): `tap(text="текст")` automatically skips fiber (Hermes limitation) and uses accessibility/OCR. For best results, use `testID` or `component` params instead.
- **Component Inspection — Understanding what's on screen**:
    1. Call `get_screen_layout` — returns a tree of visible components with positions, text, and identifiers. This is the fastest way to understand the current UI
    2. To find a specific component by name, use `find_components(pattern="Button")` — fast regex search across the fiber tree
    3. To inspect a component's props, state, and hooks, use `inspect_component(componentName="SneakerCard")`
    4. To see the full React architecture (providers, navigation, hidden modals), use `get_component_tree()`
- **Component Inspection — Identifying elements at coordinates**: When you need to find which React component renders at a specific screen position:
    1. Take a screenshot (`ios_screenshot` / `android_screenshot`) to see the current screen
    2. Call `inspect_at_point(x, y)` — returns identity, **per-ancestor frames**, **props** (handlers, refs, testID), the node's own style, and `source: {file, line, column}` plus the owner chain. Works on Bridgeless / new arch.
    3. Style is not a merged cascade — when a value looks wrong and isn't set on the node itself, walk the ancestors it returns.
- **When to use which inspection tool**:
    - `get_screen_layout` → **start here** — screen map with component tree, real positions, and text content
    - `find_components` → fast regex search by component name across the entire fiber tree
    - `inspect_component` → deep dive into props, hooks, and state of a specific component
    - `get_component_tree` → React fiber tree including internals, providers, hidden components (compact by default)
    - `inspect_at_point` → identity, per-ancestor frames, props, style, and the source file:line at coordinates (no overlay, fast) — the tool to reach for when the goal is to edit the component, not just identify it
- **Multi-Device Debugging**: When multiple devices are connected:
    1. Use `get_apps` to see all connected devices and their names
    2. Use `device="iPhone"` or `device="sdk_gphone"` to target specific devices (case-insensitive substring match)
    3. Omitting `device` uses the first connected device for execution tools, or merges data from all devices for log/network tools
    4. Example workflow: `ios_screenshot` on iPhone, `android_screenshot` on Android, compare layouts
    5. `scan_metro` now connects ALL Bridgeless targets instead of picking one — no manual `connect_metro` needed
- **Tap Verification — Burst Mode**: When `tap()` reports `meaningful: false` but you suspect the tap hit a real button (e.g., the handler may be buggy or the visual feedback is transient), retry with `burst=true`. This captures 4 rapid screenshots after the tap to detect momentary visual feedback (press animations, highlights) that settles before the standard after-screenshot. Check `verification.transientChangeDetected` and use `get_images(groupId=verification.burstGroupId)` to inspect individual frames.
- **Network mocking — clean up after yourself**: `network_mock` and `network_condition` rules are per-device and **survive `reload_app`** by design. A forgotten rule makes the next investigation start against altered traffic, and the symptom looks exactly like a real bug. Every network read carries a banner while rules are active — believe it. Finish with `network_mock({action:"clear"})` and `network_condition({mode:"normal"})`.
- **Mock vs `redux_dispatch`**: to test an error path, mock the response. `redux_dispatch` writes the post-failure state directly and skips the request builder, the error branch and the retry — the code you are trying to fix.
- **LogBox Overlay**: In development mode, React Native's LogBox may display error/warning banners at the bottom of the screen, obstructing tab bars and bottom UI. Screenshot, OCR, and describe_all tools automatically detect this and append a warning. Use `logbox` with action "dismiss" to clear the overlay — it returns the full error content so nothing is lost. Use action "ignore" to suppress known noisy warnings from reappearing. Use action "push" to display a message to the developer watching the device. LogBox does not exist in production builds.

## Telemetry System

Anonymous usage telemetry is collected to understand how the MCP server is used. Located in `src/core/telemetry.ts`.

### How It Works

- **Installation ID**: Random UUID stored in `~/.rn-debugger-telemetry.json`
- **Batching**: Events are batched (10 events or 30-second intervals) before sending
- **Data Collected**: Tool invocations (name, success/failure, duration), session starts, platform, server version
- **Metering vs analytics split**: the counted usage signal (free-tier cap) is POSTed to `execbro.com/api/usage/report` (relayed server-side to the Analytics Engine ingest), so blocking metering also blocks license validation. Analytics events still go directly to the Cloudflare Worker. Usage verdicts returned by `/api/license/validate` are Ed25519-signed; the client verifies signatures before trusting the offline cache (`src/core/signedVerdict.ts`, `src/core/usageCache.ts`).

### Configuration

Telemetry sends data to a Cloudflare Worker endpoint. The API key is a write-only token safe to embed in client code.

## Backend & Dashboard (separate repo)

Telemetry backend (Cloudflare Worker) and analytics dashboard live in a **separate private repository**: `~/rn-debugger-infra/`.

The telemetry client that sends events lives here: `src/core/telemetry.ts`.

### Cross-repo relationship

| This repo (MCP server) | Infra repo (`~/rn-debugger-infra/`) |
|---|---|
| `src/core/telemetry.ts` — sends events | `backend/worker.ts` — receives and stores events |
| Tool names, success/failure, duration | Analytics Engine schema, SQL queries |
| Telemetry endpoint URL + API key (in telemetry.ts) | Worker deployment URL + API key (in wrangler secrets) |
| — | `dashboard/index.html` — visualizes tool usage, user activity |

### Common cross-repo workflows

- **Analyzing metrics then changing tools**: Check dashboard stats in infra repo → identify underperforming tools → come back here to fix them
- **Adding new telemetry fields**: Add field in `src/core/telemetry.ts` here → update `backend/worker.ts` schema in infra repo → update dashboard queries
- **Changing Analytics Engine schema**: Update `backend/worker.ts` blob/double mappings in infra repo → update `src/core/telemetry.ts` to send matching data
