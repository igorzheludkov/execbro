import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerToolWithTelemetry } from "../core/register.js";
import { executeInApp, listDebugGlobals, inspectGlobal } from "../core/index.js";

export function registerExecutionTools(server: McpServer): void {
    // Tool: Execute JavaScript in app
    registerToolWithTelemetry(
        server,
        "execute_in_app",
        {
            description:
                "Execute JavaScript code in the connected React Native app and return the result. Use this for inspecting app state, calling methods on exposed global objects, or running diagnostic code. Hermes compatible: 'global' is automatically polyfilled to 'globalThis', so both global.__REDUX_STORE__ and globalThis.__REDUX_STORE__ work.\n\n" +
                "RECOMMENDED WORKFLOW: 1) list_debug_globals to discover available objects, 2) inspect_global to see properties/methods, 3) execute_in_app to call specific methods or read values.\n\n" +
                "LIMITATIONS (Hermes engine):\n" +
                "- NO require() or import — only pre-existing globals are available\n" +
                "- NO async/await syntax. Use `.then()` chains: `Promise.resolve().then(v => ...)`. The expression's final value is awaited automatically when awaitPromise:true.\n" +
                "- Non-ASCII characters in string literals (emoji, Arabic, CJK) are auto-escaped server-side. Write them as-is; the wire stays ASCII.\n" +
                "- Keep expressions simple and synchronous when possible\n\n" +
                "GOOD examples: `__DEV__`, `__APOLLO_CLIENT__.cache.extract()`, `__EXPO_ROUTER__.navigate('/settings')`\n" +
                "BAD examples: `async () => { await fetch(...) }`, `require('react-native')`\n" +
                "SEE ALSO: call get_usage_guide(topic=\"state\") for the full app-state playbook.",
            inputSchema: {
                expression: z
                    .string()
                    .describe(
                        "JavaScript expression to execute. Must be valid Hermes syntax — no require(), no async/await (use .then() instead), no unbalanced quotes. Use globals discovered via list_debug_globals — in particular `globalThis.__rn__` exposes I18nManager, Dimensions, PixelRatio, Platform, NativeModules, StyleSheet, AppRegistry."
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
                        "Max characters in result (default: 2000, set to 0 for unlimited). Tip: For large objects like Redux stores, use inspect_global instead or set higher limit."
                    ),
                verbose: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe("Disable result truncation. Tip: Be cautious - Redux stores or large state can return 10KB+."),
                device: z.string().optional().describe("Target device name (substring match). Omit for default device. Run get_apps to see connected devices.")
            }
        },
        async ({ expression, awaitPromise, maxResultLength, verbose, device }) => {
            const result = await executeInApp(expression, awaitPromise, {}, device);
    
            if (!result.success) {
                let errorText = `Error: ${result.error}`;
    
                // If the error is a ReferenceError (accessing a global that doesn't exist),
                // guide the agent to expose the variable as a global first
                if (result.error?.includes("ReferenceError")) {
                    errorText +=
                        "\n\nNOTE: This variable is not exposed as a global. To access it, first assign it to a global variable in your app code (e.g., `globalThis.__MY_VAR__ = myVar;`), then use execute_in_app to read `__MY_VAR__`. You can also use list_debug_globals to see what globals ARE currently available.";
                }
    
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
    
            // Apply truncation unless verbose or unlimited
            if (!verbose && maxResultLength > 0 && resultText.length > maxResultLength) {
                resultText =
                    resultText.slice(0, maxResultLength) + `... [truncated: ${result.result?.length ?? 0} chars total]`;
            }
    
    
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
                "List globally available debugging objects in the connected React Native app (Apollo Client, Redux store, React DevTools, etc.). Use this to discover what state management and debugging tools are available.\n" +
                "PURPOSE: Enumerate the app's `globalThis.*` surface so you know which stores, clients, and debug hooks you can drill into.\n" +
                "WHEN TO USE: Start of a state-debugging session, or when you don't know whether the app exposes a Redux/Apollo/Zustand handle.\n" +
                "WORKFLOW: list_debug_globals -> inspect_global(objectName=\"...\") -> execute_in_app for reads/mutations.\n" +
                "SDK INTEGRATION: If the app uses `react-native-ai-devtools-sdk` and called `init({ stores, navigation, custom })`, the response includes an `sdk.paths` array of ready-to-use dotted paths (e.g. `__RN_AI_DEVTOOLS__.stores.redux`, `__RN_AI_DEVTOOLS__.custom.mmkv`). Pass these straight to inspect_global or execute_in_app.\n" +
                "RN NAMESPACE: The `rn` field reports `globalThis.__rn__`, a curated namespace of seven RN modules — I18nManager, PixelRatio, Platform, StyleSheet, AppRegistry, NativeModules, Dimensions — populated by the SDK's exposeRnGlobals() or the executor's fallback bootstrap. `keys` lists the resolved modules; use dotted paths like `__rn__.Platform.OS` in execute_in_app/inspect_global. When `rn` is null the bootstrap has not yet run; when `keys` is empty the bootstrap ran but no fiber yielded a match.\n" +
                "OUTPUT SHAPE: { sdk: { version, capabilities, paths, hint } | null, rn: { keys: string[], hint: string } | null, categories: { 'Apollo Client': [...], 'Redux': [...], 'Other Debug': [...], ... } }\n" +
                "LIMITATIONS: Only sees variables explicitly assigned to a global (e.g., `globalThis.store = store`). Module-scoped state is invisible — expose it first or use the SDK's init().\n" +
                "GOOD: list_debug_globals()\n" +
                "BAD: Calling before scan_metro — needs a live connection.\n" +
                "SEE ALSO: call get_usage_guide(topic=\"state\") for the full app-state playbook.",
            inputSchema: {
                device: z.string().optional().describe("Target device name (substring match). Omit for default device. Run get_apps to see connected devices.")
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
                "GOOD: inspect_global({ objectName: \"__APOLLO_CLIENT__\" }) | inspect_global({ objectName: \"__RN_AI_DEVTOOLS__.stores.redux\" })\n" +
                "BAD: inspect_global({ objectName: \"store.getState()\" }) — call expressions aren't supported; use execute_in_app.\n" +
                "SEE ALSO: call get_usage_guide(topic=\"state\") for the full app-state playbook.",
            inputSchema: {
                objectName: z
                    .string()
                    .describe("Identifier or dotted path of the global to inspect (e.g., '__APOLLO_CLIENT__', '__RN_AI_DEVTOOLS__.stores.redux', '__RN_AI_DEVTOOLS__.custom.mmkv')"),
                device: z.string().optional().describe("Target device name (substring match). Omit for default device. Run get_apps to see connected devices.")
            }
        },
        async ({ objectName, device }) => {
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
    
            return {
                content: [
                    {
                        type: "text",
                        text: `Properties of ${objectName}:\n\n${result.result}`
                    }
                ]
            };
        }
    );
}
