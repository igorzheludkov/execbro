import { describe, it, expect } from "@jest/globals";
import { formatRequestDetails, redactHeaderValue } from "../../core/network.js";
import type { NetworkRequest } from "../../core/types.js";

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
        const out = formatRequestDetails(request(), { include: "request" });
        expect(out).not.toContain(JWT);
        expect(out).toContain("Bearer [redacted, 1507 chars");
        expect(formatRequestDetails(request(), { include: "request", verbose: true })).toContain(JWT);
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
