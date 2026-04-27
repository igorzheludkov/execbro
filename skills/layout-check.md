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

- Use `mcp__rn-ai-devtools__list_ios_simulators` to find running iOS simulators
- Use `mcp__rn-ai-devtools__list_android_devices` to find connected Android devices/emulators

### 2. Take Screenshots

Based on what's running, capture screenshots:

**For iOS Simulators:**
- Use `mcp__rn-ai-devtools__ios_screenshot` with the simulator UDID
- Capture from both iPhone and iPad if both are running (important for responsive layouts)

**For Android Devices:**
- Use `mcp__rn-ai-devtools__android_screenshot` with the device serial

**Screenshot with OCR (when you need tap coordinates):**
- Use `mcp__rn-ai-devtools__ocr_screenshot` to capture a screenshot and extract all visible text with tap-ready coordinates
- Recommended when you need to identify tappable elements — returns ready-to-use tapX/tapY coordinates

### 3. Present Results

- Display all captured screenshots to the user
- If multiple devices are captured, clearly label each (e.g., "iPhone 16 Pro", "iPad Pro 13-inch")
- Point out any visible layout issues or differences between device sizes

### 4. Optional: Inspect Layout Details

If a screenshot reveals a layout issue and you need precise measurements:
- Pick by question:
  - **Layout/measurement question** ("why is this clipped?", "what's the actual size?", "what handler fires here?") → `mcp__rn-ai-devtools__inspect_at_point(x, y)`. Returns FRAME PER ANCESTOR plus PROPS (handlers, refs, testID). Pure JS hit test — no overlay flicker, fast.
  - **Style question** ("why is the borderRadius wrong?", "what padding does this card have?") → `mcp__rn-ai-devtools__get_inspector_selection(x, y)`. Returns RN's curated hierarchy with merged style per ancestor (paddingHorizontal, borderRadius, fontFamily, etc.). Briefly toggles RN's Element Inspector on→off around the capture.
- Both tools work on Bridgeless / new arch and on Paper/Fabric.

### 5. Optional: Compare with Design

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

- `mcp__rn-ai-devtools__list_ios_simulators`
- `mcp__rn-ai-devtools__list_android_devices`
- `mcp__rn-ai-devtools__ios_screenshot`
- `mcp__rn-ai-devtools__android_screenshot`
- `mcp__rn-ai-devtools__inspect_at_point` (optional: per-ancestor frames + props at coordinates)
- `mcp__rn-ai-devtools__ocr_screenshot` (screenshot + OCR text with tap coordinates)
- `mcp__rn-ai-devtools__get_inspector_selection` (optional: identity + rich style per ancestor at coordinates)

## Notes

- This skill requires the rn-ai-devtools MCP server to be running
- Devices must be booted and the app must be running
- For iPad testing, ensure both portrait and landscape are considered if relevant
