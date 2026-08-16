# Device Interaction & UI Automation

Control iOS Simulators and Android devices/emulators — screenshots, tap, swipe, text input, and more.

> **Note:** iOS hardware button presses (`ios_button`) require a UI driver — either [IDB](https://github.com/facebook/idb) or [AXe CLI](https://github.com/cameroncooke/AXe). See the [Platform Setup](../README.md#platform-setup) section for installation instructions.

## Unified `tap` Tool (Recommended)

The `tap` tool is the simplest way to interact with UI elements. It automatically tries multiple strategies and handles platform detection. Coordinates need no conversion — `tap` shares one screen-space coordinate system with `get_screen_state`, `get_screen_layout`, `measure`, `inspect_at_point`, and the screenshot summaries, so a coordinate from any of them can be passed straight in:

```
# By visible text — tries fiber tree, accessibility, then OCR
tap with text="Submit"

# By testID prop
tap with testID="login-btn"

# By React component name (fiber tree only)
tap with component="HamburgerIcon"

# By coordinates from a screenshot or any layout tool — passed through unchanged
tap with x=300 y=600

# Force a specific strategy
tap with text="Menu" strategy="ocr"
```

**Fallback chain:** fiber tree (direct `onPress`) → accessibility tree → OCR → error with suggestion.

**Multi-device targeting:** when multiple simulators or devices are connected, pin the tap with `device` — a single param accepting an iOS simulator UDID, an Android adb serial, a simulator/emulator name, or the connected app's name (substring match, e.g. `device="iPhone SE"`). This mirrors `device` on `get_screen_layout`/`swipe` so the layout, screenshot, and follow-up tap all land on the same device. Run `list_devices` to enumerate.

On failure, the response includes an actionable `suggestion` telling the agent exactly what to try next.

**Screenshot & verification:** By default, `tap` captures and returns a post-tap screenshot (`screenshot=true`). For coordinate, accessibility, and OCR strategies, it also runs a before/after screenshot diff to verify the tap had a meaningful visual effect (`verify=true` by default for these strategies, `false` for fiber). Set `screenshot=false` to skip screenshots entirely for fastest execution, or `verify=false` to skip the diff check.

## Platform-Specific Tools

For gestures beyond tapping:

```
# Swipe (auto-routes to iOS/Android; returns verification.meaningful)
swipe with startX=540 startY=1500 endX=540 endY=500

# Pinch to zoom — ANDROID EMULATOR ONLY (iOS in progress)
pinch with direction="out"                       # zoom in at screen centre
pinch with direction="in"                        # zoom out
pinch with direction="out" x=250 y=650 scale=6   # zoom pivoting on a point
pinch with direction="in" span=0.3               # even smaller footprint, if a gesture lands on surrounding UI

# Text input, either platform — targets and focuses the field itself, no tap needed
input_text with testID="email" text="hello@example.com"

# On a screen with no RN connection at all (system dialog, non-RN screen), type into
# whatever the OS reports as focused — tap it first, then:
input_text with text="hello@example.com" native=true

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
list_devices
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
swipe with startX=540 startY=1500 endX=540 endY=500
```

Type text:

```
input_text with testID="email" text="hello@example.com"
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
list_devices
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


