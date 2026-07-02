# ExecBro

**Give your AI assistant eyes and hands into your running React Native app.** Like Chrome DevTools — but for AI agents.

Build, debug, and verify features end-to-end — without leaving the chat.

ExecBro is the runtime bridge between your AI coding assistant and your running React Native app — exposing MCP tools to read logs and network, inspect component state, capture screenshots, tap the UI, and run JS. Zero config, no SDK or code changes required to start — and installing the [optional SDK](#install-the-sdk-recommended) is recommended for the most robust log and network capture.

<p align="center">
  <img src="https://raw.githubusercontent.com/igorzheludkov/execbro/main/docs/demo/get_logs_demo.gif" alt="ExecBro demo" width="800" />
</p>

## Get started

1. [Setup ExecBro as an MCP server for your agent of choice](#setup)
2. [Setup UI automation helpers](docs/setup.md#ios-simulator--ui-automation-setup)
3. [Install the SDK for richer capture](#install-the-sdk-recommended) — optional, but recommended for the most robust log, network, and state experience

## See your usage — [execbro.com](https://execbro.com)

Log in at **[execbro.com](https://execbro.com)** to see your ExecBro activity rendered back to you: which tools you use most, tool **error rates**, and your **session history** — so you can spot flaky tools, track usage over time, and understand how your agent drives the app across sessions. It's built from the same anonymous telemetry described in [Telemetry & Privacy](#telemetry--privacy), tied to your installation ID.

## Features

### Runtime Interaction

- **Console Log Capture** - Capture `console.log`, `warn`, `error`, `info`, `debug` with filtering and search. Note: on a cold start (first app launch), logs emitted before the MCP server connects are missed — subsequent reloads capture everything. Install the optional [SDK](https://www.npmjs.com/package/execbro-sdk) to buffer logs from the very first line of app startup
- **Network Request Tracking** - Monitor HTTP requests/responses with headers, timing, and body content. Like logs, early network requests on cold start may be missed before the connection is established. Install the optional [SDK](https://www.npmjs.com/package/execbro-sdk) for full capture from app startup including request/response bodies
- **JavaScript Execution** - Run code directly in your app (REPL-style) and inspect results
- **Global State Debugging** - Discover and inspect Apollo Client, Redux stores, Expo Router, and custom globals. Wire stores and other app internals straight into the agent with the optional [SDK](#install-the-sdk-recommended) for direct, reliable state access
- **Bundle Error Detection** - Get Metro bundler errors and compilation issues with file locations

### Device Control

- **iOS Simulator** - Screenshots, app management, URL handling, boot/terminate (via simctl)
- **Android Devices** - Screenshots, app install/launch, package management (via ADB)
- **Unified Tap** - Single `tap` tool with automatic fallback chain: fiber tree → accessibility → OCR → coordinates. Auto-detects platform, accepts pixels from screenshots. Returns post-tap screenshot and verifies visual change by default
- **Unified Swipe** - Single `swipe` tool that auto-routes to iOS or Android based on the connected device. Accepts screenshot pixel coordinates, handles per-platform conversion, and returns a `verification.meaningful` signal so agents detect end-of-list, non-scrollable surfaces, and missed coordinates. Essential for scrolling virtualized lists (FlatList/SectionList) where off-screen items aren't in the fiber tree
- **UI Automation** - Swipe, long press, key events, and text input on both platforms. On Bridgeless/Fabric apps, `clear_focused_input` and `dismiss_keyboard` operate on whatever has focus, and `ios_input_text` / `android_input_text` accept `replace:true` to overwrite pre-filled values — all three update React state through `onChangeText` so controlled components (Formik, react-hook-form, useState) stay consistent
- **Accessibility Inspection** - Query UI hierarchy to find elements by text, label, or resource ID
- **OCR Text Extraction** - Extract visible text with tap-ready coordinates via Google Cloud Vision (works on any screen content)

### Multi-Device Debugging

- **Connect All Devices** - `scan_metro` automatically discovers and connects to all Bridgeless targets on each Metro port
- **Device Targeting** - Every tool accepts an optional `device` parameter for targeting specific devices by name (case-insensitive substring match)
- **Per-Device Buffers** - Logs and network requests are captured separately per device for clean debugging
- **Cross-Platform Comparison** - Debug iOS and Android side-by-side, comparing logs, network traffic, and component trees

### Under the Hood

- **Auto-Discovery** - Scans Metro on ports 8081, 8082, 19000-19002 automatically
- **Multi-Device Support** - Connects to all Bridgeless targets simultaneously, with per-device log and network buffers
- **Auto-Reconnection** - Exponential backoff (up to 8 attempts) when connection drops
- **Efficient Buffering** - Circular buffers: 500 logs, 200 network requests
- **Platform Support** - Expo SDK 54+ (Bridgeless) and React Native 0.70+ (Hermes)

## Setup

Add ExecBro to Claude Code in one command — no installation, `npx` fetches the latest version on demand:

```bash
claude mcp add execbro --scope user -- npx -y execbro@latest
```

Then fully restart the client (quit and relaunch) so it picks up the new server.

**Using a different client or need platform setup?** The [full setup guide](docs/setup.md) covers Claude Desktop, Codex CLI, Cursor, VS Code Copilot, Windsurf, Zed, and Gemini CLI, plus [Android](docs/setup.md#android) and [iOS simulator UI automation](docs/setup.md#ios-simulator--ui-automation-setup) requirements.

## Install the SDK (recommended)

ExecBro works with zero app changes, but installing the companion [`execbro-sdk`](https://www.npmjs.com/package/execbro-sdk) package is the single biggest upgrade to debugging quality. It lets you **wire up the important parts of your app — your state stores and your network layer — directly into the agent's reach**, so the AI inspects real Redux/TanStack Query state and full request/response bodies instead of guessing from the outside.

|                                          | Without SDK             | With SDK                       |
| ---------------------------------------- | ----------------------- | ------------------------------ |
| State stores (Redux, TanStack Query, …)  | Manual via `execute_in_app` | **Wired up — direct references** |
| Request/response bodies                  | Not available           | Full (including GraphQL)       |
| Startup network requests (auth, config)  | Missed                  | Captured from first fetch      |
| Console logs from startup                | May miss early logs     | Captured from first log        |
| Works on Bridgeless (Expo SDK 52+)       | Partial                 | Full                           |

It's one `npm install` plus a single `init()` call in your app's entry file. See the [SDK guide](docs/sdk.md) for install, initialization, and every config option.

## Requirements

- Node.js 18+
- React Native app running with Metro bundler
- **Recommended**: [`execbro-sdk`](#install-the-sdk-recommended) in your app — wires stores and the network layer into the agent for dramatically better debugging (optional; ExecBro works without it)
- **iOS UI automation**: [AXe CLI](https://github.com/cameroncooke/AXe) (`brew install cameroncooke/axe/axe`, default) or [Facebook IDB](https://fbidb.io/) (`brew install idb-companion`, opt in via `IOS_DRIVER=idb`) — required for tap, swipe, text input, accessibility on iOS Simulator
- **Optional for offline OCR fallback**: Python 3.6+ (only needed when cloud OCR is unavailable, see [OCR guide](docs/ocr.md))

## Claude Code Skills

Pre-built skills for common debugging workflows — session setup, log inspection, network debugging, and more. See the [skills guide](docs/skills.md) for the full list and installation instructions.

## Available Tools

See the [full tool reference](docs/tools.md) for all tools with descriptions. Key tools:

| Tool                                    | Description                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `scan_metro`                            | **Start here** — scan for Metro servers and auto-connect                                 |
| `get_logs` / `search_logs`              | Capture and search console logs with filtering and summaries                             |
| `get_network_requests`                  | Monitor HTTP requests with method/status filtering                                       |
| `get_screen_layout`                     | Screen map of visible components with positions, sizes, and text content                 |
| `tap`                                   | **Unified tap** — auto-detects platform, tries fiber → accessibility → OCR → coordinates |
| `ios_input_text` / `android_input_text` | Type text into the focused field. `replace:true` clears pre-filled values first (Fabric) |
| `clear_focused_input`                   | Clear the focused TextInput via React `onChangeText`, keeping controlled state in sync   |
| `dismiss_keyboard`                      | Blur the focused input and close the on-screen keyboard                                  |
| `execute_in_app`                        | Run JS expressions in the app runtime (REPL-style)                                       |
| `ios_screenshot` / `android_screenshot` | Take device screenshots                                                                  |

## Usage

1. Start your React Native app:

    ```bash
    npm start
    # or
    expo start
    ```

2. Just describe what you want in plain language — the agent picks the right tools. You don't need to know tool names or ask for a specific one. For example:

    ```
    Check the network logs and investigate why this error is happening
    ```
    ```
    Why is the current screen empty? Take a look and figure it out
    ```
    ```
    Tap the "Sign in" button and tell me what happens
    ```
    ```
    The list won't scroll — scroll it down and check what's going on
    ```

    The agent connects to Metro, reads logs and network, inspects the screen, and drives the UI as needed to answer.

## Detailed Guides

| Guide                                                      | Description                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [Setup](docs/setup.md)                                     | Per-client MCP config (Claude, Codex, Cursor, VS Code, …), Android & iOS setup  |
| [SDK Setup](docs/sdk.md)                                   | Install & `init()` the in-app SDK to wire stores + network layer into the agent |
| [Console Logging](docs/logging.md)                         | `get_logs` parameters, filtering, summary mode, TONL format, token optimization |
| [Network Tracking](docs/network.md)                        | SDK setup for full capture, filtering, request details, statistics              |
| [App Inspection](docs/app-inspection.md)                   | Debug globals (Apollo, Redux, Expo Router), `execute_in_app`, limitations       |
| [Layout & Component Inspection](docs/layout-inspection.md) | `get_screen_layout`, component tree, `inspect_at_point`, `find_components`      |
| [Device Interaction](docs/device-interaction.md)           | Unified `tap`, platform-specific gestures, text input, key events               |
| [OCR Text Extraction](docs/ocr.md)                         | Cloud Vision OCR, offline fallback, language config, workflows                  |
| [Claude Code Skills](docs/skills.md)                       | Pre-built skills for session setup, debugging, and automation                   |
| [Full Tool Reference](docs/tools.md)                       | Complete list of all 40+ tools with descriptions                                |

## How It Works

1. Fetches device list from Metro's `/json` endpoint
2. Connects to the main JS runtime via CDP (Chrome DevTools Protocol) WebSocket
3. Enables `Runtime.enable` to receive `Runtime.consoleAPICalled` events
4. Network capture via two paths:
    - **With SDK**: Reads from the SDK's in-app buffer via `Runtime.evaluate` — captures all requests from startup with full headers and bodies, including cold-start events that CDP would miss
    - **Without SDK**: Enables CDP `Network.enable` (on supported targets) or injects a JS fetch interceptor as fallback. On cold start, events emitted before the CDP connection is established are lost; subsequent reloads capture everything
5. Stores logs and network requests in circular buffers for retrieval

## Connection Management

- **One server per session** — each agent session (each terminal or IDE window) runs its own ExecBro MCP server instance.
- **Connects on request, not on startup** — the server never auto-connects. It only attaches to your running React Native app when you ask it to (e.g. `scan_metro`), so it stays out of the way until you actually need a device.
- **One driver per device** — if two or more sessions in the same project point at the same Metro/device, they'll compete to control it, like a car with two steering wheels. Keep interaction to a single session per device.
- **Want parallel sessions? Give each its own device + port** — run separate work in a [git worktree](https://git-scm.com/docs/git-worktree) with its own Metro instance on a different port, and connect a second device (simulator/emulator) to it. For example, keep `main` on the default `8081` and start the worktree's Metro on `8082` (`npx react-native start --port 8082`, or `npx expo start --port 8082`), then launch that worktree's app pointed at `8082`. Each agent session then `scan_metro`s and drives its own device, so the two never fight over the connection.

## Troubleshooting

### No devices found

- Make sure the app is running on a simulator/device
- Check that Metro bundler is running (`npm start`)

### Logs not appearing

- Ensure the app is actively running (not just Metro)
- Try `clear_logs` then trigger some actions in the app
- Check `get_apps` to verify connection status
- **On cold start (first launch):** The CDP connection is established after the app's early initialization code has already run, so startup logs and network requests are missed. Once connected, use `reload_app` — the subsequent reload captures everything from the beginning because the connection is already in place. To capture startup events on every launch, install the optional [SDK](https://www.npmjs.com/package/execbro-sdk)

## Telemetry & Privacy

ExecBro collects anonymous usage telemetry — tool names, success/failure, and durations — to improve the product. **No source code, file paths, or app content is ever sent.** This is what powers your [usage dashboard](#see-your-usage--execbrocom).

See the [Telemetry & Data Collection guide](docs/telemetry.md) for the full breakdown of what's collected, auto-registration, and how to opt out, and [PRIVACY.md](./PRIVACY.md) for the complete privacy policy.

## Supported React Native Versions

| Version        | Architecture          | Engine       | Status                                           |
| -------------- | --------------------- | ------------ | ------------------------------------------------ |
| Expo SDK 54+   | Bridgeless (New Arch) | Hermes       | ✓ Fully supported                                |
| RN 0.76+       | Bridgeless (New Arch) | Hermes       | ✓ Fully supported                                |
| RN 0.73 - 0.75 | Bridge (Old Arch)     | Hermes       | ✓ Fully supported (best network capture via CDP) |
| RN 0.70 - 0.72 | Bridge (Old Arch)     | Hermes / JSC | ✓ Supported                                      |
| RN < 0.70      | Bridge                | JSC          | Not tested                                       |

## Pricing

ExecBro is **free and open** — every feature, no usage limits, no account required. Use it as much as you like. The tools you run locally stay free; that's the model.

## Feedback & Feature Requests

**Please run this at the end of your session to help me make the tools better.** ExecBro is built for AI agents, so the most valuable feedback comes from the agent itself — paste this prompt to your agent:

> Write a report about your experience with the ExecBro tools — where you were struggling and what could be improved. Save it as a Markdown file for me, then submit it using the `send_feedback` tool (type `"feedback"`) so it becomes a GitHub issue.

It takes 30 seconds: your agent runs `send_feedback`, hands you a pre-filled GitHub issue URL (environment info already attached), and you click submit — no GitHub setup, no copy-pasting. Real friction logs from real sessions are what shape the roadmap and get fixed first, so please send one. 🙏 And if you just have a quick idea or question, drop into [GitHub Discussions](https://github.com/igorzheludkov/execbro/discussions) to share feedback, request features, and vote on what gets built next.

## Package names & staying up to date

Ships as the npm package `execbro`. The package was previously published as `react-native-ai-devtools` and before that as `react-native-ai-debugger` — both legacy names keep receiving identical builds via mirror-publish, so existing installations and MCP configs keep working unchanged. New installs should use `execbro`.

> [!IMPORTANT]
> **Already using ExecBro?** `npx` caches packages indefinitely, so you may be stuck on an old version without realizing it. Update your MCP config to use `npx -y execbro@latest` (see [Setup](#setup)) so every session pulls the latest release with new tools and bug fixes. New installs after this change auto-update automatically.

## License

MIT
