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
import { issueHttpRequest } from "../core/httpRequest.js";
import { captureToVault } from "../core/vaultCapture.js";

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
                "WHEN TO USE: reproduce a 4xx, check what an endpoint returns for an edge case, clean up test records the UI can't reach.\n" +
                "WORKFLOW: app_request({ method: \"GET\", url: \"https://api.example.com/me\" }) -> inspect status + body.\n" +
                "AUTH RESOLUTION (auth=\"auto\", in order): explicit Authorization header -> redux (state.user.accessToken, state.auth.accessToken, state.auth.token) -> the Authorization header of the app's last captured request. That last step is source-agnostic, so it covers tokens kept outside redux — keychain, secure storage, an Apollo link — as long as the app has already made one authenticated call and the SDK captured it. Cookie auth needs none of this: the native cookie jar attaches cookies to any in-app request.\n" +
                "LIMITATIONS: needs a connected app. Pass an explicit Authorization only when every step above misses — it puts the credential in the transcript.\n" +
                "GOES THROUGH THE APP: same TLS trust, proxy, cookie jar and credentials, so an active network_mock rule intercepts it too. For a clean request from your own machine — to tell a server bug from a client one — use http_request.\n" +
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
                    .describe("Request body. An object is JSON-serialised for you; a string is sent verbatim (already-encoded JSON, urlencoded, raw). Sets Content-Type: application/json unless you override it."),
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

    registerToolWithTelemetry(
        server,
        "http_request",
        {
            description:
                "Issue an HTTP request FROM THE HOST (Node), not through the app, carrying a credential you cannot read.\n" +
                "PURPOSE: Isolate server behaviour from client behaviour. This is what curl was for, minus the part where the token and the whole response landed in the transcript.\n" +
                "HOW IT DIFFERS FROM app_request: app_request runs inside the app, so it carries the app's TLS trust, proxy, native cookie jar and credentials, and an active network_mock intercepts it. http_request is a clean request from your machine. Pick app_request when the app's real conditions matter, when the session is cookie-authenticated, or when the backend enforces attestation (Firebase App Check cannot be satisfied from Node). Pick http_request to tell a server bug from a client one.\n" +
                "CREDENTIALS: pass auth:{secret:\"<origin or handle>\"} — names come from list_secrets. The value is substituted here and never rendered, and is bound to the origin it was observed on: any other host is refused. Default placement is Authorization: Bearer; set header for a key header (X-API-Key) or scheme for another (Basic).\n" +
                "READING THE RESULT: a 401 here where app_request succeeds is itself an answer — the backend is enforcing attestation.\n" +
                "GOOD: http_request({ method: \"GET\", url: \"https://api.acme.io/v1/me\", auth: { secret: \"api.acme.io\" } })\n" +
                "BAD: pasting a credential into headers to cover a shape auth does not — that is the transcript leak the vault exists to prevent. Report the gap instead.",
            inputSchema: {
                method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).describe("HTTP method."),
                url: z.string().describe("Absolute http or https URL."),
                body: z
                    .unknown()
                    .optional()
                    .describe("Request body. An object is JSON-serialised and sets Content-Type: application/json unless you override it; a string is sent verbatim."),
                headers: z.record(z.string()).optional().describe("Extra request headers. An explicit Authorization wins over auth."),
                auth: z
                    .object({
                        secret: z.string().describe("Origin (\"api.acme.io\") or handle (\"auth_api.acme.io\") from list_secrets."),
                        header: z.string().optional().describe("Header to carry it. Default \"Authorization\"; use \"X-API-Key\" or similar for key-header APIs."),
                        scheme: z.string().optional().describe("Prefix before the value. Defaults to \"Bearer\" for Authorization and to nothing for any other header; pass \"Basic\", \"token\", or \"\" for a bare value.")
                    })
                    .optional()
                    .describe("Credential to attach. Typed on purpose: the credential position is structural, never string interpolation, so it cannot be smuggled into an arbitrary field."),
                maxResultLength: z.number().optional().describe("Target size for the response body in characters (default 25000).")
            }
        },
        async ({ method, url, body, headers, auth, maxResultLength }) => {
            const text = await issueHttpRequest({ method, url, body, headers, auth, maxResultLength });
            return { content: [{ type: "text" as const, text }] };
        }
    );

    registerToolWithTelemetry(
        server,
        "vault_capture",
        {
            description:
                "Read a credential out of the running app straight into the vault. The value is never returned to you.\n" +
                "PURPOSE: Cover credentials no captured request revealed — a cold session before the app has made an authenticated call, a token the app refreshed in the background, or one held somewhere no heuristic finds (keychain, expo-secure-store, an Apollo link).\n" +
                "WHEN TO USE: http_request says no credential is known for an origin, or list_secrets shows the entry as EXPIRED after a re-login.\n" +
                "WORKFLOW: vault_capture({ expression: \"SecureStore.getItemAsync('access_token')\", origin: \"https://api.acme.io\" }) -> http_request({ ..., auth: { secret: \"api.acme.io\" } }).\n" +
                "GOOD: vault_capture({ expression: \"store.getState().auth.token\", origin: \"https://api.acme.io\" })\n" +
                "BAD: reading the same value with execute_in_app — that returns it into the transcript, permanently.",
            inputSchema: {
                expression: z
                    .string()
                    .describe("JS evaluated in the app; its result goes to the vault, not to you. An async expression is awaited."),
                origin: z
                    .string()
                    .describe("Absolute URL of the API this credential authenticates, e.g. https://api.acme.io. Binds the credential: it can only be sent back to this host."),
                device: z.string().optional().describe("Target device name (substring match). Omit for the default device.")
            }
        },
        async ({ expression, origin, device }) => {
            const text = await captureToVault(expression, origin, device);
            return { content: [{ type: "text" as const, text }] };
        }
    );
}
