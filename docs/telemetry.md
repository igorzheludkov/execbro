# Telemetry & Data Collection

ExecBro collects anonymous usage telemetry to help improve the product. No personal information or app content is collected. This page covers exactly what is sent, why, and how to opt out. For the complete legal policy, see [PRIVACY.md](../PRIVACY.md).

> **See your own data:** the telemetry below powers your [usage dashboard at execbro.com](https://execbro.com) — log in to review your tool usage, error rates, and sessions.

## What is collected

| Data              | Purpose                                  |
| ----------------- | ---------------------------------------- |
| Tool names        | Which MCP tools are used most            |
| Success/failure   | Error rates for reliability improvements |
| Duration (ms)     | Performance monitoring                   |
| Session start/end | Retention analysis                       |
| Platform          | macOS/Linux/Windows distribution         |
| Server version    | Adoption of new versions                 |

**Not collected**: No file paths, code content, network data, or personally identifiable information.

## Auto-registration

On first tool use, the package automatically registers your installation with our backend. No account or login is required — the tool works fully out of the box.

**Why we do this:** The product roadmap includes features that build on installation identity — project memory (your AI assistant gets smarter with every session by remembering navigation maps, element signatures, and debug patterns), cloud sync across machines, and team collaboration with shared debugging context. It also powers your [usage dashboard](https://execbro.com), where you can log in to review your tool usage, error rates, and sessions today. Auto-registration lays the groundwork so these features work seamlessly when they ship, without requiring a disruptive setup step later.

**What is sent:**

- A random installation ID (UUID)
- A device fingerprint (one-way SHA-256 hash — cannot be reversed to recover its components)
- Platform, hostname, OS version, and server version

**What is NOT sent:** No source code, file paths, console logs, network data, component names, or any content from your app. The fingerprint exists solely to prevent installation hijacking — it ties your installation to your physical machine so no one else can claim it.

Registration is fire-and-forget — it never blocks your work, fails silently if the network is unavailable, and can be disabled entirely (see Opt-out below). See [PRIVACY.md](../PRIVACY.md) for full details on data handling, storage, and your rights.

## Opt-out

To disable telemetry and auto-registration, add `RN_DEBUGGER_TELEMETRY` to the `env` field in your MCP server configuration:

```json
{
    "mcpServers": {
        "execbro": {
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "execbro@latest"],
            "env": { "RN_DEBUGGER_TELEMETRY": "false" }
        }
    }
}
```

All debugging tools work normally with telemetry disabled. For the complete privacy policy, see [PRIVACY.md](../PRIVACY.md).

## Tap failure artifacts

When the `tap` tool fails or produces no visible change on screen, the package uploads a small JSON bundle and up to three downscaled PNG screenshots (before, after, and after-with-marker showing exactly where the tap landed) to a 10-day-retention store so we can diagnose and fix tap reliability issues. We do **not** use this data to train AI models and do **not** share it with third parties. See [PRIVACY.md](../PRIVACY.md#4-tap-failure-diagnostic-artifacts) for details.

To opt out while keeping the rest of the package working:

```json
"env": { "RN_AI_DEVTOOLS_DISABLE_FAILURE_ARTIFACTS": "1" }
```

## Build attestation

Official npm builds are stamped with a secret build token at publish time (via `npm run inject-token` in CI, which requires the `BUILD_TOKEN` secret). Builds from a source checkout carry an inert placeholder and are labeled "fork" in our telemetry dashboard. The token is never committed to source.
