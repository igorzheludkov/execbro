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
- Use `mcp__execbro__ensure_connection` to check/establish connection
- If not connected, use `mcp__execbro__scan_metro` to find and connect to Metro

### 2. Get Component Tree Overview

Start with a lightweight structure view:
- Use `mcp__execbro__get_component_tree` with `focusedOnly=true` and `structureOnly=true`
- This gives a compact view (~1-2KB) of just the active screen, skipping navigation wrappers
- Use `hideInternals=true` (default) to filter out RN internal components (RCTView, RNS*, Animated)
- Output format defaults to `compact` (~5-6x smaller than JSON); use `format="json"` if you need structured data

### 3. Drill Down into Specific Components

Based on the task, inspect individual components:

**By component name:**
- Use `mcp__execbro__inspect_component` with `componentName` to see props, state, and hooks
- Use `includeChildren=true` with `childrenDepth=2` to see nested structure
- Use `includeState=true` (default) to see hook values

**By pattern search:**
- Use `mcp__execbro__find_components` with regex `pattern` to find components
- Use `includeLayout=true` to get padding/margin/flex styles for matched components

**By screen coordinates — pick the tool by what you need:**
1. Take a screenshot (`ios_screenshot` / `android_screenshot`) or use `ocr_screenshot` to see the current screen
2. Identify the target element visually and read off its coordinates — no conversion needed: screenshots, `get_screen_state`, `get_screen_layout`, `measure`, `inspect_at_point` and `tap` all share one screen-space coordinate system, so a coordinate from any of them goes to any other unchanged
3. Call `mcp__execbro__inspect_at_point(x, y)`. Pure JS hit test — no overlay flicker. Returns identity, FRAME PER ANCESTOR, full PROPS (handlers as `[Function]`, refs, testID, custom props), the node's own style, and `source: {file, line, column}` plus the owner chain.

### 4. Get Layout Details

For layout debugging:
- Use `mcp__execbro__get_screen_state` for a screenshot-free orientation pass — active route + navigation stack, any open overlay or raised keyboard (taps will NOT reach elements grouped behind those), and every on-screen element (pressables with component tag/label/testID/onPress hint, text, images) with a tap-ready `(x, y)` centre and frame. Call it after any tap or navigation before drilling in
- Use `mcp__execbro__get_screen_layout` for full layout data of all screen components
- Use `mcp__execbro__find_components` with `includeLayout=true` for targeted layout info
- Use `componentsOnly=true` on `get_screen_layout` to hide host components (View, Text) and see only custom components

### 5. When to use which inspection tool

- `inspect_at_point(x, y)` → identity + FRAME PER ANCESTOR + PROPS (handlers, refs, testID) + style + source file:line — answers "what is this, where exactly is each ancestor, and what does this Pressable do?". Pure JS, no overlay flicker.
- `find_components(pattern)` → searching for components by name pattern across the entire fiber tree.
- `inspect_component(name)` → props, state, and hooks for a named component.

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

- `mcp__execbro__ensure_connection`
- `mcp__execbro__scan_metro`
- `mcp__execbro__get_component_tree`
- `mcp__execbro__inspect_component`
- `mcp__execbro__find_components`
- `mcp__execbro__get_screen_state`
- `mcp__execbro__get_screen_layout`
- `mcp__execbro__inspect_at_point`

## Notes

- Requires the ExecBro MCP server to be running and connected to the app
- Always start with `structureOnly=true` to get an overview before drilling down
- All layout tools share one screen-space coordinate system — `get_screen_state`, `get_screen_layout`, `measure`, `inspect_at_point`, screenshots and `tap` speak the same coordinates. Pass a coordinate from any of them to any other unchanged; there is no pixel→point conversion to do.
- `inspect_at_point` works on Paper, Fabric, and Bridgeless / new arch.
- `inspect_at_point` returns frame per ancestor + props (handlers, refs, custom props). Pure JS — no overlay toggle, no visual side effect. Style is the node's own style object, not RN's merged cascade — when a value looks wrong and isn't on the node, walk the ancestors it returns.
- `inspect_at_point` returns `source: {file, line, column}` — the absolute path and line where the component is rendered — plus the owner chain as `Source ancestors`. Resolved from the fiber's `_debugStack` via Metro symbolication, so it works on React 19 where `_debugSource` was dropped. `node_modules` frames are filtered out, so you land on your own code. If Metro is unreachable the response carries `sourceUnavailable` and identity + props are still returned. Pass `source=false` to skip resolution in tight loops.
- Layout data can be large for complex screens - use `find_components` with `includeLayout=true` for targeted queries
- Use `device` param on any tool to target a specific device when multiple are connected (case-insensitive substring match, e.g. `device="iPhone"`)
- **MCP server alias note:** examples use the alias `execbro` (tools prefixed `mcp__execbro__`). If you previously registered the server with the older alias `rn-ai-devtools`, substitute `mcp__rn-ai-devtools__` in these examples — both work, only the alias differs.
