# Setup Guide

Full setup instructions for every supported client, plus platform (Android / iOS) requirements. For a one-line Claude Code install, see the [README quick start](../README.md#setup).

No installation required — every client below uses `npx` to fetch the latest version on demand. Pick your agent:

- [Claude Code](#claude-code) · [Claude Desktop](#claude-desktop) · [Codex CLI](#codex-cli-openai) · [Cursor](#cursor) · [VS Code Copilot](#vs-code-copilot) · [Windsurf](#windsurf) · [Zed](#zed) · [Gemini CLI](#gemini-cli)

After adding the server, fully restart the client (quit and relaunch, not just reload) so it picks up the new configuration.

## Legacy package names

The npm package was previously published as `react-native-ai-devtools` and before that as `react-native-ai-debugger`. Both legacy names continue to receive identical builds via mirror-publish — existing installations and MCP configs keep working unchanged. New installs should use `execbro`.

## Claude Code

```bash
# Project-specific (recommended) — writes .mcp.json, commit it for the team
claude mcp add execbro --scope project -- npx -y execbro@latest

# Global (all projects)
claude mcp add execbro --scope user -- npx -y execbro@latest
```

Prefer project scope. ExecBro does nothing without a Metro server, so a global registration starts it in every session you open, including backend and web repos where there is no simulator to talk to.

Or edit `~/.claude.json` (user) / `.mcp.json` (project) manually:

```json
{
    "mcpServers": {
        "execbro": {
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "execbro@latest"]
        }
    }
}
```

## Claude Desktop

Edit the config at:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
    "mcpServers": {
        "execbro": {
            "command": "npx",
            "args": ["-y", "execbro@latest"]
        }
    }
}
```

You can also open this file from **Settings → Developer → Edit Config**. Fully quit and relaunch Claude Desktop after saving.

## Codex CLI (OpenAI)

```bash
codex mcp add execbro -- npx -y execbro@latest
```

Or edit `~/.codex/config.toml` directly:

```toml
[mcp_servers.execbro]
command = "npx"
args = ["-y", "execbro@latest"]
```

## Cursor

[Docs](https://docs.cursor.com/context/model-context-protocol). Add via `Cmd+Shift+P` → "View: Open MCP Settings", or edit `.cursor/mcp.json` (project) / `~/.cursor/mcp.json` (global):

```json
{
    "mcpServers": {
        "execbro": {
            "command": "npx",
            "args": ["-y", "execbro@latest"]
        }
    }
}
```

## VS Code Copilot

Requires VS Code 1.102+ with Copilot ([docs](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)). Add via `Cmd+Shift+P` → "MCP: Add Server", or edit `.vscode/mcp.json`:

```json
{
    "servers": {
        "execbro": {
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "execbro@latest"]
        }
    }
}
```

## Windsurf

[Docs](https://docs.windsurf.com/windsurf/cascade/mcp). Edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
    "mcpServers": {
        "execbro": {
            "command": "npx",
            "args": ["-y", "execbro@latest"]
        }
    }
}
```

## Zed

[Docs](https://zed.dev/docs/ai/mcp). Open the Agent Panel settings → "Add Custom Server", or add to `settings.json`:

```json
{
    "context_servers": {
        "execbro": {
            "command": "npx",
            "args": ["-y", "execbro@latest"],
            "env": {}
        }
    }
}
```

## Gemini CLI

Edit `~/.gemini/settings.json` (user) or `.gemini/settings.json` (project):

```json
{
    "mcpServers": {
        "execbro": {
            "command": "npx",
            "args": ["-y", "execbro@latest"]
        }
    }
}
```

## Android

Android works out of the box — all device control tools use ADB, which ships with Android Studio. Verify it's available:

```bash
adb devices
```

## iOS Simulator — UI Automation Setup

iOS UI automation tools (tap, swipe, text input, accessibility queries) require a UI driver. Install one of the following:

**Option A: AXe CLI (default)**

[AXe](https://github.com/cameroncooke/AXe) is a standalone CLI for iOS simulator automation. No daemon required — single binary, simple setup. Used by default; no `IOS_DRIVER` env var needed.

```bash
brew install cameroncooke/axe/axe
```

Verify: `axe --version`

> **Note:** AXe text input only supports US keyboard layout characters.

**Option B: IDB (alternative)**

[IDB (iOS Development Bridge)](https://github.com/facebook/idb) is a tool built by Meta for automating iOS Simulators. Requires a background daemon. Use this if you prefer IDB or hit AXe limitations.

```bash
brew install idb-companion
```

Verify: `idb_companion --list 1`

Opt in by setting `IOS_DRIVER=idb` in your MCP server configuration:

```json
{
    "mcpServers": {
        "execbro": {
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "execbro@latest"],
            "env": { "IOS_DRIVER": "idb" }
        }
    }
}
```

**What works without a UI driver:**

| Capability                        | Without AXe/IDB | With AXe/IDB |
| --------------------------------- | --------------- | ------------ |
| Screenshots                       | Yes (simctl)    | Yes          |
| App install/launch/terminate      | Yes (simctl)    | Yes          |
| URL opening                       | Yes (simctl)    | Yes          |
| Boot simulator                    | Yes (simctl)    | Yes          |
| **Tap / swipe / gestures**        | **No**          | Yes          |
| **Pinch to zoom (multi-touch)**   | **No**          | **No** \*    |
| **Text input**                    | **No**          | Yes          |
| **Accessibility tree queries**    | **No**          | Yes          |
| **Element finding / waiting**     | **No**          | Yes          |
| **Hardware buttons (Home, Lock)** | **No**          | Yes          |

\* `pinch` is **Android emulator only** — iOS support is in progress. Neither AXe nor IDB exposes multi-touch: both drivers are strictly single-pointer, so installing one does not enable pinch on the simulator.

> **Troubleshooting**: If you see errors like `"IDB is not installed"` or `"AXe is not installed"` in tap results, install the appropriate driver with the commands above and retry.

## Physical iOS device

A USB-attached iPhone or iPad. What works depends on its iOS version:

- **iOS 15 and later:** `screenshot`.
- **iOS 27 and later:** `tap` by `x`/`y` coordinates, including long press (`duration`), in portrait and landscape.

Not on a phone yet: `swipe`, `input_text`, and `tap` by `testID`, `text` or `component`.

Which devices and iOS versions this was actually run on, and what has not been tested yet: [what works and what was tested](../README.md#physical-iphoneipad-what-works-and-what-was-tested).

### 1. Install pymobiledevice3

There is no Homebrew formula for it, and plain `pip install` is refused on current macOS (`externally-managed-environment`), so install it as an isolated CLI tool:

```bash
brew install pipx
pipx install pymobiledevice3
```

If you already use [uv](https://docs.astral.sh/uv/), `uv tool install pymobiledevice3` does the same thing. Both land the binary in `~/.local/bin`, which ExecBro checks directly, so it works even when your MCP client is launched from the GUI and does not inherit your shell `PATH`.

Taps need version 11.32.0 or later. To update an older install: `pipx upgrade pymobiledevice3`.

### 2. Mount the developer disk image

**iOS 17 and later:** let pymobiledevice3 fetch and mount the image:

```bash
pymobiledevice3 mounter auto-mount
```

**iOS 16 and below:** `auto-mount` fails on a stock machine (it tries to write into a root-owned Xcode directory), so mount Xcode's existing image instead:

```bash
X=/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/DeviceSupport/15.5
pymobiledevice3 mounter mount-developer \
  "$X/DeveloperDiskImage.dmg" "$X/DeveloperDiskImage.dmg.signature"
```

Pick the directory closest to your device's iOS version; a 15.5 image mounts fine on a 15.8 device. Verify with `pymobiledevice3 mounter list`.

### 3. Screenshots

The device appears in `list_devices` under "iOS physical", and `screenshot` accepts its UDID or name:

```
screenshot with device="00008030-001D69C00192802E"
```

Without `pymobiledevice3` installed, `list_devices` simply shows no physical devices and a direct capture attempt tells you what to install.

### 4. Taps (iOS 27 and later)

On top of steps 1 to 3:

1. **Developer Mode on** the phone: Settings > Privacy & Security > Developer Mode (the phone restarts).
2. **The Xcode 27 disk image mounted.** The touch service ships only in Xcode 27's image; Xcode 26's (build `17A400`) does not have it. An open Xcode 26 remounts its own image within a second of any change, so quit Xcode first, then:

   ```bash
   pymobiledevice3 mounter umount-personalized
   pymobiledevice3 mounter auto-mount
   pymobiledevice3 mounter list
   ```

   `auto-mount` downloads the image, so Xcode 27 does not need to be installed. In the `mounter list` output, `ProductBuildVersion` should start with `27`. If it says `17A400`, Xcode 26 is still running.
3. **The phone unlocked, with the screen on.** A tap on a dark screen would wake it and land on the lock screen, so `tap` refuses instead. Setting Auto-Lock to Never (Settings > Display & Brightness) keeps the phone awake during a session.

Then take a screenshot and tap with coordinates from it:

```
screenshot with device="00008030-001D69C00192802E"
tap with x=697, y=817, device="00008030-001D69C00192802E"
tap with x=697, y=817, device="00008030-001D69C00192802E", duration=800
```

Pass the UDID from `list_devices` rather than the name: a phone is often just called "iPhone", which also matches simulators.

A tap takes about 6 s, or about 9 s with the default before/after check (`verify: false` skips it). In landscape, `tap` asks the phone which way it is turned, which adds a second or two. If the phone stops answering, the tap is stopped after 15 s and never retried, because the touch may already have landed: take a screenshot before trying again.
