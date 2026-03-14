# Unified `tap` Tool Design

## Problem

AI agents struggle with tapping accuracy in React Native apps due to:

1. **Coordinate confusion** — `ios_tap` docs say "pixels" but IDB expects points. Agents do wrong math.
2. **Too many tools** — `ios_tap`, `android_tap`, `ios_tap_element`, `android_tap_element`, `press_element` all do variations of the same thing. Agents pick the wrong one.
3. **No fallback chain** — when one strategy fails (e.g., fiber tree can't find an icon-only button), the agent must manually orchestrate the next strategy (OCR, accessibility tree, coordinates).
4. **Non-text elements invisible to OCR** — icon-only buttons like hamburger menus get missed or misrecognized.

## Solution

A single unified `tap` MCP tool that:
- Auto-detects platform (iOS/Android) from connected app
- Accepts pixels for coordinates and converts internally
- Runs a built-in fallback chain across multiple strategies
- Returns actionable error messages guiding the agent to the next step

## Tool Interface

**Tool name:** `tap`

### Parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | No | Visible text to match (case-insensitive substring). ASCII only for fiber strategy; OCR handles non-ASCII. |
| `testID` | string | No | Exact match on testID/nativeID prop |
| `component` | string | No | Component name match (case-insensitive substring) |
| `index` | number | No | Zero-based index when multiple elements match (default: 0) |
| `x` | number | No | X coordinate in pixels (from screenshot) |
| `y` | number | No | Y coordinate in pixels (from screenshot) |
| `strategy` | enum | No | `"auto"` (default), `"fiber"`, `"accessibility"`, `"ocr"`, `"coordinate"` |

### Constraints

- Must provide either at least one of `text`/`testID`/`component`, OR both `x` and `y`
- If `x`/`y` are provided, strategy defaults to `"coordinate"` (skips the search chain)
- Platform is auto-detected from the connected app — agent never specifies it

### Platform Detection

The tool determines the platform from the active CDP connection in `connectedApps`. Each connected app stores device info from Metro's `/json` endpoint, which includes the device page title (e.g., "Hermes React Native"). The platform is inferred by checking which connection functions succeeded during `connect_metro` — iOS connections use IDB (`idb connect`), Android connections use ADB. The `tap` tool stores a `platform: "ios" | "android"` field on the connection state at connect time, so it can be read instantly without re-detection.

If no app is connected, the tool returns an error: "No connected app. Use `connect_metro` first."

## Fallback Chain (auto strategy)

When `strategy="auto"` (default), the tool executes this chain:

```
1. Fiber tree (press_element logic)
   | fail
2. Accessibility tree (ios_find_element / android_find_element)
   | fail
3. OCR -> coordinate tap
   | fail
4. Return error with instruction to use coordinates
```

### Strategy availability by param type

| Param | Fiber | Accessibility | OCR |
|-------|-------|--------------|-----|
| `text` | Yes | Yes (as label) | Yes |
| `testID` | Yes | Yes (iOS only — maps to `accessibilityIdentifier`; unreliable on Android) | No |
| `component` | Yes | No | No |
| `x, y` | Skip all — direct tap | | |

### Accessibility strategy details

The accessibility strategy uses `iosFindElement()` / `androidFindElement()` to search the native accessibility tree. When an element is found, the tool taps at the element's center coordinates (calculated from the element's `frame`: `x + width/2`, `y + height/2`). These coordinates are already in points (iOS) or pixels (Android) as returned by IDB/ADB, so no conversion is needed for this strategy.

### Non-ASCII text

When `text` contains non-ASCII characters, fiber is skipped (Hermes limitation) and the chain starts at accessibility.

## Response Format

### Success (minimal)

```json
{
  "success": true,
  "method": "fiber",
  "query": { "text": "Submit" },
  "pressed": "PrimaryButton",
  "text": "Submit",
  "screen": "LoginScreen",
  "path": "LoginScreen > Form > PrimaryButton"
}
```

### Coordinate success

```json
{
  "success": true,
  "method": "coordinate",
  "query": { "x": 300, "y": 600 },
  "tappedAt": { "x": 300, "y": 600 },
  "convertedTo": { "x": 100, "y": 200, "unit": "points" },
  "platform": "ios",
  "screen": "HomeScreen",
  "component": "HamburgerButton",
  "path": "HomeScreen > Header > HamburgerButton"
}
```

For coordinate taps, a best-effort `inspect_at_point` call is made after the tap to identify what was tapped. If inspection fails (e.g., no fiber roots available), the tap is still reported as successful — `screen`, `component`, and `path` fields will be `null`.

### Failure (verbose, actionable)

```json
{
  "success": false,
  "query": { "text": "hamburger" },
  "screen": "HomeScreen",
  "error": "No element found matching text=\"hamburger\"",
  "attempted": [
    { "strategy": "fiber", "reason": "No pressable element with matching text" },
    { "strategy": "accessibility", "reason": "No element with label \"hamburger\" found" },
    { "strategy": "ocr", "reason": "Text not recognized in screenshot" }
  ],
  "suggestion": "Use `screenshot` to capture the screen, visually identify the element's position, then call `tap(x=<pixel_x>, y=<pixel_y>)` with pixel coordinates from the screenshot."
}
```

### Partial match (index out of bounds)

```json
{
  "success": false,
  "query": { "text": "Menu" },
  "screen": "HomeScreen",
  "error": "Found 3 matches but index 5 requested (0-based)",
  "matches": [
    { "index": 0, "component": "NavButton", "text": "Main Menu" },
    { "index": 1, "component": "SideMenu", "text": "Menu Items" },
    { "index": 2, "component": "FooterNav", "text": "Menu" }
  ],
  "suggestion": "Use index 0-2 to select a match, e.g. tap(text=\"Menu\", index=0)"
}
```

### Component-only failure

When only `component` is provided and fiber fails:

```json
{
  "success": false,
  "query": { "component": "HamburgerIcon" },
  "screen": "HomeScreen",
  "error": "No pressable element matching component=\"HamburgerIcon\" in fiber tree",
  "attempted": [
    { "strategy": "fiber", "reason": "No pressable element with matching component name" }
  ],
  "suggestion": "Component matching only works via fiber tree. Try tap(text=...) for broader matching, or use `screenshot` to identify coordinates and call tap(x=<pixel_x>, y=<pixel_y>)."
}
```

### Response design for future memory system

All responses include `query` (the original search params), `screen` (current screen name), and `method` (strategy that worked). This enables a future memory system to cache successful tap targets so agents can recall them without re-analyzing the screen — and skip straight to the known-working strategy.

## Coordinate Conversion

When `x, y` are provided (pixels from screenshot):

1. **Detect platform** from connected app
2. **iOS:** `point = Math.round(pixel / devicePixelRatio)` using `inferIOSDevicePixelRatio()`
3. **Android:** Pass through as-is (Android uses raw pixels)
4. **Screenshot scaling:** If a prior screenshot was resized (> 2000px), multiply by `scaleFactor` to restore original pixel coordinates before converting

### Screenshot state management

The last screenshot's metadata (`originalWidth`, `originalHeight`, `scaleFactor`) is stored per-device on the connection state in `connectedApps`. It is updated whenever `screenshot` or `ocr_screenshot` is called. This ensures coordinate conversion uses the correct device's scaling, even when multiple devices are connected.

### No prior screenshot

If `tap(x, y)` is called without a prior screenshot, assume `scaleFactor=1` (no resizing). For iOS pixel ratio, take a quick screenshot internally to get device dimensions for `inferIOSDevicePixelRatio()`. This adds ~200ms but ensures correct conversion.

### OCR strategy flow

When the OCR strategy is attempted (for `text` matching):

1. Take a fresh screenshot via `iosScreenshot()` / `androidScreenshot()`
2. Run EasyOCR on the image buffer via the HTTP `/api/ocr` endpoint
3. Search OCR results for matching text (case-insensitive substring)
4. If found, use the pre-converted `tapCenter` coordinates (already in points/pixels for the platform)
5. Call `iosTap()` / `androidTap()` at those coordinates
6. If screenshot or OCR process fails, report the error and continue to the next fallback step

## Screen Identifier

The current screen is identified from the React fiber tree by finding the topmost `RNSScreen` component that isn't `aria-hidden`. This reuses the same traversal logic that `press_element` already uses to skip hidden screens.

**Fallback for non-React Navigation apps:** If no `RNSScreen` component is found, fall back to the root component name (first fiber with a user-defined component type). If no fiber tree is available at all, `screen` is `null`.

For coordinate taps, a best-effort `inspect_at_point` is called after the tap to resolve the component hierarchy.

## Tools to Remove from MCP Registry

These tools become internal implementation details of `tap`:

- `ios_tap` — replaced by `tap(x, y)`
- `android_tap` — replaced by `tap(x, y)`
- `ios_tap_element` — replaced by `tap(testID/text)` with accessibility strategy
- `android_tap_element` — replaced by `tap(testID/text)` with accessibility strategy
- `press_element` — replaced by `tap(text/testID/component)` with fiber strategy

The underlying functions (`iosTap`, `androidTap`, `pressElement`, etc.) remain in the codebase. Only MCP tool registrations are removed.

### Tools kept as-is

- `ios_screenshot` / `android_screenshot` — agent needs these independently
- `ocr_screenshot` — useful for reading text, not just tapping
- `ios_find_element` / `android_find_element` — useful for exploration
- `ios_describe_all` / `android_describe_all` — inspection, different purpose
- `find_components` — exploration tool

## Implementation Structure

### New file: `src/core/tap.ts`

Contains:
- `tap()` orchestrator function
- Fallback chain logic
- Coordinate conversion
- Response formatting
- Screen identifier extraction

Imports existing internal functions:
- `pressElement()` from `executor.ts` (fiber strategy)
- `iosFindElement()` / `androidFindElement()` from `ios.ts` / `android.ts` (accessibility)
- `ocrScreenshot()` from `ocr.ts` (OCR strategy)
- `iosTap()` / `androidTap()` from `ios.ts` / `android.ts` (tap execution)
- `inferIOSDevicePixelRatio()` from `ocr.ts`

### Changes to `src/index.ts`

- Register new `tap` tool
- Remove registrations for: `ios_tap`, `android_tap`, `ios_tap_element`, `android_tap_element`, `press_element`

### Type changes: `ConnectedApp`

The `ConnectedApp` interface in `src/core/types.ts` needs two additions:
- `platform: "ios" | "android"` — set at connect time
- `lastScreenshot?: { originalWidth: number; originalHeight: number; scaleFactor: number }` — updated on each screenshot call

### No changes to existing module logic

`executor.ts`, `ios.ts`, `android.ts`, `ocr.ts` are reused as-is (only the type interface is extended).

## Telemetry

Single telemetry event per `tap` call using existing schema:

- `blob2`: `"tap"` (tool name)
- `blob3`: `"success"` or `"failure"`
- `blob6`: On failure, the `errorCategory` (existing behavior). On success, the strategy used: `"fiber"`, `"accessibility"`, `"ocr"`, `"coordinate"`
- `double1`: total duration in ms (including all fallback attempts)

No new Analytics Engine fields required.

## Phase 2: Revisit Screenshot Scaling & Pixel Ratio

After the initial `tap` tool is working on real devices, revisit:

- **`inferIOSDevicePixelRatio()`** — current heuristic (width >= 1080 = @3x, else @2x) was written quickly. Needs validation against real device matrix (iPhone SE, Mini, Pro Max, iPads).
- **Screenshot `scaleFactor`** — images > 2000px are resized for API limits. Need to verify whether this scaling is still relevant and if the coordinate math is correct end-to-end.
- **Android DPI handling** — Android has more varied screen densities. Verify that raw pixel pass-through works across different devices.

This is intentionally deferred to avoid premature optimization before real-world testing.

## Future Work: Unified Interaction Tools

The `tap` tool establishes a pattern for unifying all platform-specific interaction tools. Future iterations should follow the same principles: auto-detect platform, accept pixels for coordinates, actionable errors, minimal success / verbose failure.

| Current tools | Future unified tool |
|---|---|
| `ios_screenshot`, `android_screenshot`, `ocr_screenshot` | `screenshot` — auto-detects platform, optional `ocr: true` param |
| `ios_swipe`, `android_swipe` | `swipe` — accepts pixel coordinates, converts internally |
| `ios_input_text`, `android_input_text` | `input_text` — platform-agnostic |
| `ios_find_element`, `android_find_element`, `find_components` | `find_element` — tries fiber tree then accessibility tree |
| `ios_describe_all`, `android_describe_all` | `describe_screen` — unified accessibility dump |
| `ios_wait_for_element`, `android_wait_for_element` | `wait_for_element` — cross-platform polling |
| `ios_launch_app`, `android_launch_app` | `launch_app` — platform-agnostic |
| `ios_install_app`, `android_install_app` | `install_app` — platform-agnostic |

Each unified tool gets its own design spec when prioritized.

## Required Documentation Updates

When `tap` is implemented, the following must be updated:

- **CLAUDE.md** — Rewrite the "UI Interaction — Preferred Method" section to reference `tap` instead of `press_element`, `ios_tap`, `android_tap`. Update the MCP Tools Exposed list. Remove references to manual coordinate conversion.
- **README.md** — Update tool listing if it references the removed tools.
- **`get_usage_guide` tool** — Update workflow recommendations to use `tap` instead of the removed tools.
