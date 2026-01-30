# Investigation: User 674b31e5 Anomalous Activity

**Date:** 2026-01-29
**Status:** Under observation

## Summary

User `674b31e5` generated ~110,000 telemetry events in a single day, accounting for 99.6% of all traffic.

## Key Findings

### Traffic Analysis

| Period | User 674b31e5 Calls | Total Calls | Percentage |
|--------|---------------------|-------------|------------|
| Today (Jan 29) | 109,966 | 110,382 | 99.6% |
| 7 Days | 109,994 | 111,261 | 98.9% |
| All Time | 109,994 | 114,284 | 96.2% |

### Tool Usage Breakdown

The most called tool by this user is `get_request_details`:

| Tool | Calls |
|------|-------|
| get_request_details | ~88,000 |
| execute_in_app | ~6,000 |
| get_logs | ~5,000 |
| get_network_requests | ~4,700 |
| get_network_stats | ~4,600 |

### Timeline

- **Jan 22-28:** Normal activity (7-237 calls/day across all users)
- **Jan 29:** Massive spike to 110,000+ calls

### Worker vs Analytics Engine Discrepancy

| Metric | Count |
|--------|-------|
| Worker HTTP Requests (24h) | ~12k |
| Analytics Engine Events | ~115k |

**Explanation:** Telemetry events are batched (10 events per request or 30-second intervals). The ~10:1 ratio confirms this user is generating many events rapidly, which get batched together.

## Hypothesis

This is likely an AI agent (Claude or similar MCP client) stuck in a loop repeatedly calling `get_request_details`. Possible causes:

1. AI agent in an infinite loop requesting network details
2. Misconfigured automation or script
3. Stress testing / load testing
4. Bug in client's MCP integration

## Not an Attack

- This is not an attack on the telemetry system
- The telemetry is correctly recording legitimate (though excessive) tool usage
- Worker is functioning normally - just receiving many batched events

## Cloudflare Limits

- **Workers Free Plan:** 100,000 requests/day
- **Current Worker usage:** ~12k requests/day (within limits)
- **Analytics Engine:** Currently free (not being billed yet)

## Dashboard Bugs Fixed (2026-01-29)

1. **"Calls/Today" display bug:** Was showing `totalCalls * 7` instead of actual count
2. **Sampling inconsistency:** Increased query limits to get accurate per-user counts
3. **Default tab:** Changed from "7 Days" to "Today"

## Next Steps

- [ ] Continue monitoring for a few days
- [ ] If pattern continues, consider:
  - Rate limiting per installation ID
  - Blocklist for specific installation IDs
  - Alerting for anomalous usage patterns

## Raw Data Queries

```bash
# Check user stats for today
curl -s "https://rn-debugger-telemetry.500griven.workers.dev/api/stats?days=0&key=<DASHBOARD_KEY>" | jq '.userActivity.users[] | select(.userId == "674b31e5")'

# Check timeline
curl -s "https://rn-debugger-telemetry.500griven.workers.dev/api/stats?days=7&key=<DASHBOARD_KEY>" | jq '.timeline'
```
