/**
 * Secret redaction for tool output.
 *
 * Applied once where tool results are serialized (see register.ts), not at each
 * render site: there are six-plus render paths (network bodies, URLs,
 * redux_get_state, execute_in_app, inspect_global, logs) and a per-site filter
 * is one that gets forgotten on the seventh. Redaction is render-time only —
 * the buffers keep the real value so app_request auth="auto" and network_replay
 * still work.
 *
 * Three mechanisms now, in the order they run:
 *
 *  1. Exact match against the vault (see vault.ts). Anything seen once is
 *     masked everywhere afterwards, whatever its shape or key name.
 *  2. Value shapes — a token in a URL or an error message where there is no
 *     key to match. These populate the vault and render as a stable handle.
 *  3. Key names — an opaque session id under an innocuous-looking value. These
 *     stay OUT of the vault: they match a name rather than a verified shape,
 *     and a wrongly-vaulted common substring would blank unrelated output
 *     everywhere with no visible cause.
 *
 * Escape hatch: `EXECBRO_REDACT=off` in the environment.
 */

import { vaultAdd, vaultMaskExact, vaultHandleRef, vaultCatalog } from "./vault.js";

/**
 * Rendering for a value below the vault's entry bar.
 *
 * The trailing four characters used to be printed here so two tokens could be
 * told apart. Handles answer that question properly now, and the rules that
 * still land in this function match a named field, so the key already says
 * which credential it is.
 */
function mark(kind: string, value: string): string {
    return `[redacted ${kind}, ${value.length} chars]`;
}

const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g;

const PROVIDER_KEY =
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|xox[baprse]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16})\b/g;

const AUTH_SCHEME = /\b(Bearer|Basic|Digest)\s+([A-Za-z0-9._~+/=-]{20,})/gi;

const SECRET_KEY = "password|passwd|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|apikey|authorization|cookie|session[_-]?id|sessionid|otp|pin|sig|signature";

/** `?access_token=…`, `&sig=…` — signed URLs and password-reset links. */
const QUERY_PARAM = new RegExp(`([?&](?:${SECRET_KEY})=)([^&\\s"'#\\\\]{4,})`, "gi");

/** `"accessToken":"…"` — JSON bodies and the JSON.stringify'd redux state. */
const JSON_FIELD = new RegExp(`("(?:${SECRET_KEY})"\\s*:\\s*)"((?:[^"\\\\]|\\\\.)*)"`, "gi");

/**
 * `token=abc123`, `api_key: abc123` in log lines and free text.
 *
 * Narrower key list than the URL and JSON forms: `sig`/`signature`/`pin` are
 * unambiguous as query parameters but collide with ordinary prose and code
 * once the delimiter is a bare colon.
 */
const LOOSE_KEY = "password|passwd|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|authorization|cookie|session[_-]?id|sessionid";
const LOOSE_FIELD = new RegExp(`\\b((?:${LOOSE_KEY})\\s*[:=]\\s*)([^\\s,;"'}\\]\\[]{8,})`, "gi");

/**
 * Values that are the absence of a secret, not a secret.
 *
 * `refresh_token: undefined` is 9 characters and matches the key rules, and
 * rendering it as `[redacted secret, 9 chars]` destroys the one thing the
 * caller came to find out — whether a token is there at all. Redacting a
 * non-secret is not a safe failure here, it is a misleading one.
 */
const PLACEHOLDER = /^(undefined|null|nil|none|true|false|empty|missing|redacted|\[object Object\])$/i;

/**
 * Spans of markers an earlier rule in the chain already produced.
 *
 * The shape rules run before the key-name rules, and a handle renders as
 * `[secret:auth_app]` — which contains the literal `secret:`, so LOOSE_FIELD
 * matches INSIDE the marker and rewrites it to `[secret:[redacted secret, 8
 * chars]]`, destroying the identity the vault exists to provide. Guarding on
 * the matched value alone does not catch this: the value there is `auth_app`,
 * the tail of the marker, which looks like an ordinary secret.
 *
 * So the guard has two halves, and both are needed:
 *
 *  - Positional, for a match that STARTS inside a marker (`secret:auth_app`
 *    within `[secret:auth_app]`).
 *  - Value-shaped, for a match that starts outside one and swallows it whole
 *    (`"accessToken":"[secret:jwt_app]"`, where the key is real text and only
 *    the value is a marker).
 *
 * Neither is a blanket overlap test, deliberately. A match that covers both a
 * marker AND raw text still gets redacted, because skipping it would leave a
 * real secret in the output — the one failure this file must not have.
 */
const MARKER = /\[(?:secret:|redacted )[^\]]*\]/g;

/** An emitted handle, capturing its name. */
const HANDLE = /\[secret:([^\]]+)\]/g;

/** A value that is nothing but markers already. */
const ONLY_MARKERS = /^\s*(?:\[(?:secret:|redacted )[^\]]*\]\s*)+$/;

function markerSpans(text: string): Array<[number, number]> {
    const spans: Array<[number, number]> = [];
    for (const m of text.matchAll(MARKER)) {
        spans.push([m.index, m.index + m[0].length]);
    }
    return spans;
}

function alreadyMarked(spans: Array<[number, number]>, offset: number, value: string): boolean {
    if (ONLY_MARKERS.test(value)) return true;
    return spans.some(([start, end]) => offset >= start && offset < end);
}

/**
 * The verified shape of a provider key. A prefix really is proof of issuer, in
 * a way that a JWT `iss` claim never is.
 */
function providerOf(value: string): string {
    if (/^gh[pousr]_|^github_pat_/.test(value)) return "github";
    if (/^(sk|pk|rk)_(live|test)_/.test(value)) return "stripe";
    if (value.startsWith("AKIA")) return "aws";
    if (value.startsWith("AIza")) return "google";
    if (/^xox[baprse]-/.test(value)) return "slack";
    return "key";
}

/**
 * Vault a high-confidence match and render its handle. Falls back to the shape
 * description when the value is under the vault's length floor.
 */
function handleFor(value: string, kind: string, hits: Set<string>, origin?: string): string {
    const handle = vaultAdd(value, kind, origin);
    if (!handle) return mark(kind, value);
    hits.add(handle);
    return vaultHandleRef(handle);
}

export function redactionEnabled(): boolean {
    return process.env.EXECBRO_REDACT?.toLowerCase() !== "off";
}

/**
 * `origin` is the host the text came from, when the call site knows one. The
 * generic chokepoint does not; the network body renderer does, and passing it
 * is what lets a token first seen in a response body be named after the host
 * that minted it rather than the generic `_app`.
 */
export function redactSecrets(text: string, opts: { catalog?: boolean; origin?: string } = {}): string {
    const hits = new Set<string>();
    const origin = opts.origin;

    // Exact matching runs FIRST and the order is load-bearing: once a
    // heuristic has rewritten part of a value, the literal is gone and the
    // exact pass can never find it again.
    let out = vaultMaskExact(text, hits);

    out = out
        .replace(JWT, (m) => handleFor(m, "jwt", hits, origin))
        .replace(PROVIDER_KEY, (m) => handleFor(m, providerOf(m), hits, origin))
        .replace(AUTH_SCHEME, (_m, scheme: string, value: string) =>
            `${scheme} ${handleFor(value, "auth", hits, origin)}`);

    // The three rules below match a key NAME, not a shape, so they stay out of
    // the vault. A wrongly-vaulted common substring would blank unrelated
    // output everywhere with no visible cause, which is a far worse failure
    // than one over-redacted field.
    //
    // Spans are recomputed per rule because each replace produces a new string
    // with different offsets.
    let spans = markerSpans(out);
    out = out.replace(QUERY_PARAM, (m, key: string, value: string, offset: number) =>
        alreadyMarked(spans, offset, value) ? m : `${key}${mark("secret", value)}`);

    spans = markerSpans(out);
    out = out.replace(JSON_FIELD, (m, key: string, value: string, offset: number) =>
        PLACEHOLDER.test(value) || alreadyMarked(spans, offset, value) ? m : `${key}"${mark("secret", value)}"`);

    spans = markerSpans(out);
    out = out.replace(LOOSE_FIELD, (m, key: string, value: string, offset: number) =>
        PLACEHOLDER.test(value) || alreadyMarked(spans, offset, value) ? m : `${key}${mark("secret", value)}`);

    if (opts.catalog === false) return out;

    // Pick up handles this call did not emit. redactHeaderValue renders its own
    // handle in network.ts, so a get_request_details result arrives here with
    // `[secret:auth_gifted.fyi]` already in it and no hit recorded — the reader
    // would see a handle with nothing explaining its age or expiry, which is
    // exactly the staleness the catalog exists to make visible before a 401
    // rather than after one. Scanning the finished text catches every producer,
    // present and future, instead of asking each one to remember to report.
    for (const m of out.matchAll(HANDLE)) hits.add(m[1]);

    const catalog = vaultCatalog(hits);
    return catalog ? `${out}\n\n${catalog}` : out;
}
