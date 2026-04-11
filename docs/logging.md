# Console Log Capture

Capture and analyze `console.log`, `warn`, `error`, `info`, `debug` output from your running React Native app.

## Quick Start

```
# Connect to Metro first
scan_metro

# Quick overview (always start here)
get_logs with summary=true

# Recent errors only
get_logs with level="error" maxLogs=20
```

## `get_logs` Tool Reference

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `maxLogs` | number | 50 | Maximum number of logs to return |
| `level` | string | "all" | Filter by level: `all`, `log`, `warn`, `error`, `info`, `debug` |
| `startFromText` | string | - | Start from the last log containing this text |
| `maxMessageLength` | number | 500 | Max chars per message (0 = unlimited) |
| `verbose` | boolean | false | Disable all truncation, return full messages |
| `format` | string | "text" | Output format: `text` or `tonl` (30-50% smaller) |
| `summary` | boolean | false | Return counts + last 5 messages only |

## Recommended Usage Patterns

```
# Quick overview (always start here)
get_logs with summary=true

# Recent errors only
get_logs with level="error" maxLogs=20

# Logs since last app reload
get_logs with startFromText="Running app" maxLogs=100

# Full messages for debugging specific issues
get_logs with maxLogs=10 verbose=true

# Token-efficient format for large outputs
get_logs with format="tonl" maxLogs=100

# Compact overview with shorter messages
get_logs with maxMessageLength=200 maxLogs=50
```

## Filtering Logs

```
get_logs with maxLogs=20 and level="error"
```

Available levels: `all`, `log`, `warn`, `error`, `info`, `debug`

## Start from Specific Line

```
get_logs with startFromText="iOS Bundled" and maxLogs=100
```

This finds the **last** (most recent) line containing the text and returns logs from that point forward. Useful for getting logs since the last app reload.

## Search Logs

```
search_logs with text="error" and maxResults=20
```

Case-insensitive search across all log messages.

## Token-Optimized Output

The tools include several options to reduce token usage when working with AI assistants.

### Summary Mode (Recommended First Step)

**Always start with `summary=true`** - it gives you the full picture in ~10-20 tokens instead of potentially thousands:

```
get_logs with summary=true
```

Returns:
- **Total count** - How many logs are in the buffer
- **Breakdown by level** - See if there are errors/warnings at a glance
- **Last 5 messages** - Most recent activity (truncated to 100 chars each)

Example output:

```
Total: 847 logs

By Level:
  LOG: 612
  WARN: 180
  ERROR: 55

Last 5 messages:
  14:32:45 [LOG] User clicked button...
  14:32:46 [WARN] Slow query detected...
  14:32:47 [ERROR] Network request failed...
```

### Why Summary First?

| Approach | Tokens | Use Case |
|----------|--------|----------|
| `summary=true` | ~20-50 | Quick health check, see if errors exist |
| `level="error"` | ~100-500 | Investigate specific errors |
| `maxLogs=50` (default) | ~500-2000 | General debugging |
| `verbose=true` | ~2000-10000+ | Deep dive into specific data |

**Recommended workflow:**
1. `summary=true` → See the big picture
2. `level="error"` or `level="warn"` → Focus on problems
3. `startFromText="..."` → Get logs since specific event
4. `verbose=true` with low `maxLogs` → Full details when needed

### Message Truncation

Long log messages are truncated by default (500 chars). Adjust as needed:

```
# Shorter for overview
get_logs with maxMessageLength=200

# Full messages (use with lower maxLogs)
get_logs with maxLogs=10 verbose=true

# Unlimited
get_logs with maxMessageLength=0
```

### TONL Format

Use TONL (Token-Optimized Notation Language) for ~30-50% smaller output:

```
get_logs with format="tonl"
```

Output:

```
[Format: TONL - compact token-optimized format. Fields in header, values in rows.]
{logs:[{time:"14:32:45",level:"LOG",msg:"App started"},{time:"14:32:46",level:"WARN",msg:"Slow query"}]}
```

TONL is also available for `search_logs`, `get_network_requests`, and `search_network`.
