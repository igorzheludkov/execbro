# Device Interact Skill

Interact with running iOS simulators and Android emulators/devices: tap, swipe, type text, press buttons, and navigate the app UI.

## When to Trigger

Use this skill when the task involves:
- Tapping buttons, links, or UI elements on the device
- Swiping or scrolling through content
- Typing text into input fields
- Pressing hardware buttons (Home, Back, etc.)
- Navigating through the app by interacting with the UI
- Automating a sequence of user interactions for testing
- Verifying UI behavior after code changes
- Reproducing a user-reported bug through specific interaction steps

## Instructions

### 1. Discover Available Devices

First, check what devices are running:
- Use `mcp__rn-debugger-local__list_ios_simulators` to find iOS simulators
- Use `mcp__rn-debugger-local__list_android_devices` to find Android devices/emulators

### 2. See What's on Screen

Before interacting, understand the current screen:

**OCR approach (recommended for tapping text/buttons):**
- Use `mcp__rn-debugger-local__ocr_screenshot` with `platform` to get all visible text with tap coordinates
- This returns ready-to-use `tapX`/`tapY` values for each text element

**Accessibility tree approach:**
- Use `mcp__rn-debugger-local__ios_describe_all` or `mcp__rn-debugger-local__android_describe_all` for full UI hierarchy
- Use `ios_describe_point` / `android_describe_point` for element info at specific coordinates

**Screenshot approach:**
- Use `mcp__rn-debugger-local__ios_screenshot` or `mcp__rn-debugger-local__android_screenshot` for visual reference

### 3. Interact with Elements

**Press via React Fiber (preferred — works even without accessibility labels):**
- `mcp__rn-debugger-local__press_element` — invokes `onPress` directly via the JS fiber tree
- Match by `text` (case-insensitive partial match), `testID` (exact), or `component` name (case-insensitive partial)
- Use `index` param when multiple elements match (0-based, default: 0)
- Only works in `__DEV__` mode; only finds elements on the **visible** screen (hidden nav screens are skipped)

**Fallback chain for pressing buttons:**
1. `press_element(text="Login")` — try text match first
2. If text fails (icon-only buttons): use `find_components` to discover component names, then `press_element(component="ButtonName", index=N)`
3. If `press_element` fails entirely + has visible text → `ocr_screenshot` → `ios_tap`/`android_tap` with coordinates
4. If `press_element` fails + no visible text → `ios_tap_element`/`android_tap_element` (accessibility tree)
5. Coordinate-based `ios_tap`/`android_tap` as last resort

**Icon-only buttons (no text inside the pressable):**
- `press_element(text=...)` will fail because the label is outside the pressable component
- Use `find_components` with a pattern related to the button area (e.g., `Button|Action|Settings`)
- Then `press_element(component="DiscoveredName", index=N)` — check screenshot to pick the right index

**Tap by element (accessibility tree):**
- iOS: `mcp__rn-debugger-local__ios_tap_element` with `label` or `labelContains`
- Android: `mcp__rn-debugger-local__android_tap_element` with `text`, `textContains`, `contentDesc`, or `resourceId`

**Tap by coordinates (from OCR or screenshot):**
- iOS: `mcp__rn-debugger-local__ios_tap` with x/y
- Android: `mcp__rn-debugger-local__android_tap` with x/y

**Long press:**
- Android: `mcp__rn-debugger-local__android_long_press` with x/y and optional duration

**Swipe/scroll:**
- iOS: `mcp__rn-debugger-local__ios_swipe` with start/end coordinates
- Android: `mcp__rn-debugger-local__android_swipe` with start/end coordinates

**Type text:**
- iOS: `mcp__rn-debugger-local__ios_input_text` (tap input field first)
- Android: `mcp__rn-debugger-local__android_input_text` (tap input field first)

**Hardware buttons:**
- iOS: `mcp__rn-debugger-local__ios_button` (HOME, LOCK, SIDE_BUTTON, SIRI, APPLE_PAY)
- Android: `mcp__rn-debugger-local__android_key_event` (HOME, BACK, ENTER, DEL, MENU, etc.)

**Key events:**
- iOS: `mcp__rn-debugger-local__ios_key_event` / `ios_key_sequence` with keycodes

**Deep links:**
- iOS: `mcp__rn-debugger-local__ios_open_url` with the full URL (e.g., `myapp://settings/profile` or `https://example.com`)
- Use this to test deep link routing, universal links, or open specific app screens directly

### 4. Get Screen Dimensions (when needed for coordinates)

When calculating swipe distances or tap positions on an unfamiliar device:
- Android: `mcp__rn-debugger-local__android_get_screen_size` returns the device's pixel resolution
- Use this before computing percentage-based coordinates (e.g., center = width/2, height/2)
- For iOS simulators, the resolution is part of the simulator spec — use `list_ios_simulators` to identify the device model

### 5. Wait for UI Updates

After navigation or interactions that change the screen:
- iOS: `mcp__rn-debugger-local__ios_wait_for_element` to wait for an element to appear
- Android: `mcp__rn-debugger-local__android_wait_for_element` to wait for an element to appear
- Then use `find_element` to get coordinates before tapping

### 6. Verify Results

After interactions, verify the result:
- Take a screenshot to confirm the expected screen
- Use OCR to verify text content changed
- Check logs for any errors triggered by the interaction

## Arguments

- `$ARGUMENTS` - Optional: describe the interaction to perform (e.g., "tap Settings button", "scroll down", "type hello in search")

## Usage Examples

- `/device-interact` - Show available devices and current screen content
- `/device-interact "tap the Settings button"` - Find and tap the Settings button
- `/device-interact "scroll down on the main screen"` - Perform a swipe-up gesture
- `/device-interact "type test@email.com in the email field"` - Tap email field and type text
- `/device-interact "open myapp://profile/123"` - Open a deep link in the iOS simulator
- `/device-interact "get screen size"` - Get the Android device's pixel resolution

## MCP Tools Used

- `mcp__rn-debugger-local__press_element`
- `mcp__rn-debugger-local__find_components`
- `mcp__rn-debugger-local__list_ios_simulators`
- `mcp__rn-debugger-local__list_android_devices`
- `mcp__rn-debugger-local__ocr_screenshot`
- `mcp__rn-debugger-local__ios_screenshot` / `android_screenshot`
- `mcp__rn-debugger-local__ios_describe_all` / `android_describe_all`
- `mcp__rn-debugger-local__ios_describe_point` / `android_describe_point`
- `mcp__rn-debugger-local__ios_tap` / `android_tap`
- `mcp__rn-debugger-local__ios_tap_element` / `android_tap_element`
- `mcp__rn-debugger-local__android_long_press`
- `mcp__rn-debugger-local__ios_swipe` / `android_swipe`
- `mcp__rn-debugger-local__ios_input_text` / `android_input_text`
- `mcp__rn-debugger-local__ios_button` / `android_key_event`
- `mcp__rn-debugger-local__ios_key_event` / `ios_key_sequence`
- `mcp__rn-debugger-local__ios_find_element` / `android_find_element`
- `mcp__rn-debugger-local__ios_wait_for_element` / `android_wait_for_element`
- `mcp__rn-debugger-local__ios_open_url`
- `mcp__rn-debugger-local__android_get_screen_size`

## Notes

- Requires the rn-debugger-local MCP server to be running
- iOS simulator interactions require IDB (`brew install idb-companion`)
- **Prefer `press_element` over OCR/accessibility for pressing buttons** — it works directly via the JS fiber tree, is faster, and handles icon-only buttons that lack accessibility labels
- For icon-only buttons: `press_element(text=...)` will fail → use `find_components` to discover component names → then `press_element(component=..., index=N)`
- **Non-ASCII text limitation**: `press_element(text=...)` only supports ASCII due to Hermes. For localized UIs (Cyrillic, CJK, Arabic, etc.), use `testID` or `component` params, or fall back to `ocr_screenshot` → coordinate tap
- Use `ocr_screenshot` only as a fallback when `press_element` fails and the target has visible text
- Use `wait_for_element` after navigation to ensure the next screen is ready before interacting
- For Android, the Back button is available via `android_key_event` with key "BACK"
- `ios_open_url` works for both custom scheme deep links (`myapp://`) and universal links (`https://`) — use it to test deep link routing without manually typing URLs in the device
- Use `android_get_screen_size` before computing swipe coordinates on physical devices where screen resolution varies
