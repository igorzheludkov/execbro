import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerToolWithTelemetry } from "../core/register.js";
import { lastAction } from "../core/actionLog.js";
import { resolveWindow, trimEvents, formatTimeline, TIMELINE_SOURCES, type TimelineSource } from "../core/timeline.js";
import { collectTimeline } from "../core/timelineSources.js";
import { DEVICE_ALL_DESC } from "./_deviceArg.js";

const DEFAULT_LIMIT = 100;

export function registerTimelineTools(server: McpServer): void {
    registerToolWithTelemetry(
        server,
        "get_timeline",
        {
            description:
                "What happened, in order: your own actions, screen changes, network requests, console logs, app restarts and Fast Refresh edits in one time-ordered list.\n" +
                "PURPOSE: Answer \"what did that cause?\" in one call instead of lining up get_logs, get_network_requests and get_screen_state by hand.\n" +
                "WHEN TO USE: Right after a tap, navigate, input_text, reload_app or execute_in_app, to see its consequences; or with since=\"-5m\" to reconstruct how the app got into its current state.\n" +
                "WORKFLOW: tap(...) -> get_timeline() -> get_request_details / get_log_details on the ids it prints.\n" +
                "LIMITATIONS: Events are merged by time, not linked by cause. Shows only what the server captured (actions made through these tools, not by hand). Route and refresh times on Android and physical devices are corrected by an estimated clock offset.\n" +
                "GOOD: get_timeline() after a tap; get_timeline({ since: \"-2m\", sources: [\"routes\", \"network\"] })\n" +
                "BAD: get_timeline({ since: \"-1h\", limit: 500 }) as a first look; start from the last action.\n",
            inputSchema: {
                since: z.union([z.number(), z.string()]).optional()
                    .describe('Window start: "last_action" (default), a relative time like "-30s" / "-5m" / "-1h", or epoch ms.'),
                until: z.union([z.number(), z.string()]).optional()
                    .describe('Window end, same formats as since except "last_action". Default: now.'),
                sources: z.array(z.enum(TIMELINE_SOURCES)).optional()
                    .describe("Subset of actions, routes, network, logs, restarts, refresh, perf. Default: all. Restarts are always shown. perf is reserved and returns nothing yet."),
                limit: z.coerce.number().int().min(1).max(500).optional().default(DEFAULT_LIMIT)
                    .describe("Maximum events (default 100). Actions, routes, restarts and errors are kept first."),
                device: z.string().optional().describe(DEVICE_ALL_DESC),
            },
        },
        async ({ since, until, sources, limit, device }) => {
            const window = resolveWindow({ since, until, now: Date.now(), lastAction: lastAction(device) });
            const wanted: TimelineSource[] = sources?.length ? sources : [...TIMELINE_SOURCES];
            const collected = await collectTimeline({ device, sources: wanted, window });

            if (wanted.every((s) => collected.unavailable.includes(s))) {
                const text = `Timeline unavailable: ${collected.notes.join("; ")}`;
                return { isError: true, content: [{ type: "text" as const, text }], _errorMessage: text };
            }

            const { kept, dropped } = trimEvents(collected.events, limit ?? DEFAULT_LIMIT);
            const notes = window.fallback
                ? ["No action recorded yet, so this shows the last 60s. Pass since to choose a window.", ...collected.notes]
                : collected.notes;
            const deviceLabel = collected.devices.length === 1 ? collected.devices[0]
                : collected.devices.length === 0 ? "no devices" : "all devices";
            const text = formatTimeline({
                // perf is reserved and has no producer yet, so it was not checked.
                window, deviceLabel, events: kept, tagDevices: collected.devices.length > 1, dropped, notes, checked: wanted.filter((s) => s !== "perf"),
            });
            return { content: [{ type: "text" as const, text }], _emptyResult: kept.length === 0 };
        }
    );
}
