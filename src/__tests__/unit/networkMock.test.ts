import { describe, it, expect } from "@jest/globals";
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
        // The SDK owns capture in that mode, but it knows nothing about mocks.
        // Suppressing this event would hide altered traffic entirely and leave
        // the server's hit counters permanently at zero.
        const t = runWithMocks([{ id: "m1", url: "/orders", mode: "replace", status: 500 }]);
        t.sandbox.__RN_NET_DISABLED__ = true;

        const xhr = t.newXhr();
        xhr.open("GET", "https://api.example.com/orders");
        xhr.send();
        t.flush();

        expect(xhr.status).toBe(500);
        expect(t.events().filter((e) => e.type === "request")).toHaveLength(0);
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
