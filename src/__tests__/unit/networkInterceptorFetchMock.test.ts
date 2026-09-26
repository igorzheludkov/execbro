import { describe, it, expect } from "@jest/globals";
import vm from "node:vm";
import { getInterceptorScript, buildMockPushScript } from "../../core/networkInterceptor.js";

/**
 * The fetch-level mock layer, used on chromium targets where fetch is native
 * and never passes through XMLHttpRequest. Runs the real injected script in a
 * vm context with Node's own Response/Headers and a fake native fetch.
 */

interface Harness {
    fetch: (input: unknown, init?: Record<string, unknown>) => Promise<Response>;
    realCalls: unknown[][];
    events: () => Array<Record<string, unknown>>;
}

function setup(rules: unknown[], nativeFetch = true, realBody = '{"user":{"email":"a@b.c","name":"A"}}'): Harness {
    const lines: string[] = [];
    const realCalls: unknown[][] = [];
    const sandbox: Record<string, unknown> = {
        console: { debug: (s: string) => lines.push(s) },
        setTimeout,
        Promise,
        Response,
        Headers,
        URL,
        TypeError,
        location: { href: "https://app.example.com/home" },
        // A browser page has XHR too, which is why the capture wrapper is dormant there.
        XMLHttpRequest: class { open() {} send() {} },
        fetch: (...args: unknown[]) => {
            realCalls.push(args);
            return Promise.resolve(new Response(realBody, { status: 200, headers: { "content-type": "application/json" } }));
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(getInterceptorScript(nativeFetch), sandbox);
    vm.runInContext(buildMockPushScript(JSON.stringify(rules)), sandbox);
    return {
        fetch: (input, init) => (vm.runInContext("fetch", sandbox) as Harness["fetch"])(input, init),
        realCalls,
        events: () =>
            lines
                .filter((l) => l.startsWith("__RN_NET__:"))
                .map((l) => JSON.parse(l.slice("__RN_NET__:".length)) as Record<string, unknown>),
    };
}

describe("injected interceptor — native fetch mocking (chromium)", () => {
    it("replace: synthesizes the response and never calls the real fetch", async () => {
        const h = setup([{ id: "m1", url: "/orders", mode: "replace", status: 500, body: '{"error":"boom"}', headers: { "content-type": "application/json" } }]);
        const res = await h.fetch("/orders?page=1");
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: "boom" });
        expect(res.headers.get("content-type")).toBe("application/json");
        expect(res.url).toBe("https://app.example.com/orders?page=1");
        expect(h.realCalls).toHaveLength(0);
        expect(h.events().map((e) => e.type)).toEqual(["request", "mock", "response"]);
        expect(h.events()[0]).toMatchObject({ mocked: true, method: "GET", url: "https://app.example.com/orders?page=1" });
        expect(h.events()[1]).toMatchObject({ ruleId: "m1" });
        expect(h.events()[2]).toMatchObject({ status: 500, mocked: true, body: '{"error":"boom"}' });
    });

    it("networkError: rejects with a TypeError, like native fetch", async () => {
        const h = setup([{ id: "c1", url: "", mode: "replace", networkError: "Network request failed" }]);
        await expect(h.fetch("https://api.example.com/x")).rejects.toThrow("Network request failed");
        expect(h.realCalls).toHaveLength(0);
        expect(h.events().map((e) => e.type)).toEqual(["request", "mock", "error"]);
    });

    it("tamper: fetches the real response and mutates it", async () => {
        const h = setup([{ id: "t1", url: "/me", mode: "tamper", status: 201, set: { "user.name": "B" }, remove: ["user.email"] }]);
        const res = await h.fetch("https://api.example.com/me", { method: "post", body: "x" });
        expect(h.realCalls).toHaveLength(1);
        expect(res.status).toBe(201);
        expect(await res.json()).toEqual({ user: { name: "B" } });
        expect(res.headers.get("content-type")).toBe("application/json");
        expect(h.events()[0]).toMatchObject({ method: "POST", body: "x" });
    });

    it("times:1 fires once, then passes through to the real fetch", async () => {
        const h = setup([{ id: "m1", url: "/r", mode: "replace", status: 503, times: 1 }]);
        expect((await h.fetch("/r")).status).toBe(503);
        expect((await h.fetch("/r")).status).toBe(200);
        expect(h.realCalls).toHaveLength(1);
    });

    it("matches on a Request object's method and url", async () => {
        const h = setup([{ id: "m1", url: "/items", method: "DELETE", mode: "replace", status: 204 }]);
        const res = await h.fetch({ url: "https://api.example.com/items/1", method: "DELETE" });
        expect(res.status).toBe(204);
        expect(await res.text()).toBe("");
    });

    it("a status fetch cannot deliver fails the call and says why", async () => {
        const h = setup([{ id: "m1", url: "/x", mode: "replace", status: 0 }]);
        await expect(h.fetch("/x")).rejects.toThrow(/Mock response rejected/);
        expect(h.events()[1]).toMatchObject({ type: "mock", warning: "status 0 cannot be delivered through fetch" });
    });

    it("React Native (nativeFetch=false): fetch rides on XHR, so it is never mocked here", async () => {
        const h = setup([{ id: "m1", url: "/orders", mode: "replace", status: 500 }], false);
        const res = await h.fetch("/orders");
        expect(res.status).toBe(200);
        expect(h.realCalls).toHaveLength(1);
        expect(h.events()).toHaveLength(0);
    });
});
