# Device Interaction & UI Automation

Control iOS Simulators and Android devices/emulators — screenshots, tap, swipe, text input, and more.

> **Note:** Many iOS interaction tools (swipe, text input, accessibility queries) require [IDB](https://github.com/facebook/idb). See the [Platform Setup](../README.md#platform-setup) section for installation instructions.

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
# Swipe
ios_swipe with startX=200 startY=400 endX=200 endY=100
android_swipe with startX=540 startY=1500 endX=540 endY=500

# Text input (tap input field first)
tap with text="Email"
ios_input_text with text="hello@example.com"

# Key events
android_key_event with key="BACK"
ios_button with button="HOME"
```

## Wait for Screen Transitions

```
android_wait_for_element with text="Dashboard" timeoutMs=15000
ios_wait_for_element with label="Home" timeoutMs=10000
```

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


