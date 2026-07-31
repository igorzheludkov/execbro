import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerToolWithTelemetry } from "../core/register.js";
import { buildRequestExpression } from "../core/appRequest.js";
import { executeInApp } from "../core/executor.js";
import { applyResultBudget, DEFAULT_MAX_BYTES } from "../core/truncate.js";

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
                "LIMITATIONS: needs a connected app. Token lookup covers state.user.accessToken, state.auth.accessToken and state.auth.token; pass an explicit Authorization header if your app stores it elsewhere.\n" +
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
                    .describe("\"auto\" (default) resolves a bearer token from app state; \"none\" sends no Authorization header."),
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
            const result = await executeInApp(
                expression,
                true,
                { timeoutMs: 30000, originatingToolName: "app_request" },
                device
            );

            if (!result.success) {
                return {
                    content: [{ type: "text", text: `Error: ${result.error ?? "Unknown error"}` }],
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
            return { content: [{ type: "text", text: parts.join("\n\n") }] };
        }
    );
}
