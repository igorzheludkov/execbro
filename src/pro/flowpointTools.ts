import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerToolWithTelemetry } from "../core/register.js";
import { getConnectedAppByDevice, getFirstConnectedApp, executeInApp } from "../core/index.js";
import { UserInputError } from "../core/errors.js";
import {
    allStoredFlowpoints,
    clearFlowpointStores,
    drainFlowpoints,
    filterFlowpoints,
    formatFlowpoints,
    formatMeta,
    getFlowpointStore,
    matchesPoint,
    buildClearExpression,
    verifyFlow,
    resolveLastRuns,
} from "./flowpoints.js";

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
    const first = getFirstConnectedApp();
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
                since: z.number().optional().describe("Epoch-ms lower bound on the point timestamp (exclusive)."),
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
                if (sourceEntries.length === 0) {
                    return { content: [{ type: "text" as const, text: NO_FLOWPOINTS_HINT }] };
                }
                return {
                    content: [
                        {
                            type: "text" as const,
                            text:
                                `${sourceEntries.length} flowpoints stored, but 0 matched your filters. ` +
                                "Loosen or drop filters (name/step/run/level/metaIncludes/since) to see them.",
                        },
                    ],
                };
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
        (result) => !!result?.content?.[0]?.text?.startsWith("No flowpoints captured"),
    );

    registerToolWithTelemetry(
        server,
        "clear_flowpoints",
        {
            description:
                "Clear stored flowpoints.\n" +
                "PURPOSE: reset flowpoint history between test sessions.\n" +
                "WHEN TO USE: rarely — prefer begin: true + run: 'last' filtering between attempts. " +
                "With name: clears one flow from the server store only (cleared entries never re-drain). " +
                "Without name: clears everything server-side AND the in-app buffer.",
            inputSchema: {
                name: z.string().optional().describe("Clear only this flow (server-side). Omit to clear all."),
                device: z
                    .string()
                    .optional()
                    .describe(
                        "Target device (substring match). Scopes both the server-store clear and the in-app " +
                            "buffer clear. Omit for all devices.",
                    ),
            },
        },
        async ({ name, device }) => {
            const deviceName = device ? resolveTargetDeviceName(device) : undefined;
            let cleared = clearFlowpointStores(name, deviceName);
            let caveat = "";
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
                } else {
                    caveat = " (in-app buffer clear failed — still-buffered points may re-drain after the next app event)";
                }
            }
            const scope = name ? ` for flow "${name}"` : "";
            return { content: [{ type: "text" as const, text: `Cleared ${cleared} flowpoints${scope}.${caveat}` }] };
        },
    );

    registerToolWithTelemetry(
        server,
        "wait_for_flowpoint",
        {
            description:
                "Block until a flowpoint matching the criteria arrives, or timeout.\n" +
                "PURPOSE: deterministic synchronization for drive-then-verify — act first, then block on the flow's " +
                "terminal step instead of sleeping and re-polling.\n" +
                "WHEN TO USE: after tapping/driving an instrumented flow, with the flow's terminal step.\n" +
                "Points emitted after your action but before this call still match (only points already " +
                "seen by a previous flowpoint tool call are excluded).\n" +
                "On timeout, returns whatever points DID arrive for the flow — that partial trail is the " +
                "diagnostic for what stalled.\n" +
                'SEE ALSO: get_usage_guide(topic="flowpoints").',
            inputSchema: {
                name: z.string().describe("Flow name to watch."),
                step: z.string().optional().describe("Step label to wait for (exact match). Omit to match any step."),
                level: z.enum(["info", "warn", "error"]).optional().describe("Only match this severity."),
                metaIncludes: z
                    .string()
                    .optional()
                    .describe("Case-insensitive substring the stringified meta must contain."),
                timeoutMs: z.number().optional().default(5000).describe("Max wait in ms (default 5000, cap 30000)."),
                device: deviceParam,
            },
        },
        async ({ name, step, level, metaIncludes, timeoutMs, device }) => {
            const effectiveTimeout = Math.min(timeoutMs, 30000);
            const deviceName = resolveTargetDeviceName(device);
            const store = getFlowpointStore(deviceName);
            const baselineEntry = store.entries.length > 0 ? store.entries[store.entries.length - 1] : null;
            const start = Date.now();
            const deadline = start + effectiveTimeout;
            const freshEntries = () => {
                const startIdx = baselineEntry ? store.entries.indexOf(baselineEntry) + 1 : 0;
                return store.entries.slice(startIdx).filter((e) => e.name === name);
            };
            for (;;) {
                const remaining = deadline - Date.now();
                if (remaining > 0) {
                    const drained = await Promise.race([
                        drainFlowpoints(deviceName, device),
                        new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
                    ]);
                    if (drained && !drained.ok) {
                        return { isError: true, content: [{ type: "text" as const, text: drained.error }] };
                    }
                }
                const fresh = freshEntries();
                const match = fresh.find((e) => matchesPoint(e, { step, level, metaIncludes }));
                if (match) {
                    const meta = match.meta !== undefined ? `\nmeta: ${formatMeta(match.meta)}` : "";
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text:
                                    `Matched after ${Date.now() - start}ms: flow "${match.name}" ` +
                                    `run ${match.run} step "${match.step}" [${match.level}]${meta}`,
                            },
                        ],
                    };
                }
                if (Date.now() >= deadline) {
                    const trail = fresh.length
                        ? `Points that DID arrive for "${name}" during the wait:\n\n${formatFlowpoints(fresh)}`
                        : `No new points arrived for flow "${name}" during the wait.`;
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `Timeout after ${effectiveTimeout}ms waiting for flow "${name}"${step ? ` step "${step}"` : ""}.\n${trail}`,
                            },
                        ],
                    };
                }
                await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
            }
        },
    );

    registerToolWithTelemetry(
        server,
        "verify_flow",
        {
            description:
                "Assert a flow behaved as expected: compare the actual flowpoint trail of one run " +
                "against an expected step sequence and get a factual PASS/FAIL diff.\n" +
                "PURPOSE: factual PASS/FAIL assertion of a flow run against an expected step sequence.\n" +
                "WHEN TO USE: after wait_for_flowpoint confirms the flow finished; or write the expectation first " +
                "(runtime TDD) and iterate until PASS.\n" +
                "Matching is subsequence: expected steps must appear in order; extra points in between " +
                "are fine. Any unexpected error-level point fails the run unless allowErrors is true or " +
                "that step is explicitly expected.\n" +
                "WORKFLOW: write the expected sequence (even before implementing — runtime TDD), drive " +
                "the flow, wait_for_flowpoint on the terminal step, then verify_flow.\n" +
                'SEE ALSO: get_usage_guide(topic="flowpoints").',
            inputSchema: {
                name: z.string().describe("Flow name to verify."),
                expect: z
                    .array(
                        z.union([
                            z.string(),
                            z.object({
                                step: z.string(),
                                level: z.enum(["info", "warn", "error"]).optional(),
                                metaIncludes: z.string().optional(),
                            }),
                        ]),
                    )
                    .describe("Expected step sequence, in order. Strings are shorthand for { step }."),
                run: z.string().optional().default("last").describe("Run id to check, or 'last' (default)."),
                allowErrors: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe("Tolerate unexpected error-level points (default false)."),
                device: deviceParam,
            },
        },
        async ({ name, expect: expected, run, allowErrors, device }) => {
            const deviceName = resolveTargetDeviceName(device);
            const drained = await drainFlowpoints(deviceName, device);
            if (!drained.ok) {
                return { isError: true, content: [{ type: "text" as const, text: drained.error }] };
            }
            const sourceEntries = device ? getFlowpointStore(deviceName).entries : allStoredFlowpoints();
            const flowEntries = sourceEntries.filter((e) => e.name === name);
            if (flowEntries.length === 0) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `No flowpoints recorded for flow "${name}".\n\n${NO_FLOWPOINTS_HINT}`,
                        },
                    ],
                };
            }
            const runId = run === "last" || run === undefined ? resolveLastRuns(flowEntries).get(name)! : run;
            const runEntries = flowEntries.filter((e) => e.run === runId);
            if (runEntries.length === 0) {
                return {
                    isError: true,
                    content: [{ type: "text" as const, text: `No entries for flow "${name}" run "${runId}".` }],
                };
            }
            const result = verifyFlow(name, runId, runEntries, expected, allowErrors ?? false);
            // A FAIL verdict is a successful verification, not a tool error — never set isError for it.
            return { content: [{ type: "text" as const, text: result.text }] };
        },
    );
}
