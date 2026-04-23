# Device Interaction & UI Automation

Control iOS Simulators and Android devices/emulators — screenshots, tap, swipe, text input, and more.

> **Note:** iOS hardware button presses (`ios_button`) require a UI driver — either [IDB](https://github.com/facebook/idb) or [AXe CLI](https://github.com/cameroncooke/AXe). See the [Platform Setup](../README.md#platform-setup) section for installation instructions.

## Unified `tap` Tool (Recommended)

The `tap` tool is the simplest way to interact with UI elements. It automatically tries multiple strategies and handles platform detection and coordinate conversion:

```
# By visible text — tries fiber tree, accessibility, then OCR
tap with text="Submit"

# By testID prop
tap with testID="login-btn"

# By React component name (fiber tree only)
tap with component="HamburgerIcon"

# By pixel coordinates from screenshot (auto-converts to points on iOS)
tap with x=300 y=600

# Force a specific strategy
tap with text="Menu" strategy="ocr"
```

**Fallback chain:** fiber tree (direct `onPress`) → accessibility tree → OCR → error with suggestion.

On failure, the response includes an actionable `suggestion` telling the agent exactly what to try next.

**Screenshot & verification:** By default, `tap` captures and returns a post-tap screenshot (`screenshot=true`). For coordinate, accessibility, and OCR strategies, it also runs a before/after screenshot diff to verify the tap had a meaningful visual effect (`verify=true` by default for these strategies, `false` for fiber). Set `screenshot=false` to skip screenshots entirely for fastest execution, or `verify=false` to skip the diff check.

## Platform-Specific Tools

For gestures beyond tapping, use platform-specific tools:

```
# Swipe (Android)
android_swipe with startX=540 startY=1500 endX=540 endY=500

# Text input on Android (tap input field first)
tap with text="Email"
android_input_text with text="hello@example.com"

# On iOS, tap a text field and use `tap(text=...)` — the fiber tree handles TextInput focus.

# Key events
android_key_event with key="BACK"
ios_button with button="HOME"
```

## Wait for Screen Transitions

Poll for a component to appear using `find_components` inside a short retry loop, or
re-call `get_screen_layout` after an expected navigation event to confirm the target
screen is visible.

## Android (requires ADB)

List connected devices:

```
list_android_devices
```

Take a screenshot:

```
android_screenshot
```

Tap on screen:

```
tap with x=540 y=960
```

Swipe gesture:

```
android_swipe with startX=540 startY=1500 endX=540 endY=500
```

Type text (tap input field first):

```
tap with x=540 y=400
android_input_text with text="hello@example.com"
```

Send key events:

```
android_key_event with key="BACK"
android_key_event with key="HOME"
android_key_event with key="ENTER"
```

## iOS Simulator (requires Xcode)

List available simulators:

```
list_ios_simulators
```

Boot a simulator:

```
ios_boot_simulator with udid="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
```

Take a screenshot:

```
ios_screenshot
```

Launch an app:

```
ios_launch_app with bundleId="com.example.myapp"
```

Open a deep link:

```
ios_open_url with url="myapp://settings"
```


