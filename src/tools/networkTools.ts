import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerToolWithTelemetry } from "../core/register.js";
import {
    getNetworkStats,
    formatRequestDetails,
    DEFAULT_BODY_BUDGET,
    getConnectedAppByDevice,
    networkBuffers,
    metroMissingHintIfAbsent,
    checkAndEnsureConnection,
    getPassiveConnectionStatus,
    getRecentGaps,
    formatDuration,
    getNetworkBuffer,
} from "../core/index.js";
import { resolveNetworkBuffer } from "../core/toolHelpers.js";
import { UserInputError } from "../core/errors.js";
import { diagnoseEmptyResult, type EmptyDiagnosisLabels } from "../core/logDiagnosis.js";
import { isSDKInstalled, clearSDKNetwork } from "../core/sdkBridge.js";
import { refreshMirror } from "../core/sdkMirrorPoller.js";
import { withRestartDividers, evictionNotice, resolveEpochFilter } from "../core/epochRender.js";
import { formatRequest } from "../core/network.js";
import { pushMockRules } from "../core/networkInterceptor.js";
import {
    addRule,
    removeRule,
    clearRules,
    clearConditionRules,
    listRules,
    serializeRules,
    formatRuleList,
    activeMockBanner,
} from "../core/mockRules.js";
import {
    buildNetInfoPatchScript,
    parseNetInfoResult,
    describeNetInfoOutcome,
} from "../core/netInfoPatch.js";
import { executeInApp } from "../core/jsExecute.js";
import { DEVICE_ALL_DESC } from "./_deviceArg.js";

/**
 * Resolves the single device a mock rule applies to. Rules are per-device — a
 * rule added while an iPhone and an emulator are both connected must not fire
 * on both — so unlike the read tools this one never merges.
 */
function resolveMockTarget(device?: string): { ws: import("ws").WebSocket; deviceName: string } {
    const app = getConnectedAppByDevice(device);
    if (!app) {
        throw new UserInputError(
            "No connected app. Run scan_metro first — mock rules are stored per device and need one to attach to.",
            "no_devices_connected"
        );
    }
    return {
        ws: app.ws,
        deviceName: app.deviceInfo.deviceName || app.deviceInfo.title || "unknown"
    };
}

// Network capture has no end-to-end probe equivalent to verifyLogPipeline, so
// the "connected but nothing captured" verdict is always unverified: a silently
// dead interceptor is indistinguishable from an idle app. Labelled honestly
// rather than reported as a clean "no requests". Options for an actual probe
// are drafted in docs/devtools-core/specs/2026-07-29-network-capture-verification-design.md
const NETWORK_EMPTY_LABELS: EmptyDiagnosisLabels = {
    verified: "no_requests_verified",
    unverified: "no_requests_unverified"
};

function networkDiagnosisDeps(device?: string) {
    return {
        checkConnection: () => checkAndEnsureConnection(device),
        labels: NETWORK_EMPTY_LABELS
    };
}

export function registerNetworkTools(server: McpServer): void {
    // Tool: Get network requests
    registerToolWithTelemetry(
        server,
        "get_network_requests",
        {
            description:
                "Retrieve captured network requests from connected React Native app. Shows URL, method, status, and timing. Note: On Bridgeless targets (Expo SDK 52+) without the SDK, capture may miss early startup requests. Install execbro-sdk for full capture with headers and response bodies. Tip: Use summary=true first for stats overview.\n" +
                "PURPOSE: Inspect HTTP traffic the app made since connection — URLs, methods, status codes, and timings — to debug API, auth, and caching issues.\n" +
                "WHEN TO USE: User reports a failed login/load, slow screen, or wrong data. Confirm a request fired, check its status, and pivot to get_request_details for headers/body.\n" +
                "WORKFLOW: scan_metro -> reproduce action -> get_network_requests({ summary: true }) -> get_network_requests({ status: 500 }) or search_network -> get_request_details(id).\n" +
                "LIMITATIONS: Bridgeless targets without the SDK may miss pre-connect requests and response bodies — install execbro-sdk for full fidelity.\n" +
                "GOOD: get_network_requests({ summary: true }) then get_network_requests({ urlPattern: \"/login\", status: 401 })\n" +
                "BAD: get_network_requests({ maxRequests: 500 }) as the first call — start with summary=true.\n",
            inputSchema: {
                maxRequests: z
                    .number()
                    .optional()
                    .default(50)
                    .describe("Maximum number of requests to return (default: 50)"),
                method: z.string().optional().describe("Filter by HTTP method (GET, POST, PUT, DELETE, etc.)"),
                urlPattern: z.string().optional().describe("Filter by URL pattern (case-insensitive substring match). Also matches GraphQL operation names (e.g. \"GetCharacters\"), since every GraphQL call shares one URL."),
                status: z.number().optional().describe("Filter by HTTP status code (e.g., 200, 401, 500)"),
                summary: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe("Return statistics only (count, methods, domains, status codes). Use for quick overview."),
                device: z.string().optional().describe(DEVICE_ALL_DESC),
                epoch: z
                    .union([z.number(), z.literal("current"), z.literal("all")])
                    .optional()
                    .describe("Filter by app run. 'current' = the live run only; a number targets a specific run; omit or 'all' for everything including pre-restart data (default).")
            }
        },
        async ({ maxRequests, method, urlPattern, status, summary, device, epoch }) => {
            // The buffer is a superset of the SDK's in-app buffer (mirrored), the
            // CDP domain and the JS interceptor, and it retains prior app runs.
            // Refresh it first so this read is as current as a live SDK query.
            await refreshMirror(device);

            // Kept only for the "install the SDK" hint on an empty result.
            const sdkAvailable = await isSDKInstalled(device);

            // Return summary if requested
            if (summary) {
                const buffer = resolveNetworkBuffer(device);
                const stats = getNetworkStats(buffer);
                // Judge emptiness by the buffer this summary was built from, not
                // the global count across every device.
                const summaryEmpty = buffer.size === 0;
                let connectionWarning = "";
                let emptyReason: string | undefined;
                if (summaryEmpty) {
                    const diagnosis = await diagnoseEmptyResult(networkDiagnosisDeps(device));
                    connectionWarning = diagnosis.warning;
                    emptyReason = diagnosis.reason;
                    if (!sdkAvailable) {
                        connectionWarning += "\n\n[TIP] For full network capture including startup requests and response bodies, install the SDK: npm install execbro-sdk";
                    }
                    connectionWarning += await metroMissingHintIfAbsent("get_network_requests");
                }
                return {
                    _emptyResult: summaryEmpty,
                    ...(emptyReason && { _emptyReason: emptyReason }),
                    content: [
                        {
                            type: "text",
                            text: `Network Summary:\n\n${stats}${evictionNotice(buffer.droppedCount, "EXECBRO_NET_BUFFER_SIZE")}${connectionWarning}${activeMockBanner()}`
                        }
                    ]
                };
            }
    
            // Resolved once: for the all-devices case this copies every buffered
            // entry into a merged buffer, so it is not free to call repeatedly.
            const networkBuffer = resolveNetworkBuffer(device);
            const requests = networkBuffer.getAll({
                count: maxRequests,
                method,
                urlPattern,
                status,
                epoch: resolveEpochFilter(epoch, device)
            });
            const count = requests.length;
            const formatted = count === 0
                ? "No network requests captured yet."
                : withRestartDividers(requests, formatRequest);

            // `_emptyResult` measures CAPTURE reliability, not whether this
            // particular call returned rows — see the 2026-03-19 empty-result
            // spec. Filters matching nothing is a natural outcome, reported via
            // `_emptyReason` without setting the empty flag.
            const bufferEmpty = networkBuffer.size === 0;

            // Check connection health
            let connectionWarning = "";
            let emptyReason: string | undefined;
            if (count === 0) {
                // Capture is demonstrably working if the buffer holds anything —
                // the method/url/status filters simply matched none of it. Report
                // that directly instead of probing the connection and blaming it.
                if (!bufferEmpty) {
                    emptyReason = "filtered_out";
                } else {
                    const diagnosis = await diagnoseEmptyResult(networkDiagnosisDeps(device));
                    connectionWarning = diagnosis.warning;
                    emptyReason = diagnosis.reason;
                    if (!sdkAvailable) {
                        connectionWarning += "\n\n[TIP] For full network capture including startup requests and response bodies, install the SDK: npm install execbro-sdk";
                    }
                    connectionWarning += await metroMissingHintIfAbsent("get_network_requests");
                }
            } else {
                const passive = getPassiveConnectionStatus();
                connectionWarning = !passive.connected
                    ? "\n\n[CONNECTION] Disconnected. Showing cached data. New data is not being captured."
                    : "";
            }
    
            // Check for recent connection gaps
            const warningThresholdMs = 30000; // 30 seconds
            const recentGaps = getRecentGaps(warningThresholdMs);
            let gapWarning = "";
    
            if (recentGaps.length > 0) {
                const latestGap = recentGaps[recentGaps.length - 1];
                const gapDuration = latestGap.durationMs || Date.now() - latestGap.disconnectedAt.getTime();
    
                if (latestGap.reconnectedAt) {
                    const secAgo = Math.round((Date.now() - latestGap.reconnectedAt.getTime()) / 1000);
                    gapWarning = `\n\n[WARNING] Connection was restored ${secAgo}s ago. Some requests may have been missed during the ${formatDuration(gapDuration)} gap.`;
                } else {
                    gapWarning = `\n\n[WARNING] Connection is currently disconnected. Network data may be incomplete.`;
                }
            }
    
            return {
                _emptyResult: bufferEmpty,
                ...(emptyReason && { _emptyReason: emptyReason }),
                content: [
                    {
                        type: "text",
                        text: `Network Requests (${count} entries):\n\n${formatted}${evictionNotice(networkBuffer.droppedCount, "EXECBRO_NET_BUFFER_SIZE")}${gapWarning}${connectionWarning}${activeMockBanner()}`
                    }
                ]
            };
        },
        // Fallback only — every return path above sets `_emptyResult` explicitly,
        // which takes precedence. Retained so a future path that forgets to set it
        // still reports something rather than nothing.
        () => { let total = 0; for (const b of networkBuffers.values()) total += b.size; return total === 0; }
    );
    
    // Tool: Search network requests
    registerToolWithTelemetry(
        server,
        "search_network",
        {
            description: "Search network requests by URL pattern (case-insensitive).\n" +
                "PURPOSE: Filter the network buffer to requests whose URL matches a substring — fast way to find a specific endpoint in a noisy app.\n" +
                "WHEN TO USE: You know part of the URL (e.g., \"/graphql\", \"users\", a domain) and want matching requests across all devices.\n" +
                "WORKFLOW: search_network(urlPattern=\"/api/\") -> get_request_details(requestId=\"...\") for full headers/body.\n" +
                "LIMITATIONS: Matches URL only; for method/status/body filtering use get_network_requests. Bodies are only present when the SDK is installed.\n" +
                "GOOD: search_network({ urlPattern: \"/graphql\" })\n" +
                "BAD: search_network({ urlPattern: \"\" }) — empty pattern matches everything; use get_network_requests instead.\n",
            inputSchema: {
                urlPattern: z.string().describe("URL pattern to search for. Also matches GraphQL operation names (e.g. \"GetCharacters\") — use the operation name to find one GraphQL call among many sharing the same endpoint."),
                maxResults: z.number().optional().default(50).describe("Maximum number of results to return (default: 50)"),
                device: z.string().optional().describe(DEVICE_ALL_DESC)
            }
        },
        async ({ urlPattern, maxResults, device }) => {
            await refreshMirror(device);

            const networkBuffer = resolveNetworkBuffer(device);
            const matches = networkBuffer.search(urlPattern, maxResults);
            const count = matches.length;
            const formatted = count === 0
                ? "No network requests captured yet."
                : withRestartDividers(matches, formatRequest);

            // Check connection health. Distinguish "buffer has data, urlPattern
            // just didn't match" from "buffer is genuinely empty" — only the
            // latter is a capture-reliability problem worth diagnosing/nudging
            // the SDK for, same split get_network_requests already makes.
            let connectionWarning = "";
            if (count === 0) {
                if (networkBuffer.size > 0) {
                    connectionWarning = await metroMissingHintIfAbsent("search_network");
                } else {
                    const diagnosis = await diagnoseEmptyResult(networkDiagnosisDeps(device));
                    connectionWarning = diagnosis.warning;
                    if (!(await isSDKInstalled(device))) {
                        connectionWarning += "\n\n[TIP] For full network capture including startup requests and response bodies, install the SDK: npm install execbro-sdk";
                    }
                    connectionWarning += await metroMissingHintIfAbsent("search_network");
                }
            } else {
                const passive = getPassiveConnectionStatus();
                connectionWarning = !passive.connected
                    ? "\n\n[CONNECTION] Disconnected. Showing cached data. New data is not being captured."
                    : "";
            }
    
            return {
                content: [
                    {
                        type: "text",
                        text: `Network search results for "${urlPattern}" (${count} matches):\n\n${formatted}${connectionWarning}${activeMockBanner()}`
                    }
                ]
            };
        }
    );
    
    // Tool: Get request details
    registerToolWithTelemetry(
        server,
        "get_request_details",
        {
            description:
                "Get full details of one network request: headers, body, status, timing.\n" +
                "PURPOSE: Drill into a single entry after get_network_requests or search_network returns a suspect id.\n" +
                "WORKFLOW: get id -> read the shape -> get_request_details({ requestId, query }) for the subtree you need.\n" +
                "SHAPE FIRST: a large JSON body returns as its structure — key paths kept, arrays and objects annotated with real sizes, leaves clipped. The first call already answers 'is there an errors array' and 'does this field exist'.\n" +
                "QUERY: dot-path into the JSON body, returned in full. Supports a.b.c, [0], [-1], [*], [\"key.with.dots\"]. Targets the response body, or the request body when there is none. No match returns the shape plus what IS there — retry from that.\n" +
                "LIMITATIONS: Bodies need the execbro-sdk; CDP-only targets have no response body. Non-JSON is clipped at maxBodyLength, not projected.\n" +
                "GOOD: get_request_details({ requestId: \"42\", query: \"data.approvals.single.basicInfo\" }) | query: \"errors[*].message\"\n" +
                "BAD: verbose:true to find one field — that is the 40KB dump this avoids. Or guessing requestIds.\n",
            inputSchema: {
                requestId: z.string().describe("The request ID to get details for"),
                query: z
                    .string()
                    .optional()
                    .describe(
                        "Dot-path into the JSON body, returned in full: \"data.items[0].id\", \"errors[*].message\", \"data[\\\"weird.key\\\"]\". A leading $. is accepted. Omit to get the shape of the whole body. A path that matches nothing returns the shape plus what is actually there, not an error."
                    ),
                maxBodyLength: z.coerce
                    .number()
                    .optional()
                    .default(DEFAULT_BODY_BUDGET)
                    .describe(
                        `Byte target for each rendered body (default: ${DEFAULT_BODY_BUDGET}, 0 for unlimited). JSON is bounded structurally, so this trades depth and array width for size rather than cutting the text off.`
                    ),
                verbose: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe("Return bodies raw and unbounded. Prefer query — verbose on a large JSON body is the 40KB dump this tool exists to avoid."),
                device: z.string().optional().describe(DEVICE_ALL_DESC)
            }
        },
        async ({ requestId, query, maxBodyLength, verbose, device }) => {
            // Single source: the buffer holds mirrored SDK entries (with bodies),
            // CDP entries and interceptor entries, across every app run. get()
            // falls back across epochs so a pre-restart id still resolves.
            await refreshMirror(device);
            const request = resolveNetworkBuffer(device).get(requestId);

            if (!request) {
                const status = await checkAndEnsureConnection(device);
                let connectionNote = status.message ? `\n\n${status.message}` : "";
                connectionNote += await metroMissingHintIfAbsent("get_request_details");
    
                // Enrich with up to 5 recent ids so the agent can pick a real one
                // instead of retrying with the same stale / made-up id (telemetry
                // shows ids like "latest", "js-x6e0-1208", "261" passed in).
                const recent = resolveNetworkBuffer(device).getAll({ count: 5 });
                let recentNote = "";
                if (recent.length > 0) {
                    const lines = recent
                        .slice()
                        .reverse()
                        .map((r) => `  - ${r.requestId} — ${r.method} ${r.url}`)
                        .join("\n");
                    recentNote = `\n\nRecent request ids in buffer (most recent first):\n${lines}\n\nIds are opaque strings — use one of the above, or call get_network_requests / search_network to discover more.`;
                } else {
                    recentNote =
                        "\n\nNo network requests in the buffer for this device. " +
                        "Reproduce the action and call get_network_requests first to discover request ids.";
                }
    
                return {
                    content: [
                        {
                            type: "text",
                            text: `Request not found: ${requestId}${connectionNote}${recentNote}`
                        }
                    ],
                    isError: true
                };
            }
    
            return {
                content: [
                    {
                        type: "text",
                        text: formatRequestDetails(request, { maxBodyLength, verbose, query }) + activeMockBanner()
                    }
                ]
            };
        }
    );
    
    // Tool: Mock network responses
    registerToolWithTelemetry(
        server,
        "network_mock",
        {
            description:
                "Intercept the app's HTTP requests and replace or modify the response.\n" +
                "PURPOSE: Drive the app down an error path through its REAL code — the request builder, the error branch, the retry, the toast. redux_dispatch writes the post-failure state directly and skips all of it.\n" +
                "WHEN TO USE: 'what does this screen do on a 500', 'what if this field is null', 'does the retry work'.\n" +
                "WORKFLOW: network_mock({action:\"add\", url:\"/orders\", status:500}) -> reproduce -> get_network_requests (rows show [MOCK m1]) -> network_mock({action:\"clear\"}).\n" +
                "MODES: replace returns a canned response; tamper fetches the real one and mutates it (set/remove take dotted paths).\n" +
                "MATCHING: url is a substring by default; wrap it in slashes for a regex (\"/\\\\/orders\\\\/\\\\d+$/\"). First matching rule wins, so add specific rules before broad ones.\n" +
                "LIMITATIONS: JS-originated HTTP only — native-module traffic (native SDKs, <Image> loading) is not intercepted. Rules are per-device and survive reload_app; clear them when done.\n" +
                "GOOD: network_mock({action:\"add\", url:\"/orders\", mode:\"tamper\", remove:[\"data.email\"]})\n" +
                "BAD: leaving a rule active and then debugging why the app 'always fails' — check network_mock({action:\"list\"}) hit counts first.",
            inputSchema: {
                action: z.enum(["add", "list", "remove", "clear"]).describe("What to do."),
                id: z.string().optional().describe("Rule id, for action=\"remove\"."),
                url: z.string().optional().describe("URL substring, or /regex/ when slash-wrapped."),
                method: z.string().optional().describe("Restrict to one HTTP method."),
                mode: z
                    .enum(["replace", "tamper"])
                    .optional()
                    .default("replace")
                    .describe("replace = canned response; tamper = mutate the real one."),
                times: z
                    .number()
                    .optional()
                    .describe("Fire at most N times, then pass through. Use times:1 to test retry logic."),
                delayMs: z.number().optional().describe("Delay before delivering."),
                status: z
                    .number()
                    .optional()
                    .describe("Response status. In tamper mode, overrides the real status."),
                headers: z.record(z.string()).optional().describe("Response headers (replace mode)."),
                body: z.string().optional().describe("Response body (replace mode)."),
                networkError: z
                    .string()
                    .optional()
                    .describe("Fail the request instead of responding."),
                set: z
                    .record(z.unknown())
                    .optional()
                    .describe("tamper: dotted path -> value, e.g. {\"data.user.email\": null}."),
                remove: z.array(z.string()).optional().describe("tamper: dotted paths to delete."),
                bodyReplace: z.string().optional().describe("tamper: replace the whole body."),
                device: z.string().optional().describe(DEVICE_ALL_DESC)
            }
        },
        async (args) => {
            const { ws, deviceName } = resolveMockTarget(args.device);

            if (args.action === "list") {
                return {
                    content: [{ type: "text" as const, text: formatRuleList(deviceName) }]
                };
            }

            if (args.action === "remove") {
                if (!args.id) {
                    throw new UserInputError(
                        "action=\"remove\" needs an id. Get it from network_mock({action:\"list\"}).",
                        "missing_rule_id"
                    );
                }
                const removed = removeRule(deviceName, args.id);
                pushMockRules(ws, serializeRules(deviceName));
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: removed
                                ? `Removed ${args.id}. ${listRules(deviceName).length} rule(s) remain on ${deviceName}.`
                                : `No rule ${args.id} on ${deviceName}. ${formatRuleList(deviceName)}`
                        }
                    ]
                };
            }

            if (args.action === "clear") {
                const n = clearRules(deviceName);
                pushMockRules(ws, serializeRules(deviceName));
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Cleared ${n} mock rule(s) on ${deviceName}.`
                        }
                    ]
                };
            }

            if (!args.url) {
                throw new UserInputError(
                    "action=\"add\" needs a url to match on. Use a substring (\"/orders\"), or slash-wrap it for a regex.",
                    "missing_rule_url"
                );
            }
            const rule = addRule(deviceName, {
                url: args.url,
                method: args.method,
                mode: args.mode ?? "replace",
                times: args.times,
                delayMs: args.delayMs,
                status: args.status,
                headers: args.headers,
                body: args.body,
                networkError: args.networkError,
                set: args.set,
                remove: args.remove,
                bodyReplace: args.bodyReplace,
                source: "mock"
            });
            pushMockRules(ws, serializeRules(deviceName));

            // A rule added behind a broader one never fires, and the only
            // symptom is hits=0 much later. Say so at the point of the mistake.
            const shadowedBy = listRules(deviceName).find(
                (r) => r.id !== rule.id && !r.method && r.url !== "" && rule.url.indexOf(r.url) !== -1
            );
            const shadowNote = shadowedBy
                ? `\nWARNING: [${shadowedBy.id}] matches "${shadowedBy.url}" and is listed first, so it will fire instead. Remove it or reorder.`
                : "";

            return {
                content: [
                    {
                        type: "text" as const,
                        text:
                            `Added [${rule.id}] ${rule.method ?? "ANY"} ${rule.url} -> ${rule.mode} on ${deviceName}. ` +
                            `Survives reload_app. Clear with network_mock({action:"clear"}).${shadowNote}`
                    }
                ]
            };
        }
    );

    // Tool: Simulate network conditions
    registerToolWithTelemetry(
        server,
        "network_condition",
        {
            description:
                "Simulate offline or slow network for the running app.\n" +
                "PURPOSE: Reach the offline / timeout branches through the app's real code.\n" +
                "WHEN TO USE: 'what does this screen do with no network', 'is there a loading state', 'does the retry banner appear'.\n" +
                "WORKFLOW: network_condition({mode:\"offline\"}) -> reproduce -> network_condition({mode:\"normal\"}).\n" +
                "OFFLINE also patches NetInfo when installed, because many apps gate their offline UI on useNetInfo() rather than on a failed request. The result reports netInfo as patched / reads-patched-only / not-installed. Request failure works regardless.\n" +
                "LIMITATIONS: JS-originated HTTP only. Does not change the device's real connectivity. Leaves network_mock rules untouched.\n" +
                "GOOD: network_condition({mode:\"slow\", latencyMs:3000})\n" +
                "BAD: forgetting network_condition({mode:\"normal\"}) afterwards — it survives reload_app.",
            inputSchema: {
                mode: z
                    .enum(["offline", "slow", "normal"])
                    .describe("offline fails every request; slow delays them; normal clears."),
                latencyMs: z
                    .number()
                    .optional()
                    .default(2000)
                    .describe("Delay per request in slow mode."),
                device: z.string().optional().describe(DEVICE_ALL_DESC)
            }
        },
        async (args) => {
            const { ws, deviceName } = resolveMockTarget(args.device);

            // Only this tool's own rule is removed. Clearing the device would
            // destroy the agent's network_mock rules as a side effect of asking
            // for "offline", which is never what was meant.
            const replaced = clearConditionRules(deviceName);

            let summary: string;
            if (args.mode === "offline") {
                addRule(deviceName, {
                    url: "",
                    mode: "replace",
                    networkError: "Network request failed",
                    source: "condition"
                });
                summary = "Offline: every JS-originated request now fails with 'Network request failed'.";
            } else if (args.mode === "slow") {
                const latencyMs = args.latencyMs ?? 2000;
                // tamper, not replace: the real response still has to arrive,
                // it just arrives late. A replace rule would return nothing.
                addRule(deviceName, {
                    url: "",
                    mode: "tamper",
                    delayMs: latencyMs,
                    source: "condition"
                });
                summary = `Slow: every JS-originated request is delayed by ${latencyMs}ms; responses are otherwise unchanged.`;
            } else {
                summary =
                    replaced > 0
                        ? "Normal: the network condition has been removed."
                        : "Normal: no network condition was active.";
            }

            pushMockRules(ws, serializeRules(deviceName));

            // NetInfo only matters at the two ends of the range. "slow" leaves
            // the device reporting connected, which is the truth.
            const parts = [`${summary} (${deviceName})`];
            if (args.mode !== "slow") {
                const result = await executeInApp(
                    buildNetInfoPatchScript(args.mode === "offline"),
                    false,
                    { timeoutMs: 10000, originatingToolName: "network_condition" },
                    args.device
                );
                parts.push(
                    result.success
                        ? describeNetInfoOutcome(parseNetInfoResult(result.result))
                        : `NetInfo: unknown — the in-app check could not run (${result.error ?? "no error given"}). Assume NetInfo was NOT patched.`
                );
            }
            const remaining = listRules(deviceName).filter((r) => r.source !== "condition").length;
            if (remaining > 0) {
                parts.push(`${remaining} network_mock rule(s) left untouched on this device.`);
            }
            if (args.mode !== "normal") {
                parts.push("Survives reload_app. Undo with network_condition({mode:\"normal\"}).");
            }

            return { content: [{ type: "text" as const, text: parts.join("\n") }] };
        }
    );

    // Tool: Get network stats
    registerToolWithTelemetry(
        server,
        "clear_network",
        {
            description: "Clear the network request buffer.\n" +
                "PURPOSE: Reset the captured request list to isolate new traffic from a specific user action.\n" +
                "WHEN TO USE: Right before reproducing a bug so the buffer contains only the relevant requests.\n" +
                "WORKFLOW: clear_network -> trigger action (tap, execute_in_app) -> get_network_requests / search_network.\n" +
                "LIMITATIONS: Irreversible — cleared requests cannot be recovered. Also clears the SDK's in-app buffer when SDK is present.\n" +
                "GOOD: clear_network() before a reproduction.\n" +
                "BAD: Using clear_network as a workaround for stale connections — use scan_metro / ensure_connection instead.\n",
            inputSchema: {
                device: z.string().optional().describe(DEVICE_ALL_DESC)
            }
        },
        async ({ device }) => {
            let totalCleared = 0;
            if (device) {
                const app = getConnectedAppByDevice(device);
                if (!app) throw new UserInputError(`No connected device matches "${device}"`);
                const deviceName = app.deviceInfo.deviceName || app.deviceInfo.title || "unknown";
                totalCleared = getNetworkBuffer(deviceName).clear();
            } else {
                for (const buffer of networkBuffers.values()) {
                    totalCleared += buffer.clear();
                }
            }
    
            // Also clear SDK buffer if available
            const sdkAvailable = await isSDKInstalled(device);
            if (sdkAvailable) {
                const sdkResult = await clearSDKNetwork(device);
                if (sdkResult.success && sdkResult.count) {
                    totalCleared += sdkResult.count;
                }
            }
    
            return {
                content: [
                    {
                        type: "text",
                        text: `Cleared ${totalCleared} network requests from buffer.`
                    }
                ]
            };
        }
    );
}
