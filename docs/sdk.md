# SDK Guide

ExecBro works with zero app changes, but installing the companion [`execbro-sdk`](https://www.npmjs.com/package/execbro-sdk) package is the single biggest upgrade to debugging quality. It lets you **wire up the important parts of your app — your state stores and your network layer — directly into the agent's reach**, so the AI inspects real Redux/TanStack Query state and full request/response bodies instead of guessing from the outside.

## Why it helps

Under the hood, the MCP server connects over Chrome DevTools Protocol (CDP), which misses events that fire before it attaches and can't read request/response bodies on newer architectures. The SDK patches `fetch` and `console` at import time and buffers everything in-app from the very first line — the MCP server auto-detects it and reads from it, no extra config.

|                                          | Without SDK             | With SDK                       |
| ---------------------------------------- | ----------------------- | ------------------------------ |
| State stores (Redux, TanStack Query, …)  | Manual via `execute_in_app` | **Wired up — direct references** |
| Request/response bodies                  | Not available           | Full (including GraphQL)       |
| Startup network requests (auth, config)  | Missed                  | Captured from first fetch      |
| Console logs from startup                | May miss early logs     | Captured from first log        |
| Works on Bridgeless (Expo SDK 52+)       | Partial                 | Full                           |

## Install

```bash
npm install execbro-sdk
```

## Initialize

Add to your app's entry file (`index.js`, `App.tsx`, or `app/_layout.tsx` for Expo Router) as the **first import**, and pass in the stores and references you want the agent to reach:

```js
import { init } from 'execbro-sdk';
import { store } from './store'; // Redux store
import { queryClient } from './queryClient'; // TanStack Query
import { navigationRef } from './navigation';

if (__DEV__) {
  init({
    stores: { redux: store, queryClient },
    navigation: navigationRef,
  });
}

// ... rest of your imports
```

`init()` alone (no arguments) already unlocks full log and network capture. Wiring `stores`, `navigation`, or `custom` references is what makes the agent able to read and reason about your app's state directly. See the [SDK README](https://github.com/igorzheludkov/execbro-sdk#readme) for every config option.
