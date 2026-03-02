# Test Infrastructure Design

## Context

The project has zero test infrastructure. After confirming issue #3 (IIFE wrapping bug) manually, we're adding automated tests to prevent regressions and cover core logic.

## Decisions

- **Framework**: Jest with ts-jest (ESM support)
- **Scope**: Unit + integration tests
- **Mocking**: Manual fake CDP WebSocket server for integration tests

## Architecture

```
src/
  __tests__/
    unit/
      executor.test.ts        # Expression validation, wrapping, unicode detection
      logs.test.ts             # LogBuffer circular buffer, filtering, search
      network.test.ts          # NetworkBuffer lifecycle, filtering, sorting
      metro.test.ts            # Device selection/prioritization logic
      bundle.test.ts           # BundleErrorBuffer behavior
    integration/
      execute-in-app.test.ts   # Full executeInApp flow with fake CDP server
      connection.test.ts       # Connect/disconnect/reconnect with fake WebSocket
      tools.test.ts            # MCP tool handlers (component tree, debug globals)
    helpers/
      fake-cdp-server.ts       # Minimal WS server simulating CDP responses
      fixtures.ts              # Shared test data (device lists, fiber trees)
```

## Unit Tests

Pure logic, no mocks needed:

### executor.test.ts
- `validateAndPreprocessExpression()`: emoji rejection, comment stripping, async detection
- `containsProblematicUnicode()`: surrogate pair detection
- `stripLeadingComments()`: single-line and multi-line comments
- Expression wrapping: verify polyfill prepend without IIFE (the #3 fix)

### logs.test.ts
- `LogBuffer`: add, get with limit/offset, search by text, clear
- Circular overflow behavior (exceed maxSize)
- Level filtering (log, warn, error)

### network.test.ts
- `NetworkBuffer`: set request, update with response, getAll
- Filtering: by method, URL pattern, status code, completedOnly
- Sorting by timestamp
- search(), clear()

### metro.test.ts
- `selectMainDevice()`: Bridgeless > Hermes > Any RN prioritization
- Filtering out Reanimated/Experimental devices
- Edge cases: empty list, single device, no RN devices

### bundle.test.ts
- `BundleErrorBuffer`: add, get, clear error tracking

## Integration Tests

Use fake CDP server to simulate real WebSocket communication:

### Fake CDP Server (`helpers/fake-cdp-server.ts`)
- Lightweight `ws.Server` on random port
- Receives CDP messages, returns configurable responses
- Supports: `Runtime.evaluate` (success/error/timeout), `Runtime.enable`, `Log.enable`, `Network.enable`
- Configurable response delay for timeout testing

### execute-in-app.test.ts
- Single expression returns value (`1 + 1` -> `2`)
- Multi-statement returns last value (`var x = 1; x` -> `1`)
- Already-IIFE expressions return correctly
- Timeout handling
- Error responses (ReferenceError, SyntaxError)
- Stale context detection and reconnection

### connection.test.ts
- Connect to device via WebSocket
- Health check (Runtime.evaluate ping)
- Disconnect handling
- Reconnection on stale context errors

### tools.test.ts
- `getComponentTree()`: receives fiber tree data, formats correctly
- `listDebugGlobals()`: returns categorized globals
- `getScreenLayout()`: returns layout summary
- `findComponents()`: matches patterns, returns results

## Jest Configuration

- `ts-jest` with `useESM: true` for ESM compatibility
- `moduleNameMapper`: map `.js` imports to `.ts` source files
- `testMatch`: `src/__tests__/**/*.test.ts`
- Scripts: `npm test`, `npm run test:unit`, `npm run test:integration`

## Dependencies to Add

- `jest` + `@types/jest`
- `ts-jest`
