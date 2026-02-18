# Session Setup Skill

Bootstrap a React Native debugging session from scratch: discover devices, boot simulators, install and launch the app, connect to Metro, and verify the debugger is ready.

## When to Trigger

Use this skill when the task involves:
- Starting a fresh debugging session with no app currently running
- Booting a simulator or finding a connected device
- Installing or reinstalling the app on a device/simulator
- Connecting to Metro when no connection exists
- The app has crashed and needs to be relaunched
- Switching to a different simulator or device
- Verifying the debugger connection is healthy before starting other tasks
- Any time another skill fails because the app is not running or Metro is not connected

## Instructions

### 1. Check Existing Connections First

Before doing anything else, check if a connection already exists:
- Use `mcp__rn-debugger-local__get_apps` to see if any apps are already connected
- Use `mcp__rn-debugger-local__get_connection_status` to check connection health (uptime, recent disconnects, gaps)
- If a healthy connection exists and `get_connection_status` shows no significant gaps, skip to step 5

### 2. Discover Available Devices

Find what devices are available:
- Use `mcp__rn-debugger-local__list_ios_simulators` to find iOS simulators (booted and available)
- Use `mcp__rn-debugger-local__list_android_devices` to find Android devices/emulators

**If no devices are running:**
- For iOS: use `mcp__rn-debugger-local__ios_boot_simulator` with the desired simulator UDID to boot it
- For Android: instruct the user to start the Android emulator via Android Studio or `emulator` CLI (no MCP tool for this)

### 3. Check if the App is Installed

Before launching, verify the app is present on the device:

**iOS:**
- If you know the bundle ID, skip to launch; otherwise ask the user
- If the app is not installed, use `mcp__rn-debugger-local__ios_install_app` with the `.app` bundle path

**Android:**
- Use `mcp__rn-debugger-local__android_list_packages` to verify the package is installed
- If not installed, use `mcp__rn-debugger-local__android_install_app` with the APK path

### 4. Launch the App

Start the React Native app on the device:

**iOS:**
```
mcp__rn-debugger-local__ios_launch_app with bundleId
```

**Android:**
```
mcp__rn-debugger-local__android_launch_app with packageName
```

Wait 2–3 seconds after launch for Metro to start bundling.

### 5. Connect to Metro

Scan for and connect to the Metro bundler:
- Use `mcp__rn-debugger-local__scan_metro` — this automatically finds Metro on common ports (8081, 8082, 19000–19002) and connects
- If Metro is on a non-standard port, use `mcp__rn-debugger-local__connect_metro` with the specific `port`

**If scan_metro finds no servers:**
- Metro may not be running — ask the user to run `npx react-native start` or `npx expo start`
- Wait a few seconds, then retry `scan_metro`

### 6. Verify Connection Health

Confirm the connection is stable and ready:
- Use `mcp__rn-debugger-local__get_apps` to confirm the app appears in the connected list
- Use `mcp__rn-debugger-local__get_connection_status` and check that `isConnected=true` with no large gaps
- Use `mcp__rn-debugger-local__ensure_connection` with `healthCheck=true` for a full health probe

### 7. Present Status

Report back to the user:
- Which device/simulator is in use (name, platform, UDID/serial)
- Metro port connected
- App bundle ID or package name
- Connection health summary
- Confirm ready to proceed with debugging

## Arguments

- `$ARGUMENTS` - Optional: target platform or device hint (e.g., "ios", "android", "iPhone 16 Pro", "pixel"), or "status" to check existing connections only

## Usage Examples

- `/session-setup` - Full auto-discovery: find devices, connect to Metro, verify readiness
- `/session-setup ios` - Set up only for iOS simulator
- `/session-setup android` - Set up only for Android device/emulator
- `/session-setup status` - Check current connection status without making changes
- `/session-setup "iPhone 16 Pro"` - Boot and connect to a specific simulator

## MCP Tools Used

- `mcp__rn-debugger-local__get_apps`
- `mcp__rn-debugger-local__get_connection_status`
- `mcp__rn-debugger-local__list_ios_simulators`
- `mcp__rn-debugger-local__list_android_devices`
- `mcp__rn-debugger-local__ios_boot_simulator`
- `mcp__rn-debugger-local__ios_install_app`
- `mcp__rn-debugger-local__ios_launch_app`
- `mcp__rn-debugger-local__ios_terminate_app`
- `mcp__rn-debugger-local__android_install_app`
- `mcp__rn-debugger-local__android_launch_app`
- `mcp__rn-debugger-local__android_list_packages`
- `mcp__rn-debugger-local__scan_metro`
- `mcp__rn-debugger-local__connect_metro`
- `mcp__rn-debugger-local__ensure_connection`

## Notes

- Always run this skill (or its "status" variant) at the start of a new debugging session if you are unsure the app is running
- `scan_metro` is preferred over `connect_metro` because it auto-discovers the port; only use `connect_metro` when you know the exact non-standard port
- After `ios_boot_simulator`, wait ~5 seconds before attempting `ios_launch_app` — simulators need time to fully boot
- `get_connection_status` reports connection gaps: a large gap means logs or network events from that period may be missing
- If the app was previously connected and Metro reconnected automatically, `scan_metro` may report "already connected" — this is fine
- To restart the app cleanly (e.g., reset navigation state), use `ios_terminate_app` followed by `ios_launch_app` rather than `reload_app`
