# Claude Code Skills

This repository includes pre-built [Claude Code skills](https://docs.anthropic.com/en/docs/claude-code/skills) for common React Native debugging workflows. Skills let Claude handle multi-step tasks (session setup, log inspection, network debugging, etc.) with a single slash command instead of manual back-and-forth.

## Available Skills

| Skill | Description |
| ----- | ----------- |
| `session-setup` | Bootstrap a debugging session: discover devices, boot simulators, connect to Metro |
| `debug-logs` | Capture, filter, and analyze console logs to find errors and warnings |
| `network-inspect` | Monitor and inspect HTTP requests, filter by status/method, and analyze failures |
| `app-state` | Inspect Redux/Apollo/context state, navigate the app, and execute code in the runtime |
| `component-inspect` | Inspect React component tree, props, state, and layout |
| `layout-check` | Verify UI layout against design specs using screenshots and component data |
| `device-interact` | Automate device interaction: tap, swipe, text input, and element finding |
| `bundle-check` | Detect and diagnose Metro bundler errors and compilation failures |
| `native-rebuild` | Rebuild and verify the app after installing native Expo packages |

See [`skills/overview.md`](../skills/overview.md) for a decision guide on which skill to use and a recommended workflow.

## Installing Skills

Copy the skill files into your project's `.claude/skills/` directory:

```bash
# Install all skills
mkdir -p .claude/skills
curl -s https://api.github.com/repos/igorzheludkov/react-native-ai-devtools/contents/skills \
  | grep download_url \
  | cut -d '"' -f 4 \
  | xargs -I {} sh -c 'curl -sL {} -o .claude/skills/$(basename {})'
```

Or pick individual skills from the [`skills/`](../skills/) folder and drop them into `.claude/skills/`.

Then invoke in Claude Code:

```
/session-setup
/debug-logs
/network-inspect
```

Skills can also be triggered **automatically** — each skill file contains a "When to Trigger" section that tells Claude when to proactively invoke it without a slash command. For example, Claude will run `bundle-check` on its own when it detects a red screen, or `session-setup` when starting a fresh debugging task with no connection established yet.
