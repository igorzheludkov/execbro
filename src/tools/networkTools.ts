import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerToolWithTelemetry } from "../core/register.js";
import {
    getNetworkStats,
    formatRequestDetails,
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
                "BAD: get_network_requests({ maxRequests: 500 }) as the first call — start with summary=true.\n" +
                "SEE ALSO: call get_usage_guide(topic=\"network\") for the full network-inspect playbook.",
            inputSchema: {
                maxRequests: z
                    .number()
                    .optional()
                    .default(50)
                    .describe("Maximum number of requests to return (default: 50)"),
                method: z.string().optional().describe("Filter by HTTP method (GET, POST, PUT, DELETE, etc.)"),
                urlPattern: z.string().optional().describe("Filter by URL pattern (case-insensitive substring match)"),
                status: z.number().optional().describe("Filter by HTTP status code (e.g., 200, 401, 500)"),
                summary: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe("Return statistics only (count, methods, domains, status codes). Use for quick overview."),
                device: z.string().optional().describe("Target device name (substring match). Omit for all devices. Run get_apps to see connected devices."),
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
                            text: `Network Summary:\n\n${stats}${evictionNotice(buffer.droppedCount, "EXECBRO_NET_BUFFER_SIZE")}${connectionWarning}`
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
                        text: `Network Requests (${count} entries):\n\n${formatted}${evictionNotice(networkBuffer.droppedCount, "EXECBRO_NET_BUFFER_SIZE")}${gapWarning}${connectionWarning}`
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
                "BAD: search_network({ urlPattern: \"\" }) — empty pattern matches everything; use get_network_requests instead.\n" +
                "SEE ALSO: call get_usage_guide(topic=\"network\") for the full network-inspect playbook.",
            inputSchema: {
                urlPattern: z.string().describe("URL pattern to search for"),
                maxResults: z.number().optional().default(50).describe("Maximum number of results to return (default: 50)"),
                device: z.string().optional().describe("Target device name (substring match). Omit for all devices. Run get_apps to see connected devices.")
            }
        },
        async ({ urlPattern, maxResults, device }) => {
            await refreshMirror(device);

            const matches = resolveNetworkBuffer(device).search(urlPattern, maxResults);
            const count = matches.length;
            const formatted = count === 0
                ? "No network requests captured yet."
                : withRestartDividers(matches, formatRequest);

            // Check connection health
            let connectionWarning = "";
            if (count === 0) {
                const status = await checkAndEnsureConnection(device);
                connectionWarning = status.message ? `\n\n${status.message}` : "";
                connectionWarning += await metroMissingHintIfAbsent("search_network");
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
                        text: `Network search results for "${urlPattern}" (${count} matches):\n\n${formatted}${connectionWarning}`
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
                "Get full details of a specific network request including headers, body, and timing. With the SDK installed, includes full request/response bodies. Without SDK, bodies are not available on most targets. Use get_network_requests first to find the request ID.\n" +
                "PURPOSE: Drill into a single network entry — full request/response headers, body, status, and timing breakdown.\n" +
                "WHEN TO USE: After get_network_requests or search_network returns a suspect ID and you need the payload to diagnose.\n" +
                "WORKFLOW: get_network_requests / search_network -> copy id -> get_request_details(requestId).\n" +
                "LIMITATIONS: Bodies require the execbro-sdk in the app; on CDP-only targets response bodies are missing. Large bodies are truncated — raise maxBodyLength.\n" +
                "GOOD: get_request_details({ requestId: \"42\", maxBodyLength: 4000 })\n" +
                "BAD: Guessing requestIds — always get them from get_network_requests / search_network first.\n" +
                "SEE ALSO: call get_usage_guide(topic=\"network\") for the full network-inspect playbook.",
            inputSchema: {
                requestId: z.string().describe("The request ID to get details for"),
                maxBodyLength: z.coerce
                    .number()
                    .optional()
                    .default(500)
                    .describe(
                        "Max characters for request body (default: 500, set to 0 for unlimited). Tip: Large POST bodies (file uploads, base64) can be 10KB+."
                    ),
                verbose: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe("Disable body truncation. Tip: Use when you need to inspect full JSON payloads."),
                device: z.string().optional().describe("Target device name (substring match). Omit for all devices. Run get_apps to see connected devices.")
            }
        },
        async ({ requestId, maxBodyLength, verbose, device }) => {
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
                        text: formatRequestDetails(request, { maxBodyLength, verbose })
                    }
                ]
            };
        }
    );
    
    // Tool: Get network stats
    registerToolWithTelemetry(
        server,
        "get_network_stats",
        {
            description: "Get statistics about captured network requests: counts by method, status code, and domain.\n" +
                "PURPOSE: High-level view of traffic shape — totals, error counts, average duration, and top domains — without scanning every request.\n" +
                "WHEN TO USE: To quickly answer \"is there a spike in 5xx?\", \"which domain is chattiest?\", or to sanity-check capture is working.\n" +
                "WORKFLOW: get_network_stats -> if errors > 0: get_network_requests(status=\"500\") -> get_request_details.\n" +
                "LIMITATIONS: Reflects only the buffered window (last 200 entries per device). Resets when clear_network is called.\n" +
                "GOOD: get_network_stats()\n" +
                "BAD: Using it to find a specific request — use search_network or get_network_requests.\n" +
                "SEE ALSO: call get_usage_guide(topic=\"network\") for the full network-inspect playbook.",
            inputSchema: {
                device: z.string().optional().describe("Target device name (substring match). Omit for all devices. Run get_apps to see connected devices.")
            }
        },
        async ({ device }) => {
            await refreshMirror(device);

            const stats = getNetworkStats(resolveNetworkBuffer(device));

            // Check connection health
            let connectionWarning = "";
            if (resolveNetworkBuffer(device).size === 0) {
                const status = await checkAndEnsureConnection(device);
                connectionWarning = status.message ? `\n\n${status.message}` : "";
                connectionWarning += await metroMissingHintIfAbsent("get_network_stats");
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
                        text: `Network Statistics:\n\n${stats}${connectionWarning}`
                    }
                ]
            };
        },
        // Empty result detector: buffer has no entries at all
        () => { let total = 0; for (const b of networkBuffers.values()) total += b.size; return total === 0; }
    );
    
    // Tool: Clear network requests
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
                "BAD: Using clear_network as a workaround for stale connections — use scan_metro / ensure_connection instead.\n" +
                "SEE ALSO: call get_usage_guide(topic=\"network\") for the full network-inspect playbook.",
            inputSchema: {
                device: z.string().optional().describe("Target device name (substring match). Omit to clear all devices. Run get_apps to see connected devices.")
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
