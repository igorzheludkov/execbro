# Claude Code Skills

This repository includes pre-built [Claude Code skills](https://docs.anthropic.com/en/docs/claude-code/skills) for common React Native debugging workflows. Skills let Claude handle multi-step tasks (session setup, log inspection, network debugging, etc.) with a single slash command instead of manual back-and-forth.

## Available Skills

| Skill | Description |
| ----- | ----------- |
| `session-setup` | Bootstrap a debugging session: discover devices, boot simulators, connect to Metro |
| `debug-logs` | Capture, filter, and analyze console logs to find errors and warnings |
| `network-inspect` | Monitor and inspect HTTP requests, filter by status/method, analyze failures — and mock, delay or replay responses to reach error paths |
| `app-state` | Inspect Redux/Apollo/context state, navigate the app, and execute code in the runtime |
| `component-inspect` | Inspect React component tree, props, state, and layout |
| `layout-check` | Verify UI layout against design specs using screenshots and component data |
| `device-interact` | Automate device interaction: tap, swipe, pinch (Android emulator only), text input, and element finding |
| `bundle-check` | Detect and diagnose Metro bundler errors and compilation failures |
| `native-rebuild` | Rebuild and verify the app after installing native Expo packages |
| `verify-change` | Check a finished feature or refactor on the device before handing it on: walks the flow, checks the neighbouring screens and the error paths, reports findings and changes nothing |

See [`skills/overview.md`](../skills/overview.md) for a decision guide on which skill to use and a recommended workflow.

## Installing Skills

Claude Code loads a skill from a folder named after it, with the content in `SKILL.md`: `.claude/skills/debug-logs/SKILL.md`, not `.claude/skills/debug-logs.md`. A flat file in `.claude/skills/` is never loaded. Install each file from [`skills/`](../skills/) into its own folder:

```bash
# Install all skills
curl -s https://api.github.com/repos/igorzheludkov/execbro/contents/skills \
  | grep download_url \
  | cut -d '"' -f 4 \
  | while read -r url; do
      name=$(basename "$url" .md)
      mkdir -p ".claude/skills/$name"
      curl -sL "$url" -o ".claude/skills/$name/SKILL.md"
    done
```

To install one skill by hand, save `skills/<name>.md` as `.claude/skills/<name>/SKILL.md`.

Then invoke in Claude Code:

```
/session-setup
/debug-logs
/network-inspect
```

Skills can also be triggered **automatically** — each skill file contains a "When to Trigger" section that tells Claude when to proactively invoke it without a slash command. For example, Claude will run `bundle-check` on its own when it detects a red screen, or `session-setup` when starting a fresh debugging task with no connection established yet.
