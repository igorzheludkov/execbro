import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerToolWithTelemetry } from "../core/register.js";
import { performNavigation } from "../core/navigate.js";

export function registerNavigationTools(server: McpServer): void {
    registerToolWithTelemetry(
        server,
        "navigate",
        {
            description:
                "Navigate the app's router directly, and verify it actually moved.\n" +
                "PURPOSE: Jump to a screen without tapping through the UI, with a settled before/after route check.\n" +
                "WHY THIS EXISTS: hand-written router calls report success whenever nothing throws. A path sent to a React Navigation ref changes nothing and warns only in LogBox, so a no-op reads as a success.\n" +
                "DESTINATIONS ARE NOT INTERCHANGEABLE: Expo Router takes paths (\"/event-details?id=1\"); React Navigation takes route names (\"TarotNav\"). The response reports which router resolved. Unknown React Navigation names are rejected before dispatch, with nearest-match suggestions.\n" +
                "WORKFLOW: navigate({ to: \"/settings\" }) -> check changed -> get_screen_state.\n" +
                "LIMITATIONS: push/replace are unavailable on a React Navigation root ref (stack-scoped). changed=false means it settled without moving; indeterminate=true means no settled reading.\n" +
                "DISCOVERY: navigate({ routeTable: true }) with no destination just LISTS the registered route names — call it first when you do not know them.\n" +
                "GOOD: navigate({ to: \"TarotNav\" }); navigate({ action: \"back\" }); navigate({ routeTable: true })\n" +
                "BAD: navigate({ to: \"/TarotNav\" }) on React Navigation — that is a path, not a route name.",
            inputSchema: {
                to: z
                    .string()
                    .optional()
                    .describe("Destination: a path for Expo Router, a route name for React Navigation. Required unless action is \"back\" or \"reset\"."),
                params: z
                    .record(z.unknown())
                    .optional()
                    .describe("Route params, passed as the second navigate argument."),
                action: z
                    .enum(["navigate", "push", "replace", "back", "reset"])
                    .optional()
                    .describe("Default \"navigate\"."),
                routeTable: z
                    .boolean()
                    .optional()
                    .describe("Include the app's registered route names in the response. Pass it alone, with no `to`, to just list them."),
                device: z
                    .string()
                    .optional()
                    .describe("Target device name (substring match).")
            }
        },
        async ({ to, params, action, routeTable, device }) => {
            const result = await performNavigation({
                action: action ?? "navigate",
                to,
                params,
                device,
                includeRouteTable: routeTable
            });

            if (!result.success) {
                return {
                    content: [{ type: "text", text: `Error: ${result.error ?? "Navigation failed"}` }],
                    isError: true
                };
            }

            const lines = [JSON.stringify(result, null, 2)];
            // A bare routeTable request is a listing: nothing was asked to
            // move, so "the route did not change" reads as a failed navigation.
            const listedOnly = to === undefined && action !== "back" && action !== "reset";
            if (listedOnly) {
                // No note: the table is the answer.
            } else if (result.indeterminate) {
                lines.push("NOTE: no settled route reading — the app may still be transitioning. Re-check with get_screen_state.");
            } else if (!result.changed) {
                lines.push("NOTE: the route did not change. A guard may have blocked it, or the destination was already current.");
            }
            return { content: [{ type: "text", text: lines.join("\n\n") }] };
        }
    );
}
