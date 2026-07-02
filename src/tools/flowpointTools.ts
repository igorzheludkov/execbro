import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerToolWithTelemetry } from "../core/register.js";
import { getConnectedAppByDevice, connectedApps, executeInApp } from "../core/index.js";
import { UserInputError } from "../core/errors.js";
import {
    allStoredFlowpoints,
    clearFlowpointStores,
    drainFlowpoints,
    filterFlowpoints,
    formatFlowpoints,
    getFlowpointStore,
    matchesPoint,
    buildClearExpression,
} from "../core/flowpoints.js";

const NO_FLOWPOINTS_HINT =
    "No flowpoints captured. Instrument the flow under test (execbro-sdk required):\n\n" +
    "  import { flowpoint } from 'execbro-sdk'\n" +
    "  flowpoint({ name: 'my-flow', step: 'start', begin: true })\n" +
    "  flowpoint({ name: 'my-flow', step: 'done', meta: { anything: true } })\n\n" +
    "Then reload the app, drive the flow, and query again. " +
    'See get_usage_guide(topic="flowpoints").';

export function resolveTargetDeviceName(device?: string): string {
    if (device) {
        const app = getConnectedAppByDevice(device);
        if (!app) throw new UserInputError(`No connected device matches "${device}"`);
        return app.deviceInfo.deviceName || app.deviceInfo.title || "unknown";
    }
    const first = connectedApps.values().next().value;
    if (!first) throw new UserInputError("No connected app. Run scan_metro first.");
    return first.deviceInfo.deviceName || first.deviceInfo.title || "unknown";
}

const deviceParam = z
    .string()
    .optional()
    .describe("Target device name (substring match). Omit for all devices. Run get_apps to see connected devices.");

export function registerFlowpointTools(server: McpServer): void {
    registerToolWithTelemetry(
        server,
        "get_flowpoints",
        {
            description:
                "Read flowpoint breadcrumbs — structured, timestamped points emitted by flowpoint() calls " +
                "(execbro-sdk) — grouped by flow and run, with inter-point timing deltas.\n" +
                "PURPOSE: verify what actually happened inside a flow (steps, order, timing, failures) " +
                "instead of inferring it from console logs.\n" +
                "WHEN TO USE: after driving an instrumented flow; or with level: 'error' to ask " +
                '"did any flow fail?" across all flows at once.\n' +
                "WORKFLOW: instrument with flowpoint() -> reload -> drive the flow -> " +
                "wait_for_flowpoint (sync) -> verify_flow (assert) -> get_flowpoints (inspect details).\n" +
                "LIMITATIONS: requires execbro-sdk init() and flowpoint() instrumentation in app code.\n" +
                "GOOD: get_flowpoints({ name: 'add-to-cart', run: 'last' }) after a retry.\n" +
                "BAD: polling get_flowpoints in a loop — use wait_for_flowpoint instead.\n" +
                'SEE ALSO: call get_usage_guide(topic="flowpoints") for the full playbook.',
            inputSchema: {
                name: z.string().optional().describe("Filter to one flow name. Omit for all flows."),
                step: z.string().optional().describe("Filter to one step label (exact match)."),
                run: z
                    .string()
                    .optional()
                    .describe("Filter to one run id, or 'last' for the most recent run per flow."),
                level: z.enum(["info", "warn", "error"]).optional().describe("Filter by severity."),
                metaIncludes: z
                    .string()
                    .optional()
                    .describe("Case-insensitive substring match against the stringified meta payload."),
                since: z.number().optional().describe("Epoch-ms lower bound on the point timestamp."),
                limit: z.number().optional().default(200).describe("Max points returned, newest kept (default 200)."),
                device: deviceParam,
            },
        },
        async ({ name, step, run, level, metaIncludes, since, limit, device }) => {
            const deviceName = resolveTargetDeviceName(device);
            const drained = await drainFlowpoints(deviceName, device);
            if (!drained.ok) {
                return { isError: true, content: [{ type: "text" as const, text: drained.error }] };
            }
            const sourceEntries = device ? getFlowpointStore(deviceName).entries : allStoredFlowpoints();
            const entries = filterFlowpoints(sourceEntries, {
                name,
                step,
                run,
                level,
                metaIncludes,
                since,
                limit,
            });
            if (entries.length === 0) {
                return { content: [{ type: "text" as const, text: NO_FLOWPOINTS_HINT }] };
            }
            const flows = new Set(entries.map((e) => e.name)).size;
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Flowpoints (${entries.length} points, ${flows} flow${flows === 1 ? "" : "s"}):\n\n${formatFlowpoints(entries)}`,
                    },
                ],
            };
        },
        () => allStoredFlowpoints().length === 0,
    );

    registerToolWithTelemetry(
        server,
        "clear_flowpoints",
        {
            description:
                "Clear stored flowpoints. With name: clears one flow from the server store only " +
                "(cleared entries never re-drain). Without name: clears everything server-side AND " +
                "the in-app buffer. Usually unnecessary — prefer begin: true + run: 'last' filtering.",
            inputSchema: {
                name: z.string().optional().describe("Clear only this flow (server-side). Omit to clear all."),
                device: deviceParam,
            },
        },
        async ({ name, device }) => {
            let cleared = clearFlowpointStores(name);
            if (!name) {
                const result = await executeInApp(
                    buildClearExpression(),
                    false,
                    { timeoutMs: 3000, originatingToolName: "clear_flowpoints" },
                    device,
                );
                if (result.success) {
                    const inApp = parseInt(result.result || "0", 10);
                    if (!isNaN(inApp)) cleared = Math.max(cleared, inApp);
                }
            }
            const scope = name ? ` for flow "${name}"` : "";
            return { content: [{ type: "text" as const, text: `Cleared ${cleared} flowpoints${scope}.` }] };
        },
    );
}
