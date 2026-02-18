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
- Use `mcp__rn-debugger-local__ensure_connection` to check/establish connection
- If not connected, use `mcp__rn-debugger-local__scan_metro` to find and connect to Metro

### 2. Get Component Tree Overview

Start with a lightweight structure view:
- Use `mcp__rn-debugger-local__get_component_tree` with `focusedOnly=true` and `structureOnly=true`
- This gives a compact view (~1-2KB) of just the active screen, skipping navigation wrappers

### 3. Drill Down into Specific Components

Based on the task, inspect individual components:

**By component name:**
- Use `mcp__rn-debugger-local__inspect_component` with `componentName` to see props, state, and hooks
- Use `includeChildren=true` with `childrenDepth=2` to see nested structure
- Use `includeState=true` (default) to see hook values

**By pattern search:**
- Use `mcp__rn-debugger-local__find_components` with regex `pattern` to find components
- Use `includeLayout=true` to get padding/margin/flex styles for matched components

**By screen coordinates:**
- Use `mcp__rn-debugger-local__get_inspector_selection` with x/y coordinates to find the component at a specific point
- Alternatively, use `mcp__rn-debugger-local__inspect_at_point` for direct coordinate inspection

### 4. Get Layout Details

For layout debugging:
- Use `mcp__rn-debugger-local__get_screen_layout` for full layout data of all screen components
- Use `mcp__rn-debugger-local__find_components` with `includeLayout=true` for targeted layout info
- Use `componentsOnly=true` on `get_screen_layout` to hide host components (View, Text) and see only custom components

### 5. Element Inspector Mode

For interactive inspection:
- Use `mcp__rn-debugger-local__toggle_element_inspector` to enable/disable the visual inspector overlay
- Use `mcp__rn-debugger-local__get_inspector_selection` to read the currently selected component

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

- `mcp__rn-debugger-local__ensure_connection`
- `mcp__rn-debugger-local__scan_metro`
- `mcp__rn-debugger-local__get_component_tree`
- `mcp__rn-debugger-local__inspect_component`
- `mcp__rn-debugger-local__find_components`
- `mcp__rn-debugger-local__get_screen_layout`
- `mcp__rn-debugger-local__get_inspector_selection`
- `mcp__rn-debugger-local__inspect_at_point`
- `mcp__rn-debugger-local__toggle_element_inspector`

## Notes

- Requires the rn-debugger-local MCP server to be running and connected to the app
- Always start with `structureOnly=true` to get an overview before drilling down
- `inspect_at_point` may not work in newer React Native versions with Fabric - use `get_inspector_selection` instead
- Layout data can be large for complex screens - use `find_components` with `includeLayout=true` for targeted queries
