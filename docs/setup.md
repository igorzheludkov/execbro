# Setup Guide

Full setup instructions for every supported client, plus platform (Android / iOS) requirements. For a one-line Claude Code install, see the [README quick start](../README.md#setup).

No installation required — every client below uses `npx` to fetch the latest version on demand. Pick your agent:

- [Claude Code](#claude-code) · [Claude Desktop](#claude-desktop) · [Codex CLI](#codex-cli-openai) · [Cursor](#cursor) · [VS Code Copilot](#vs-code-copilot) · [Windsurf](#windsurf) · [Zed](#zed) · [Gemini CLI](#gemini-cli)

After adding the server, fully restart the client (quit and relaunch, not just reload) so it picks up the new configuration.

## Legacy package names

The npm package was previously published as `react-native-ai-devtools` and before that as `react-native-ai-debugger`. Both legacy names continue to receive identical builds via mirror-publish — existing installations and MCP configs keep working unchanged. New installs should use `execbro`.

## Claude Code

```bash
# Global (all projects)
claude mcp add execbro --scope user -- npx -y execbro@latest

# Project-specific
claude mcp add execbro --scope project -- npx -y execbro@latest
```

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
| **Text input**                    | **No**          | Yes          |
| **Accessibility tree queries**    | **No**          | Yes          |
| **Element finding / waiting**     | **No**          | Yes          |
| **Hardware buttons (Home, Lock)** | **No**          | Yes          |

> **Troubleshooting**: If you see errors like `"IDB is not installed"` or `"AXe is not installed"` in tap results, install the appropriate driver with the commands above and retry.
