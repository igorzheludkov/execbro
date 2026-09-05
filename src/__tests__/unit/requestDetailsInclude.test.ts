import { describe, it, expect, beforeEach } from "@jest/globals";
import { formatRequestDetails, redactHeaderValue } from "../../core/network.js";
import type { NetworkRequest } from "../../core/types.js";
import { resetVaultForTests, vaultByHandle } from "../../core/vault.js";

const JWT = "Bearer " + "e".repeat(1500);

function request(overrides: Partial<NetworkRequest> = {}): NetworkRequest {
    return {
        requestId: "js-1",
        url: "https://api.example.com/graphql",
        method: "POST",
        headers: { authorization: JWT, accept: "application/json" },
        postData: JSON.stringify({ query: "query GetThings { things { id } }" }),
        responseBody: JSON.stringify({ data: { things: [{ id: "t1" }] } }),
        timestamp: new Date("2026-08-25T10:00:00Z"),
        epoch: 1,
        completed: true,
        status: 200,
        ...overrides
    } as NetworkRequest;
}

describe("get_request_details request/response split", () => {
    it("keeps a live token out of the transcript unless verbose asks for it", () => {
        resetVaultForTests();
        const out = formatRequestDetails(request(), { include: "request" });
        expect(out).not.toContain(JWT);
        // A vaulted credential renders as its handle, named after the host it
        // was seen on, rather than as a shape description.
        expect(out).toContain("Bearer [secret:auth_api.example.com]");
        // verbose:true no longer lifts header redaction. That hatch was in the
        // hands of the model, which is the exact actor a mechanism must not
        // depend on. EXECBRO_REDACT=off is the only way out, a human sets it,
        // and it needs a restart.
        expect(formatRequestDetails(request(), { include: "request", verbose: true })).not.toContain(JWT);
        expect(redactHeaderValue("accept", "application/json")).toBe("application/json");
    });

    it("renders only the queried side, so narrowing does not re-dump the request", () => {
        const out = formatRequestDetails(request(), { query: "data.things[0].id" });
        expect(out).toContain("t1");
        expect(out).not.toContain("Request Headers");
        expect(out).not.toContain("Request Body");
        expect(out).not.toContain("Response Headers");
        expect(out).toContain('include:"both"');
    });

    it("still shows both sides when there is no query", () => {
        const out = formatRequestDetails(request());
        expect(out).toContain("Request Headers");
        expect(out).toContain("Response Body");
    });

    it("honours an explicit include over the query default", () => {
        const out = formatRequestDetails(request(), { query: "data.things[0].id", include: "both" });
        expect(out).toContain("Request Headers");
        expect(out).toContain("t1");
    });
});

describe("redactHeaderValue and the vault", () => {
    beforeEach(resetVaultForTests);

    it("names the handle after the request host", () => {
        const out = redactHeaderValue(
            "authorization",
            "Bearer opaque-session-id-abcdefgh",
            "https://api.acme.io/v1/me"
        );
        expect(out).toBe("Bearer [secret:auth_api.acme.io]");
        expect(vaultByHandle("auth_api.acme.io")!.origin).toBe("api.acme.io");
    });

    it("vaults the token without its scheme, so the same value has one identity everywhere", () => {
        redactHeaderValue("authorization", "Bearer opaque-session-id-abcdefgh", "https://api.acme.io/v1/me");
        expect(vaultByHandle("auth_api.acme.io")!.value).toBe("opaque-session-id-abcdefgh");
    });

    it("falls back to a shape description for a short credential header", () => {
        const out = redactHeaderValue("x-api-key", "abc123", "https://api.acme.io/v1/me");
        expect(out).toContain("[redacted, 6 chars");
        expect(out).not.toContain("abc123");
    });

    it("still leaves a non-credential header alone", () => {
        expect(redactHeaderValue("accept", "application/json")).toBe("application/json");
    });
});
