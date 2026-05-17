import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerToolWithTelemetry } from "../core/register.js";
import { reduxDispatch, reduxGetState } from "../core/redux.js";

export function registerReduxTools(server: McpServer): void {
    registerToolWithTelemetry(
        server,
        "redux_dispatch",
        {
            description:
                "Dispatch a Redux action to the store bound to the app's <Provider>, triggering useSelector subscribers and React re-renders. Resolves the live store by walking the React fiber tree on each call (no SDK setup needed; works even if no store was registered with init()).\n" +
                "PURPOSE: Drive state-controlled UI (loaders, modals, toasts, error overlays) without exercising the real flow (network, OTP, etc.).\n" +
                "WHY THIS EXISTS: __RN_AI_DEVTOOLS__.stores.redux often holds a different store reference than the one passed to <Provider>, so dispatching through it updates state but does NOT notify react-redux subscribers. This tool dispatches through the actual Provider store, so views re-render.\n" +
                "WHEN TO USE: Verify state-driven UI by seeding redux state directly. Example: dispatch app/setIsLoading: true, then ios_screenshot to confirm the loader rendered.\n" +
                "WORKFLOW: redux_dispatch({ action: { type: 'app/setIsLoading', payload: true } }) -> ios_screenshot -> redux_dispatch({ action: { type: 'app/setIsLoading', payload: false } }).\n" +
                "LIMITATIONS: Requires React DevTools hook (dev mode). Action must be plain JSON-serializable (no thunks/functions). If the app has multiple <Provider> roots, pass storeIndex (default 0).\n" +
                "GOOD: redux_dispatch({ action: { type: 'app/setIsLoading', payload: true } })\n" +
                "BAD: redux_dispatch({ action: () => ... }) — actions must be plain objects; for thunks use execute_in_app to call your action creator.",
            inputSchema: {
                action: z
                    .record(z.unknown())
                    .describe("Plain JSON-serializable Redux action object, e.g. { type: 'app/setIsLoading', payload: true }."),
                storeIndex: z
                    .number()
                    .int()
                    .min(0)
                    .optional()
                    .describe("Index of the Provider store to dispatch to when the app has multiple <Provider> roots (default: 0)."),
                returnPath: z
                    .string()
                    .optional()
                    .describe("Optional dotted path into the post-dispatch state to return for verification (e.g. 'app' or 'auth.user'). Omit to skip returning state — keeps the response small. Use redux_get_state for ad-hoc reads."),
                device: z
                    .string()
                    .optional()
                    .describe("Target device name (substring match). Omit for default device. Run get_apps to see connected devices.")
            }
        },
        async ({ action, storeIndex, returnPath, device }) => {
            const result = await reduxDispatch({ action: action as Record<string, unknown>, storeIndex, returnPath, device });
            if (!result.success) {
                return {
                    content: [{ type: "text", text: `Error: ${result.error ?? "Unknown error"}` }],
                    isError: true
                };
            }
            const ack = `Dispatched to store ${result.storeIndex} of ${result.storeCount}: ${JSON.stringify(result.previousAction)}`;
            const stateLine = returnPath
                ? `\n\nState at '${returnPath}':\n${JSON.stringify(result.state, null, 2)}`
                : "";
            return { content: [{ type: "text", text: ack + stateLine }] };
        }
    );
    
    registerToolWithTelemetry(
        server,
        "redux_get_state",
        {
            description:
                "Read state from the Redux store bound to the app's <Provider>, resolved live via the fiber tree (same store redux_dispatch targets).\n" +
                "PURPOSE: Inspect the current app state without relying on __RN_AI_DEVTOOLS__.stores.redux (which may point at a different store instance than the Provider).\n" +
                "WHEN TO USE: Verify state shape before/after redux_dispatch, or check what slice keys exist before crafting an action.\n" +
                "WORKFLOW: redux_get_state() -> craft action -> redux_dispatch -> redux_get_state({ path: 'app' }) to confirm.\n" +
                "LIMITATIONS: Requires React DevTools hook (dev mode). State must be JSON-serializable; non-serializable values are replaced with an error marker.\n" +
                "GOOD: redux_get_state({ path: 'app' })\n" +
                "BAD: redux_get_state({ path: 'app.isLoading.0' }) when isLoading is a boolean — path traversal returns undefined.",
            inputSchema: {
                storeIndex: z
                    .number()
                    .int()
                    .min(0)
                    .optional()
                    .describe("Index of the Provider store to read from when the app has multiple <Provider> roots (default: 0)."),
                path: z
                    .string()
                    .optional()
                    .describe("Optional dotted path into state (e.g. 'app' or 'auth.user'). Omit for the full state."),
                device: z
                    .string()
                    .optional()
                    .describe("Target device name (substring match). Omit for default device.")
            }
        },
        async ({ storeIndex, path, device }) => {
            const result = await reduxGetState({ storeIndex, path, device });
            if (!result.success) {
                return {
                    content: [{ type: "text", text: `Error: ${result.error ?? "Unknown error"}` }],
                    isError: true
                };
            }
            const header = `Store ${result.storeIndex} of ${result.storeCount}${path ? ` at path '${path}'` : ""}:`;
            return { content: [{ type: "text", text: `${header}\n\n${JSON.stringify(result.state, null, 2)}` }] };
        }
    );
}
