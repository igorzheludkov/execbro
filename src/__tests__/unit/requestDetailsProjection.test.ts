import { describe, it, expect, beforeEach } from "@jest/globals";
import { formatRequestDetails } from "../../core/network.js";
import { resetVaultForTests } from "../../core/vault.js";
import type { NetworkRequest } from "../../core/types.js";

function request(overrides: Partial<NetworkRequest> = {}): NetworkRequest {
    return {
        requestId: "js-1",
        url: "https://api.example.com/graphql",
        method: "POST",
        headers: {},
        timestamp: new Date("2026-08-06T10:00:00Z"),
        epoch: 1,
        completed: true,
        status: 200,
        ...overrides
    } as NetworkRequest;
}

const graphqlResponse = JSON.stringify({
    documentId: "d1",
    data: {
        approvals: {
            single: { meetingItem: { basicInfo: { referenceNumber: "000342" } } }
        },
        rows: Array.from({ length: 200 }, (_, i) => ({ id: i, note: "n".repeat(200) }))
    }
});

describe("get_request_details body rendering", () => {
    it("surfaces a deep field on the first call instead of the head of the string", () => {
        const text = formatRequestDetails(request({ responseBody: graphqlResponse }));
        // The old char slice stopped inside `{"documentId":...,"data":{"approvals":`
        // and never reached this.
        expect(text).toContain("referenceNumber");
        expect(text).toContain("000342");
        expect(text).toContain("[bounded:");
    });

    it("returns the queried subtree in full", () => {
        const text = formatRequestDetails(request({ responseBody: graphqlResponse }), {
            query: "data.approvals.single.meetingItem.basicInfo"
        });
        expect(text).toContain('"referenceNumber": "000342"');
        expect(text).not.toContain('"rows"');
    });

    it("explains a missed query instead of erroring, and still shows the shape", () => {
        const text = formatRequestDetails(request({ responseBody: graphqlResponse }), {
            query: "data.approvals.singel"
        });
        expect(text).toContain("matched nothing");
        expect(text).toContain("single");
        expect(text).toContain("approvals");
    });

    it("queries the request body when the request has no response body", () => {
        const text = formatRequestDetails(
            request({ postData: JSON.stringify({ operationName: "GetApprovals", variables: { id: 7 } }) }),
            { query: "variables.id" }
        );
        expect(text).toContain("7");
    });

    it("leaves a non-JSON body as text and says the query did not apply", () => {
        const text = formatRequestDetails(request({ responseBody: "<html>oops</html>" }), {
            query: "data.x"
        });
        expect(text).toContain("<html>oops</html>");
        expect(text).toMatch(/not JSON/i);
    });

    it("returns a small body unchanged", () => {
        const body = JSON.stringify({ ok: true });
        const text = formatRequestDetails(request({ responseBody: body }));
        expect(text).toContain(body);
        expect(text).not.toContain("[bounded:");
    });

    it("verbose still returns the body raw", () => {
        const text = formatRequestDetails(request({ responseBody: graphqlResponse }), { verbose: true });
        expect(text).toContain(graphqlResponse);
    });
});

describe("credential headers", () => {
    const JWT =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const VALUE = "abc123def456ghi789jkl";

    const render = (headers: Record<string, string>, verbose = false) =>
        formatRequestDetails(request({ headers }), { verbose });

    // Measured against the ecosystem on 2026-09-05: a fixed seven-name list let
    // all of these through, because vendors namespace their own header names.
    it.each([
        "authorization",
        "cookie",
        "x-api-key",
        "apikey",
        "api-key",
        "x-goog-api-key",
        "x-algolia-api-key",
        "x-shopify-access-token",
        "x-amz-security-token",
        "x-hasura-admin-secret",
        "x-firebase-appcheck",
        "x-access-token",
        "x-refresh-token",
        "x-session-token",
        "x-client-token",
        "x-csrf-token",
        "x-xsrf-token",
        "sec-websocket-protocol",
        "token"
    ])("redacts %s", (name) => {
        expect(render({ [name]: VALUE })).not.toContain(VALUE);
    });

    // Redacting these would break the debugging and pagination workflows this
    // tool exists to serve, so a bare `key` or `token` segment must not match.
    it.each([
        "x-request-id",
        "x-correlation-id",
        "x-amzn-trace-id",
        "x-idempotency-key",
        "x-continuation-token",
        "content-type"
    ])("leaves %s alone", (name) => {
        expect(render({ [name]: VALUE })).toContain(VALUE);
    });

    // verbose used to print credentials in full. That put the escape hatch in
    // the model's hands, and a transcript is append-only, so one revealing call
    // is permanent. Only EXECBRO_REDACT=off lifts redaction now.
    // Reset per case so the handle is deterministic: the suffix counts distinct
    // values seen for a host, so it would otherwise depend on test order.
    beforeEach(resetVaultForTests);

    it.each([false, true])("stays redacted with verbose:%s", (verbose) => {
        const out = render({ authorization: `Bearer ${JWT}` }, verbose);
        expect(out).not.toContain(JWT);
        expect(out).toContain("Bearer [secret:auth_api.example.com]");
    });
});

describe("redaction runs before structural bounding", () => {
    beforeEach(resetVaultForTests);

    // Measured live on 2026-09-05 against an MSAL flow: projection clips
    // strings to 60 chars, so a ~2KB access_token reached the redactor already
    // truncated. It no longer matched the JWT shape, fell through to the
    // key-name rule, and rendered as `[redacted secret, 66 chars]` with no
    // handle — so the most valuable link in the flow, "the token minted here is
    // the token sent there", was the one the projection broke.
    const BIG_JWT =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
        "e" + "y".repeat(1200) +
        ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

    function tokenResponse(): NetworkRequest {
        return request({
            url: "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
            responseBody: JSON.stringify({ token_type: "Bearer", access_token: BIG_JWT, expires_in: 4887 })
        });
    }

    it("gives a long token in a body a handle instead of a truncated shape description", () => {
        const out = formatRequestDetails(tokenResponse(), { include: "response", maxBodyLength: 400 });
        expect(out).not.toContain(BIG_JWT);
        expect(out).toContain("[secret:jwt_login.microsoftonline.com]");
        expect(out).not.toContain("[redacted secret,");
    });

    it("links a body token to the same token seen in a header, which is the whole point", () => {
        formatRequestDetails(tokenResponse(), { include: "response", maxBodyLength: 400 });
        const sent = formatRequestDetails(
            request({ url: "https://api.example.com/graphql", headers: { authorization: `Bearer ${BIG_JWT}` } }),
            { include: "request" }
        );
        // Same handle on both sides: minted there, sent here, nothing disclosed.
        expect(sent).toContain("[secret:jwt_login.microsoftonline.com]");
    });

    it("keeps the body valid JSON after substitution", () => {
        const out = formatRequestDetails(tokenResponse(), { include: "response", maxBodyLength: 0 });
        const body = out.split("--- Response Body ---")[1].split("--- secrets")[0].trim();
        expect(() => JSON.parse(body)).not.toThrow();
        expect(JSON.parse(body).access_token).toBe("[secret:jwt_login.microsoftonline.com]");
    });
});
