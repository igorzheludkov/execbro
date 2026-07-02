# Flow Verify Skill

Instrument a React Native flow with flowpoint() breadcrumbs, drive it, and factually verify it behaved as expected — instead of inferring success from toasts, badges, or console logs.

## When to Trigger

Use this skill when the task involves:

- Verifying that a user flow (checkout, login, onboarding step, form submit) behaves correctly end to end
- Confirming a just-implemented feature actually works at runtime, not just that it compiles
- Debugging a flow that fails intermittently or in a specific order
- Checking timing between steps (async sequencing, races, slow transitions)
- Any request phrased like "make sure the flow works", "verify this behavior", "did X happen after Y?"

## Prerequisites

The app must use `execbro-sdk` with `init()` called at startup. If `mcp__execbro__get_flowpoints` reports the SDK is missing, install it first (`npm install execbro-sdk`).

## Instructions

### 1. Ensure Connection

- Use `mcp__execbro__ensure_connection` to check/establish connection
- If not connected, use `mcp__execbro__scan_metro` to find and connect to Metro

### 2. Instrument the Flow

Edit the app code under test. Place one flowpoint at each milestone of the flow:

    import { flowpoint } from 'execbro-sdk'

    flowpoint({ name: 'checkout', step: 'start', begin: true })   // flow entry — begin separates retries
    flowpoint({ name: 'checkout', step: 'cart-validated', meta: { items: cart.length } })
    flowpoint({ name: 'checkout', step: 'payment-ok' })
    flowpoint({ name: 'checkout', step: 'done' })
    // on every failure path:
    flowpoint({ name: 'checkout', step: 'failed', meta: { reason }, level: 'error' })

Keep `name` and `step` stable and low-cardinality; put dynamic data in `meta`.
For a feature you are building, write the expected sequence FIRST (step 5) and implement until it passes — runtime TDD.

### 3. Reload

- Use `mcp__execbro__reload_app` so the instrumented code is live

### 4. Drive the Flow and Wait

- Drive the UI with `mcp__execbro__tap` / `mcp__execbro__swipe` / input tools
- Immediately after the triggering action, call `mcp__execbro__wait_for_flowpoint` with the flow's terminal step (e.g. `{ name: 'checkout', step: 'done', timeoutMs: 10000 }`) — never sleep-and-poll
- On timeout, the partial trail it returns shows exactly where the flow stalled

### 5. Verify

- Call `mcp__execbro__verify_flow` with the expected sequence:
  `{ name: 'checkout', expect: ['start', 'cart-validated', 'payment-ok', 'done'] }`
- FAIL output diffs the run: ✓ seen, ✗ missing, ! unexpected error points
- For retry scenarios, the default `run: 'last'` checks only the newest attempt

### 6. Diagnose Failures

- `mcp__execbro__get_flowpoints({ name, run: 'last' })` — full trail with inter-step timing
- `mcp__execbro__get_flowpoints({ level: 'error' })` — failures across ALL flows
- Correlate with `mcp__execbro__get_logs` and `mcp__execbro__get_network_requests` around the failing step's timestamp

### 7. Clean Up (optional)

- flowpoint() is a production no-op, so instrumentation can safely stay as permanent flow tracing
- If the user prefers, remove the flowpoint() calls after verification passes

## Presenting Findings

- Lead with the verify_flow verdict (PASS/FAIL) and the diff
- For failures, show the last successful step, the missing/error step, and timing deltas
- Include the relevant meta payloads when they explain the failure

## MCP Tools Used

- `mcp__execbro__ensure_connection`
- `mcp__execbro__scan_metro`
- `mcp__execbro__get_flowpoints`
- `mcp__execbro__reload_app`
- `mcp__execbro__tap`
- `mcp__execbro__swipe`
- `mcp__execbro__wait_for_flowpoint`
- `mcp__execbro__verify_flow`
- `mcp__execbro__get_logs`
- `mcp__execbro__get_network_requests`
