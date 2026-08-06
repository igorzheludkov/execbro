import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerToolWithTelemetry } from "../core/register.js";
import { buildRequestExpression } from "../core/appRequest.js";
import { executeInApp } from "../core/executor.js";
import { applyResultBudget, DEFAULT_MAX_BYTES } from "../core/truncate.js";
import { buildReplayArgs } from "../core/replay.js";
import { resolveNetworkBuffer } from "../core/toolHelpers.js";
import { refreshMirror } from "../core/sdkMirrorPoller.js";
import { activeMockBanner } from "../core/mockRules.js";

/**
 * Runs an in-app request and renders the result. Shared by app_request and
 * network_replay so a replay goes through the app's own stack — the same TLS
 * trust, proxy config and credentials — rather than a parallel implementation.
 */
async function runAppRequest(
    expression: string,
    maxResultLength: number | undefined,
    device: string | undefined,
    toolName: string,
    extraNotes: string[] = []
) {
    const result = await executeInApp(
        expression,
        true,
        { timeoutMs: 30000, originatingToolName: toolName },
        device
    );

    if (!result.success) {
        return {
            content: [{ type: "text" as const, text: `Error: ${result.error ?? "Unknown error"}` }],
            isError: true
        };
    }

    // Lift authNote out before bounding. It is the field most likely to
    // change what the caller does next ("your 401 is because no token
    // was found"), and the body it travels with is exactly what gets
    // truncated — so bounding it alongside would clip the warning.
    const raw = String(result.result ?? "");
    let authNote: string | undefined;
    let payload = raw;
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (typeof parsed.authNote === "string") {
            authNote = parsed.authNote;
            delete parsed.authNote;
            payload = JSON.stringify(parsed);
        }
    } catch {
        // Not JSON — leave it alone.
    }

    const bounded = applyResultBudget(payload, maxResultLength ?? DEFAULT_MAX_BYTES);
    const parts = [bounded.text];
    if (bounded.budget.truncated) {
        parts.push(`[bounded: ${bounded.budget.originalBytes} -> ${bounded.budget.returnedBytes} chars]`);
    }
    if (authNote) parts.push(`WARNING: ${authNote}`);
    parts.push(...extraNotes);
    return { content: [{ type: "text" as const, text: parts.join("\n\n") }] };
}

export function registerRequestTools(server: McpServer): void {
    registerToolWithTelemetry(
        server,
        "app_request",
        {
            description:
                "Issue an HTTP request from inside the running app, as the logged-in user.\n" +
                "PURPOSE: Probe your backend through the app's real network stack, TLS trust and proxy config — without pasting credentials into the conversation.\n" +
                "WHY THIS EXISTS: hand-written fetch calls either dig the token out of redux or embed a JWT literal in the expression, which puts the credential in the transcript. auth=\"auto\" resolves it in-app instead.\n" +
                "WHEN TO USE: reproduce a 4xx, check what an endpoint returns for an edge case, clean up test records the UI can't reach.\n" +
                "WORKFLOW: app_request({ method: \"GET\", url: \"https://api.example.com/me\" }) -> inspect status + body.\n" +
                "AUTH RESOLUTION (auth=\"auto\", in order): explicit Authorization header -> redux (state.user.accessToken, state.auth.accessToken, state.auth.token) -> the Authorization header of the app's last captured request. That last step is source-agnostic, so it covers tokens kept outside redux — keychain, secure storage, an Apollo link — as long as the app has already made one authenticated call and the SDK captured it. Cookie auth needs none of this: the native cookie jar attaches cookies to any in-app request.\n" +
                "LIMITATIONS: needs a connected app. Pass an explicit Authorization only when every step above misses — it puts the credential in the transcript.\n" +
                "GOOD: app_request({ method: \"DELETE\", url: \"https://api.example.com/address/17\" })\n" +
                "BAD: embedding a bearer token in an execute_in_app expression — it lands in the transcript.",
            inputSchema: {
                method: z
                    .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
                    .describe("HTTP method."),
                url: z.string().describe("Absolute URL to request."),
                body: z
                    .unknown()
                    .optional()
                    .describe("JSON-serialisable request body. Sets Content-Type: application/json unless you override it."),
                headers: z
                    .record(z.string())
                    .optional()
                    .describe("Extra request headers. An explicit Authorization here wins over auth=\"auto\"."),
                auth: z
                    .enum(["auto", "none"])
                    .optional()
                    .describe("\"auto\" (default) resolves a bearer token in-app: redux, then the last captured request's Authorization header. \"none\" sends no Authorization header — the right choice for cookie-authenticated APIs."),
                maxResultLength: z
                    .number()
                    .optional()
                    .describe("Target size for the returned body in characters (default 25000). Oversized bodies are bounded structurally."),
                device: z
                    .string()
                    .optional()
                    .describe("Target device name (substring match). Omit for the default device.")
            }
        },
        async ({ method, url, body, headers, auth, maxResultLength, device }) => {
            const expression = buildRequestExpression({ method, url, body, headers, auth });
            return runAppRequest(expression, maxResultLength, device, "app_request");
        }
    );

    registerToolWithTelemetry(
        server,
        "network_replay",
        {
            description:
                "Re-issue a request the app already made, optionally with changes.\n" +
                "PURPOSE: Retry a captured call without driving the UI back to the screen that made it — and vary one field at a time to find what the backend actually rejects.\n" +
                "WHEN TO USE: A request 4xx'd and you want to know whether it was the body, a header, or the endpoint. Or a flaky call you want to run again.\n" +
                "WORKFLOW: get_network_requests -> copy the id -> network_replay({requestId:\"js-x1-7\"}) -> network_replay({requestId:\"js-x1-7\", body:\"{...}\"}).\n" +
                "GOES THROUGH THE APP: same network stack, TLS trust, proxy and credentials as the original — cookies are attached by the native cookie jar, so a cookie-authenticated call replays as the logged-in user with no token handling. An active network_mock rule will intercept the replay too; the response says so when it does.\n" +
                "LIMITATIONS: ids come from get_network_requests and expire when the buffer rolls over or clear_network runs. Headers replace wholesale, they do not merge.\n" +
                "GOOD: network_replay({requestId:\"js-x1-7\", body:\"{\\\"qty\\\":99}\"})\n" +
                "BAD: guessing a requestId — read one from get_network_requests first.",
            inputSchema: {
                requestId: z
                    .string()
                    .describe("Id of a captured request, from get_network_requests or search_network."),
                method: z.string().optional().describe("Override the captured HTTP method."),
                url: z.string().optional().describe("Override the captured URL."),
                headers: z
                    .record(z.string())
                    .optional()
                    .describe("Replace the captured headers entirely (not merged)."),
                body: z
                    .string()
                    .optional()
                    .describe("Replace the captured request body. Sent verbatim, already-encoded."),
                auth: z
                    .enum(["auto", "none"])
                    .optional()
                    .default("none")
                    .describe("Default \"none\": the captured headers already carry the original Authorization. Use \"auto\" to resolve a fresh token instead."),
                maxResultLength: z
                    .number()
                    .optional()
                    .describe("Target size for the returned body in characters (default 25000)."),
                device: z
                    .string()
                    .optional()
                    .describe("Target device name (substring match). Omit for the default device.")
            }
        },
        async ({ requestId, method, url, headers, body, auth, maxResultLength, device }) => {
            // The buffer is the same one get_network_requests reads, so an id
            // shown there resolves here — including across app restarts.
            await refreshMirror(device);
            const replay = buildReplayArgs(resolveNetworkBuffer(device), requestId, {
                method,
                url,
                headers,
                body
            });

            const expression = buildRequestExpression({
                method: replay.method,
                url: replay.url,
                headers: replay.headers,
                // Verbatim: the captured body is already a wire string, and
                // re-encoding it would send a quoted string instead.
                rawBody: replay.body,
                auth: auth ?? "none"
            });

            // A live rule will intercept the replay, because it goes through the
            // app's own stack. That is correct, and it must not be a surprise.
            const notes: string[] = [];
            const banner = activeMockBanner();
            if (banner) {
                notes.push(
                    `NOTE: this replay went through the app's network stack, so any matching mock rule intercepted it too.${banner}`
                );
            }

            return runAppRequest(expression, maxResultLength, device, "network_replay", notes);
        }
    );
}
