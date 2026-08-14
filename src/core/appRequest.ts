export interface AppRequestOptions {
    method: string;
    url: string;
    body?: unknown;
    /**
     * A body that is already a wire string, sent verbatim.
     *
     * `body` is JSON-serialised, which is right for a caller describing a
     * payload but wrong for a captured one: network_replay's postData is
     * already encoded, and re-encoding it would send the string "{...}" wrapped
     * in quotes — a valid request that means something else. Wins over `body`.
     */
    rawBody?: string;
    headers?: Record<string, string>;
    auth?: "auto" | "none";
}

/**
 * Build an in-app fetch as a promise chain.
 *
 * Runs inside the app so it inherits the real network stack, TLS trust and
 * proxy configuration — and so the bearer token is resolved from live state
 * rather than pasted into the expression. The corpus shows 21 instances of this
 * pattern across two apps; AppB's 15 embed a full JWT literal, which puts
 * the credential in the transcript.
 *
 * Promise chain, not async/await: async function syntax is engine-dependent and
 * rejected by many Hermes builds.
 */
export function buildRequestExpression(opts: AppRequestOptions): string {
    const method = JSON.stringify(opts.method.toUpperCase());
    const url = JSON.stringify(opts.url);
    const extraHeaders = JSON.stringify(opts.headers ?? {});
    // A string `body` is already a wire payload — MCP clients routinely pass the
    // JSON pre-serialised. Re-encoding it sent "{\"name\":...}" as a quoted
    // string, which every JSON API reads as an empty parameter set and answers
    // with a plausible-looking validation error. Send strings verbatim.
    const bodyJson =
        opts.rawBody !== undefined
            ? JSON.stringify(opts.rawBody)
            : typeof opts.body === "string"
              ? JSON.stringify(opts.body)
              : opts.body !== undefined
                ? JSON.stringify(JSON.stringify(opts.body))
                : "null";
    const wantsAuth = (opts.auth ?? "auto") === "auto";

    // Token lookup covers the shapes seen in the corpus. `state` comes from the
    // injected context, so this works without the caller knowing where the app
    // keeps its credentials.
    const authBlock = wantsAuth
        ? `
    var token = null;
    var authFrom = hget('authorization') ? 'explicit' : null;
    try {
        if (typeof state !== 'undefined' && state) {
            token = (state.user && state.user.accessToken) ||
                    (state.auth && (state.auth.accessToken || state.auth.token)) || null;
            if (token && !authFrom) authFrom = 'redux';
        }
    } catch (e) { token = null; }
    // Fallback: reuse the Authorization header from the app's most recent real
    // request. Source-agnostic, so it works for apps that keep the token
    // outside redux — Apollo holds it in the link chain, which is not
    // introspectable, and is exactly why those requests used to be hand-written
    // with a pasted JWT. Requires the SDK's network capture.
    if (!token && !hget('authorization')) {
        try {
            var sdk = globalThis.__RN_AI_DEVTOOLS__;
            var entries = sdk && sdk.getNetworkEntries ? sdk.getNetworkEntries() : null;
            if (entries) {
                for (var ei = entries.length - 1; ei >= 0 && !token; ei--) {
                    var rh = entries[ei] && entries[ei].requestHeaders;
                    if (!rh) continue;
                    var hk = Object.keys(rh);
                    for (var hi = 0; hi < hk.length; hi++) {
                        if (hk[hi].toLowerCase() === 'authorization' && rh[hk[hi]]) {
                            headers['Authorization'] = rh[hk[hi]];
                            authFrom = 'captured-request';
                            token = true;
                            break;
                        }
                    }
                }
            }
        } catch (e) { /* leave unauthenticated */ }
    }
    // An explicit header wins: the caller knows where their token lives.
    if (token && authFrom === 'redux' && !hget('authorization')) {
        headers['Authorization'] = 'Bearer ' + token;
    }`
        : "";

    return `(function(){
    var headers = {};
    var extra = ${extraHeaders};
    for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) headers[k] = extra[k]; }
    // Header names are case-insensitive on the wire, so every lookup here must
    // be too: a caller passing 'content-type' or 'authorization' in lower case
    // otherwise gets a *second* header added next to their own — the JSON
    // content type stamped over a urlencoded body, or the auto bearer over
    // their explicit one.
    var hget = function (n) {
        n = n.toLowerCase();
        for (var hk in headers) {
            if (Object.prototype.hasOwnProperty.call(headers, hk) && hk.toLowerCase() === n && headers[hk]) return headers[hk];
        }
        return null;
    };
    var bodyText = ${bodyJson};
    if (bodyText !== null && !hget('content-type')) headers['Content-Type'] = "application/json";${authBlock}
    var init = { method: ${method}, headers: headers };
    if (bodyText !== null) init.body = bodyText;
    ${wantsAuth
        ? `var authNote = !hget('authorization')
        ? 'auth="auto" found no token: not in state.user.accessToken / state.auth.accessToken / state.auth.token, and no captured request carried an Authorization header (the SDK network capture may be absent, or the app has not made an authenticated request yet). This request was sent UNAUTHENTICATED - pass headers.Authorization explicitly.'
        : null;
    var authSource = hget('authorization') ? authFrom : null;`
        : `var authNote = null;`}
    return fetch(${url}, init).then(function (res) {
        return res.text().then(function (text) {
            var parsed = text;
            try { parsed = JSON.parse(text); } catch (e) { parsed = text; }
            var out = { status: res.status, ok: res.ok, authorized: !!hget('authorization'), body: parsed };
            if (typeof authSource !== 'undefined' && authSource) out.authSource = authSource;
            if (authNote) out.authNote = authNote;
            return out;
        });
    }, function (err) {
        var out = { status: 0, ok: false, error: String(err && err.message ? err.message : err) };
        if (authNote) out.authNote = authNote;
        return out;
    });
})()`;
}
