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
- Use `mcp__rn-ai-devtools__list_ios_simulators` to find iOS simulators
- Use `mcp__rn-ai-devtools__list_android_devices` to find Android devices/emulators

### 2. See What's on Screen

Before interacting, understand the current screen:

**Screenshot approach (recommended first step):**
- Use `mcp__rn-ai-devtools__ios_screenshot` or `mcp__rn-ai-devtools__android_screenshot` for visual reference

**Component tree approach (for finding React Native elements without screenshots):**
- Use `mcp__rn-ai-devtools__get_screen_layout` for an indented tree of visible components with positions, text, and identifiers
- Use `mcp__rn-ai-devtools__find_components` to regex-search the fiber tree for a specific component by name

### 3. Tap Elements

**Use the unified `tap` tool for all tapping — it auto-detects the platform and tries multiple strategies automatically:**

- `mcp__rn-ai-devtools__tap` — single cross-platform tool with automatic fallback chain:
  1. Fiber tree (direct `onPress` invocation)
  2. Accessibility tree (native element matching)
  3. OCR (visual text recognition)
  4. Error with actionable suggestion

**By visible text:**
```
tap(text="Login")          # case-insensitive substring match
tap(text="Submit")
```

**By testID prop:**
```
tap(testID="login-btn")    # exact match
```

**By React component name:**
```
tap(component="MenuIcon")  # case-insensitive substring match
```

**By pixel coordinates (from screenshot):**
```
tap(x=300, y=600)          # auto-converts pixels to points on iOS
tap(x=300, y=600, platform="android")  # explicit platform when both are connected
```

**Native mode (no React Native connection needed):**
```
tap(x=300, y=600, native=true)            # taps directly via ADB/simctl
tap(x=300, y=600, native=true, platform="android")  # explicit platform
```
Use `native=true` when tapping system dialogs, non-RN apps, or before establishing a React Native connection. Requires x/y coordinates. Platform is auto-detected if not specified.

**Force a specific strategy:**
```
tap(text="Settings", strategy="ocr")           # skip fiber/accessibility
tap(text="Submit", strategy="accessibility")   # skip fiber
```

**Multiple matches — use index:**
```
tap(text="Button", index=2)   # tap the 3rd match (0-based)
```

**Control screenshots and verification:**
```
tap(text="Submit", screenshot=false)       # skip post-tap screenshot for faster execution
tap(x=300, y=600, verify=true)             # before/after diff to confirm tap had visual effect
tap(text="Login", verify=false)            # skip verification (default for fiber strategy)
```
`screenshot` (default: true) controls whether a post-tap screenshot is returned. `verify` (default: true for coordinate/accessibility/ocr, false for fiber) runs a before/after screenshot diff to detect if the tap caused a meaningful visual change.

**Deeply wrapped components — increase traversal depth:**
```
tap(component="CartIcon", maxTraversalDepth=25)   # default is 15
```
Use `maxTraversalDepth` when `tap(component=...)` fails because the component is deeply wrapped in HOCs or animation wrappers.

**On failure**, the response includes a `suggestion` field telling you exactly what to try next. Follow it.

**Non-ASCII text** (Cyrillic, CJK, Arabic): `tap` automatically skips fiber (Hermes limitation) and uses accessibility/OCR. For best results, use `testID` or `component` params instead.

**Icon-only buttons** (no text label): Use `tap(component="ComponentName")`. Use `find_components` first to discover component names. If that fails, use screenshot coordinates: `tap(x=..., y=...)`.

### 4. Other Interactions

**Long press:**
- Android: `mcp__rn-ai-devtools__android_long_press` with x/y and optional duration

**Swipe/scroll:**
- Android: `mcp__rn-ai-devtools__android_swipe` with start/end coordinates
- iOS: no dedicated swipe tool — use `tap(x=, y=)` for interactions and scroll by tapping scroll targets, or rely on the app's own navigation

**Type text:**
- iOS: use `mcp__rn-ai-devtools__tap` with `text=` or `testID=` on the `TextInput` — the fiber tree strategy focuses the input natively. For the value itself, set it via state (e.g., `execute_in_app`) or rely on existing focus + native keyboard
- Android: `mcp__rn-ai-devtools__android_input_text` (tap input field first)

**Hardware buttons:**
- iOS: `mcp__rn-ai-devtools__ios_button` (HOME, LOCK, SIDE_BUTTON, SIRI, APPLE_PAY)
- Android: `mcp__rn-ai-devtools__android_key_event` (HOME, BACK, ENTER, DEL, MENU, etc.)

**Deep links:**
- iOS: `mcp__rn-ai-devtools__ios_open_url` with the full URL (e.g., `myapp://settings/profile` or `https://example.com`)

### 5. Get Screen Dimensions (when needed for coordinates)

When calculating swipe distances or tap positions on an unfamiliar device:
- Android: `mcp__rn-ai-devtools__android_get_screen_size` returns the device's pixel resolution
- Use this before computing percentage-based coordinates (e.g., center = width/2, height/2)
- For iOS simulators, the resolution is part of the simulator spec — use `list_ios_simulators` to identify the device model

### 6. Wait for UI Updates

After navigation or interactions that change the screen, poll the UI by re-calling
`mcp__rn-ai-devtools__get_screen_layout` (or `find_components`) in a short retry
loop until the expected component shows up.

### 7. Verify Results

After interactions, verify the result:
- Take a screenshot to confirm the expected screen
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

- `mcp__rn-ai-devtools__tap`
- `mcp__rn-ai-devtools__find_components`
- `mcp__rn-ai-devtools__list_ios_simulators`
- `mcp__rn-ai-devtools__list_android_devices`
- `mcp__rn-ai-devtools__ios_screenshot` / `android_screenshot`
- `mcp__rn-ai-devtools__get_screen_layout`
- `mcp__rn-ai-devtools__inspect_at_point`
- `mcp__rn-ai-devtools__android_long_press`
- `mcp__rn-ai-devtools__android_swipe`
- `mcp__rn-ai-devtools__android_input_text`
- `mcp__rn-ai-devtools__ios_button` / `android_key_event`
- `mcp__rn-ai-devtools__ios_open_url`
- `mcp__rn-ai-devtools__android_get_screen_size`

## Notes

- Requires the rn-ai-devtools MCP server to be running
- iOS simulator interactions require IDB (`brew install idb-companion`) or AXe CLI (`brew install cameroncooke/axe/axe`). Set `IOS_DRIVER=axe` env var to use AXe.
- **Always use `tap` for tapping** — it handles platform detection, coordinate conversion, and fallback strategies automatically. Use `native=true` for system UI or non-RN apps
- On failure, follow the `suggestion` field in the tap response — it tells you exactly what to try next
- Poll with `get_screen_layout` (or `find_components`) after navigation to ensure the next screen is ready before interacting
- For Android, the Back button is available via `android_key_event` with key "BACK"
- `ios_open_url` works for both custom scheme deep links (`myapp://`) and universal links (`https://`)
- Use `android_get_screen_size` before computing swipe coordinates on physical devices where screen resolution varies
