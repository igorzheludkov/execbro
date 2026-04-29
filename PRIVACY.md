# Privacy Policy

**Last updated:** April 30, 2026

React Native AI DevTools ("the Tool") is an MCP server for AI-powered React Native debugging. This document explains what data the Tool collects, how it is used, and how you can control it.

## Summary

| Data type | What is sent | When | Opt-out |
|-----------|-------------|------|---------|
| **Telemetry** | Anonymous usage metrics (tool names, success/failure, duration) | Automatically on every session | `RN_DEBUGGER_TELEMETRY=false` |
| **Auto-registration** | Installation ID, device fingerprint, platform, hostname, OS version, server version | Once on first tool use per session | `RN_DEBUGGER_TELEMETRY=false` |
| **License validation** | Installation ID, device fingerprint | Once per session (cached 24 hours) | Cannot be disabled (required for license check) |
| **OCR screenshots** | Screenshot image for text recognition | Only when `ocr_screenshot` tool is called | Don't use the tool, or use local fallback |
| **Tap failure artifacts** | JSON bundle + up to 3 downscaled PNG screenshots | On `tap` failure or unmeaningful tap (`changeRate < 0.1%`) | `RN_AI_DEVTOOLS_DISABLE_FAILURE_ARTIFACTS=1` |
| **Installation ID** | Random UUID (not linked to your identity) | With telemetry, registration, and OCR requests | Delete `~/.rn-ai-debugger/` |

## 1. Anonymous Telemetry

### What we collect

When you use the Tool, anonymous usage data is sent to our telemetry service:

- **Tool usage**: which tools are invoked, whether they succeeded or failed, and how long they took
- **Error info**: error category and a truncated error message (first 200 characters) when a tool fails
- **App characteristics**: React Native version, architecture (new/old), JS engine (Hermes/JSC), platform (iOS/Android), and OS version — detected from the connected app
- **Session data**: session start/end and session duration
- **Environment**: server version, Node.js version, and operating system (macOS/Linux/Windows)
- **Installation ID**: a randomly generated UUID stored locally at `~/.rn-ai-debugger/telemetry.json`

### What we do NOT collect

- Source code, file paths, or file contents
- Console log content
- Network request/response data (URLs, headers, bodies)
- Component names, component tree, or app structure
- Redux, Apollo, or any other app state
- Personal information (name, email, IP address is not stored)
- Environment variables or secrets

### How it works

- Events are batched (10 events or 30 seconds) and sent via HTTPS to a Cloudflare Worker
- All requests have a 5-second timeout and fail silently — telemetry never blocks your work
- No retries on failure

### How to opt out

Add `RN_DEBUGGER_TELEMETRY` to the `env` field in your MCP server configuration:

```json
"env": { "RN_DEBUGGER_TELEMETRY": "false" }
```

Also accepts `"0"` or `"off"`. Telemetry is fully disabled before any data is sent.

## 2. Auto-Registration & Device Fingerprinting

### What happens

On the first tool use in each session, the Tool automatically registers your installation with our backend. This is required for license validation and enables optional account linking (e.g., upgrading to a Pro plan).

### What is sent

| Data | Purpose |
|------|---------|
| Installation ID | Random UUID — identifies this installation |
| Device fingerprint | SHA-256 hash of (OS username + CPU model + machine hardware UUID) — prevents installation hijacking |
| Platform | macOS, Linux, or Windows |
| Hostname | Your machine's hostname |
| OS version | Operating system name and release version |
| Server version | The installed version of react-native-ai-devtools |

### How the fingerprint works

The device fingerprint is a **one-way hash** — it cannot be reversed to recover your username, CPU model, or hardware UUID individually. It is used solely to verify that license activations and account links come from the same physical machine.

The raw components (username, CPU, hardware UUID) are never sent to our servers. Only the resulting SHA-256 hash is transmitted.

### Where data is stored

Registration data is stored in **Google Firebase Firestore**. Each installation creates a document with:

- Status: `"anonymous"` (default) or `"linked"` (if you connect a web account)
- Tier: `"free"` (default) or `"pro"`/`"team"` (if upgraded)
- The data listed above (fingerprint, platform, hostname, OS version, server version)
- Timestamps: when the installation was created and last seen

### How to opt out

Auto-registration is tied to telemetry. To disable both, add to your MCP server config:

```json
"env": { "RN_DEBUGGER_TELEMETRY": "false" }
```

With telemetry disabled, registration does not occur. License validation will still check the local cache but will not create remote records. The Tool defaults to the free tier if no cached license exists.

## 3. OCR Screenshot Processing

### What happens

When you use the `ocr_screenshot` tool, the Tool takes a screenshot of your app and sends the image to our cloud OCR service for text recognition.

### Data flow

1. A screenshot is captured from your iOS Simulator or Android emulator/device
2. The PNG image is sent via HTTPS to a Cloudflare Worker (`rn-debugger-ocr.500griven.workers.dev`)
3. The Cloudflare Worker forwards the image to **Google Cloud Vision API** for text recognition
4. Recognized text, coordinates, and confidence scores are returned to your machine
5. **The image is not stored** — it is processed in memory and discarded immediately after the response

### What is sent

- The screenshot image (PNG binary)
- Your installation ID (in the request header)

### Third-party processing

The screenshot image is processed by **Google Cloud Vision API** via our Cloudflare Worker proxy. Google's data usage is governed by [Google Cloud's Terms of Service](https://cloud.google.com/terms) and [Data Processing Terms](https://cloud.google.com/terms/data-processing-terms). Under Google Cloud Vision API terms, Google does not use customer data to train its models.

### Local fallback

If the cloud OCR service is unavailable (timeout, network error), the Tool automatically falls back to **local OCR** using EasyOCR (Python-based). In local mode, no data leaves your machine.

### How to avoid cloud OCR

- Use `ios_screenshot` or `android_screenshot` instead of `ocr_screenshot`
- If cloud OCR fails, the local fallback processes everything on your machine

## 4. Tap Failure Diagnostic Artifacts

### What we collect

When the `tap` tool fails or produces no visible change on screen (`changeRate < 0.1%`), the Tool uploads diagnostic evidence so we can reproduce and fix tap reliability issues:

- **JSON bundle** (~5–30 KB, gzipped): the predicate (text/testID/component/coordinates), error category and message, the strategy chain that ran (accessibility / fiber / OCR / coordinate with reasons), the chosen tap point if any, and device metadata (platform, driver, screen size).
- **Up to three downscaled PNG screenshots** (50% scale, ~50 KB each):
  - `before.png` — the screen captured before the tap was attempted.
  - `after.png` — the screen after the tap (only if a tap actually fired).
  - `after-with-marker.png` — the post-tap screenshot with a red-cross marker drawn at the exact pixel where the tap landed.

### When

- Only on `tap` failures (predicate-not-found, timeout, strategy chain exhausted) and `tap` successes that produced no visible change (`changeRate < 0.001`).
- Successful, meaningful taps upload nothing.
- No artifacts are uploaded for unactionable errors (UI driver missing, no connected device, pre-strategy Metro errors).

### Where stored

- Cloudflare R2 storage (same Cloudflare account as the telemetry endpoint).
- Accessed only via authenticated dashboard endpoint by the maintainer.

### Retention

**10 days.** Objects are auto-deleted by an R2 lifecycle policy.

### Use

- Solely to diagnose and improve the `tap` tool.
- **Not used to train AI models.**
- **Not shared with or sold to any third party.**

### Scope note

The Tool only operates against development environments (simulators, emulators, dev builds). Screenshots may include whatever is on your screen at the time of the tap. We do not run against production or release builds.

### How to opt out

Add to your MCP server configuration:

```json
"env": { "RN_AI_DEVTOOLS_DISABLE_FAILURE_ARTIFACTS": "1" }
```

Disabling telemetry (`RN_DEBUGGER_TELEMETRY=false`) also disables artifact upload. When opted out, anonymous structured signals (sense counts, closest-match scores) still flow under the existing telemetry policy; PNGs and JSON bundles are not uploaded.

## 5. Local Storage

The Tool creates the following files on your machine:

| File | Purpose | Contents |
|------|---------|----------|
| `~/.rn-ai-debugger/telemetry.json` | Persistent installation ID | Random UUID, first-run timestamp |
| `~/.rn-ai-debugger/license.json` | License tier cache | License status, cache expiry (24h TTL) |

To delete all locally stored data:

```bash
rm -rf ~/.rn-ai-debugger/
```

A new installation ID will be generated on the next server startup.

## 6. Accounts & Authentication

### Free tier (no account required)

The Tool works without any account or login. Anonymous installations are registered automatically (see Section 2) and default to the free tier.

### Optional account linking

You can optionally create a web account at `mobile-ai-devtools.link` to:

- Upgrade to a Pro or Team plan
- Manage multiple installations from a dashboard
- Generate activation tokens for linking devices

Account creation uses **Google sign-in via Firebase Authentication**. When you sign in, the following is stored:

| Data | Source |
|------|--------|
| Email address | Your Google account |
| Display name | Your Google account |
| Sign-in provider | `"google.com"` |
| Linked installation IDs | From your MCP installations |

### Activation tokens

Activation tokens are one-time codes (valid for 24 hours) that link an MCP installation to your web account. The raw token is shown once in the dashboard; only a SHA-256 hash is stored server-side.

### Account deletion

You can delete your account and all associated data using the `delete_account` MCP tool (requires typing `confirm: "DELETE"`). This removes:

- Your account record and all activation tokens from Firestore
- Your local license cache and installation ID files

You can also delete local data manually:

```bash
rm -rf ~/.rn-ai-debugger/
```

## 7. Data Retention

| Data | Retention |
|------|-----------|
| **Telemetry** | Stored in Cloudflare Analytics Engine. Retained for analytics purposes. Not linked to personal identity. |
| **Installation records** | Stored in Firebase Firestore. Retained while the installation is active. Deleted when you use the `delete_account` tool. |
| **Account records** | Stored in Firebase Firestore. Retained while the account exists. Deleted on account deletion. |
| **Activation tokens** | Stored in Firebase Firestore. Expired tokens (24h) are cleaned up lazily on new token creation. |
| **OCR images** | Not retained. Processed in memory and discarded immediately. |
| **Tap failure artifacts** | Stored in Cloudflare R2. Auto-deleted after 10 days. Not used for AI training; not shared with third parties. |
| **Local files** | Remain on your machine until you delete them. |

## 8. Infrastructure

External services used by the Tool:

| Service | Provider | Purpose |
|---------|----------|---------|
| Telemetry endpoint | Cloudflare Workers | Anonymous usage metrics |
| OCR endpoint | Cloudflare Workers → Google Cloud Vision | Screenshot text recognition |
| Registration & license API | Firebase (Google Cloud) | Installation registration, license validation |
| Account storage | Firebase Firestore (Google Cloud) | Installation records, account data, activation tokens |
| Authentication | Firebase Authentication (Google Cloud) | Optional Google sign-in for web dashboard |
| Tap artifact storage | Cloudflare R2 | Short-term storage of diagnostic screenshots and JSON bundles for failed/unmeaningful taps (10-day retention) |

API keys embedded in the source code are **write-only tokens** — they cannot be used to read or access any stored data.

## 9. Disabling All External Communication

To run the Tool with zero external data transmission, add to your MCP server config:

```json
"env": {
  "RN_DEBUGGER_TELEMETRY": "false",
  "RN_AI_DEVTOOLS_DISABLE_FAILURE_ARTIFACTS": "1"
}
```

`ocr_screenshot` will automatically fall back to local OCR (EasyOCR) when cloud is unavailable.

All debugging tools will continue to work normally — external calls are never required for core functionality. License validation falls back to local cache, then defaults to the free tier.

## 10. Children's Privacy

The Tool is a developer tool and is not directed at children under 13. We do not knowingly collect data from children.

## 11. Changes to This Policy

We may update this privacy policy from time to time. Changes will be reflected in the "Last updated" date at the top of this document and committed to the repository.

## 12. Contact

If you have questions about this privacy policy or data practices, please open an issue on [GitHub](https://github.com/igorzheludkov/react-native-ai-devtools/issues).
