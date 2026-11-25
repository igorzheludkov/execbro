/**
 * An agent that needs what the server sends often writes its own fetch through
 * execute_in_app. That request carries none of the app's auth, so it is refused,
 * and the agent then hunts for the token (seen in the deck recordings, C3).
 * When an expression made an HTTP call and the result is an auth refusal, the
 * reply says which tools already do this as the logged-in user.
 */
const HTTP_CALL = /\bfetch\s*\(|XMLHttpRequest|\baxios\b/;
const REFUSED = [
    /^\s*"?(401|403)"?\s*$/,
    /"?status"?\s*[:=]\s*(401|403)\b/i,
    /unauthori[sz]ed|forbidden/i,
];

export function authRefusalHint(expression: string, resultText: string): string | null {
    if (!HTTP_CALL.test(expression)) return null;
    if (!REFUSED.some((re) => re.test(resultText))) return null;
    return (
        "[hint] This request went out without the app's auth: a fetch from execute_in_app sends no token. " +
        'app_request({ method: "GET", url, auth: "auto" }) sends it as the logged-in user, and the app\'s own call ' +
        "may already be captured: get_network_requests({ urlPattern }) then get_request_details."
    );
}
