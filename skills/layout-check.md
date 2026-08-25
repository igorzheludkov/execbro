# Layout Check Skill

Capture screenshots from running React Native devices to verify layout changes.

## When to Trigger

**Auto-trigger after code changes:** When you modify any style, layout, or UI component code, automatically run this skill to capture a screenshot and verify the change visually — do not wait for the user to ask. This includes fixing padding, margins, safe areas, colors, font sizes, component structure, or any visual property.

Also use this skill when the task involves:
- Verifying layout changes after modifying UI code
- Comparing how the app looks across different device sizes (iPhone, iPad, Android)
- Checking responsive layout behavior
- Visual regression testing after style changes
- Comparing the app against a Figma design

## Instructions

When this skill is invoked, follow these steps:

### 1. Discover Running Devices

First, check what devices are available:

- Use `mcp__execbro__list_devices` to find running simulators, emulators, and connected devices

### 2. Read the Screen State First

Before capturing anything, get a screenshot-free read of what's on screen:

- Use `mcp__execbro__get_screen_state` — returns the active route + navigation stack, groups elements behind an open overlay or raised keyboard (taps will NOT reach those until it closes), and lists every on-screen element — pressables (component tag, label, testID, onPress hint), text, images — each with a tap-ready `(x, y)` centre and frame
- This answers "which screen am I on, what text/prices are rendered, which image loaded" without a screenshot + OCR round trip, and it is the right call after any tap or navigation to orient
- Use `pressablesOnly=true` for the lean tappable-only list, `fullText=true` to disable the 80-char text truncation

### 3. Take Screenshots

Based on what's running, capture screenshots:

**For iOS Simulators:**
- Use `mcp__execbro__ios_screenshot` with the simulator UDID
- Capture from both iPhone and iPad if both are running (important for responsive layouts)

**For Android Devices:**
- Use `mcp__execbro__android_screenshot` with the device serial

**Screenshot with OCR (when you need tap coordinates):**
- Use `mcp__execbro__ocr_screenshot` to capture a screenshot and extract all visible text with tap-ready coordinates
- Recommended when you need to identify tappable elements — returns ready-to-use tapX/tapY coordinates

### 4. Present Results

- Display all captured screenshots to the user
- If multiple devices are captured, clearly label each (e.g., "iPhone 16 Pro", "iPad Pro 13-inch")
- Point out any visible layout issues or differences between device sizes

### 5. Optional: Inspect Layout Details

If a screenshot reveals a layout issue and you need precise measurements:
- Pick by question:
  - **Layout/measurement question** ("why is this clipped?", "what's the actual size?", "what handler fires here?") → `mcp__execbro__inspect_at_point(x, y)`. Returns FRAME PER ANCESTOR plus PROPS (handlers, refs, testID). Pure JS hit test — no overlay flicker, fast.
  - **Style question** ("why is the borderRadius wrong?", "what padding does this card have?") → `mcp__execbro__inspect_at_point(x, y)`. Returns the node's own style object plus every ancestor's frame, and `source: {file, line, column}` so you can open the owning file directly rather than searching for the component. Style is not a merged cascade — when a value isn't on the node itself, walk the ancestors it returns.
- Both tools work on Bridgeless / new arch and on Paper/Fabric.
- Coordinates need no conversion: `get_screen_state`, `get_screen_layout`, `measure`, `inspect_at_point`, screenshots and `tap` all share one screen-space coordinate system, so a coordinate from any of them goes to any other unchanged.
- On a modal-sheet screen (`presentation:'modal'`) UIKit insets the screen from the top of the window and React Native's measurements do not include that inset. All of these tools correct for it, derived from the sheet's own measured height, so they keep agreeing with each other and with the screenshot; `get_screen_state` names the correction when it applies.

### 6. Optional: Compare with Design

If the user provides a Figma URL or design reference:
- Use the Figma MCP tools to fetch the design
- Compare the screenshot against the design
- Highlight any discrepancies

## Arguments

- `$ARGUMENTS` - Optional: specific device type to capture (e.g., "iphone", "ipad", "android", "all")

## Usage Examples

- `/layout-check` - Capture from all running devices
- `/layout-check iphone` - Capture only from iPhone simulators
- `/layout-check ipad` - Capture only from iPad simulators
- `/layout-check android` - Capture only from Android devices

## MCP Tools Used

- `mcp__execbro__list_devices`
- `mcp__execbro__get_screen_state` (screenshot-free route + element read — start here)
- `mcp__execbro__ios_screenshot`
- `mcp__execbro__android_screenshot`
- `mcp__execbro__inspect_at_point` (optional: per-ancestor frames + props at coordinates)
- `mcp__execbro__ocr_screenshot` (screenshot + OCR text with tap coordinates)

## Notes

- This skill requires the ExecBro MCP server to be running
- Devices must be booted and the app must be running
- For iPad testing, ensure both portrait and landscape are considered if relevant
- **MCP server alias note:** examples use the alias `execbro` (tools prefixed `mcp__execbro__`). If you previously registered the server with the older alias `rn-ai-devtools`, substitute `mcp__rn-ai-devtools__` in these examples — both work, only the alias differs.
