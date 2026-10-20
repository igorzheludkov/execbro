import { describe, it, expect } from "@jest/globals";
import vm from "node:vm";
import { buildMockPushScript } from "../../core/networkInterceptor.js";
import { runWithMocks } from "../helpers/mock-harness.js";

describe("injected interceptor — mock matching", () => {
    it("replaces a matching request without touching the wire", () => {
        const t = runWithMocks([
            { id: "m1", url: "/orders", mode: "replace", status: 500, body: '{"error":"boom"}' },
        ]);
        const xhr = t.newXhr();
        const seen: number[] = [];
        xhr.addEventListener("load", () => seen.push(xhr.status));
        xhr.open("GET", "https://api.example.com/orders/7");
        xhr.send();
        t.flush();

        expect(xhr.sendCalled).toBe(0); // never reached the wire
        expect(seen).toEqual([500]);
        expect(xhr.status).toBe(500);
        expect(xhr.responseText).toBe('{"error":"boom"}');
        expect(t.events().some((e) => e.type === "mock" && e.ruleId === "m1")).toBe(true);
    });

    it("passes a non-matching request straight through", () => {
        const t = runWithMocks([{ id: "m1", url: "/orders", mode: "replace", status: 500 }]);
        const xhr = t.newXhr();
        xhr.open("GET", "https://api.example.com/users/1");
        xhr.send();
        expect(xhr.sendCalled).toBe(1);
        expect(t.events().some((e) => e.type === "mock")).toBe(false);
    });

    it("honours a method filter", () => {
        const t = runWithMocks([
            { id: "m1", url: "/orders", method: "POST", mode: "replace", status: 500 },
        ]);
        const get = t.newXhr();
        get.open("GET", "https://api.example.com/orders");
        get.send();
        expect(get.sendCalled).toBe(1);

        const post = t.newXhr();
        post.open("POST", "https://api.example.com/orders");
        post.send();
        t.flush();
        expect(post.sendCalled).toBe(0);
    });

    it("matches a slash-wrapped pattern as a regex", () => {
        const t = runWithMocks([{ id: "m1", url: "/\\/orders\\/\\d+$/", mode: "replace", status: 418 }]);
        const hit = t.newXhr();
        hit.open("GET", "https://api.example.com/orders/42");
        hit.send();
        t.flush();
        expect(hit.status).toBe(418);

        const miss = t.newXhr();
        miss.open("GET", "https://api.example.com/orders/list");
        miss.send();
        expect(miss.sendCalled).toBe(1);
    });

    it("first rule wins, so a broad rule shadows a later specific one", () => {
        const t = runWithMocks([
            { id: "m1", url: "/api", mode: "replace", status: 500 },
            { id: "m2", url: "/api/orders", mode: "replace", status: 200 },
        ]);
        const xhr = t.newXhr();
        xhr.open("GET", "https://x.example.com/api/orders");
        xhr.send();
        t.flush();
        expect(xhr.status).toBe(500);
        expect(t.events().find((e) => e.type === "mock")!.ruleId).toBe("m1");
    });

    it("consumes a times-limited rule and then passes through", () => {
        const t = runWithMocks([{ id: "m1", url: "/retry", mode: "replace", status: 503, times: 1 }]);
        const first = t.newXhr();
        first.open("GET", "https://x.example.com/retry");
        first.send();
        t.flush();
        expect(first.status).toBe(503);
        expect(first.sendCalled).toBe(0);

        const second = t.newXhr();
        second.open("GET", "https://x.example.com/retry");
        second.send();
        expect(second.sendCalled).toBe(1); // rule exhausted
    });

    it("delivers a network error instead of a response", () => {
        const t = runWithMocks([
            { id: "m1", url: "/down", mode: "replace", networkError: "Network request failed" },
        ]);
        const xhr = t.newXhr();
        const events: string[] = [];
        xhr.addEventListener("load", () => events.push("load"));
        xhr.addEventListener("error", () => events.push("error"));
        xhr.open("GET", "https://x.example.com/down");
        xhr.send();
        t.flush();
        expect(events).toEqual(["error"]);
    });

    it("does not match while __RN_NET_MOCKS__ is empty", () => {
        const t = runWithMocks([]);
        const xhr = t.newXhr();
        xhr.open("GET", "https://x.example.com/anything");
        xhr.send();
        expect(xhr.sendCalled).toBe(1);
    });

    it("still reports the request itself, so a mocked call is not invisible", () => {
        const t = runWithMocks([{ id: "m1", url: "/orders", mode: "replace", status: 500 }]);
        const xhr = t.newXhr();
        xhr.open("POST", "https://api.example.com/orders");
        xhr.send('{"qty":1}');
        t.flush();

        const request = t.events().find((e) => e.type === "request")!;
        expect(request.method).toBe("POST");
        expect(request.body).toBe('{"qty":1}');
        const mock = t.events().find((e) => e.type === "mock")!;
        expect(mock.id).toBe(request.id);
    });

    it("reports the mock even while __RN_NET_DISABLED__ suppresses capture", () => {
        // The SDK owns capture in that mode, but it knows nothing about mocks:
        // it patches XHR at this same layer and a mock returns before its send
        // runs. Suppressing the mocked request too left it with no row at all
        // (seen live on an SDK app: hits=3, zero rows).
        const t = runWithMocks([{ id: "m1", url: "/orders", mode: "replace", status: 500 }]);
        t.sandbox.__RN_NET_DISABLED__ = true;

        const xhr = t.newXhr();
        xhr.open("GET", "https://api.example.com/orders");
        xhr.send();
        t.flush();

        expect(xhr.status).toBe(500);
        expect(t.events().filter((e) => e.type === "request")).toHaveLength(1);
        expect(t.events().filter((e) => e.type === "mock")).toHaveLength(1);
    });

    it("delivers response headers the app can read back", () => {
        const t = runWithMocks([
            {
                id: "m1",
                url: "/orders",
                mode: "replace",
                status: 200,
                body: "{}",
                headers: { "Content-Type": "application/json" },
            },
        ]);
        const xhr = t.newXhr();
        xhr.open("GET", "https://api.example.com/orders");
        xhr.send();
        t.flush();
        expect(xhr.getAllResponseHeaders()).toContain("content-type: application/json");
    });

    it("fires an onload property handler, not only addEventListener listeners", () => {
        const t = runWithMocks([{ id: "m1", url: "/orders", mode: "replace", status: 201 }]);
        const xhr = t.newXhr();
        const seen: number[] = [];
        xhr.onload = () => seen.push(xhr.status);
        xhr.open("GET", "https://api.example.com/orders");
        xhr.send();
        t.flush();
        expect(seen).toEqual([201]);
    });

    it("a rule with no times budget keeps firing", () => {
        const t = runWithMocks([{ id: "m1", url: "/always", mode: "replace", status: 500 }]);
        for (let i = 0; i < 3; i++) {
            const xhr = t.newXhr();
            xhr.open("GET", "https://x.example.com/always");
            xhr.send();
            t.flush();
            expect(xhr.status).toBe(500);
            expect(xhr.sendCalled).toBe(0);
        }
        expect(t.events().filter((e) => e.type === "mock")).toHaveLength(3);
    });
});

describe("injected interceptor — GraphQL operation matching", () => {
    const rules = [{ id: "m1", url: "/graphql", operation: "GetLicenseInfo", mode: "replace", status: 500 }];

    function post(t: ReturnType<typeof runWithMocks>, body: string, url = "https://api.example.com/graphql") {
        const xhr = t.newXhr();
        xhr.open("POST", url);
        xhr.send(body);
        t.flush();
        return xhr;
    }

    it("matches operationName in the body and lets other operations through", () => {
        const t = runWithMocks(rules);
        expect(post(t, JSON.stringify({ operationName: "GetLicenseInfo", query: "query GetLicenseInfo { a }" })).status).toBe(500);
        expect(post(t, JSON.stringify({ operationName: "GetUser", query: "query GetUser { a }" })).sendCalled).toBe(1);
    });

    it("falls back to the name in the query document", () => {
        const t = runWithMocks(rules);
        expect(post(t, JSON.stringify({ query: "query GetLicenseInfo($id: ID) { a }" })).status).toBe(500);
    });

    it("is exact, so a longer name sharing the prefix does not match", () => {
        const t = runWithMocks(rules);
        expect(post(t, JSON.stringify({ operationName: "GetLicenseInfoV2" })).sendCalled).toBe(1);
    });

    it("matches operationName in a GET url", () => {
        const t = runWithMocks(rules);
        const xhr = t.newXhr();
        xhr.open("GET", "https://api.example.com/graphql?operationName=GetLicenseInfo&variables=%7B%7D");
        xhr.send();
        t.flush();
        expect(xhr.status).toBe(500);
    });

    it("never matches a batched array body", () => {
        const t = runWithMocks(rules);
        expect(post(t, JSON.stringify([{ operationName: "GetLicenseInfo" }, { operationName: "GetUser" }])).sendCalled).toBe(1);
    });

    it("still requires the url to match", () => {
        const t = runWithMocks(rules);
        expect(post(t, JSON.stringify({ operationName: "GetLicenseInfo" }), "https://api.example.com/other").sendCalled).toBe(1);
    });

    it("with no url, matches the operation on any endpoint", () => {
        const t = runWithMocks([{ id: "m1", url: "", operation: "GetLicenseInfo", mode: "replace", status: 500 }]);
        expect(post(t, JSON.stringify({ operationName: "GetLicenseInfo" }), "https://other.example.com/gql").status).toBe(500);
    });
});

describe("buildMockPushScript", () => {
    it("replaces the app's rule list wholesale", () => {
        const script = buildMockPushScript('[{"id":"m1"}]');
        expect(script).toContain("__RN_NET_MOCKS__");
        expect(script).toContain('[{"id":"m1"}]');
    });

    it("a later push overwrites an earlier one rather than appending", () => {
        const t = runWithMocks([{ id: "m1", url: "/a", mode: "replace", status: 500 }]);
        t.push([{ id: "m2", url: "/b", mode: "replace", status: 404 }]);

        const gone = t.newXhr();
        gone.open("GET", "https://x.example.com/a");
        gone.send();
        expect(gone.sendCalled).toBe(1); // m1 no longer exists

        const live = t.newXhr();
        live.open("GET", "https://x.example.com/b");
        live.send();
        t.flush();
        expect(live.status).toBe(404);
    });
});

describe("operation rules and an older interceptor", () => {
    it("the push script holds operation rules back when the app lacks the capability", () => {
        const ctx: Record<string, unknown> = {};
        vm.createContext(ctx);
        vm.runInContext(buildMockPushScript(JSON.stringify([
            { id: "m1", url: "/graphql", operation: "GetUser", mode: "replace" },
            { id: "m2", url: "/orders", mode: "replace" },
        ])), ctx);
        expect((ctx.__RN_NET_MOCKS__ as Array<{ id: string }>).map((r) => r.id)).toEqual(["m2"]);
    });

    it("the current interceptor advertises the capability, so nothing is held back", () => {
        const t = runWithMocks([{ id: "m1", url: "/graphql", operation: "GetUser", mode: "replace", status: 500 }]);
        const xhr = t.newXhr();
        xhr.open("POST", "https://api.example.com/graphql");
        xhr.send(JSON.stringify({ operationName: "GetUser" }));
        t.flush();
        expect(xhr.status).toBe(500);
    });
});
