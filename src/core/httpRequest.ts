/**
 * Host-side HTTP, the counterpart to app_request.
 *
 * app_request and network_replay both build a JS expression and run it INSIDE
 * the app, which is what makes them the only tools that can satisfy Firebase
 * App Check, and also what makes them useless for the job this tool does: a
 * live mock rule intercepts them, and the app's own stack is exactly what
 * someone isolating a server bug from a client bug is trying to escape.
 *
 * curl escaped it, and redaction closed that door by removing the copy step.
 * Improving credential DELIVERY could not reopen it: even if the token reached
 * the shell without entering the transcript, the RESPONSE still came back
 * through Bash, which this server never sees — the body, an error carrying a
 * signed URL, and `curl -v` echoing the request headers. That protects the
 * request and abandons the response.
 *
 * This tool covers both directions, which no Bash-based scheme can: the
 * credential is substituted here and never rendered, and the response returns
 * through us, so it passes the redactor on the way out.
 */

import { UserInputError } from "./errors.js";
import { vaultResolve, vaultStaleness } from "./vault.js";
import { redactSecrets } from "./redact.js";
import { redactHeaderValue } from "./network.js";
import { applyResultBudget, DEFAULT_MAX_BYTES } from "./truncate.js";

/**
 * Where a vaulted credential goes in the request.
 *
 * `header` and `scheme` exist because Bearer-only was not the neutral
 * simplification it looked like. Outside Bearer the only way to authenticate
 * was `headers: { "X-API-Key": "<pasted value>" }` — which puts the raw
 * credential back in the transcript, silently, with no error. The fallback for
 * the unsupported case WAS the insecure case, so covering the other shapes is
 * what makes the vault's guarantee hold rather than merely usually hold.
 */
export interface AuthArg {
    secret: string;
    /** Header to carry it. Default `Authorization`. */
    header?: string;
    /** Prefix before the value. Defaults to `Bearer` for `Authorization`, none otherwise; `""` forces a bare value. */
    scheme?: string;
}

export interface HttpRequestArgs {
    method: string;
    url: string;
    body?: unknown;
    headers?: Record<string, string>;
    auth?: AuthArg;
    maxResultLength?: number;
}

const TIMEOUT_MS = 30_000;
/** RFC 7230 token: what a header name and an auth scheme are allowed to be. */
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function hostOfUrl(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        throw new UserInputError(`Not a valid absolute URL: ${url}`, "bad_url");
    }
}

/**
 * Resolve `auth: { secret, header?, scheme? }` to one request header.
 *
 * Origin binding lives here and it is the whole security story of this tool.
 * Without it, "send secret X to evil.com" is single-call exfiltration, and that
 * instruction arrives through exactly the untrusted channel this product exists
 * to read: an API response, a log line, a rendered string. The check is against
 * the RESOLVED ENTRY's recorded origin, never the name the caller passed, so
 * naming a handle instead of a slot is not a way around it.
 */
export function resolveAuth(
    auth: AuthArg | undefined,
    url: string,
): { name?: string; value?: string; note?: string } {
    if (!auth) return {};

    // The header name and scheme are agent-controlled and land in the request
    // line, so they are a trust boundary: an unchecked newline here is header
    // injection. fetch would reject most of it, but as an opaque transport
    // error long after the useful message could be given.
    const name = auth.header ?? "Authorization";
    if (!HTTP_TOKEN.test(name)) {
        throw new UserInputError(`"${name}" is not a valid HTTP header name.`, "bad_header_name");
    }
    const scheme = auth.scheme ?? (name.toLowerCase() === "authorization" ? "Bearer" : "");
    if (scheme && !HTTP_TOKEN.test(scheme)) {
        throw new UserInputError(`"${scheme}" is not a valid auth scheme.`, "bad_scheme_name");
    }

    const entry = vaultResolve(auth.secret);
    if (!entry) {
        throw new UserInputError(
            `No credential named "${auth.secret}". Call list_secrets to see what the session has captured. The vault is memory-only, so a server restart empties it and a name from an older transcript resolves to nothing.`,
            "unknown_secret",
        );
    }

    const target = hostOfUrl(url);
    if (!entry.origin || entry.origin !== target) {
        throw new UserInputError(
            `Credential "${entry.handle}" was observed on ${entry.origin ?? "no recorded origin"} and cannot be sent to ${target}. Credentials are bound to the origin they came from.`,
            "origin_binding",
        );
    }

    return { name, value: scheme ? `${scheme} ${entry.value}` : entry.value, note: vaultStaleness(entry) };
}

/** Render response headers, reusing the credential-header rules. */
function renderHeaders(headers: Headers, origin: string): string {
    const lines: string[] = [];
    headers.forEach((value, key) => {
        lines.push(`${key}: ${redactHeaderValue(key, value, origin)}`);
    });
    return lines.join("\n");
}

export async function issueHttpRequest(args: HttpRequestArgs): Promise<string> {
    let parsed: URL;
    try {
        parsed = new URL(args.url);
    } catch {
        throw new UserInputError(`Not a valid absolute URL: ${args.url}`, "bad_url");
    }
    // Origin binding governs vaulted credentials; it says nothing about the
    // general outbound case. This tool makes arbitrary requests from the
    // user's machine, so the scheme is a trust boundary of its own.
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new UserInputError(
            `http_request only issues http and https requests, not ${parsed.protocol}`,
            "bad_scheme",
        );
    }

    const headers: Record<string, string> = { ...(args.headers ?? {}) };
    const { name, value, note } = resolveAuth(args.auth, args.url);
    if (name && value && !Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase())) {
        headers[name] = value;
    }

    let body: string | undefined;
    if (args.body !== undefined && args.body !== null) {
        if (typeof args.body === "string") {
            body = args.body;
        } else {
            body = JSON.stringify(args.body);
            if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
                headers["Content-Type"] = "application/json";
            }
        }
    }

    let res: Response;
    try {
        res = await fetch(args.url, {
            method: args.method,
            headers,
            body,
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `Request failed: ${message}`;
    }

    const raw = await res.text();
    // Redact BEFORE bounding. Structural bounding clips strings, and a token
    // clipped first no longer matches any shape, so it earns no handle and can
    // never be linked to the same token seen elsewhere. Phase 1 shipped this
    // ordering in network.ts renderBody for the same reason.
    const redacted = redactSecrets(raw, { catalog: false, origin: args.url });
    const bounded = applyResultBudget(redacted, args.maxResultLength ?? DEFAULT_MAX_BYTES);

    const parts = [
        `=== ${args.method.toUpperCase()} ${args.url} ===`,
        `Status: ${res.status} ${res.statusText}`,
        "issued from host (Node), NOT through the app",
        "\n--- Response Headers ---",
        renderHeaders(res.headers, args.url),
        "\n--- Response Body ---",
        bounded.text,
    ];
    if (bounded.budget.truncated) {
        parts.push(`[bounded: ${bounded.budget.originalBytes} -> ${bounded.budget.returnedBytes} chars]`);
    }
    if (note) parts.push(`WARNING: ${note}`);
    return parts.join("\n");
}
