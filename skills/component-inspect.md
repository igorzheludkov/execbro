# Component Inspect Skill

Inspect the React component tree, props, state, and layout styles in the running React Native app.

## When to Trigger

Use this skill when the task involves:
- Understanding the component hierarchy of the current screen
- Inspecting a specific component's props, state, or hooks
- Debugging layout issues (padding, margin, flex, positioning)
- Finding which component renders a specific UI element
- Understanding how components are nested or composed
- Checking component styles at runtime

## Instructions

### 1. Ensure Connection

First, verify the debugger is connected:
- Use `mcp__rn-ai-devtools__ensure_connection` to check/establish connection
- If not connected, use `mcp__rn-ai-devtools__scan_metro` to find and connect to Metro

### 2. Get Component Tree Overview

Start with a lightweight structure view:
- Use `mcp__rn-ai-devtools__get_component_tree` with `focusedOnly=true` and `structureOnly=true`
- This gives a compact view (~1-2KB) of just the active screen, skipping navigation wrappers
- Use `hideInternals=true` (default) to filter out RN internal components (RCTView, RNS*, Animated)
- Output format defaults to `tonl` (compact, ~40% smaller than JSON); use `format="json"` if you need structured data

### 3. Drill Down into Specific Components

Based on the task, inspect individual components:

**By component name:**
- Use `mcp__rn-ai-devtools__inspect_component` with `componentName` to see props, state, and hooks
- Use `includeChildren=true` with `childrenDepth=2` to see nested structure
- Use `includeState=true` (default) to see hook values

**By pattern search:**
- Use `mcp__rn-ai-devtools__find_components` with regex `pattern` to find components
- Use `includeLayout=true` to get padding/margin/flex styles for matched components

**By screen coordinates (preferred for identifying components):**
1. Take a screenshot (`ios_screenshot` / `android_screenshot`) or use `ocr_screenshot` to see the current screen
2. Identify the target element visually and estimate its coordinates (convert screenshot pixels to points: divide by device pixel ratio)
3. Use `mcp__rn-ai-devtools__get_inspector_selection` with x/y coordinates — returns a clean component hierarchy with file paths (e.g. `HomeScreen(./(tabs)/index.tsx) > SneakerCard > PulseActionButton`). Auto-enables the Element Inspector overlay, taps at coordinates, and reads the result.
4. If you also need layout details (frame bounds, props, styles), use `mcp__rn-ai-devtools__inspect_at_point` with the same coordinates

### 4. Get Layout Details

For layout debugging:
- Use `mcp__rn-ai-devtools__get_screen_layout` for full layout data of all screen components
- Use `mcp__rn-ai-devtools__find_components` with `includeLayout=true` for targeted layout info
- Use `componentsOnly=true` on `get_screen_layout` to hide host components (View, Text) and see only custom components

### 5. Element Inspector Mode

`get_inspector_selection` auto-enables the inspector when called with coordinates, so `toggle_element_inspector` is rarely needed directly. Use it only when you want manual control over the overlay visibility.

**When to use which inspection tool:**
- `get_inspector_selection(x, y)` → finding component names and screen structure (returns clean hierarchy with file paths, like RN's Element Inspector overlay)
- `inspect_at_point(x, y)` → layout debugging with component props, exact frame measurements (position/size in dp), and component path
- `find_components(pattern)` → searching for components by name pattern across the entire fiber tree

### 6. Present Findings

- Show the component hierarchy in a clear tree format
- Highlight relevant props and state values
- For layout issues, show computed styles (padding, margin, flex, dimensions)
- Suggest code changes based on what you find

## Arguments

- `$ARGUMENTS` - Optional: component name to inspect, or "layout" for full layout dump, or "tree" for structure overview

## Usage Examples

- `/component-inspect` - Get the component tree of the current screen
- `/component-inspect Button` - Inspect all Button component instances
- `/component-inspect layout` - Get full layout information for the current screen
- `/component-inspect "Screen$"` - Find components whose names end with "Screen"

## MCP Tools Used

- `mcp__rn-ai-devtools__ensure_connection`
- `mcp__rn-ai-devtools__scan_metro`
- `mcp__rn-ai-devtools__get_component_tree`
- `mcp__rn-ai-devtools__inspect_component`
- `mcp__rn-ai-devtools__find_components`
- `mcp__rn-ai-devtools__get_screen_layout`
- `mcp__rn-ai-devtools__get_inspector_selection`
- `mcp__rn-ai-devtools__inspect_at_point`
- `mcp__rn-ai-devtools__toggle_element_inspector`

## Notes

- Requires the rn-ai-devtools MCP server to be running and connected to the app
- Always start with `structureOnly=true` to get an overview before drilling down
- Both `inspect_at_point` and `get_inspector_selection` work on Paper and Fabric (New Architecture)
- `inspect_at_point` returns the nearest user-defined component (skipping RN primitives and common library wrappers like Expo, SVG, gesture handler components)
- `get_inspector_selection` returns the most complete hierarchy with source file paths — prefer it when you need to find the exact component name to edit
- Layout data can be large for complex screens - use `find_components` with `includeLayout=true` for targeted queries
- Use `device` param on any tool to target a specific device when multiple are connected (case-insensitive substring match, e.g. `device="iPhone"`)
