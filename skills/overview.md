# Skills Overview

Quick reference for all available React Native debugging skills. Use this to pick the right skill for the task at hand.

## Skill Index

| Skill | One-liner | When to reach for it |
|---|---|---|
| `/session-setup` | Bootstrap debugger connection | Starting a session, booting a simulator, connecting to Metro |
| `/debug-logs` | Read console logs | Checking errors, warnings, tracing runtime behavior |
| `/network-inspect` | Inspect HTTP requests | Debugging API calls, auth issues, failed/slow requests |
| `/app-state` | Inspect runtime state | Reading Redux store, executing JS, checking globals |
| `/component-inspect` | Inspect component tree | Exploring hierarchy, props, state, hooks of components |
| `/layout-check` | Capture device screenshots | Verifying UI changes, comparing across devices/Figma |
| `/device-interact` | Tap, swipe, type on device | Automating UI interactions, reproducing bugs |
| `/bundle-check` | Check Metro bundler health | Red screens, compilation errors, reload issues |
| `/native-rebuild` | Rebuild after native installs | After adding native Expo packages that need dev client |

## Decision Guide

**"The app isn't running or connected"** → `/session-setup`

**"Something is wrong, I need to investigate"**
- See console output → `/debug-logs`
- See network activity → `/network-inspect`
- See app/Redux state → `/app-state`
- See component tree/props → `/component-inspect`
- See the screen visually → `/layout-check`

**"I made code changes and need to verify"**
- JS/style changes → `/layout-check` (auto-triggered after UI edits)
- Bundle won't load / red screen → `/bundle-check`
- Added a native package → `/native-rebuild`

**"I need to interact with the app"** → `/device-interact`

**"I want to use the built-in React Native debugger"** → `/session-setup` with `disconnect_metro`, then `scan_metro` to reconnect

## Typical Workflow

1. `/session-setup` — connect to the running app
2. Investigate with `/debug-logs`, `/network-inspect`, `/app-state`, or `/component-inspect`
3. Make code changes
4. `/layout-check` — verify visually
5. `/bundle-check` — only if changes aren't reflected or errors appear

## Notes

- All skills (except `/session-setup` and `/native-rebuild`) require an active debugger connection. If connection is missing, run `/session-setup` first.
- `/layout-check` auto-triggers after any style/layout code change — no need to invoke it manually in that case.
- Most skills accept optional arguments to narrow scope (e.g., `/debug-logs error`, `/network-inspect 500`). See individual skill files for details.
- To switch to the built-in React Native debugger, use `disconnect_metro` to free the CDP connection. Use `scan_metro` to reconnect afterward.

## Multi-Device Debugging

When multiple devices are connected (e.g., iPhone + Android emulator):
- Use `get_apps` to see all connected devices and their names
- Most tools accept a `device` param (case-insensitive substring match, e.g., `device="iPhone"` or `device="sdk_gphone"`)
- Omitting `device` uses the first connected device for execution tools, or merges data from all devices for log/network tools
- `scan_metro` connects ALL Bridgeless targets automatically — no manual `connect_metro` needed
