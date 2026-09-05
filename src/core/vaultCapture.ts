/**
 * Pull a credential from the app into the vault, without it passing through
 * the transcript.
 *
 * The one agent-facing vault write, and it is additive: it can only add or
 * supersede, never delete. That is not an oversight. Slots supersede rather
 * than accumulate, so "delete a stale entry" has nothing to do; adding the
 * operation would invite the agent to reason about vault hygiene and hand an
 * injected instruction a target. A pleasant consequence is that nothing can
 * talk the agent into wiping the credential cache mid-investigation.
 *
 * The agent chooses the expression and never receives the value: the return
 * channel goes to the vault, not to the caller. That asymmetry is precisely
 * what makes this safe where a bare execute_in_app is not — and note that
 * execute_in_app defeats redaction by construction anyway (measured 2026-09-05:
 * of nine transformations of a JWT, only the untouched token was caught), so
 * this tool is a convenience for cooperative use, never a containment boundary.
 */

import { UserInputError } from "./errors.js";
import { executeInApp } from "./jsExecute.js";
import { vaultAdd, vaultHandleRef } from "./vault.js";

export async function captureToVault(expression: string, origin: string, device?: string): Promise<string> {
    let host: string;
    try {
        host = new URL(origin).host;
    } catch {
        throw new UserInputError(
            `origin must be an absolute URL such as https://api.acme.io, got: ${origin}`,
            "bad_origin"
        );
    }
    if (!host) {
        throw new UserInputError(`origin must name a host, got: ${origin}`, "bad_origin");
    }

    const result = await executeInApp(
        expression,
        true,
        { timeoutMs: 15000, originatingToolName: "vault_capture" },
        device
    );

    if (!result.success) {
        // The error message is rendered; the expression deliberately is not.
        // execute_in_app used to return the raw expression as _errorContext,
        // which reached PostHog and the local JSONL without ever passing the
        // content redaction, because it is not content.
        return `Capture failed: ${result.error ?? "unknown error"}`;
    }

    let value = String(result.result ?? "");
    // The runtime hands back a JSON-encoded string for a string return, so an
    // unwrapped capture would vault the value WITH its quotes and never match
    // the same token seen anywhere else.
    if (value.startsWith('"') && value.endsWith('"')) {
        try {
            const unwrapped: unknown = JSON.parse(value);
            if (typeof unwrapped === "string") value = unwrapped;
        } catch {
            /* not JSON — keep it as-is */
        }
    }

    if (value === "" || value === "null" || value === "undefined") {
        return `Capture returned no value for ${host}. The expression ran but produced nothing — check the storage key, and remember an async read needs to resolve.`;
    }

    const handle = vaultAdd(value, "auth", origin);
    if (!handle) {
        return `Capture returned a value that is too short to vault (${value.length} chars, floor is 20). Short values are refused because exact matching would blank unrelated output everywhere it happened to appear.`;
    }
    return `Captured for ${host} as ${vaultHandleRef(handle)}. The value was never rendered. Use it with http_request({ auth: { secret: "${host}" } }).`;
}
