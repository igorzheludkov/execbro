# Layout & Component Inspection

> **Preview:** This guide is a work in progress. Tool descriptions and workflows may change as the feature set evolves.

Tools for understanding the structure and layout of your React Native screens. Use these to identify components, inspect their props and styles, and debug layout issues.

## Overview

| Tool                       | Purpose                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `get_screen_layout`        | Screen map of visible components with positions, sizes, and text content             |
| `get_component_tree`       | Full React fiber tree including providers, navigation, and internal components       |
| `find_components`          | Search for components by name pattern across the entire tree                         |
| `inspect_component`        | Deep dive into a specific component's props, state, and hooks                        |
| `inspect_at_point`         | Per-ancestor frames + props at (x, y) — pure JS, no overlay flicker                   |
| `get_inspector_selection`  | Identity + rich style per ancestor at (x, y) — briefly toggles RN inspector          |
| `toggle_element_inspector` | Manually toggle RN's Element Inspector overlay (rarely needed)                       |
| `get_images`               | Access the shared image buffer (screenshots from all tools, tap verification frames) |

## get_screen_layout

Returns visible components as an indented tree with actual screen positions. Uses `measureInWindow` for real coordinates and filters out off-screen components. This is the best starting point for understanding what's on screen.

```
get_screen_layout
```

Returns meaningful component names with text content and frame data (`x, y width x height`). Coordinates are in **points** (iOS) or **dp** (Android) — not screenshot pixels.

**Key parameters:**

- `extended=true` — include layout styles (padding, margin, flex, backgroundColor)
- `componentsOnly=true` — hide host components (View, Text) and show only custom components

**Tip:** Use `tap(text=...)` or `tap(testID=...)` to interact with components discovered in the layout.

## get_component_tree

Returns the full React fiber hierarchy — includes providers, navigation wrappers, context components, and everything rendered in the tree.

```
get_component_tree
```

**Key parameters:**

- `structureOnly=true` — compact names-only output, much smaller response
- `focusedOnly=true` — limit to the focused screen (useful in navigation-heavy apps)

Use this when you need the complete picture. For a screen overview with positions and text, prefer `get_screen_layout`.

## find_components

Search for components matching a name pattern across the entire fiber tree.

```
find_components with pattern="Card"
```

**Key parameters:**

- `includeLayout=true` — include padding, margin, flex styles for each match

**Workflow:** Use after `get_screen_layout` or `get_component_tree(structureOnly=true)` to locate specific components by pattern.

## inspect_component

Deep dive into a specific component — returns props, style, state (hooks), and optionally children.

```
inspect_component with name="ProductCard"
```

**Key parameters:**

- `childrenDepth` — control how deep nested children go

**Workflow:** Use after `get_screen_layout` or `find_components` to identify which component to inspect.

## inspect_at_point

Inspect layout AND props at (x, y). Returns FRAME PER ANCESTOR (position/size in dp for every ancestor that hit-tested the point) plus the innermost component's PROPS (handlers as `[Function]`, refs, testID, custom props). Pure JS hit test via fiber tree + `measureInWindow` — no on-device overlay toggled, zero visual side effect.

```
inspect_at_point with x=150 y=300
```

Coordinates are in dp (density-independent pixels). Convert from screenshot pixels by dividing by the device pixel ratio (e.g., 540px / 2.625 = 205dp).

Works on Paper, Fabric, and Bridgeless / new arch. Skips RN primitives and common library wrappers to surface meaningful components.

**Best for:** layout debugging ("where exactly is each ancestor positioned?"), props/handler inspection ("what fires when this Pressable is pressed?"), and rapid/repeated calls (no overlay flicker).

## get_inspector_selection

Identity + RICH STYLE per ancestor at (x, y). Invokes RN's Element Inspector programmatically (briefly toggles the overlay on, captures, hides it again — no screenshot pollution). Returns the same data the on-device overlay shows: full curated hierarchy where each entry has its own merged style (paddingHorizontal, borderRadius, fontFamily, etc.), plus the inspected element's frame and merged style.

```
get_inspector_selection with x=200 y=450
```

Coordinates are in points/dp. Works on Paper, Fabric, and Bridgeless / new arch (uses RN's owner-tree internals, not adb-tap routing).

- **With x/y:** toggles overlay on, captures the selection programmatically, hides overlay
- **Without coordinates:** returns the current selection from a manually-driven overlay

**Best for:** visual/styling debugging ("why is borderRadius 14 instead of 16?", "what padding does this card have?"). Use `inspect_at_point` if you need per-ancestor frames or non-style props.

## inspect_at_point vs get_inspector_selection — at a glance

| | `inspect_at_point` | `get_inspector_selection` |
|---|---|---|
| Frame | Per ancestor | Inspected element only |
| Style | Reference (no merging) | RICH per ancestor (padding, margin, border, layout) |
| Props | Full (handlers, refs, testID, custom) | None |
| Source paths | None | Pre-wired (null on React 19) |
| Overlay flicker | None — pure JS | ~600ms on→off |
| Best for | Layout, props, tight loops | Style, visual debugging |

## toggle_element_inspector

Toggle React Native's built-in Element Inspector overlay on/off.

```
toggle_element_inspector
```

Rarely needed directly — `get_inspector_selection` auto-toggles the overlay around its capture and hides it afterward. Use this only when you want the overlay to remain visible (e.g., capturing a user-facing screenshot of the inspector itself).

## get_images

Access the shared image buffer containing screenshots from all tools (`ios_screenshot`, `android_screenshot`, `ocr_screenshot`, tap verification).

```
get_images
```

Returns metadata only by default. Use `id` or `groupId` + `frameIndex` to retrieve actual image data. Tap burst verification stores frame groups here when `burst=true` is used.

## Recommended Workflows

### Understand What's on Screen

1. `get_screen_layout` — see all visible components with positions
2. `find_components(pattern="...")` — find specific components by name
3. `inspect_component(name="...")` — get full props, state, hooks for a component

### Identify a Component from a Screenshot

1. Take a screenshot (`ios_screenshot` / `android_screenshot`)
2. Estimate the target element's coordinates
3. `get_inspector_selection(x, y)` — get component hierarchy with file paths
4. Use the file path to find and edit the source code

### Debug Layout Issues

1. `get_screen_layout(extended=true)` — see positions and layout styles
2. `inspect_at_point(x, y)` — check frame measurements and props at a specific point
3. Compare actual frames against expected layout
