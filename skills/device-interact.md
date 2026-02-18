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

**Tap by element (preferred for known elements):**
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
- Always use `ocr_screenshot` first when you need to find and tap text elements
- Use `wait_for_element` after navigation to ensure the next screen is ready before interacting
- For Android, the Back button is available via `android_key_event` with key "BACK"
- `ios_open_url` works for both custom scheme deep links (`myapp://`) and universal links (`https://`) — use it to test deep link routing without manually typing URLs in the device
- Use `android_get_screen_size` before computing swipe coordinates on physical devices where screen resolution varies
