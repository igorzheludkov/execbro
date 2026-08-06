import { describe, it, expect } from "@jest/globals";
import { formatRequestDetails } from "../../core/network.js";
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
