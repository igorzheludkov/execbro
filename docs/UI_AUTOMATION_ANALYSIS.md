# UI Automation Integration Analysis

## Overview

This document analyzes the feasibility of adding UI automation capabilities to react-native-ai-debugger to enable combined debugging flows like: **tap button → capture logs → take screenshot**.

## Current State

| Project                  | Focus                                       | Platform       |
|--------------------------|---------------------------------------------|----------------|
| react-native-ai-debugger | Runtime debugging (logs, network, JS exec)  | Cross-platform |
| ios-simulator-mcp        | UI automation (tap, swipe, screenshots)     | iOS only       |

## Native Tool Capabilities

### Android (ADB) - Full Support, No Extra Dependencies

ADB comes bundled with Android SDK (already installed for RN developers).

| Capability   | Command                                            | Notes                    |
|--------------|----------------------------------------------------|--------------------------|
| Tap          | `adb shell input tap <x> <y>`                      | Coordinates in pixels    |
| Swipe        | `adb shell input swipe <x1> <y1> <x2> <y2> [ms]`   | Duration optional        |
| Text Input   | `adb shell input text "<string>"`                  | Escape spaces with `\ `  |
| Long Press   | `adb shell input swipe <x> <y> <x> <y> <duration>` | Same start/end coords    |
| Key Events   | `adb shell input keyevent <code>`                  | 3=HOME, 4=BACK, 66=ENTER |
| Screenshot   | `adb shell screencap -p /sdcard/screenshot.png`    | PNG format               |
| Video Record | `adb shell screenrecord /sdcard/video.mp4`         | Android 4.4+             |
| Install App  | `adb install <path.apk>`                           | -                        |
| Launch App   | `adb shell am start -n <package>/<activity>`       | -                        |
| List Devices | `adb devices`                                      | -                        |

### iOS (simctl) - Partial Support, No Extra Dependencies

`xcrun simctl` is built into Xcode.

| Capability     | Supported | Command                                            |
|----------------|:---------:|----------------------------------------------------|
| Screenshot     | Yes       | `xcrun simctl io booted screenshot <path>`         |
| Video Record   | Yes       | `xcrun simctl io booted recordVideo <path>`        |
| Install App    | Yes       | `xcrun simctl install booted <app.app>`            |
| Launch App     | Yes       | `xcrun simctl launch booted <bundle.id>`           |
| Open URL       | Yes       | `xcrun simctl openurl booted "<url>"`              |
| Clipboard      | Yes       | `xcrun simctl pbpaste booted` / `pbcopy`           |
| Permissions    | Yes       | `xcrun simctl privacy booted grant location <id>`  |
| **Tap/Swipe**  | **No**    | Not available in simctl                            |
| **Text Input** | **No**    | Not available in simctl                            |

### iOS (Facebook IDB) - Full Support, Requires Installation

[Facebook IDB](https://github.com/facebook/idb) exposes private Xcode frameworks via FBSimulatorControl.

Additional capabilities over simctl:
- Touch/tap input simulation
- Swipe gestures
- Text input
- Accessibility tree inspection (UI element discovery)

Installation: `brew install idb-companion`

#### Why IDB is Required for iOS Touch Input

iOS Simulator touch injection requires reverse-engineering Apple's private "Indigo" protocol. From [FBSimulatorControl docs](https://fbidb.io/docs/fbsimulatorcontrol/):

> "Indigo" is a service present in the iOS Simulator used to synthesize "Input Events"... This uses "mach" IPC, where data structures are sent using mach_msg_send... FBSimulatorControl's understanding of these data structures comes through **reverse engineering**.

**There is no simpler alternative.** Options comparison:

| Approach                   | Touch | Complexity | Notes                                |
|----------------------------|:-----:|:----------:|--------------------------------------|
| IDB                        | Yes   | Low        | `brew install idb-companion`         |
| FBSimulatorControl direct  | Yes   | High       | Same frameworks, requires Obj-C code |
| AppleScript + cliclick     | Hacky | Medium     | Clicks on window, not sim screen     |
| simctl                     | No    | N/A        | Not supported                        |

---

## Two Approaches to UI Automation

### Approach A: Coordinate-Based (Tap/Swipe Simulation)

Traditional UI automation using screen coordinates.

**Pros:**
- Works with any UI without code changes
- Can interact with system dialogs, third-party SDKs
- Flexible - just need screenshot + coordinates
- Mimics real user interaction

**Cons:**
- iOS requires IDB dependency
- Coordinates can break with UI changes
- Platform-specific implementations
- Slower (waits for UI rendering)

### Approach B: Programmatic Execution (JavaScript Calls)

Use existing `execute_in_app` to call functions directly via CDP.

```javascript
// Instead of tapping a button at coordinates:
global.debugActions.pressLoginButton()

// Instead of swiping to scroll:
global.listRef.scrollToIndex({ index: 10 })

// Trigger navigation:
global.navigation.navigate('Profile')

// Dispatch Redux action:
global.__REDUX_STORE__.dispatch({ type: 'LOAD_MORE' })
```

**Pros:**
- No additional dependencies (already implemented!)
- Cross-platform with same code
- More reliable (no coordinate calculation)
- Faster execution (no UI wait)
- More powerful automation (access to app internals)

**Cons:**
- Requires exposing global handlers in app code
- Need to modify app for each new action
- Cannot interact with system dialogs or third-party UI
- Doesn't test actual touch/gesture handling

**App Setup Required:**
```javascript
// In your React Native app (development only)
if (__DEV__) {
  global.debugActions = {
    scrollDown: () => listRef.current?.scrollToEnd(),
    tapLogin: () => handleLogin(),
    loadMore: () => fetchNextPage(),
    navigate: (screen) => navigation.navigate(screen),
    setState: (state) => setAppState(state),
  }
}
```

### Comparison

| Aspect           | Coordinate-Based            | Programmatic             |
|------------------|:---------------------------:|:------------------------:|
| **Setup**        | Install tools (IDB for iOS) | Expose globals in app    |
| **Flexibility**  | Any UI element              | Only exposed functions   |
| **Reliability**  | Can break with UI changes   | Stable if API unchanged  |
| **Speed**        | Slower                      | Faster                   |
| **Power**        | Surface-level interaction   | Deep app control         |
| **Dependencies** | ADB (Android), IDB (iOS)    | None                     |
| **System UI**    | Yes                         | No                       |

### Recommendation

**Use both approaches together:**
1. **Programmatic** for app-internal actions (navigation, state, data loading)
2. **Coordinate-based** for visual verification and system UI interaction

---

## Recommended Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              react-native-ai-debugger                       │
├─────────────────────────────────────────────────────────────┤
│  Runtime Debugging (existing)                               │
│  • Metro/CDP connection                                     │
│  • Console logs capture & search                            │
│  • Network request tracking                                 │
│  • JavaScript execution in app (execute_in_app)             │
│  • Debug globals inspection                                 │
├─────────────────────────────────────────────────────────────┤
│  Programmatic Actions (via execute_in_app - no new deps)    │
│  • Call exposed global functions                            │
│  • Trigger navigation, state changes, data loading          │
│  • Dispatch Redux/MobX actions                              │
│  • Control ScrollView/FlatList programmatically             │
├─────────────────────────────────────────────────────────────┤
│  Visual Capture (proposed - minimal deps)                   │
│  ┌────────────────────────┬────────────────────────────┐   │
│  │       Android          │           iOS              │   │
│  │        (ADB)           │        (simctl)            │   │
│  ├────────────────────────┼────────────────────────────┤   │
│  │ • screenshot           │ • screenshot               │   │
│  │ • video recording      │ • video recording          │   │
│  │ • install/launch app   │ • install/launch app       │   │
│  │                        │ • open URL                 │   │
│  │ [No deps needed]       │ [No deps needed]           │   │
│  └────────────────────────┴────────────────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│  Coordinate-Based UI Input (proposed - optional deps)       │
│  ┌────────────────────────┬────────────────────────────┐   │
│  │       Android          │           iOS              │   │
│  │        (ADB)           │          (IDB)             │   │
│  ├────────────────────────┼────────────────────────────┤   │
│  │ • tap                  │ • tap                      │   │
│  │ • swipe                │ • swipe                    │   │
│  │ • text input           │ • text input               │   │
│  │ • key events           │ • accessibility tree       │   │
│  │                        │                            │   │
│  │ [No deps needed]       │ [Requires IDB]             │   │
│  └────────────────────────┴────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Strategy

### Phase 1: Visual Capture (Zero Dependencies)
Priority: High - Enables screenshot-based debugging workflows

**Android (ADB):**
- `android_screenshot` - capture current screen
- `android_record_video` - record screen video
- `android_install_app`, `android_launch_app`

**iOS (simctl):**
- `ios_screenshot` - capture current screen
- `ios_record_video` - record screen video
- `ios_install_app`, `ios_launch_app`, `ios_open_url`

### Phase 2: Android UI Input (Zero Dependencies)
Priority: Medium - Full automation for Android

- `android_tap` - tap at coordinates
- `android_swipe` - swipe gesture
- `android_input_text` - type text
- `android_keyevent` - send key events (back, home, etc.)

### Phase 3: iOS UI Input (Optional - Requires IDB)
Priority: Low - Only for users who need coordinate-based iOS automation

- Detect if IDB is installed at startup
- `ios_tap`, `ios_swipe`, `ios_input_text`
- `ios_describe_ui` - accessibility tree inspection
- Graceful degradation: inform user to install IDB or use programmatic approach

### Phase 4: Enhanced Programmatic Helpers
Priority: Medium - Better developer experience for execute_in_app

- Document common patterns for exposing debug globals
- Add helper tool to discover available global actions
- Consider helper library for React Native apps

## Combined Debugging Flows

### Using Programmatic Approach (No Dependencies)

1. **Pagination Debug Flow**
   ```
   execute_in_app("global.listRef.scrollToIndex({ index: 20 })")
   get_logs()  // See pagination events
   ios_screenshot / android_screenshot  // Verify UI state
   ```

2. **Navigation Debug Flow**
   ```
   execute_in_app("global.navigation.navigate('Profile', { userId: 123 })")
   get_logs()  // See navigation and data loading
   get_network_requests()  // Verify API calls
   ```

3. **State Manipulation**
   ```
   execute_in_app("global.__REDUX_STORE__.dispatch({ type: 'SET_USER', payload: mockUser })")
   get_logs()  // See state change effects
   ios_screenshot  // Verify UI reflects new state
   ```

### Using Coordinate-Based Approach (Requires ADB/IDB)

1. **Visual Button Testing**
   ```
   ios_screenshot  // Get current UI
   android_tap 300 500  // Tap at coordinates
   get_logs()  // See handler execution
   get_network_requests()  // Verify API calls
   ```

2. **Gesture Testing**
   ```
   android_swipe 540 1600 540 100 500  // Swipe up
   get_logs()  // See scroll events
   android_screenshot  // Verify new content loaded
   ```

3. **Form Input Testing**
   ```
   android_tap 200 300  // Focus input field
   android_input_text "test@example.com"
   android_tap 200 400  // Focus next field
   android_input_text "password123"
   android_tap 200 500  // Tap submit
   get_network_requests()  // Verify form submission
   ```

### Hybrid Approach (Best of Both)

1. **Complex Flow with Visual Verification**
   ```
   // Use programmatic for speed and reliability
   execute_in_app("global.debugActions.login('testuser', 'password')")
   get_logs()  // Verify login process
   get_network_requests()  // Check auth API calls

   // Use screenshot for visual verification
   ios_screenshot  // Confirm UI shows logged-in state

   // Use coordinate-based for system dialogs
   android_tap 300 500  // Dismiss system permission dialog
   ```

## References

- [ADB Input Commands](https://commandmasters.com/commands/input-android/)
- [simctl Guide](https://medium.com/xcblog/simctl-control-ios-simulators-from-command-line-78b9006a20dc)
- [Facebook IDB](https://github.com/facebook/idb)
- [ios-simulator-mcp](https://github.com/joshuayoes/ios-simulator-mcp)
