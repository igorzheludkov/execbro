export interface AppRequestOptions {
    method: string;
    url: string;
    body?: unknown;
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
    const hasBody = opts.body !== undefined;
    const bodyJson = hasBody ? JSON.stringify(JSON.stringify(opts.body)) : "null";
    const wantsAuth = (opts.auth ?? "auto") === "auto";

    // Token lookup covers the shapes seen in the corpus. `state` comes from the
    // injected context, so this works without the caller knowing where the app
    // keeps its credentials.
    const authBlock = wantsAuth
        ? `
    var token = null;
    try {
        if (typeof state !== 'undefined' && state) {
            token = (state.user && state.user.accessToken) ||
                    (state.auth && (state.auth.accessToken || state.auth.token)) || null;
        }
    } catch (e) { token = null; }
    // An explicit header wins: the caller knows where their token lives, and
    // apps that keep it outside redux depend on being able to pass it.
    if (token && !headers['Authorization']) headers['Authorization'] = 'Bearer ' + token;`
        : "";

    return `(function(){
    var headers = {};
    var extra = ${extraHeaders};
    for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) headers[k] = extra[k]; }
    var bodyText = ${bodyJson};
    if (bodyText !== null && !headers['Content-Type']) headers['Content-Type'] = "application/json";${authBlock}
    var init = { method: ${method}, headers: headers };
    if (bodyText !== null) init.body = bodyText;
    ${wantsAuth
        ? `var authNote = !headers['Authorization']
        ? 'auth="auto" found no token in state.user.accessToken / state.auth.accessToken / state.auth.token. This request was sent UNAUTHENTICATED. Some apps hold the token outside redux (e.g. in an Apollo auth link) - pass headers.Authorization explicitly.'
        : null;`
        : `var authNote = null;`}
    return fetch(${url}, init).then(function (res) {
        return res.text().then(function (text) {
            var parsed = text;
            try { parsed = JSON.parse(text); } catch (e) { parsed = text; }
            var out = { status: res.status, ok: res.ok, authorized: !!headers['Authorization'], body: parsed };
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
