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

### 0. Read the Project's Build Config First (MANDATORY)

Never guess the build commands, the bundle ID, or the Metro port. All three are in the repo. Read them before booting, installing, launching or scanning anything:

- **`package.json` scripts** — look for custom entries (`start:local`, `ios:debug`, `android:staging`, flavor or scheme variants). Use the project's own script. Do **not** default to `npx react-native start`, `npm run ios` or `run-ios` unless those scripts actually exist and are unqualified.
- **Metro port** — check `metro.config.js` (`server.port`, and `watchFolders` for a monorepo) and any `--port` flag inside the `start` script. `scan_metro` sweeps 8081-8090 only. A project on 8099 scans clean and looks like "Metro is not running", which is a wrong diagnosis, not a missing server. If the port is outside that range, use `connect_metro` with the explicit port.
- **Bundle ID / package name** — read it rather than asking the user: `app.json` / `app.config.js` for Expo, `ios/*/Info.plist` or the Xcode project for `PRODUCT_BUNDLE_IDENTIFIER`, `android/app/build.gradle` for `applicationId`. Note that flavors and build types change it (`com.acme.app.staging`, `.debug` suffixes), so pick the one matching the variant you are about to launch.
- **iOS workspace** — if an `.xcworkspace` exists, use it, never the `.xcodeproj`.

**Ask the user only when the project genuinely does not resolve**: multiple flavors with no obvious default, a monorepo with several apps, or build scripts that call into tooling you cannot read. Asking after reading is fine; asking instead of reading is not.

State what you found (script, port, bundle ID, variant) before acting on it, so a wrong inference is visible to the user rather than buried in a failed launch.

### 1. Check Existing Connections First

Before doing anything else, check if a connection already exists:
- Use `mcp__execbro__get_apps` to see if any apps are already connected
- Use `mcp__execbro__get_connection_status` to check connection health (uptime, recent disconnects, gaps)
- If a healthy connection exists and `get_connection_status` shows no significant gaps, skip to step 5

### 2. Discover Available Devices

Find what devices are available:
- Use `mcp__execbro__list_devices` to find iOS simulators, Android emulators, and physical devices in one call

**If no devices are running:**
- For iOS: use `mcp__execbro__ios_boot_simulator` with the desired simulator UDID to boot it
- For Android: instruct the user to start the Android emulator via Android Studio or `emulator` CLI (no MCP tool for this)

### 3. Check if the App is Installed

Before launching, verify the app is present on the device:

**iOS:**
- Use the bundle ID resolved in step 0; ask the user only if the project did not resolve one
- If the app is not installed, build and install it from a terminal using the script found in step 0 (fall back to `xcrun simctl install booted <path.app>` when a build already exists)

**Android:**
- Use `mcp__execbro__android_list_packages` to verify the package is installed
- If not installed, build and install it from a terminal using the script found in step 0 (fall back to `adb install <path.apk>` when a build already exists)

### 4. Launch the App

Start the React Native app on the device:

**iOS:**
```
mcp__execbro__ios_launch_app with bundleId
```

**Android:**
```
mcp__execbro__android_launch_app with packageName
```

Wait 2–3 seconds after launch for Metro to start bundling.

### 5. Connect to Metro

Scan for and connect to the Metro bundler:
- If step 0 found an explicit Metro port, go straight to `mcp__execbro__connect_metro` with that `port`
- Otherwise use `mcp__execbro__scan_metro` — it sweeps ports 8081-8090 and connects to what it finds

**If scan_metro finds no servers:**
- First re-check the port from step 0. A Metro outside 8081-8090 is invisible to the scan, and reporting it as "not running" is a wrong diagnosis
- Otherwise Metro may genuinely not be running — ask the user to run the project's own start script (from step 0)
- Wait a few seconds, then retry `scan_metro`

### 6. Verify Connection Health

Confirm the connection is stable and ready:
- Use `mcp__execbro__get_apps` to confirm the app appears in the connected list
- Use `mcp__execbro__get_connection_status` and check that `isConnected=true` with no large gaps
- Use `mcp__execbro__ensure_connection` with `healthCheck=true` for a full health probe

### 7. Present Status

Report back to the user:
- Which device/simulator is in use (name, platform, UDID/serial)
- Metro port connected
- App bundle ID or package name
- Connection health summary
- Confirm ready to proceed with debugging

### 8. Disconnect (when switching to native debugger)

If the user wants to use the built-in React Native debugger:
- Use `mcp__execbro__disconnect_metro` to close all CDP connections and stop auto-reconnect
- This frees the CDP WebSocket slot for the native debugger
- Log and network buffers are preserved (cached data remains readable)
- When done with the native debugger, use `mcp__execbro__scan_metro` to reconnect

## Arguments

- `$ARGUMENTS` - Optional: target platform or device hint (e.g., "ios", "android", "iPhone 16 Pro", "pixel"), or "status" to check existing connections only

## Usage Examples

- `/session-setup` - Full auto-discovery: find devices, connect to Metro, verify readiness
- `/session-setup ios` - Set up only for iOS simulator
- `/session-setup android` - Set up only for Android device/emulator
- `/session-setup status` - Check current connection status without making changes
- `/session-setup "iPhone 16 Pro"` - Boot and connect to a specific simulator

## MCP Tools Used

- `mcp__execbro__get_apps`
- `mcp__execbro__get_connection_status`
- `mcp__execbro__list_devices`
- `mcp__execbro__ios_boot_simulator`
- `mcp__execbro__ios_launch_app`
- `mcp__execbro__ios_terminate_app`
- `mcp__execbro__android_launch_app`
- `mcp__execbro__android_list_packages`
- `mcp__execbro__scan_metro`
- `mcp__execbro__connect_metro`
- `mcp__execbro__ensure_connection`
- `mcp__execbro__disconnect_metro`

## Notes

- Always run this skill (or its "status" variant) at the start of a new debugging session if you are unsure the app is running
- `scan_metro` is preferred over `connect_metro` when the port is unknown, but step 0 usually makes it known; prefer `connect_metro` with an explicit port whenever the project declares one
- After `ios_boot_simulator`, wait ~5 seconds before attempting `ios_launch_app` — simulators need time to fully boot
- `get_connection_status` reports connection gaps: a large gap means logs or network events from that period may be missing
- If the app was previously connected and Metro reconnected automatically, `scan_metro` may report "already connected" — this is fine
- To restart the app cleanly (e.g., reset navigation state), use `ios_terminate_app` followed by `ios_launch_app` rather than `reload_app`
- Only one debugger client can connect to a device at a time via CDP. If the built-in React Native debugger needs the connection, use `disconnect_metro` to release it
- **MCP server alias note:** examples use the alias `execbro` (tools prefixed `mcp__execbro__`). If you previously registered the server with the older alias `rn-ai-devtools`, substitute `mcp__rn-ai-devtools__` in these examples — both work, only the alias differs.
