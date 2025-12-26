# RN Debugger Telemetry Backend

Cloudflare Worker for receiving anonymous usage telemetry from the React Native AI Debugger MCP server.

## Setup

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- Node.js 18+

### Deployment

1. Install dependencies:
   ```bash
   npm install
   ```

2. Login to Cloudflare:
   ```bash
   npx wrangler login
   ```

3. Set the API key secret (choose a secure random string):
   ```bash
   npx wrangler secret put TELEMETRY_API_KEY
   # Enter your chosen API key when prompted
   ```

4. Deploy the worker:
   ```bash
   npx wrangler deploy
   ```

5. Note the deployed URL (e.g., `https://rn-debugger-telemetry.YOUR_SUBDOMAIN.workers.dev`)

### Client Configuration

After deployment, update two constants in `src/core/telemetry.ts`:

```typescript
const TELEMETRY_ENDPOINT = "https://rn-debugger-telemetry.YOUR_SUBDOMAIN.workers.dev";
const TELEMETRY_API_KEY = "YOUR_API_KEY_HERE";
```

Use the same API key you set as the Cloudflare secret.

## Rate Limiting (Optional)

For additional protection, configure rate limiting in the Cloudflare dashboard:

1. Go to your Worker in the Cloudflare dashboard
2. Navigate to **Settings** > **Triggers** > **Routes**
3. Click **Add Rate Limiting Rule**
4. Set: 10 requests per minute per IP

## Querying Analytics

Use the Cloudflare dashboard or GraphQL API to query telemetry data:

```graphql
query {
  viewer {
    accounts(filter: { accountTag: "YOUR_ACCOUNT_ID" }) {
      rnDebuggerEventsAdaptiveGroups(
        filter: { date_geq: "2024-01-01" }
        limit: 100
      ) {
        count
        dimensions {
          blob1  # Event name
          blob2  # Tool name
          blob3  # Success/failure
        }
        avg {
          double1  # Average duration
        }
      }
    }
  }
}
```

## Data Collected

| Field | Description |
|-------|-------------|
| Event name | "tool_invocation", "session_start", "session_end" |
| Tool name | Name of the MCP tool (e.g., "scan_metro", "get_logs") |
| Success/failure | Whether the tool call succeeded |
| Duration (ms) | Execution time |
| Platform | darwin, linux, win32 |
| Server version | e.g., "1.0.5" |
| Installation ID | First 8 chars of anonymous UUID (truncated for privacy) |

**No PII is collected**: No file paths, code content, IP addresses, or device identifiers.

## Local Development

```bash
npm run dev
```

This starts a local development server for testing.

## Monitoring

View real-time logs:
```bash
npm run tail
```
