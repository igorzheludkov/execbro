# Privacy Policy

**Last updated:** March 27, 2026

React Native AI DevTools ("the Tool") is an MCP server for AI-powered React Native debugging. This document explains what data the Tool collects, how it is used, and how you can control it.

## Summary

| Data type | What is sent | When | Opt-out |
|-----------|-------------|------|---------|
| **Telemetry** | Anonymous usage metrics (tool names, success/failure, duration) | Automatically on every session | `RN_DEBUGGER_TELEMETRY=false` |
| **OCR screenshots** | Screenshot image for text recognition | Only when `ocr_screenshot` tool is called | Don't use the tool, or use local fallback |
| **Installation ID** | Random UUID (not linked to your identity) | With telemetry and OCR requests | Delete `~/.rn-ai-debugger/` |

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

Set the environment variable before starting the server:

```bash
export RN_DEBUGGER_TELEMETRY=false
```

Also accepts `0` or `off`. Telemetry is fully disabled before any data is sent.

## 2. OCR Screenshot Processing

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

## 3. Local Storage

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

## 4. No Account or Authentication

The Tool does not require user accounts, login, or any form of authentication. There are no cookies, session tokens, or tracking across services.

## 5. Data Retention

- **Telemetry**: Usage metrics are stored in Cloudflare Analytics Engine. Data is retained for analytics purposes and is not linked to any personal identity.
- **OCR images**: Not retained. Images are processed in memory and discarded immediately.
- **Local files**: Remain on your machine until you delete them.

## 6. Infrastructure

All external services run on **Cloudflare Workers** (serverless edge compute):

- Telemetry endpoint: `rn-debugger-telemetry.500griven.workers.dev`
- OCR endpoint: `rn-debugger-ocr.500griven.workers.dev`

API keys embedded in the source code are **write-only tokens** — they cannot be used to read or access any stored data.

## 7. Disabling All External Communication

To run the Tool with zero external data transmission:

```bash
# Disable telemetry
export RN_DEBUGGER_TELEMETRY=false

# Avoid using ocr_screenshot (or let it fall back to local OCR)
```

All tools will continue to work normally — external calls are never required for core functionality.

## 8. Children's Privacy

The Tool is a developer tool and is not directed at children under 13. We do not knowingly collect data from children.

## 9. Changes to This Policy

We may update this privacy policy from time to time. Changes will be reflected in the "Last updated" date at the top of this document and committed to the repository.

## 10. Contact

If you have questions about this privacy policy or data practices, please open an issue on [GitHub](https://github.com/igorzheludkov/react-native-ai-devtools/issues).
