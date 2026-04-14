# get_pressable_elements — Design Spec

## Problem

AI agents struggle to tap non-text UI elements (burger menus, icon buttons, sidebars) because screenshots don't reliably reveal their exact positions. Agents resort to approximate coordinate guessing, which frequently misses.

The fiber tree already knows which elements have `onPress` handlers and can measure their screen positions. This tool exposes that information proactively so the agent can pick the right target.

## Solution

A new standalone MCP tool `get_pressable_elements` that walks the React fiber tree, finds all visible elements with press/input handlers, measures their screen positions, and returns a flat list with tap-ready center coordinates and component names.

## Architecture

### Two-Phase JS Injection (same pattern as `get_screen_layout`)

**Phase 1 — Collect & Dispatch measureInWindow:**

1. Discover fiber roots via `__REACT_DEVTOOLS_GLOBAL_HOOK__` (same as `get_screen_layout`)
2. Walk the fiber tree recursively, skipping:
   - Inactive screens: `RNSScreen` with `aria-hidden === true`
   - Inactive screens: `MaybeScreen` with `active === 0`
   - Unfocused screens: `SceneView` with `focused === false`
3. For each fiber, check props for handlers:
   - `onPress` (function) → pressable element
   - `onChangeText` or `onFocus` (function, and no `onPress`) → input element
4. For each pressable/input fiber found:
   - Walk UP the fiber tree to find the nearest meaningful (non-primitive) ancestor component name, using the same `RN_PRIMITIVES` regex filter from `get_screen_layout`
   - Collect text content from the subtree using `collectText` (same helper logic as `get_screen_layout`)
   - Collect `testID`, `accessibilityLabel` from props
   - Build the component path from ancestor names
   - Find the measurable host fiber by walking DOWN with `findFirstHost` (same helper as `get_screen_layout`)
   - Dispatch `measureInWindow` on the host fiber
5. Store all results in `globalThis.__pressableMeasurements`

**Phase 2 — Resolve measurements (after 300ms delay):**

1. Read measurements from `globalThis.__pressableMeasurements`
2. Detect viewport dimensions (same logic as `get_screen_layout` — find root view at x=0, y<=0)
3. Filter out elements that are:
   - Zero-size (`width <= 0` or `height <= 0`)
   - Off-screen left/top (`x + width < 0` or `y + height < 0`)
   - Off-screen right/bottom (`x > viewportW` or `y > viewportH`)
4. Compute center coordinates for each surviving element: `center.x = x + width/2`, `center.y = y + height/2`
5. Sort top-to-bottom, left-to-right (by y, then x)
6. Clean up globals

### Component Name Resolution

The key difference from `get_screen_layout`: instead of walking top-down looking for meaningful custom components, this tool starts at each pressable fiber and walks **up** to find the nearest non-primitive ancestor name. This gives meaningful names like `CartButton` or `HamburgerIcon` instead of raw `View`.

The walk-up uses the same `RN_PRIMITIVES` regex to skip internal/library wrappers. If no meaningful ancestor is found within a reasonable depth (e.g., 20 levels), fall back to the pressable fiber's own type name.

## Output Format

```json
{
  "pressableElements": [
    {
      "component": "HamburgerIcon",
      "path": "Header > MenuButton > HamburgerIcon",
      "center": { "x": 28, "y": 56 },
      "frame": { "x": 8, "y": 40, "width": 40, "height": 32 },
      "text": "",
      "testID": null,
      "accessibilityLabel": "Open menu",
      "hasLabel": false,
      "isInput": false
    },
    {
      "component": "SubmitButton",
      "path": "LoginForm > SubmitButton",
      "center": { "x": 195, "y": 420 },
      "frame": { "x": 40, "y": 400, "width": 310, "height": 40 },
      "text": "Sign In",
      "testID": "submit-btn",
      "accessibilityLabel": null,
      "hasLabel": true,
      "isInput": false
    }
  ],
  "summary": "Found 12 pressable elements (4 icon-only, 8 with text labels)",
  "device": "iPhone 16 Pro"
}
```

### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `component` | string | Nearest meaningful ancestor component name |
| `path` | string | Component ancestor path (e.g., `Header > MenuButton > HamburgerIcon`) |
| `center` | `{x, y}` | Tap-ready center coordinates in points (iOS) / dp (Android) |
| `frame` | `{x, y, width, height}` | Bounding box in points/dp |
| `text` | string | Text content from subtree, empty string if none |
| `testID` | string \| null | React Native testID prop if set |
| `accessibilityLabel` | string \| null | Accessibility label if set |
| `hasLabel` | boolean | `true` if `text` is non-empty |
| `isInput` | boolean | `true` if element is a TextInput (onChangeText/onFocus), `false` if pressable (onPress) |

## Tool Registration

### Parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `device` | string | No | Target specific device (case-insensitive substring match). Omit for first connected device. |

### Implementation Location

- Tool registration: `src/index.ts` (alongside other tool registrations)
- Core implementation: `src/core/executor.ts` (new exported function `getPressableElements`, alongside `getScreenLayout`)
- Two new JS payloads: dispatch phase and resolve phase (same structure as `getScreenLayout`)

### Reused Infrastructure

From `get_screen_layout` / existing code:
- Fiber root discovery
- `RN_PRIMITIVES` regex filter
- `collectText` helper logic
- `findFirstHost` / `getMeasurable` helper logic
- Screen/viewport detection
- Visibility filtering
- measureInWindow dispatch pattern (both Fabric and Paper)
- `device` parameter handling and multi-device targeting

## Agent Workflow

1. Agent takes a screenshot — sees an icon but can't identify its tap coordinates
2. Agent calls `get_pressable_elements` — gets all pressable elements with names and coordinates
3. Agent identifies the target (e.g., `HamburgerIcon` with `center: {x: 28, y: 56}`)
4. Agent uses `tap(component="HamburgerIcon")` or `tap(x=28, y=56)` to tap it

## Scope

- Standalone tool only — no integration with `tap` tool in this phase
- No new parameters beyond `device`
- No changes to existing tools
