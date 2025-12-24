# UI Automation Integration Analysis

## Overview

This document analyzes the feasibility of adding UI automation capabilities to react-native-ai-debugger to enable combined debugging flows like: **tap button → capture logs → take screenshot**.

## Current State

| Project | Focus | Platform |
|---------|-------|----------|
| react-native-ai-debugger | Runtime debugging (logs, network, JS execution) | Cross-platform |
| ios-simulator-mcp | UI automation (tap, swipe, screenshots) | iOS only |

## Native Tool Capabilities

### Android (ADB) - Full Support, No Extra Dependencies

ADB comes bundled with Android SDK (already installed for RN developers).

| Capability | Command | Notes |
|------------|---------|-------|
| Tap | `adb shell input tap <x> <y>` | Coordinates in pixels |
| Swipe | `adb shell input swipe <x1> <y1> <x2> <y2> [duration_ms]` | Duration optional |
| Text Input | `adb shell input text "<string>"` | Escape spaces with `\ ` |
| Long Press | `adb shell input swipe <x> <y> <x> <y> <duration>` | Same start/end coords |
| Key Events | `adb shell input keyevent <code>` | 3=HOME, 4=BACK, 66=ENTER |
| Screenshot | `adb shell screencap -p /sdcard/screenshot.png` | PNG format |
| Video Record | `adb shell screenrecord /sdcard/video.mp4` | Android 4.4+ |
| Install App | `adb install <path.apk>` | |
| Launch App | `adb shell am start -n <package>/<activity>` | |
| List Devices | `adb devices` | |

### iOS (simctl) - Partial Support, No Extra Dependencies

`xcrun simctl` is built into Xcode.

| Capability | Supported | Command |
|------------|-----------|---------|
| Screenshot | Yes | `xcrun simctl io booted screenshot <path>` |
| Video Record | Yes | `xcrun simctl io booted recordVideo <path>` |
| Install App | Yes | `xcrun simctl install booted <app.app>` |
| Launch App | Yes | `xcrun simctl launch booted <bundle.id>` |
| Open URL | Yes | `xcrun simctl openurl booted "<url>"` |
| Clipboard | Yes | `xcrun simctl pbpaste booted` / `pbcopy` |
| Permissions | Yes | `xcrun simctl privacy booted grant location <bundle.id>` |
| **Tap/Swipe** | **No** | Not available in simctl |
| **Text Input** | **No** | Not available in simctl |

### iOS (Facebook IDB) - Full Support, Requires Installation

[Facebook IDB](https://github.com/facebook/idb) exposes private Xcode frameworks.

Additional capabilities over simctl:
- Touch/tap input simulation
- Swipe gestures
- Text input
- Accessibility tree inspection (UI element discovery)

Installation: `brew install idb-companion`

## Recommended Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              react-native-ai-debugger                       │
├─────────────────────────────────────────────────────────────┤
│  Runtime Debugging (existing)                               │
│  • Metro/CDP connection                                     │
│  • Console logs capture & search                            │
│  • Network request tracking                                 │
│  • JavaScript execution in app                              │
│  • Debug globals inspection                                 │
├─────────────────────────────────────────────────────────────┤
│  UI Automation (proposed)                                   │
│  ┌────────────────────────┬────────────────────────────┐   │
│  │       Android          │           iOS              │   │
│  │        (ADB)           │                            │   │
│  ├────────────────────────┼──────────────┬─────────────┤   │
│  │ • tap                  │   simctl     │    IDB      │   │
│  │ • swipe                │ • screenshot │ • tap       │   │
│  │ • text input           │ • video      │ • swipe     │   │
│  │ • screenshot           │ • install    │ • text      │   │
│  │ • video                │ • launch     │ • a11y      │   │
│  │ • install/launch       │              │ (optional)  │   │
│  │                        │              │             │   │
│  │ [No deps needed]       │ [No deps]    │ [Needs IDB] │   │
│  └────────────────────────┴──────────────┴─────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Strategy

### Phase 1: Android Full Support (Zero Dependencies)
- Add ADB-based tools: `android_tap`, `android_swipe`, `android_input_text`
- Add `android_screenshot`, `android_record_video`
- Add `android_list_devices`, `android_install_app`, `android_launch_app`

### Phase 2: iOS Basic Support (Zero Dependencies)
- Add simctl-based tools: `ios_screenshot`, `ios_record_video`
- Add `ios_install_app`, `ios_launch_app`, `ios_open_url`

### Phase 3: iOS Advanced Support (Optional IDB)
- Detect if IDB is installed
- Add IDB-based tools: `ios_tap`, `ios_swipe`, `ios_input_text`
- Add `ios_describe_ui` for accessibility inspection
- Graceful degradation: inform user if IDB not available

## Combined Debugging Flows

With UI automation integrated, enable workflows like:

1. **Pagination Debug Flow**
   - `android_swipe` / `ios_swipe` to scroll
   - `get_logs` to capture pagination events
   - `android_screenshot` to verify UI state
   - Repeat and analyze

2. **Button Interaction Debug**
   - `android_tap` / `ios_tap` on button coordinates
   - `get_logs` to see handler execution
   - `get_network_requests` to verify API calls

3. **Form Input Testing**
   - `android_input_text` / `ios_input_text`
   - `execute_in_app` to check form state
   - `android_screenshot` to verify UI

## References

- [ADB Input Commands](https://commandmasters.com/commands/input-android/)
- [simctl Guide](https://medium.com/xcblog/simctl-control-ios-simulators-from-command-line-78b9006a20dc)
- [Facebook IDB](https://github.com/facebook/idb)
- [ios-simulator-mcp](https://github.com/joshuayoes/ios-simulator-mcp)
