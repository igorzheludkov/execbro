import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerToolWithTelemetry } from "../core/register.js";
import { executeInApp, listDebugGlobals, inspectGlobal } from "../core/index.js";
import { getRefreshStatus } from "../core/fastRefreshTools.js";
import { applyResultBudget, DEFAULT_MAX_BYTES } from "../core/truncate.js";
import { projectJsonText, formatProjectionNote } from "../core/jsonProjection.js";
import { buildCollectExpression, dropHandle } from "../core/promiseHandles.js";
import { DEVICE_ARG_DESC } from "./_deviceArg.js";

export function registerExecutionTools(server: McpServer): void {
    // Tool: Execute JavaScript in app
    registerToolWithTelemetry(
        server,
        "execute_in_app",
        {
            description:
                "Execute JavaScript code in the connected React Native app and return the result. Use this for inspecting app state, calling methods on exposed global objects, or running diagnostic code. Hermes compatible: 'global' is automatically polyfilled to 'globalThis', so both global.__REDUX_STORE__ and globalThis.__REDUX_STORE__ work.\n\n" +
                "RECOMMENDED WORKFLOW: 1) list_debug_globals to discover available objects, 2) inspect_global to see properties/methods, 3) execute_in_app to call methods or read values.\n\n" +
                "LIMITATIONS (Hermes engine):\n" +
                "- NO require() or import — only pre-existing globals are available\n" +
                "- Async: use `Promise.resolve(foo()).then(function(r){ return r; })` (resolved for you when awaitPromise:true). `async`/`await` syntax is engine-dependent — many Hermes builds reject it.\n" +
                "- Multi-statement input is auto-wrapped into an IIFE returning the last statement's value. If that can't yield a value (`if`/`for`/declaration), write the IIFE yourself with an explicit `return`.\n" +
                "- Non-ASCII in string literals (emoji, Arabic, CJK) is auto-escaped server-side. Write it as-is.\n\n" +
                "GOOD examples: `__DEV__`, `__APOLLO_CLIENT__.cache.extract()`, `__EXPO_ROUTER__.navigate('/settings')`\n" +
                "BAD examples: `await fetch(...)` (bare top-level await), `require('react-native')`\n" +
                "Pass timeoutMs (ms) for long-running expressions; capped at 120000. Auto-reconnect surfaces _meta.reconnected when a transport drop was self-healed.\n",
            inputSchema: {
                collect: z
                    .string()
                    .optional()
                    .describe(
                        "Collect a deferred promise result by handle. When a promise outlives its poll budget the result is kept in the app and its handle returned; pass it here to retrieve the settled value. Use instead of `expression`, not alongside it."
                    ),
                expression: z
                    .string()
                    .optional()
                    .describe(
                        "JavaScript expression to execute. Must be valid Hermes syntax — no require(), no `await`/`async` (use `Promise.resolve(foo()).then(function(r){ return r; })`), no unbalanced quotes. Multi-statement input is auto-wrapped into an IIFE returning the last statement's value. Use globals discovered via list_debug_globals — `globalThis.__rn__` exposes I18nManager, Dimensions, PixelRatio, Platform, NativeModules, StyleSheet, AppRegistry when populated, but check it for null before dereferencing."
                    ),
                awaitPromise: z.coerce
                    .boolean()
                    .optional()
                    .default(true)
                    .describe("Whether to await promises (default: true)"),
                maxResultLength: z.coerce
                    .number()
                    .optional()
                    .default(2000)
                    .describe(
                        "Target size of the result in characters (default: 2000, 0 for unlimited). Oversized results are bounded structurally — arrays and objects are elided with count-preserving markers like \"…+150 more\" — not clipped mid-string."
                    ),
                verbose: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe("Disable result truncation. Tip: Be cautious - Redux stores or large state can return 10KB+."),
                device: z.string().optional().describe(DEVICE_ARG_DESC),
                timeoutMs: z.coerce
                    .number()
                    .optional()
                    .describe(
                        "Per-call timeout in milliseconds. Default: 10000. Hard cap: 120000 (values above are clamped with a warning surfaced in the response). A timeout here is a logical failure and does NOT trigger auto-reconnect."
                    )
            }
        },
        async ({ expression, collect, awaitPromise, maxResultLength, verbose, device, timeoutMs }) => {
            if (collect) {
                const collected = await executeInApp(
                    buildCollectExpression(collect),
                    false,
                    { originatingToolName: "execute_in_app" },
                    device
                );
                if (!collected.success) {
                    return { content: [{ type: "text", text: `Error: ${collected.error}` }], isError: true };
                }
                if (collected.result === "__pending__") {
                    return {
                        content: [{ type: "text", text: `Still pending. Retry execute_in_app({ collect: "${collect}" }) shortly.` }]
                    };
                }
                dropHandle(collect);
                if (collected.result === "__missing__") {
                    return {
                        content: [{ type: "text", text: `Handle "${collect}" no longer exists — the app reloaded, or the value was already collected.` }],
                        isError: true
                    };
                }
                const boundedCollect = applyResultBudget(String(collected.result ?? ""), maxResultLength > 0 ? maxResultLength : Number.MAX_SAFE_INTEGER);
                return { content: [{ type: "text", text: boundedCollect.text }] };
            }

            if (!expression) {
                return {
                    content: [{ type: "text", text: "Error: provide either `expression` to run, or `collect` with a deferred promise handle." }],
                    isError: true
                };
            }

            const result = await executeInApp(expression, awaitPromise, {
                timeoutMs,
                originatingToolName: "execute_in_app",
            }, device);
    
            const metaNotes: string[] = [];
            if (result._meta?.reconnected) {
                metaNotes.push(`[reconnected: transport error "${result._meta.transportError ?? "unknown"}" was auto-recovered]`);
            }
            if (result._meta?.timeoutClampedFrom !== undefined) {
                metaNotes.push(`[warning: timeoutMs ${result._meta.timeoutClampedFrom} clamped to 120000]`);
            }

            if (!result.success) {
                let errorText = `Error: ${result.error}`;

                // If the error is a ReferenceError (accessing a global that doesn't exist),
                // guide the agent to expose the variable as a global first
                if (result.error?.includes("ReferenceError")) {
                    errorText +=
                        "\n\nNOTE: This variable is not exposed as a global. To access it, first assign it to a global variable in your app code (e.g., `globalThis.__MY_VAR__ = myVar;`), then use execute_in_app to read `__MY_VAR__`. You can also use list_debug_globals to see what globals ARE currently available.";
                }
                if (metaNotes.length > 0) errorText = `${errorText}\n\n${metaNotes.join("\n")}`;

                return {
                    content: [
                        {
                            type: "text",
                            text: errorText
                        }
                    ],
                    isError: true,
                    // Include expression as context for telemetry (helps debug syntax errors)
                    _errorContext: expression
                };
            }

            let resultText = result.result ?? "undefined";

            // Bound the result unless verbose or explicitly unlimited.
            //
            // Structural bounding rather than a mid-string clip: a clip can cut
            // JSON in half, which tells the reader nothing about what was lost
            // and cannot be parsed. Bounding keeps the shape and reports real
            // array lengths and key counts, so the next read can be targeted.
            if (!verbose && maxResultLength > 0) {
                const bounded = applyResultBudget(resultText, maxResultLength);
                resultText = bounded.text;
                if (bounded.budget.truncated) {
                    const b = bounded.budget.appliedBudget;
                    const shape = b
                        ? `, depth<=${b.maxDepth}, arrays<=${b.maxArrayItems}, strings<=${b.maxStringLength}`
                        : "";
                    resultText +=
                        `\n\n[bounded: ${bounded.budget.originalBytes} -> ${bounded.budget.returnedBytes} chars${shape}]` +
                        `\nRead a narrower path, or raise maxResultLength, for full detail.`;
                }
            }

            if (metaNotes.length > 0) resultText = `${resultText}\n\n${metaNotes.join("\n")}`;

            return {
                content: [
                    {
                        type: "text",
                        text: resultText
                    }
                ]
            };
        },
        // Empty result detector: successful execution but no meaningful output
        (result) => {
            if (result?.isError) return false;
            const text = result?.content?.[0]?.text;
            return text === undefined || text === "" || text === "undefined" || text === "null";
        }
    );
    
    // Tool: List debug globals available in the app
    registerToolWithTelemetry(
        server,
        "list_debug_globals",
        {
            description:
                "List globally available debugging objects in the connected app (Apollo, Redux, React DevTools, etc.).\n" +
                "PURPOSE: Enumerate the app's globalThis.* surface so you know which stores, clients, and debug hooks you can drill into.\n" +
                "WHEN TO USE: Start of a state-debugging session, or when you don't know whether the app exposes a Redux/Apollo/Zustand handle.\n" +
                "WORKFLOW: list_debug_globals -> inspect_global(objectName=\"...\") -> execute_in_app for reads/mutations.\n" +
                "SDK INTEGRATION: When react-native-ai-devtools-sdk's init({ stores, navigation, custom }) was called, the response includes an sdk.paths array of dotted paths (e.g. __RN_AI_DEVTOOLS__.stores.redux). Pass them to inspect_global or execute_in_app.\n" +
                "RN NAMESPACE: The rn field reports globalThis.__rn__ — a curated set of seven RN modules (I18nManager, PixelRatio, Platform, StyleSheet, AppRegistry, NativeModules, Dimensions) populated by SDK exposeRnGlobals() or the executor's fallback bootstrap. Use paths like __rn__.Platform.OS. rn=null → bootstrap not yet run; keys=[] → ran but no match.\n" +
                "OUTPUT: { sdk: {...}|null, rn: {keys, hint}|null, categories: {...} }\n" +
                "LIMITATIONS: Only sees variables explicitly assigned to a global. Module-scoped state is invisible — expose it first or use the SDK.\n",
            inputSchema: {
                device: z.string().optional().describe(DEVICE_ARG_DESC)
            }
        },
        async ({ device }) => {
            const result = await listDebugGlobals(device);
    
            if (!result.success) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: ${result.error}`
                        }
                    ],
                    isError: true
                };
            }
    
            return {
                content: [
                    {
                        type: "text",
                        text: `Available debug globals in the app:\n\n${result.result}`
                    }
                ]
            };
        }
    );
    
    // Tool: Inspect a global object to see its properties and types
    registerToolWithTelemetry(
        server,
        "inspect_global",
        {
            description:
                "Inspect a global object (or a dotted path into one) to see its properties, types, and whether they are callable functions. Use this BEFORE calling methods on unfamiliar objects to avoid errors.\n" +
                "PURPOSE: Surface the shape of a global (Apollo client, Redux store, Expo Router, SDK-registered store, etc.) — keys, types, and which members are callable — without executing arbitrary code.\n" +
                "WHEN TO USE: After list_debug_globals identifies a promising global and before you try execute_in_app on it.\n" +
                "WORKFLOW: list_debug_globals -> inspect_global(objectName=\"__APOLLO_CLIENT__\") -> execute_in_app(\"__APOLLO_CLIENT__.cache.extract()\").\n" +
                "DOTTED PATHS: Pass dotted paths to drill into the SDK surface, e.g. inspect_global({ objectName: \"__RN_AI_DEVTOOLS__.stores.redux\" }) or \"__RN_AI_DEVTOOLS__.custom.mmkv\". Only identifier paths are accepted — for arbitrary expressions, use execute_in_app.\n" +
                "LIMITATIONS: Only reads one level deep; nested objects show as a 100-char JSON preview — re-inspect the child path. Returns an error object (not a throw) when the path doesn't resolve.\n" +
                "WIDE OBJECTS: a global with hundreds of keys is bounded structurally rather than dumped; use query to pull one entry in full.\n" +
                "GOOD: inspect_global({ objectName: \"__APOLLO_CLIENT__\" }) | inspect_global({ objectName: \"__RN_AI_DEVTOOLS__.stores.redux\", query: \"cache\" })\n" +
                "BAD: inspect_global({ objectName: \"store.getState()\" }) — call expressions aren't supported; use execute_in_app.\n",
            inputSchema: {
                objectName: z
                    .string()
                    .describe("Identifier or dotted path of the global to inspect (e.g., '__APOLLO_CLIENT__', '__RN_AI_DEVTOOLS__.stores.redux', '__RN_AI_DEVTOOLS__.custom.mmkv')"),
                query: z
                    .string()
                    .optional()
                    .describe(
                        "Dot-path into the property listing, returned in full (e.g. \"cache\" or \"stores.redux\"). A path that matches nothing returns the listing plus what is actually there, not an error."
                    ),
                maxResultLength: z.coerce
                    .number()
                    .optional()
                    .default(DEFAULT_MAX_BYTES)
                    .describe(`Byte target for the rendered listing (default: ${DEFAULT_MAX_BYTES}, 0 for unlimited).`),
                device: z.string().optional().describe(DEVICE_ARG_DESC)
            }
        },
        async ({ objectName, query, maxResultLength, device }) => {
            const result = await inspectGlobal(objectName, device);
    
            if (!result.success) {
                let errorText = `Error: ${result.error}`;
    
                // If the global (or path) doesn't resolve, guide the agent toward
                // either exposing it manually or registering it via the SDK.
                const looksMissing = result.error?.includes("ReferenceError") || result.error?.includes("NotFound") || result.error?.includes("not found");
                if (looksMissing) {
                    const isPath = objectName.includes(".");
                    if (isPath) {
                        errorText += `\n\nNOTE: '${objectName}' did not resolve. Call list_debug_globals to confirm the path. If you expected the SDK to expose it, verify init({ stores, navigation, custom }) was called and check the sdk.paths array.`;
                    } else {
                        const suggested = objectName.replace(/^__/, "").replace(/__$/, "");
                        errorText += `\n\nNOTE: '${objectName}' is not exposed as a global variable. Either (a) assign it in app code (\`globalThis.${objectName} = ${suggested};\`), or (b) register it via react-native-ai-devtools-sdk's init({ custom: { ${suggested}: ${suggested} } }) and access it as __RN_AI_DEVTOOLS__.custom.${suggested}. Then call list_debug_globals to confirm.`;
                    }
                }
    
                return {
                    content: [
                        {
                            type: "text",
                            text: errorText
                        }
                    ],
                    isError: true
                };
            }
    
            const projected = projectJsonText(String(result.result ?? ""), {
                query,
                maxBytes: maxResultLength > 0 ? maxResultLength : Number.MAX_SAFE_INTEGER
            });
            const note = formatProjectionNote(
                projected,
                "Re-inspect a child path, pass a query, or raise maxResultLength."
            );
            return {
                content: [
                    {
                        type: "text",
                        text: `Properties of ${objectName}:\n\n${projected.text}${note ? `\n\n${note}` : ""}`
                    }
                ]
            };
        }
    );

    // Tool: Did the JS runtime accept a Fast Refresh update since `since`?
    registerToolWithTelemetry(
        server,
        "get_refresh_status",
        {
            description:
                "Pull-style probe: did the JS runtime accept a Fast Refresh (HMR) update since `since`? Returns lastUpdateAt, updateCount, and recentUpdates from a 32-entry ring buffer fed by a recorder around __ReactRefresh.performReactRefresh (preferred) or \\$RefreshReg\\$ (fallback).\n\n" +
                "PURPOSE: Confirm an edit landed in the running app without polling logs or screenshots. After editing TSX, wait ~2s then call with `since` = a Date.now() captured BEFORE the edit. updateCount > 0 means Fast Refresh accepted.\n\n" +
                "WHEN TO USE: After editing .tsx/.ts files (prefer over reload_app). To distinguish runtime acceptance (this) from Metro build state (get_bundle_status).\n\n" +
                "FILTER: `since` (epoch ms) keeps entries with at > since. `sincePath` (substring) matches modulePath — available on the \\$RefreshReg\\$ path but often omitted on performReactRefresh; if so the filter matches nothing — drop it.\n\n" +
                "LIMITATIONS: A full reload resets the buffer (next call reports `recorder just installed`). Edits to non-React utility files still increment. Requires the React 18+ refresh runtime.\n\n" +
                "SEE ALSO: get_bundle_status (did Metro compile?), get_bundle_errors (compile failures), reload_app (force full reload).",
            inputSchema: {
                sincePath: z
                    .string()
                    .optional()
                    .describe("Substring matched against entry modulePath. Must not contain double quotes. Omit on builds where modulePath is unavailable."),
                since: z
                    .number()
                    .optional()
                    .describe("Epoch ms; only count refresh entries with at > since. Capture Date.now() before your edit."),
                device: z
                    .string()
                    .optional()
                    .describe(DEVICE_ARG_DESC)
            }
        },
        async ({ sincePath, since, device }) => {
            const r = await getRefreshStatus({ sincePath, since, device });

            if (!r.success) {
                return {
                    content: [{ type: "text", text: `Error: ${r.error}` }],
                    isError: true
                };
            }

            const lines: string[] = [
                `updateCount: ${r.updateCount ?? 0}`,
                `lastUpdateAt: ${r.lastUpdateAt ?? "null"}`,
                `via: ${r.via ?? "unknown"}`
            ];
            if (r.recentUpdates && r.recentUpdates.length > 0) {
                lines.push("recentUpdates (newest first):");
                for (const e of r.recentUpdates) {
                    lines.push(`  - at=${e.at}${e.modulePath ? ` modulePath=${e.modulePath}` : ""}`);
                }
            } else {
                lines.push("recentUpdates: (none)");
            }
            if (r.justInstalled) {
                lines.push("(recorder just installed — past updates not captured)");
            }

            return {
                content: [{ type: "text", text: lines.join("\n") }]
            };
        }
    );
}
